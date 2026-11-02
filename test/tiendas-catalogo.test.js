import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { tiendasSchema } from '../src/db/tiendasSchema.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { firmarToken } from '../src/lib/auth.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@catalogo-tienda.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'editor@catalogo-tienda.invalid', rol: 'empleado', password_hash: 'unused' });
const lector = await crearUsuario({ email: 'pedidos@catalogo-tienda.invalid', rol: 'empleado', password_hash: 'unused' });
const adminToken = firmarToken(admin), token = firmarToken(empleado), lectorToken = firmarToken(lector);
const a = await crearNegocio({ nombre: 'Apple QA' }), b = await crearNegocio({ nombre: 'Ropa QA' });
await asignarNegocio(empleado.id, a.id, { 'tienda.editar': true });
await asignarNegocio(lector.id, a.id, { 'tienda.pedidos': true });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
async function api(path, user = adminToken, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const path = (suffix = '', n = a) => `/tiendas${suffix}?negocio_id=${n.id}`;
const request = data => ({ solicitud_id: randomUUID(), negocio_id: a.id, ...data });
async function publicarConfig(n, slug, extra = {}) {
  const response = await api('/tiendas/config', adminToken, 'PUT', request({ negocio_id: n.id, habilitada: true, slug,
    nombre: n.nombre, descripcion: 'Catálogo público QA', tipo: n.id === a.id ? 'iphone' : 'ropa', whatsapp: '+54 (11) 5555-2222', secciones: ['Ofertas', 'Nuevos'], ...extra }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function crear(data, user = adminToken) {
  const response = await api('/tiendas/productos', user, 'POST', request(data));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
async function tablas() {
  return Object.fromEntries(await Promise.all(['productos', 'producto_historial', 'tienda_productos', 'tiendas_config', 'ventas', 'pagos'].map(async tabla => [tabla, await db.prepare(`SELECT * FROM ${tabla} ORDER BY ${tabla === 'tiendas_config' ? 'negocio_id' : 'id'}`).all()])));
}

test('Tienda: configuración por defecto deshabilitada; permisos de catálogo y pedidos no permiten habilitarla', async () => {
  const initial = await api(path(), token);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.config.habilitada, false);
  assert.equal(initial.body.estadisticas.productos, 0);
  assert.equal((await api(path(), lectorToken)).status, 200);
  assert.equal((await api('/tienda-publica/apple-qa', null)).status, 404);
  assert.equal((await api('/tiendas/config', token, 'PUT', request({ habilitada: true, slug: 'apple-qa' }))).status, 403);
  assert.equal((await api(path(), null)).status, 401);
  assert.equal((await api(path('', b), token)).status, 403);
  assert.equal((await api(path('/productos'), lectorToken)).status, 403);
});

test('Tienda: direcciones únicas, configuración acotada y deshabilitación inmediata del catálogo público', async () => {
  const r = await publicarConfig(a, 'apple-qa');
  assert.equal(r.config.whatsapp, '541155552222');
  assert.deepEqual(r.config.secciones, ['Ofertas', 'Nuevos']);
  const collision = await api('/tiendas/config', adminToken, 'PUT', request({ negocio_id: b.id, slug: 'APPLE-QA', habilitada: true }));
  assert.equal(collision.status, 409);
  for (const extra of [{ slug: '../otra' }, { whatsapp: 'javascript:alert(1)' }, { tipo: 'desconocido' }, { secciones: Array(41).fill('X') }, { creado_por: empleado.id }]) {
    const response = await api('/tiendas/config', adminToken, 'PUT', request(extra));
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  const body = request({ habilitada: false });
  assert.equal((await api('/tiendas/config', adminToken, 'PUT', body)).status, 200);
  assert.equal((await api('/tiendas/config', adminToken, 'PUT', body)).status, 200);
  assert.equal((await api('/tienda-publica/apple-qa', null)).status, 404);
  await publicarConfig(a, 'apple-qa');
});

test('Tienda: vincular inventario existente no duplica stock ni expone costos en el selector o la tienda pública', async () => {
  const p = await crearProducto({ negocio_id: a.id, nombre: 'iPhone 13 Pro', categoria: 'Nuevos', stock: 5, precio_contado_centavos: 15000000, costo_centavos: 9876543, imei: 'PRIVADO-IMEI-QA' });
  const before = await getProducto(p.id);
  const listing = await crear({ producto_id: p.id, publicado: true, modelos: ['iPhone 13 Pro'], precio_centavos: 14000000 });
  assert.notEqual(listing.id, p.id);
  assert.equal(listing.producto_id, p.id);
  assert.equal(listing.stock_disponible, 5);
  assert.equal(listing.version.length, 64);
  assert.deepEqual(await getProducto(p.id), before);
  const picker = await api(path('/catalogo'), token);
  assert.equal(picker.status, 200);
  assert.equal(picker.body.find(x => x.id === p.id).stock, 5);
  assert.doesNotMatch(JSON.stringify(picker.body), /costo_centavos|PRIVADO-IMEI/);
  const publica = await api('/tienda-publica/apple-qa', null);
  assert.equal(publica.status, 200, JSON.stringify(publica.body));
  assert.equal(publica.body.tienda.slug, 'apple-qa');
  const visible = publica.body.productos.find(x => x.id === listing.id);
  assert.equal(visible.precio_centavos, 14000000);
  assert.deepEqual(visible.modelos, ['iPhone 13 Pro']);
  assert.doesNotMatch(JSON.stringify(publica.body), /producto_id|negocio_id|costo_centavos|PRIVADO-IMEI|usuario_id/);
  const duplicate = await api('/tiendas/productos', token, 'POST', request({ producto_id: p.id }));
  assert.equal(duplicate.status, 409);
  const foreign = await crearProducto({ negocio_id: b.id, nombre: 'Ajeno QA', stock: 8 });
  assert.equal((await api('/tiendas/productos', token, 'POST', request({ producto_id: foreign.id }))).status, 404);
});

test('Tienda: empleados pueden asignar stock inicial a un producto nuevo y no alterar existencias; reintentos no duplican inventario', async () => {
  const body = request({ nombre: 'iPhone 14 QA', precio_centavos: 10000000, modelos: ['iPhone 14'], categoria: 'Ofertas' });
  const [one, two] = await Promise.all([api('/tiendas/productos', token, 'POST', body), api('/tiendas/productos', token, 'POST', body)]);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(two.status, 201, JSON.stringify(two.body));
  assert.equal(one.body.id, two.body.id);
  assert.equal(one.body.producto_id, two.body.producto_id);
  assert.equal((await getProducto(one.body.producto_id)).stock, 0);
  assert.equal(one.body.publicado, false);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM producto_historial WHERE producto_id=?').get(one.body.producto_id)).cantidad, 1);
  assert.equal((await api('/tiendas/productos', token, 'POST', { ...body, nombre: 'Diferente' })).status, 409);
  const nuevoEmpleado = await crear({ nombre: 'Stock inicial delegado', precio_centavos: 100, stock: 3 }, token);
  assert.equal((await getProducto(nuevoEmpleado.producto_id)).stock, 3);
  assert.equal((await api('/tiendas/productos', token, 'POST', request({ producto_id: one.body.producto_id, stock: 50 }))).status, 400);
  const adminListing = await crear({ nombre: 'Producto inicial dueño', precio_centavos: 50000, stock: 7 });
  assert.equal((await getProducto(adminListing.producto_id)).stock, 7);
});

test('Tienda: edición sólo cambia listado, exige versión y conserva inventario y finanzas; retries no repiten el cambio', async () => {
  const listing = await crear({ nombre: 'Modelo edición QA', precio_centavos: 20000, stock: 3, publicado: true });
  const coreBefore = await getProducto(listing.producto_id);
  const body = request({ version: listing.version, nombre: 'Modelo editado', precio_centavos: 25000, modelos: ['iPhone 13', 'iPhone 13 Pro'], publicado: false });
  const response = await api(path('/productos/' + listing.id), token, 'PUT', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.nombre, 'Modelo editado');
  assert.equal(response.body.precio_centavos, 25000);
  assert.notEqual(response.body.version, listing.version);
  assert.deepEqual(await getProducto(listing.producto_id), coreBefore);
  assert.equal((await api(path('/productos/' + listing.id), token, 'PUT', body)).status, 200);
  assert.equal((await api(path('/productos/' + listing.id), token, 'PUT', { ...body, nombre: 'Otra edición' })).status, 409);
  assert.equal((await api(path('/productos/' + listing.id), token, 'PUT', { ...body, solicitud_id: randomUUID() })).status, 409);
  const before = await tablas();
  for (const extra of [{ stock: 999 }, { producto_id: randomUUID() }, { costo_centavos: 1 }, { nombre: '' }, { modelos: 'iPhone 13' }, { precio_centavos: -1 }, { precio_centavos: 2147483648 }]) {
    const r = await api(path('/productos/' + listing.id), token, 'PUT', request({ version: response.body.version, ...extra }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal((await api(path('/productos/' + listing.id, b), token, 'PUT', { ...body, negocio_id: b.id })).status, 403);
  assert.deepEqual(await tablas(), before);
  const publica = await api('/tienda-publica/apple-qa', null);
  assert.ok(!publica.body.productos.some(p => p.id === listing.id), 'El borrador deja de mostrarse al instante');
});

test('Tienda: el stock público se actualiza con inventario, limita negativos a cero y calcula disponibilidad de combos', async () => {
  const p = await crearProducto({ negocio_id: a.id, nombre: 'Stock libre QA', stock: null, costo_centavos: 200 });
  const listing = await crear({ producto_id: p.id, precio_centavos: 10000, publicado: true });
  let publica = (await api('/tienda-publica/apple-qa', null)).body;
  assert.equal(publica.productos.find(x => x.id === listing.id).stock_disponible, null);
  assert.equal(publica.productos.find(x => x.id === listing.id).disponible, true);
  await db.prepare('UPDATE productos SET stock=-5 WHERE id=?').run(p.id);
  publica = (await api('/tienda-publica/apple-qa', null)).body;
  assert.equal(publica.productos.find(x => x.id === listing.id).stock_disponible, 0);
  assert.equal(publica.productos.find(x => x.id === listing.id).disponible, false);
  const component = await crearProducto({ negocio_id: a.id, nombre: 'Componente QA', stock: 5 });
  const combo = await crearProducto({ negocio_id: a.id, nombre: 'Combo QA' });
  await db.prepare('INSERT INTO producto_combo_componentes(combo_id,producto_id,cantidad) VALUES(?,?,?)').run(combo.id, component.id, 2);
  const comboListing = await crear({ producto_id: combo.id, precio_centavos: 10000, publicado: true });
  publica = (await api('/tienda-publica/apple-qa', null)).body;
  assert.equal(publica.productos.find(x => x.id === comboListing.id).stock_disponible, 2);
  await db.prepare('UPDATE productos SET stock=1 WHERE id=?').run(component.id);
  publica = (await api('/tienda-publica/apple-qa', null)).body;
  assert.equal(publica.productos.find(x => x.id === comboListing.id).disponible, false);
});

test('Tienda: migración aditiva repetible conserva productos, inventario, publicaciones y configuración', async () => {
  const before = await tablas();
  await db.transaction(() => db.exec(tiendasSchema));
  await db.transaction(() => db.exec(tiendasSchema));
  assert.deepEqual(await tablas(), before);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM ventas').get()).cantidad, 0);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM pagos').get()).cantidad, 0);
});
