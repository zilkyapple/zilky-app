import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.TIENDANUBE_APP_SECRET = 'secret-tiendanube-solo-local';
process.env.TIENDANUBE_TOKEN_KEY = 'ab'.repeat(32);
const { db, pool } = await import('../src/db/connection.js');
const { migrate } = await import('../src/db/migrate.js');
const { crearNegocio } = await import('../src/repositories/negocios.js');
const { crearUsuario, asignarNegocio } = await import('../src/repositories/usuarios.js');
const { firmarToken } = await import('../src/lib/auth.js');
const { app } = await import('../src/app.js');

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = 'http://127.0.0.1:' + server.address().port;
const realFetch = globalThis.fetch;
let exchange, exchanges = 0, fixtureStore = 1000;
globalThis.fetch = async (input, options) => {
  if (String(input).startsWith(base + '/')) return realFetch(input, options);
  assert.equal(String(input), 'https://www.tiendanube.com/apps/authorize/token', 'No se permite acceso a servicios externos');
  exchanges++;
  return exchange(input, options);
};
test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});
test.beforeEach(() => {
  exchanges = 0;
  const storeId = ++fixtureStore;
  exchange = async () => new Response(JSON.stringify({ user_id: storeId, access_token: 'token-sintetico-local', scope: 'write_products,read_orders' }), { status: 200 });
});

async function fixture() {
  const admin = await crearUsuario({ email: randomUUID() + '@oauth.invalid', password_hash: 'unused' });
  const owner = await crearUsuario({ email: randomUUID() + '@oauth.invalid', password_hash: 'unused' });
  const negocio = await crearNegocio({ nombre: 'OAuth QA ' + randomUUID() });
  return { admin, owner, negocio };
}
async function api(path, { user, method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(user ? { Authorization: 'Bearer ' + firmarToken(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function iniciar(f) {
  const response = await api('/api/tiendanube/iniciar', { user: f.admin, method: 'POST', body: { negocio_id: f.negocio.id } });
  assert.equal(response.status, 200);
  return new URL(response.data.url).searchParams.get('state');
}
const callback = state => api('/api/tiendanube/oauth/callback?state=' + state + '&code=synthetic-code');
async function desactivar(f) {
  assert.equal((await api('/api/usuarios/' + f.admin.id, { user: f.owner, method: 'PATCH', body: { activo: 0 } })).status, 200);
}

test('OAuth: una cuenta desactivada pierde el estado pendiente antes de intercambiar el código', async () => {
  const f = await fixture(), state = await iniciar(f);
  await desactivar(f);
  assert.equal((await api('/api/tiendanube/estado?negocio_id=' + f.negocio.id, { user: f.admin })).status, 401);
  assert.equal((await callback(state)).status, 403);
  assert.equal(exchanges, 0);
  assert.equal(await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(f.negocio.id), undefined);
  assert.equal((await callback(state)).status, 409);
});

test('OAuth: desactivar al administrador durante el intercambio impide persistir la conexión', async () => {
  const f = await fixture(), state = await iniciar(f);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  exchange = async () => {
    entered();
    await resume;
    return new Response(JSON.stringify({ user_id: 222, access_token: 'token-sintetico-local', scope: 'write_products,read_orders' }), { status: 200 });
  };
  const pending = callback(state);
  await started;
  try { await desactivar(f); } finally { release(); }
  assert.equal((await pending).status, 403);
  assert.equal(exchanges, 1);
  assert.equal(await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(f.negocio.id), undefined);
});

test('OAuth: perder el rol administrador revoca un estado emitido previamente', async () => {
  const f = await fixture(), state = await iniciar(f);
  // La API de empleados no permite cambiar roles; esta fixture local representa
  // un cambio de rol administrativo sin inventar un endpoint nuevo.
  await db.prepare("UPDATE usuarios SET rol='empleado' WHERE id=?").run(f.admin.id);
  assert.equal((await api('/api/tiendanube/estado?negocio_id=' + f.negocio.id, { user: f.admin })).status, 403);
  assert.equal((await callback(state)).status, 403);
  assert.equal(exchanges, 0);
  assert.equal(await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(f.negocio.id), undefined);
});

test('OAuth: conserva el negocio del estado, oculta el token y rechaza reutilización', async () => {
  const f = await fixture(), other = await crearNegocio({ nombre: 'Negocio ajeno ' + randomUUID() }), state = await iniciar(f);
  exchange = async () => new Response(JSON.stringify({ user_id: 333, access_token: 'token-sintetico-local', scope: 'write_products,read_orders' }), { status: 200 });
  const response = await api('/api/tiendanube/oauth/callback?state=' + state + '&code=synthetic-code&negocio_id=' + other.id);
  assert.equal(response.status, 200);
  assert.equal(String(response.data).includes('token-sintetico-local'), false);
  const view = await api('/api/tiendanube/estado?negocio_id=' + f.negocio.id, { user: f.admin });
  assert.equal(view.status, 200);
  assert.equal(view.data.conexion.store_id, '333');
  assert.equal(view.data.conexion.pausada, true);
  assert.equal(Object.hasOwn(view.data.conexion, 'token_cifrado'), false);
  assert.equal(await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(other.id), undefined);
  assert.equal((await callback(state)).status, 409);
});

test('Tiendanube: los empleados no administran la integración con permisos de tienda de ningún negocio', async () => {
  const f = await fixture(), other = await crearNegocio({ nombre: 'Negocio ajeno ' + randomUUID() });
  const employee = await crearUsuario({ email: randomUUID() + '@oauth.invalid', password_hash: 'unused', rol: 'empleado' });
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.editar': true, 'tienda.pedidos': true, 'productos.ver': true, 'empleados.gestionar': true });
  for (const n of [f.negocio, other]) {
    for (const [path, method, body] of [
      ['/api/tiendanube/estado?negocio_id=' + n.id, 'GET', undefined],
      ['/api/tiendanube/iniciar', 'POST', { negocio_id: n.id }],
      ['/api/tiendanube/vinculos', 'POST', { negocio_id: n.id, producto_id: 'unknown', product_id: '1', variant_id: '2' }],
      ['/api/tiendanube/pedidos/conciliar', 'POST', { negocio_id: n.id, order_id: '3' }],
    ]) {
      assert.equal((await api(path, { user: employee, method, body })).status, 403);
      assert.equal((await api(path, { method, body })).status, 401);
    }
  }
  assert.equal(exchanges, 0);
});

test('Tiendanube: los webhooks públicos siguen rechazando firmas incorrectas', async () => {
  for (const path of ['/webhook', '/privacy/store-redact', '/privacy/customer-redact', '/privacy/customer-data-request']) {
    const response = await fetch(base + '/api/tiendanube' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-linkedstore-hmac-sha256': '00'.repeat(32) },
      body: JSON.stringify({ store_id: 111, event: 'order/created', id: 42 }),
    });
    assert.equal(response.status, 401);
  }
  assert.equal(exchanges, 0);
});
