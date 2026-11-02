import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { firmarToken } from '../src/lib/auth.js';
import { crearPedidoPublico, detallePedidoTienda, confirmarPedidoTienda, cancelarPedidoTienda } from '../src/services/tiendaPedidosService.js';
import { registrarCobroPedido } from '../src/services/tiendaCobrosService.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'encargos-admin@qa.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'encargos-empleado@qa.invalid', password_hash: 'unused', rol: 'empleado' });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(r => server.close(r)); await pool.end(); });

async function api(url, { usuario = admin, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method,
    headers: { ...(usuario ? { Authorization: 'Bearer ' + firmarToken(usuario) } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
async function fixture({ stock = 0 } = {}) {
  const n = await crearNegocio({ nombre: 'Encargos QA ' + randomUUID().slice(0, 6), mora_valor: 0 });
  const producto = await crearProducto({ negocio_id: n.id, nombre: 'Funda original', stock });
  const webId = randomUUID(), slug = 'encargo-' + randomUUID().slice(0, 8);
  await pool.query('INSERT INTO tiendas_config(negocio_id,slug,habilitada,nombre) VALUES($1,$2,TRUE,$3)', [n.id, slug, 'Fundas QA']);
  await pool.query(`INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,publicado,precio_centavos,modelos,talle,color)
    VALUES($1,$2,$3,$4,TRUE,25000,$5::jsonb,$6,$7)`, [webId, n.id, producto.id, 'Funda de silicona', JSON.stringify(['iPhone 13', 'iPhone 14']), 'Único', 'Negro']);
  return { n, producto, webId, slug };
}
function body(f, extra = {}) {
  return { solicitud_id: randomUUID(), contacto: { nombre: 'Ana', apellido: 'Encargo', telefono: '+5491112345678', email: '' },
    items: [{ producto_id: f.webId, cantidad: 2, es_encargo: true }], total_esperado_centavos: 50000, acepta_contacto: true, ...extra };
}
async function stock(p) { return (await pool.query('SELECT stock FROM productos WHERE id=$1', [p.id])).rows[0].stock; }
async function pedido(f, input = body(f)) { return crearPedidoPublico(f.slug, input); }
async function detalle(f, p) { return detallePedidoTienda(f.n.id, p.id); }
function accion(f, version, extra = {}) { return { negocio_id: f.n.id, solicitud_id: randomUUID(), version, ...extra }; }
async function confirmar(f, p, version) { return confirmarPedidoTienda(f.n.id, p.id, accion(f, version || (await detalle(f, p)).version), admin.id); }
async function cancelar(f, p, version, solicitud_id = randomUUID()) { return cancelarPedidoTienda(f.n.id, p.id,
  { ...accion(f, version || (await detalle(f, p)).version), solicitud_id, motivo: 'QA cancelar encargo' }, admin.id); }
async function snapshot(tablas) { return Object.fromEntries(await Promise.all(tablas.map(async t => [t, (await pool.query(`SELECT * FROM ${t} ORDER BY ${t === 'saldo_favor' ? 'cliente_id,negocio_id' : 'id'}`)).rows]))); }

test('Encargos: sin stock sólo se recibe el item marcado explícitamente y el checkout no mueve inventario ni dinero', async () => {
  const f = await fixture(), input = body(f);
  const tablas = ['productos', 'producto_historial', 'ventas', 'creditos', 'cuotas', 'pagos', 'comprobantes', 'caja_asientos'];
  const antes = await snapshot(tablas);
  for (const item of [{ producto_id: f.webId, cantidad: 2 }, { producto_id: f.webId, cantidad: 2, es_encargo: false }]) {
    const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: { ...input, solicitud_id: randomUUID(), items: [item] } });
    assert.equal(r.status, 409);
  }
  const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: input });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.estado, 'pendiente');
  assert.equal(r.body.items[0].es_encargo, true); assert.equal(r.body.total_centavos, 50000);
  assert.doesNotMatch(JSON.stringify(r.body), /contacto|telefono|cobros|comprobante|cliente_id/);
  assert.deepEqual(await snapshot(tablas), antes);
  const v = await detalle(f, r.body);
  assert.equal(v.has_encargos, true); assert.equal(v.pedido.has_encargos, true);
  assert.equal(v.stock[0].insuficiente, true); assert.equal(v.resumen_cobros.cobrado_centavos, 0);
});

test('Encargos: variantes quedan congeladas y el reintento exacto conserva flag, precio y opciones originales', async () => {
  const f = await fixture(), input = body(f), p = await pedido(f, input);
  const opciones = { modelos: ['iPhone 13', 'iPhone 14'], talle: 'Único', color: 'Negro' };
  assert.deepEqual((await detalle(f, p)).items[0].opciones, opciones);
  await pool.query("UPDATE tienda_productos SET nombre='Otra funda',modelos='[\"iPhone 17\"]'::jsonb,talle='XL',color='Azul',precio_centavos=99999 WHERE id=$1", [f.webId]);
  await pool.query('UPDATE productos SET stock=7 WHERE id=$1', [f.producto.id]);
  assert.deepEqual(await pedido(f, input), p);
  const v = await detalle(f, p);
  assert.equal(v.items[0].nombre, 'Funda de silicona'); assert.equal(v.items[0].precio_unitario_centavos, 25000);
  assert.deepEqual(v.items[0].opciones, opciones);
  await assert.rejects(() => pedido(f, { ...input, items: [{ ...input.items[0], es_encargo: false }] }), e => e.status === 409);
});

