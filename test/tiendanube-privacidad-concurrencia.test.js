import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

process.env.TIENDANUBE_APP_SECRET = 'tiendanube-privacidad-local';
process.env.TIENDANUBE_TOKEN_KEY = 'ef'.repeat(32);
const { db, pool } = await import('../src/db/connection.js');
const { migrate } = await import('../src/db/migrate.js');
const { crearNegocio } = await import('../src/repositories/negocios.js');
const { crearProducto } = await import('../src/repositories/productos.js');
const { crearCliente } = await import('../src/repositories/clientes.js');
const { crearUsuario } = await import('../src/repositories/usuarios.js');
const { crearVenta } = await import('../src/services/ventasService.js');
const { firmarToken } = await import('../src/lib/auth.js');
const { cifrarToken } = await import('../src/lib/tiendanube.js');
const { app } = await import('../src/app.js');
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: randomUUID() + '@privacy.invalid', password_hash: 'unused' });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = 'http://127.0.0.1:' + server.address().port;
const originalFetch = globalThis.fetch, originalQuery = db.query;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith(origin + '/')) return originalFetch(input, options);
  assert.match(url, /^https:\/\/api\.tiendanube\.com\/2025-03\/\d+\/products\/12\/variants\/34$/, 'No se permiten solicitudes externas');
  return Response.json({ id: 34, product_id: 12 });
};
test.after(async () => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function fixture(store, otherStore) {
  const a = await crearNegocio({ nombre: 'Privacidad A ' + randomUUID() });
  const b = await crearNegocio({ nombre: 'Privacidad B ' + randomUUID() });
  const pa = await crearProducto({ negocio_id: a.id, nombre: 'Producto A', stock: 9 });
  const pb = await crearProducto({ negocio_id: b.id, nombre: 'Producto B', stock: 11 });
  const cliente = await crearCliente({ nombre: 'Cliente', apellido: 'QA', negocio_id: a.id });
  await crearVenta({ negocio_id: a.id, cliente_id: cliente.id, modalidad: 'cuotas', items: [{ producto_id: pa.id, cantidad: 1, precio_unitario_centavos: 10000 }], monto_total_centavos: 10000, entrega_inicial_centavos: 1000, plan: { cantidad_cuotas: 2, valor_cuota_centavos: 4500, fecha_primera_cuota: '2090-01-10' }, usuario_id: admin.id, solicitud_id: randomUUID() });
  for (const [n, id] of [[a, store], [b, otherStore]]) {
    await db.prepare('INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes) VALUES(?,?,?,?,?)').run(n.id, id, '51162', cifrarToken('fake-local-token'), 'write_products,read_orders');
  }
  await db.prepare('INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id) VALUES(?,?,?,?,?)').run(pb.id, b.id, otherStore, '56', '78');
  await db.prepare('INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado) VALUES(?,?,?)').run(pb.id, b.id, 11);
  return { a, b, pa, pb, store, otherStore };
}
async function financialSnapshot() {
  const tables = ['clientes', 'cliente_negocio', 'ventas', 'venta_detalle', 'creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'productos', 'producto_historial'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT * FROM ${table} ORDER BY ${table === 'cliente_negocio' ? 'cliente_id,negocio_id' : 'id'}`)).rows])));
}
async function otherSnapshot(f) {
  return {
    connection: await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get(f.b.id),
    links: await db.prepare('SELECT * FROM tiendanube_variantes WHERE negocio_id=?').all(f.b.id),
    outbox: await db.prepare('SELECT * FROM tiendanube_stock_outbox WHERE negocio_id=?').all(f.b.id),
  };
}

for (const [path, topic, store] of [['/privacy/store-redact', undefined, '601'], ['/webhook', 'app/uninstalled', '602']]) {
  test('Tiendanube: ' + path + ' serializa la limpieza con vínculos en vuelo y preserva otros negocios y el historial financiero', async () => {
    const f = await fixture(store, String(Number(store) + 100));
    const before = await financialSnapshot(), otherBefore = await otherSnapshot(f);
    assert.ok(before.ventas.length && before.pagos.length && before.comprobantes.length && before.cuotas.length);
    let reached, release;
    const deletingLinks = new Promise(resolve => { reached = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    db.query = async (sql, params = []) => {
      const response = await originalQuery(sql, params);
      // Suspend the signed cleanup after its variant DELETE, before it can
      // delete the connection. A new link races exactly across that boundary.
      if (sql === 'DELETE FROM tiendanube_variantes WHERE store_id=$1' && params[0] === store) { reached(); await resume; }
      return response;
    };
    const raw = JSON.stringify({ store_id: store, ...(topic ? { event: topic, id: store } : {}) });
    const cleanup = fetch(origin + '/api/tiendanube' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-linkedstore-hmac-sha256': createHmac('sha256', process.env.TIENDANUBE_APP_SECRET).update(raw).digest('hex') }, body: raw });
    await deletingLinks;
    let completedLink;
    const link = fetch(origin + '/api/tiendanube/vinculos', { method: 'POST', headers: { Authorization: 'Bearer ' + firmarToken(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ negocio_id: f.a.id, producto_id: f.pa.id, product_id: '12', variant_id: '34' }) }).then(response => { completedLink = response; return response; });
    try {
      // Wait for the link either to finish (the former race) or to block on the
      // cleanup's row lock. No sleeps determine the asserted result.
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=$1 FOR UPDATE') AS blocked");
        if (completedLink || rows[0].blocked) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(observed, true, 'El vínculo debe alcanzar la operación concurrente');
    } finally { release(); }
    const cleaned = await cleanup, linked = await link;
    db.query = originalQuery;
    assert.equal(cleaned.status, 200, await cleaned.text());
    assert.equal(linked.status, 409, await linked.text());
    assert.equal(await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE negocio_id=?').get(f.a.id), undefined);
    assert.equal(await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE producto_id=?').get(f.pa.id), undefined);
    assert.equal(await db.prepare('SELECT producto_id FROM tiendanube_stock_outbox WHERE producto_id=?').get(f.pa.id), undefined);
    assert.deepEqual(await otherSnapshot(f), otherBefore);
    assert.deepEqual(await financialSnapshot(), before);
  });
}
