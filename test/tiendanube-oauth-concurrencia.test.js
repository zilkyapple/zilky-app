import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearVenta } from '../src/services/ventasService.js';
import { firmarToken } from '../src/lib/auth.js';
import { cifrarToken } from '../src/lib/tiendanube.js';
import { app } from '../src/app.js';

process.env.TIENDANUBE_APP_SECRET = 'oauth-concurrencia-local-only';
process.env.TIENDANUBE_TOKEN_KEY = '33'.repeat(32);
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch, originalQuery = db.query;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.startsWith(origin + '/')) return originalFetch(input, {...options, signal: AbortSignal.timeout(10000)});
  if (url === 'https://www.tiendanube.com/apps/authorize/token') {
    const {code} = JSON.parse(options.body);
    assert.match(code, /^store-\d+$/);
    return Response.json({user_id: code.slice(6), access_token: 'fake-' + code, scope: 'write_products,read_orders'});
  }
  if (/^https:\/\/api\.tiendanube\.com\/2025-03\/\d+\/products\/12\/variants\/34$/.test(url)) return Response.json({id: '34', product_id: '12'});
  throw new Error('Blocked unexpected outbound request: ' + url);
};
test.after(async () => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('OAuth: revalidar al administrador permite ventas y vínculos concurrentes sin bloquear sus claves foráneas', {timeout: 15000}, async () => {
  const admin = await crearUsuario({email: randomUUID() + '@oauth-lock.invalid', password_hash: 'unused'});
  const business = await crearNegocio({nombre: 'OAuth and sale locks ' + randomUUID()});
  const customer = await crearCliente({nombre: 'Cliente', apellido: 'QA', negocio_id: business.id});
  const product = await crearProducto({negocio_id: business.id, nombre: 'Product with concurrent sale', stock: 5});
  await db.prepare('INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes) VALUES(?,?,?,?,?)').run(business.id, '611', '51162', cifrarToken('fake-local-token'), 'write_products,read_orders');
  const started = await post(admin, '/iniciar', {negocio_id: business.id});
  assert.equal(started.status, 200);
  const state = new URL((await started.json()).url).searchParams.get('state');
  const saleStock = gate(), resumeSale = gate(), linkConnection = gate(), resumeLink = gate(), callbackUser = gate(), resumeCallback = gate();
  let heldConnection = false;
  db.query = async function(sql, params = []) {
    const result = await originalQuery(sql, params);
    // The real sale already changed stock and holds the product. Its next
    // history write references the same administrator being revalidated.
    if (sql === 'UPDATE productos SET stock = $1 WHERE id = $2' && params[1] === product.id) {saleStock.release(); await resumeSale.ready;}
    if (sql === 'SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=$1 FOR UPDATE' && params[0] === business.id && !heldConnection) {heldConnection = true; linkConnection.release(); await resumeLink.ready;}
    if (/^SELECT activo,rol FROM usuarios WHERE id=\$1 FOR (?:NO KEY )?UPDATE$/.test(sql) && params[0] === admin.id) {callbackUser.release(); await resumeCallback.ready;}
    return result;
  };
  let sale, link, callback;
  try {
    sale = crearVenta({negocio_id: business.id, cliente_id: customer.id, usuario_id: admin.id, solicitud_id: randomUUID(), modalidad: 'unico', items: [{producto_id: product.id, cantidad: 1, precio_unitario_centavos: 10000}], monto_total_centavos: 10000, entrega_inicial_centavos: 0, plan: {plazo_dias: 30}})
      .then(value => ({ok: true, value}), error => ({ok: false, code: error.code, message: error.message}));
    await saleStock.ready;
    link = post(admin, '/vinculos', {negocio_id: business.id, producto_id: product.id, product_id: '12', variant_id: '34'});
    await linkConnection.ready;
    callback = fetch(origin + '/api/tiendanube/oauth/callback?state=' + state + '&code=store-611');
    await callbackUser.ready;
    resumeLink.release(); resumeCallback.release();
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const {rows} = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
      if (rows[0].n >= 2) {blocked = true; break;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'La venta, vínculo y callback deben alcanzar la contención real');
    resumeSale.release();
    const sold = await sale, linked = await link, connected = await callback;
    assert.equal(sold.ok, true, JSON.stringify(sold));
    assert.equal(linked.status, 201, await linked.text());
    assert.equal(connected.status, 200, await connected.text());
    const snapshot = await db.prepare('SELECT p.stock,o.stock_deseado FROM productos p JOIN tiendanube_stock_outbox o ON o.producto_id=p.id WHERE p.id=?').get(product.id);
    assert.deepEqual(snapshot, {stock: 4, stock_deseado: 4});
  } finally {
    resumeSale.release(); resumeLink.release(); resumeCallback.release();
    await Promise.allSettled([sale, link, callback].filter(Boolean));
    db.query = originalQuery;
  }
});
function gate() {
  let release;
  const ready = new Promise(resolve => {release = resolve;});
  return {ready, release};
}
function post(user, path, body) {
  return fetch(origin + '/api/tiendanube' + path, {method: 'POST', headers: {
    Authorization: 'Bearer ' + firmarToken(user), 'Content-Type': 'application/json',
  }, body: JSON.stringify(body)});
}

test('OAuth: dos primeras autorizaciones no reemplazan una tienda que adquirió vínculos mientras esperaban', {timeout: 15000}, async () => {
  const firstAdmin = await crearUsuario({email: randomUUID() + '@oauth-race.invalid', password_hash: 'unused'});
  const secondAdmin = await crearUsuario({email: randomUUID() + '@oauth-race.invalid', password_hash: 'unused'});
  const business = await crearNegocio({nombre: 'Initial OAuth race ' + randomUUID()});
  const product = await crearProducto({negocio_id: business.id, nombre: 'First installation product', stock: 8});
  async function stateFor(admin) {
    const response = await post(admin, '/iniciar', {negocio_id: business.id});
    assert.equal(response.status, 200);
    return new URL((await response.json()).url).searchParams.get('state');
  }
  const firstState = await stateFor(firstAdmin), secondState = await stateFor(secondAdmin);
  const callback = (state, store) => fetch(origin + '/api/tiendanube/oauth/callback?state=' + state + '&code=store-' + store);
  const firstRead = gate(), releaseFirst = gate(), secondAttempt = gate(), secondHeld = gate(), releaseSecond = gate();
  let businessLocks = 0, connectionReads = 0, heldSecondRead = false;
  // Control transaction scheduling after real database reads. The first
  // callback observes the missing row. The second starts before it commits;
  // its write waits until a legitimate link has been added in between.
  db.query = async function(sql, params = []) {
    if (params[0] !== business.id) return originalQuery(sql, params);
    if (/^SELECT id FROM negocios WHERE id=\$1 FOR NO KEY UPDATE$/.test(sql)) {
      businessLocks++;
      if (businessLocks === 2) {
        secondAttempt.release();
        const result = await originalQuery(sql, params);
        secondHeld.release();
        await releaseSecond.ready;
        return result;
      }
    }
    if (/^SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=\$1 FOR UPDATE$/.test(sql)) {
      connectionReads++;
      const result = await originalQuery(sql, params);
      if (connectionReads === 1) {
        assert.equal(result.rows.length, 0);
        firstRead.release();
        await releaseFirst.ready;
      } else if (businessLocks < 2 && !heldSecondRead) {
        // On the original route there is no business lock. Both callbacks
        // can really read an absent connection before either inserts it.
        heldSecondRead = true;
        assert.equal(result.rows.length, 0);
        secondAttempt.release();
        secondHeld.release();
        await releaseSecond.ready;
      }
      return result;
    }
    return originalQuery(sql, params);
  };
  let secondPending;
  try {
    const firstPending = callback(firstState, '111');
    await firstRead.ready;
    secondPending = callback(secondState, '222');
    await secondAttempt.ready;
    releaseFirst.release();
    const first = await firstPending;
    assert.equal(first.status, 200, await first.text());
    await secondHeld.ready;
    const linked = await post(firstAdmin, '/vinculos', {negocio_id: business.id, producto_id: product.id, product_id: '12', variant_id: '34'});
    assert.equal(linked.status, 201, await linked.text());
    releaseSecond.release();
    const second = await secondPending;
    assert.equal(second.status, 409, 'La autorización que esperaba debe revalidar los vínculos creados por la primera');
    const mapping = await db.prepare(`SELECT c.store_id AS connection_store,v.store_id AS variant_store
      FROM tiendanube_conexiones c JOIN tiendanube_variantes v USING(negocio_id) WHERE v.producto_id=?`).get(product.id);
    assert.deepEqual(mapping, {connection_store: '111', variant_store: '111'});
  } finally {
    releaseFirst.release();
    releaseSecond.release();
    if (secondPending) await secondPending.catch(() => {});
    db.query = originalQuery;
  }
});
