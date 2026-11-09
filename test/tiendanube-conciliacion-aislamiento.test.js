import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.TIENDANUBE_APP_SECRET = 'tiendanube-conciliacion-local';
process.env.TIENDANUBE_TOKEN_KEY = 'cd'.repeat(32);
const { db, pool } = await import('../src/db/connection.js');
const { migrate } = await import('../src/db/migrate.js');
const { crearNegocio } = await import('../src/repositories/negocios.js');
const { crearUsuario } = await import('../src/repositories/usuarios.js');
const { firmarToken } = await import('../src/lib/auth.js');
const { cifrarToken } = await import('../src/lib/tiendanube.js');
const { app } = await import('../src/app.js');
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: randomUUID() + '@conciliar.invalid', password_hash: 'unused' });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = 'http://127.0.0.1:' + server.address().port;
const originalFetch = globalThis.fetch;
let quantity = 1, pendingOrder;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith(origin + '/')) return originalFetch(input, options);
  if (url === 'https://www.tiendanube.com/apps/authorize/token') {
    const { code } = JSON.parse(options.body);
    assert.match(code, /^store-\d+$/);
    return Response.json({ user_id: code.slice(6), access_token: 'synthetic-local-token', scope: 'write_products,read_orders' });
  }
  const match = url.match(/^https:\/\/api\.tiendanube\.com\/2025-03\/\d+\/orders\/(\d+)$/);
  assert.ok(match, 'No se permiten solicitudes externas: ' + url);
  const pause = pendingOrder;
  pendingOrder = undefined;
  if (pause) { pause.entered(); await pause.wait; }
  return Response.json({ id: match[1], status: 'open', payment_status: 'pending', products: [{ variant_id: 99, quantity }] });
};
test.after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});
test.beforeEach(() => { quantity = 1; pendingOrder = undefined; });
async function post(path, body) {
  const r = await fetch(origin + '/api/tiendanube' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + firmarToken(admin), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function fixture(store) {
  const a = await crearNegocio({ nombre: 'Conciliación A ' + randomUUID() });
  const b = await crearNegocio({ nombre: 'Conciliación B ' + randomUUID() });
  await db.prepare('INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes) VALUES(?,?,?,?,?)').run(a.id, store, '51162', cifrarToken('synthetic-local-token'), 'write_products,read_orders');
  return { a, b };
}
async function connect(n, store) {
  const start = await post('/iniciar', { negocio_id: n.id });
  assert.equal(start.status, 200);
  const state = new URL(start.data.url).searchParams.get('state');
  const response = await fetch(origin + '/api/tiendanube/oauth/callback?state=' + state + '&code=store-' + store);
  return { status: response.status, body: await response.text() };
}
const conciliar = n => post('/pedidos/conciliar', { negocio_id: n.id, order_id: '1' });
const snapshot = store => db.prepare('SELECT * FROM tiendanube_pedidos WHERE store_id=? AND order_id=?').get(store, '1');

test('Conciliación: cambiar de tienda conserva los pedidos y exige resolver el historial existente', async () => {
  const { a } = await fixture('101');
  assert.equal((await conciliar(a)).status, 200);
  const before = await snapshot('101');
  const switched = await connect(a, '202');
  assert.equal(switched.status, 409, 'No debe dejar pedidos de la tienda anterior asociados a un negocio reconectado');
  assert.equal((await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(a.id)).store_id, '101');
  assert.deepEqual(await snapshot('101'), before);
  quantity = 2;
  const next = await conciliar(a);
  assert.equal(next.status, 200);
  assert.deepEqual(next.data.comparacion.delta, { '99': 1 });
});

test('Conciliación: un snapshot legado de otro negocio se rechaza sin revelarlo ni sobrescribirlo', async () => {
  const { a, b } = await fixture('303');
  assert.equal((await conciliar(a)).status, 200);
  const before = await snapshot('303');
  // Representa el estado inconsistente que podía dejar la versión anterior.
  await db.prepare('DELETE FROM tiendanube_conexiones WHERE negocio_id=?').run(a.id);
  assert.equal((await connect(b, '303')).status, 200);
  quantity = 2;
  const next = await conciliar(b);
  assert.equal(next.status, 409);
  assert.equal(Object.hasOwn(next.data, 'pedido'), false);
  assert.equal(Object.hasOwn(next.data, 'comparacion'), false);
  assert.deepEqual(await snapshot('303'), before);
});

test('Conciliación: una respuesta demorada no crea pedidos para una conexión reemplazada', async () => {
  const { a, b } = await fixture('404');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  pendingOrder = { entered, wait: new Promise(resolve => { release = resolve; }) };
  const pending = conciliar(a);
  await started;
  try {
    assert.equal((await connect(a, '505')).status, 200);
    assert.equal((await connect(b, '404')).status, 200);
  } finally { release(); }
  assert.equal((await pending).status, 409);
  assert.equal(await snapshot('404'), undefined);
  const current = await conciliar(b);
  assert.equal(current.status, 200);
  assert.deepEqual(current.data.comparacion.delta, { '99': 1 });
  assert.equal((await snapshot('404')).negocio_id, b.id);
});