test('Encargos: rechaza flags y opciones del cliente inválidos sin convertir silenciosamente un pedido normal', async () => {
  const f = await fixture({ stock: 4 }), input = body(f);
  for (const es_encargo of ['true', 1, null, {}, []]) {
    const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: { ...input, solicitud_id: randomUUID(), items: [{ ...input.items[0], es_encargo }] } });
    assert.equal(r.status, 400);
  }
  const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: { ...input, items: [{ producto_id: f.webId, cantidad: 2, opciones: { color: 'Otro' } }] } });
  assert.equal(r.status, 400);
  const normal = await pedido(f, { ...input, solicitud_id: randomUUID(), items: [{ producto_id: f.webId, cantidad: 2 }] });
  assert.equal(normal.items[0].es_encargo, false);
  assert.equal((await detalle(f, normal)).has_encargos, false);
});

test('Encargos: un carrito mixto sigue exigiendo stock para todos los renglones normales', async () => {
  const f = await fixture(), normal = await crearProducto({ negocio_id: f.n.id, nombre: 'Cable disponible', stock: 1 });
  const web = randomUUID();
  await pool.query('INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,publicado,precio_centavos) VALUES($1,$2,$3,$4,TRUE,10000)', [web, f.n.id, normal.id, 'Cable']);
  const input = body(f, { items: [{ producto_id: f.webId, cantidad: 2, es_encargo: true }, { producto_id: web, cantidad: 2 }], total_esperado_centavos: 70000 });
  await assert.rejects(() => pedido(f, input), e => e.status === 409);
  const p = await pedido(f, { ...input, solicitud_id: randomUUID(), items: [{ ...input.items[0] }, { producto_id: web, cantidad: 1 }], total_esperado_centavos: 60000 });
  assert.deepEqual((await detalle(f, p)).items.map(i => i.es_encargo).sort(), [false, true]);
  assert.equal(await stock(f.producto), 0); assert.equal(await stock(normal), 1);
});

test('Encargos: confirmar espera stock real para TODO el pedido y descuenta una sola vez al conseguirlo', async () => {
  const f = await fixture(), p = await pedido(f), v = await detalle(f, p);
  const antes = await snapshot(['productos', 'tienda_pedidos', 'producto_historial', 'pagos']);
  await assert.rejects(() => confirmar(f, p, v.version), e => e.status === 409);
  assert.deepEqual(await snapshot(['productos', 'tienda_pedidos', 'producto_historial', 'pagos']), antes);
  await pool.query('UPDATE productos SET stock=3 WHERE id=$1', [f.producto.id]);
  await assert.rejects(() => confirmar(f, p, v.version), e => e.status === 409, 'El cambio de stock también invalida la revisión anterior');
  const lista = await detalle(f, p), solicitud = accion(f, lista.version);
  const [a, b] = await Promise.all([confirmarPedidoTienda(f.n.id, p.id, solicitud, admin.id), confirmarPedidoTienda(f.n.id, p.id, solicitud, admin.id)]);
  assert.equal(a.pedido.estado, 'confirmado'); assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); assert.equal(await stock(f.producto), 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM producto_historial WHERE producto_id=$1 AND tipo='pedido_web'", [f.producto.id])).rows[0].n, 1);
  assert.equal(a.resumen_cobros.estado, 'sin_cobrar'); assert.equal(a.resumen_cobros.cobrado_centavos, 0);
});

test('Encargos: componentes compartidos con renglones normales se validan por separado al pedir y juntos al confirmar', async () => {
  const f = await fixture({ stock: null }), pieza = await crearProducto({ negocio_id: f.n.id, nombre: 'Pieza', stock: 2 });
  const webNormal = randomUUID();
  await pool.query('INSERT INTO producto_combo_componentes(combo_id,producto_id,cantidad) VALUES($1,$2,2)', [f.producto.id, pieza.id]);
  await pool.query('INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,publicado,precio_centavos) VALUES($1,$2,$3,$4,TRUE,10000)', [webNormal, f.n.id, pieza.id, 'Pieza suelta']);
  const p = await pedido(f, body(f, { items: [{ producto_id: f.webId, cantidad: 5, es_encargo: true }, { producto_id: webNormal, cantidad: 2 }], total_esperado_centavos: 145000 }));
  assert.equal(await stock(pieza), 2);
  await assert.rejects(() => confirmar(f, p), e => e.status === 409);
  await pool.query('UPDATE productos SET stock=12 WHERE id=$1', [pieza.id]);
  const confirmado = await confirmar(f, p);
  assert.equal(await stock(pieza), 0); assert.equal(confirmado.pedido.stock_movimientos[0].cantidad, 12);
  await cancelar(f, p); assert.equal(await stock(pieza), 12); assert.equal(await stock(f.producto), null);
});

