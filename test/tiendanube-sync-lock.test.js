import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearVenta } from '../src/services/ventasService.js';
import { crearServicioTiendanubeSync } from '../src/services/tiendanubeSyncService.js';

test.after(async () => { await pool.end(); });

// This test needs independent PostgreSQL sessions: an in-memory adapter that
// serializes transactions cannot exercise the stock row-lock order.
test('reserva de dos variantes y venta local concurrente bloquean productos en el mismo orden', async () => {
  await migrate();
  const n = await crearNegocio({ nombre: 'Concurrencia de stock QA' });
  const actor = await crearUsuario({ email: `${randomUUID()}@sync-lock.invalid`, password_hash: 'unused' });
  const customer = await crearCliente({ nombre: 'Cliente', apellido: 'QA', negocio_id: n.id });
  const products = [`a-${randomUUID()}`, `z-${randomUUID()}`];
  const store = String(BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`));
  for (const product of products) await db.prepare('INSERT INTO productos(id,negocio_id,nombre,stock) VALUES(?,?,?,5)').run(product, n.id, product);
  await db.prepare(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada,sync_activada_at,sync_baseline_at,sync_webhooks_at)
    VALUES(?,?,'51162','fixture-no-access','write_products,read_orders',FALSE,'2026-11-09T10:00:00Z','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z')`).run(n.id, store);
  // Remote variant order is deliberately the opposite of local product order.
  for (const [product, variant] of [[products[1], '111'], [products[0], '222']]) await db.prepare(`INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id,sync_baseline_at,sync_stock_remoto)
    VALUES(?, ?,?,'11',?,'2026-11-09T10:00:00Z',5)`).run(product, n.id, store, variant);
  await db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_proximo_intento)
    VALUES(?,'order/created','40','fixture-created','{}','2026-11-09T12:00:00Z')`).run(store);

  let releaseSale, saleLocked;
  const resumeSale = new Promise(resolve => { releaseSale = resolve; });
  const firstSaleLock = new Promise(resolve => { saleLocked = resolve; });
  const query = db.query;
  let salePid, syncPid, sale, inbound;
  db.query = async (sql, params = []) => {
    const result = await query(sql, params);
    if (sql === 'SELECT * FROM productos WHERE id = $1 FOR UPDATE' && params[0] === products[0]) {
      salePid = (await query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await query("SET LOCAL statement_timeout='8s'");
      saleLocked();
      await resumeSale;
    }
    if (sql === 'SELECT * FROM tiendanube_conexiones WHERE negocio_id=$1 FOR UPDATE' && params[0] === n.id) {
      syncPid = (await query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await query("SET LOCAL statement_timeout='8s'");
    }
    return result;
  };
  const sync = crearServicioTiendanubeSync({ db, enabled: true, now: () => new Date('2026-11-09T14:00:00Z'),
    apiFactory: () => async (method, path) => {
      assert.equal(method, 'GET'); assert.equal(path, '/orders/40');
      return { id: 40, store_id: store, created_at: '2026-11-09T11:00:00Z', status: 'open', payment_status: 'pending',
        products: [{ variant_id: 111, quantity: 1 }, { variant_id: 222, quantity: 1 }] };
    } });
  const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code, message: error.message }));
  try {
    sale = settled(crearVenta({ negocio_id: n.id, cliente_id: customer.id, modalidad: 'unico', monto_total_centavos: 20000,
      entrega_inicial_centavos: 0, items: products.map(producto_id => ({ producto_id, cantidad: 1, precio_unitario_centavos: 10000 })),
      usuario_id: actor.id, solicitud_id: randomUUID(), plan: { plazo_dias: 30 } }));
    await Promise.race([firstSaleLock, sale.then(result => { throw new Error(`La venta terminó antes del bloqueo esperado: ${JSON.stringify(result)}`); })]);
    inbound = settled(sync.procesarEntrada(n.id));
    // Wait for a real row-lock dependency, not a timing guess. On the old
    // implementation sync already owns z-product while waiting for a-product;
    // releasing the sale then creates a cycle. With product-order prelocks it
    // waits for a-product before acquiring z-product, so both can complete.
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      if (syncPid) blocked = (await query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [salePid, syncPid])).rows[0].blocked;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'La reserva debe esperar el producto que ya posee la venta');
    releaseSale();
    const [reservation, ordinary] = await Promise.all([inbound, sale]);
    assert.equal(reservation.ok, true, JSON.stringify(reservation));
    assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
    assert.equal(reservation.value.unidades_reservadas, 2);
    assert.equal(reservation.value.cobros_creados, 0);
    assert.equal(reservation.value.comisiones_creadas, 0);
    const rows = await db.prepare('SELECT id,stock FROM productos WHERE negocio_id=? ORDER BY id').all(n.id);
    assert.deepEqual(rows.map(p => p.stock), [3, 3]);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM tiendanube_pedido_stock WHERE store_id=?').get(store)).n, 2);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM ventas WHERE negocio_id=?').get(n.id)).n, 1);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM pagos WHERE negocio_id=?').get(n.id)).n, 0);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM comision_acuerdos WHERE negocio_id=?').get(n.id)).n, 0);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM producto_historial WHERE negocio_id=?').get(n.id)).n, 4);
    await db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_proximo_intento)
      VALUES(?,'order/paid','40','fixture-paid','{}','2026-11-09T12:00:00Z')`).run(store);
    assert.equal((await sync.procesarEntrada(n.id)).unidades_reservadas, 0);
    assert.deepEqual((await db.prepare('SELECT stock FROM productos WHERE negocio_id=? ORDER BY id').all(n.id)).map(p => p.stock), [3, 3]);
  } finally {
    releaseSale();
    await Promise.allSettled([inbound, sale].filter(Boolean));
    db.query = query;
  }
});
