import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { firmarToken } from '../src/lib/auth.js';
import { app } from '../src/app.js';

process.env.TIENDANUBE_APP_SECRET = 'tiendanube-vinculos-local-only';
process.env.TIENDANUBE_TOKEN_KEY = '22'.repeat(32);
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({email: randomUUID() + '@tiendanube-vinculos.invalid', password_hash: 'unused'});
const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
const headers = {Authorization: 'Bearer ' + firmarToken(admin), 'Content-Type': 'application/json'};
const pendingBarriers = new Set();
let nextVariantBarrier;

// Every provider response is mocked; unexpected outbound destinations fail.
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.startsWith(origin + '/')) return originalFetch(input, options);
  if (url === 'https://www.tiendanube.com/apps/authorize/token') {
    const {code} = JSON.parse(options.body);
    assert.match(code, /^store-\d+$/);
    return Response.json({user_id: code.slice(6), access_token: 'fake-' + code, scope: 'write_products,read_orders'});
  }
  const variant = url.match(/^https:\/\/api\.tiendanube\.com\/2025-03\/\d+\/products\/(\d+)\/variants\/(\d+)$/);
  if (variant) {
    const barrier = nextVariantBarrier;
    nextVariantBarrier = undefined;
    if (barrier) {
      barrier.reached();
      await barrier.released;
    }
    return Response.json({id: variant[2], product_id: variant[1]});
  }
  throw new Error('Blocked unexpected outbound request: ' + url);
};
test.after(async () => {
  for (const barrier of pendingBarriers) barrier.release();
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

function pauseNextVariant() {
  let signalReached, release;
  const reached = new Promise(resolve => {signalReached = resolve;});
  const released = new Promise(resolve => {release = resolve;});
  const barrier = {reached: signalReached, released, release};
  nextVariantBarrier = barrier;
  pendingBarriers.add(barrier);
  return {reached, release: () => {release(); pendingBarriers.delete(barrier);}};
}
function post(path, body) {
  return fetch(origin + '/api/tiendanube' + path, {method: 'POST', headers, body: JSON.stringify(body)});
}
async function connect(business, store) {
  const started = await post('/iniciar', {negocio_id: business.id});
  assert.equal(started.status, 200);
  const {url} = await started.json();
  const state = new URL(url).searchParams.get('state');
  const response = await fetch(origin + '/api/tiendanube/oauth/callback?state=' + state + '&code=store-' + store);
  assert.equal(response.status, 200, await response.text());
}
async function fixture(name, stock = 9) {
  const business = await crearNegocio({nombre: name + ' ' + randomUUID()});
  const product = await crearProducto({negocio_id: business.id, nombre: name + ' product', stock});
  return {business, product};
}
const link = (f, product, variant) => post('/vinculos', {negocio_id: f.business.id, producto_id: f.product.id, product_id: product, variant_id: variant});

test('Tiendanube: un vínculo pendiente no puede usar una conexión reemplazada ni bloquear otro negocio', async () => {
  const a = await fixture('Store race A'), b = await fixture('Store race B');
  await connect(a.business, '111');
  const barrier = pauseNextVariant();
  const delayedLink = link(a, '12', '34');
  try {
    await barrier.reached;
    await connect(a.business, '222');
    await connect(b.business, '111');
  } finally {barrier.release();}
  const linked = await delayedLink;
  assert.equal(linked.status, 409, 'Debe rechazar la conexión que cambió mientras validaba la variante');
  assert.equal(await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE producto_id=?').get(a.product.id), undefined);
  assert.equal(await db.prepare('SELECT producto_id FROM tiendanube_stock_outbox WHERE producto_id=?').get(a.product.id), undefined);
  const ownerLink = await link(b, '12', '34');
  assert.equal(ownerLink.status, 201, await ownerLink.text());
});

test('Tiendanube: el outbox inicial conserva el stock actual si cambia durante la validación externa', async () => {
  const f = await fixture('Stock race', 9);
  await connect(f.business, '333');
  const barrier = pauseNextVariant();
  const delayedLink = link(f, '56', '78');
  try {
    await barrier.reached;
    await db.prepare('UPDATE productos SET stock=? WHERE id=?').run(4, f.product.id);
    assert.equal(await db.prepare('SELECT producto_id FROM tiendanube_stock_outbox WHERE producto_id=?').get(f.product.id), undefined);
  } finally {barrier.release();}
  const linked = await delayedLink;
  assert.equal(linked.status, 201, await linked.text());
  const snapshot = await db.prepare(`SELECT p.stock,o.stock_deseado,o.version,o.estado
    FROM productos p JOIN tiendanube_stock_outbox o ON o.producto_id=p.id WHERE p.id=?`).get(f.product.id);
  assert.equal(snapshot.stock, 4);
  assert.equal(snapshot.stock_deseado, 4, 'El cambio previo al vínculo también debe quedar representado en la cola');
});