test('Encargos: permite solicitar existencias negativas explícitamente y conserva stock sin control', async () => {
  const f = await fixture({ stock: -2 }), p = await pedido(f);
  assert.equal(p.items[0].es_encargo, true); assert.equal(await stock(f.producto), -2);
  await assert.rejects(() => confirmar(f, p), e => e.status === 409);
  const libre = await fixture({ stock: null }), encargo = await pedido(libre);
  await confirmar(libre, encargo); assert.equal(await stock(libre.producto), null);
  await pool.query('UPDATE productos SET stock=9 WHERE id=$1', [libre.producto.id]);
  await cancelar(libre, encargo); assert.equal(await stock(libre.producto), 9);
});

test('Encargos: listado normal incluye todos, filtro true sólo encargos y la segmentación respeta negocio/permisos', async () => {
  const a = await fixture({ stock: 4 }), b = await fixture();
  const encargo = await pedido(a), normal = await pedido(a, body(a, { items: [{ producto_id: a.webId, cantidad: 1 }], total_esperado_centavos: 25000 }));
  const ajeno = await pedido(b);
  await asignarNegocio(empleado.id, a.n.id, { 'tienda.pedidos': true });
  const url = `/tiendas/pedidos?negocio_id=${a.n.id}`;
  const todos = await api(url, { usuario: empleado }); assert.equal(todos.status, 200);
  assert.deepEqual(todos.body.map(p => p.id).sort(), [normal.id, encargo.id].sort());
  const solo = await api(url + '&encargos=true', { usuario: empleado }); assert.equal(solo.status, 200);
  assert.deepEqual(solo.body.map(p => [p.id, p.has_encargos]), [[encargo.id, true]]);
  const normales = await api(url + '&encargos=false', { usuario: empleado }); assert.deepEqual(normales.body.map(p => p.id), [normal.id]);
  assert.equal((await api(url + '&encargos=1', { usuario: empleado })).status, 400);
  assert.equal((await api(`/tiendas/pedidos?negocio_id=${b.n.id}&encargos=true`, { usuario: empleado })).status, 403);
  assert.equal((await api(`/tiendas/pedidos/${ajeno.id}?negocio_id=${a.n.id}`, { usuario: empleado })).status, 404);
});

test('Encargos: cancelar pendiente no descuenta ni repone y un carrito con precios cambiados sigue protegido', async () => {
  const f = await fixture(), input = body(f), p = await pedido(f, input);
  const sinStock = await stock(f.producto), v = await detalle(f, p);
  assert.equal((await cancelar(f, p, v.version)).pedido.estado, 'cancelado'); assert.equal(await stock(f.producto), sinStock);
  assert.equal((await pool.query('SELECT count(*)::int n FROM producto_historial WHERE producto_id=$1', [f.producto.id])).rows[0].n, 0);
  await pool.query('UPDATE tienda_productos SET precio_centavos=30000 WHERE id=$1', [f.webId]);
  await assert.rejects(() => pedido(f, { ...input, solicitud_id: randomUUID() }), e => e.status === 409 && /precios cambiaron/.test(e.message));
  assert.deepEqual(await pedido(f, input), p);
});

test('Encargos: cobros canónicos invalidan versiones anteriores y cancelar conserva dinero real y comprobantes', async () => {
  const f = await fixture({ stock: 4 }), p = await pedido(f);
  await confirmar(f, p);
  const sinCobros = await detalle(f, p);
  const pagado = await registrarCobroPedido(f.n.id, p.id, { ...accion(f, sinCobros.version), monto_centavos: 10000, medio_pago: 'efectivo' }, admin.id);
  assert.equal(pagado.resumen_cobros.cobrado_centavos, 10000); assert.equal(pagado.resumen_cobros.saldo_centavos, 40000);
  await assert.rejects(() => cancelar(f, p, sinCobros.version), e => e.status === 409);
  const versionPago = pagado.version;
  await pool.query('UPDATE pagos SET nota=$1 WHERE id=$2', ['Nota corregida, mismo dinero', pagado.cobros[0].pago_id]);
  await assert.rejects(() => cancelar(f, p, versionPago), e => e.status === 409, 'La versión incluye filas canónicas, no solamente el total cobrado');
  const financieros = await snapshot(['pagos', 'comprobantes', 'caja_asientos', 'saldo_favor']);
  const vista = await detalle(f, p), solicitud_id = randomUUID();
  const [a, b] = await Promise.all([cancelar(f, p, vista.version, solicitud_id), cancelar(f, p, vista.version, solicitud_id)]);
  assert.equal(a.pedido.estado, 'cancelado'); assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); assert.equal(await stock(f.producto), 4);
  assert.equal(a.resumen_cobros.cobrado_centavos, 10000); assert.equal(a.cobros[0].anulado, 0); assert.equal(a.cobros[0].comprobante.estado, 'emitido');
  assert.deepEqual(await snapshot(['pagos', 'comprobantes', 'caja_asientos', 'saldo_favor']), financieros);
  await assert.rejects(() => cancelar(f, p), e => e.status === 409);
});
