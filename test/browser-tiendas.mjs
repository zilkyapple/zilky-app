// Datos ficticios, PostgreSQL descartable y navegador sin acceso a sitios externos.
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { guardarConfigTienda, crearProductoTienda } from '../src/services/tiendasService.js';
import { crearPedidoPublico } from '../src/services/tiendaPedidosService.js';
import { todayAR, addDays } from '../src/lib/dates.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const output = process.env.BROWSER_ARTIFACTS || '/tmp/zilky-tiendas-browser';
await fs.mkdir(output, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=', 'base64');
// MP4 H.264 real de medio segundo, generado para esta prueba; no usa ffmpeg en CI.
const video = gunzipSync(Buffer.from('H4sIAAAAAAACA61UTWzcRBSeTdIq9Ie2IpEARWKACC7JxvYumx9kKZsoYlGL4NIipErWeDxeuzv+yXiSeHuAIAKqxLFSET1EXKpCqVCFED0BPYDEz6E3RCQuqAVRKn4ULrmQ5Y13t+sEyAlrx/PevO97P/OeFyGEXdmM/SQKEOpDaodlkGWqB3FZR6j/2yCKlhFCPFj2HLTj6f8ZOIOogNSv9xR2onbrs2jPpw/8FqQgDZBPy0YWs/+f3iAu2jvOv8Z9B1aaqaPMkQnsI4wnssdQfgc63L5m4PgEBBw4u2s3YD2MTn6eKeOew0XXsuw7LI88BXpUI6HDmcL0jQZ+6IIwtBxkTvNpjjpt24gjmJsr49CS4LgtF24n0uYg30hk4uQw11TT/uMqVOEpqsFe6yKGTwC+ohf16aKu6Zj7dmpUyjnGg60WvCuAmi846GDrB/RQHfarG3NrL58emFVdgdeh1744wFYLaL9399Y3j934a2tLcY/GJIk7eag1ZEvRueTJC13/icwa0M33cNZ7wEJd+XO1UtrDHm6fDXTsB9BO/V4j/w/7CORCd+XSiY9qYDubuy+V/y+q9g6mu4ZhHdlDh3pp1IsxsB92suRINXgvBSzb1fNofshgMAWJY55v8ZjfnuTR92QUZUNEMnJWFHTbhW5PQrNLoA66gsGU9l8KAASJf7B/X6t15fuFO5/8tFG7fmHsO7zx+G+/q4nA45hGgmEdRFHStSlc0pk+7U6DoVYEwMRzLyw8M17G1VPzgHQYBcN8FDc5cyU2NK00bmhGCQ49KeOZiYmVlZWi+kYiTsJiJOoTKkrRkwEHTBRLPwqTGUyJTaipY/gOzBJ2mM0j2jD1GW1GwyQkvJkwU0tLM1qq6yUcMNNjKU6WbJAmcZw0gQpvSzimXtSABC8c+ClzLOVRB4YlSFhnpl7B1BNRQCyg6lgKxrmfgDSVTjlUgkAXA1ODFIhzNgqZaehjuo5dkkgrThp+rBBtB4uxFbluwqQ5bmDpCWAkZhnzKGoQDxSre6bjhPuU9Q40HIosBvUDIlUefiiZ4ARAcG7zJUGaFo2CmEjQKVwR/EX6IbgAoCAK4woSsAQuy7biJsi+YxogE4fEqgrbsn2iIsHksKyuFebXPWmDFMUstOpRDNb2YQzUBmuCb9N4SuuIFvxxgYoTykJGl6RZ1nAWXV2pYIkHdEGte+Uqu6AmFS4O4PtnqixQTKNU1PCiKsbUihUQY+U420lqVqZBSCSL4eb8GJoEAwE9BF9kEfqvuolWYYLL7Nwaerq1fev9raFPm08+8eH5zbmP6PM3h97imw9Mjlw7eeTmlR/DP9jHx49voi/RvtuP/CrfVH+l1YujfP6V7ctr6E/l577q+lz6egudf1UphXUi5z5DX622FXpGKcpyrHrRe/bdqvf2icF6a3v9aP91ODxYXX9j4djYRI99SXYJoFw+03UF7KvA5sB+sbU9NXv/uTb764XhPPtOPvbdNvtvMzCxbqMHAAA=', 'base64'));
const results = [], errors = [], captures = [], requests = [], external = [], rejectedResponses = [];
let browser, server, owner, publicPage, employeePage, failed;
const check = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { results.push({ name, passed: false, error: error.message }); throw error; } };
const financialTables = ['ventas', 'creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'comision_acuerdos', 'comision_generaciones', 'comision_eventos'];
const snapshot = async () => Object.fromEntries(await Promise.all(financialTables.map(async tabla => [tabla, await db.prepare(`SELECT * FROM ${tabla} ORDER BY id`).all()])));

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password = 'solo-qa-tienda-browser-123', password_hash = await bcrypt.hash(password, 10);
  const admin = await crearUsuario({ email: 'jefe@tienda-browser.invalid', nombre: 'Dueño ficticio QA', password_hash });
  const staff = await crearUsuario({ email: 'editor@tienda-browser.invalid', nombre: 'Empleado ficticio QA', rol: 'empleado', password_hash });
  const apple = await crearNegocio({ nombre: 'Apple tienda ficticia QA', mora_valor: 0 });
  const ropa = await crearNegocio({ nombre: 'Ropa tienda ficticia QA', mora_valor: 0 });
  await asignarNegocio(staff.id, apple.id, { 'tienda.editar': true });
  const core = await crearProducto({ negocio_id: apple.id, nombre: 'Funda premium iPhone 13 Pro QA', categoria: 'Fundas', stock: 8, precio_contado_centavos: 2500000, costo_centavos: 1357911 });
  const core13 = await crearProducto({ negocio_id: apple.id, nombre: 'Funda iPhone 13 QA', categoria: 'Fundas', stock: 4, precio_contado_centavos: 1000000 });
  const jean = await crearProducto({ negocio_id: ropa.id, nombre: 'Jean azul QA', categoria: 'Jean', stock: 5, precio_contado_centavos: 6000000 });
  const remera = await crearProducto({ negocio_id: ropa.id, nombre: 'Remera negra QA', categoria: 'Remeras', stock: 10, precio_contado_centavos: 2000000 });
  const createListing = (n, p, extra = {}) => crearProductoTienda(n.id, { negocio_id: n.id, producto_id: p.id, publicado: true, precio_centavos: p.precio_contado_centavos, solicitud_id: randomUUID(), ...extra }, admin.id);
  const p13 = await createListing(apple, core13, { modelos: ['iPhone 13'] });
  const jeanWeb = await createListing(ropa, jean, { talle: '42', color: 'Azul' });
  await createListing(ropa, remera, { talle: 'M', color: 'Negro' });
  await guardarConfigTienda(ropa.id, { negocio_id: ropa.id, habilitada: true, slug: 'ropa-qa', nombre: ropa.nombre, tipo: 'ropa', secciones: ['Jean', 'Remeras'], solicitud_id: randomUUID() }, admin.id);
  const cliente = await crearCliente({ nombre: 'Cliente preexistente ficticio', apellido: 'QA', negocio_id: ropa.id });
  const original = await crearVenta({ negocio_id: ropa.id, cliente_id: cliente.id, usuario_id: admin.id, fecha: todayAR(), modalidad: 'unico', monto_total_centavos: 2000000,
    items: [{ producto_id: remera.id, cantidad: 1, precio_unitario_centavos: 2000000 }], plan: { fecha_limite: addDays(todayAR(), 30) } });
  await registrarPago({ credito_id: original.credito.id, monto_centavos: 500000, usuario_id: admin.id });
  const financesBefore = await snapshot(), otherStockBefore = (await getProducto(remera.id)).stock;
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  async function context(viewport) {
    const c = await browser.newContext({ viewport, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', serviceWorkers: 'block' });
    await c.route('**/*', r => { const u = r.request().url(); if (new URL(u).origin === base) return r.continue(); external.push(u); return r.abort('blockedbyclient'); });
    c.on('page', p => { p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); p.on('response', async r => { if (r.status() >= 400 && new URL(r.url()).origin === base) rejectedResponses.push({ path: new URL(r.url()).pathname, status: r.status(), body: (await r.text().catch(() => '')).slice(0, 1000) }); }); p.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/tiendas/pedidos/')) requests.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }); }); });
    return c;
  }
  const ownerContext = await context({ width: 1440, height: 1050 });
  const anonymous = await context({ width: 1440, height: 1050 });
  owner = await ownerContext.newPage(); publicPage = await anonymous.newPage();
  async function login(page, user) {
    await page.goto(base); await page.locator('#authEmail').fill(user.email); await page.locator('#authPassword').fill(password); await page.locator('#authSubmit').click(); await page.locator('#root').waitFor({ state: 'visible' });
  }
  async function store(page, n) {
    await page.locator('#btnNegocioSwitch').click(); await page.locator(`[data-action="elegir-negocio"][data-id="${n.id}"]`).click(); await page.locator('#activeSheet').waitFor({ state: 'detached' });
    await page.evaluate(() => { location.hash = '#/tienda'; }); await page.locator('.tienda-admin h1').waitFor();
  }
  async function capture(page, name) {
    await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Desborde horizontal en ' + name);
    captures.push(name);
  }
  async function privateApi(page, pathname, method = 'GET', body) {
    return page.evaluate(async ({ pathname, method, body }) => {
      const r = await fetch('/api' + pathname, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('zilky_token') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    }, { pathname, method, body });
  }
  let main, firstOrder;

  await check('Dueño habilita el enlace por negocio y vincula inventario existente desde la pantalla de tienda', async () => {
    await login(owner, admin); await store(owner, apple);
    await owner.locator('[data-ta-tab="tienda"]').click();
    await owner.locator('#ta-config [name="habilitada"]').check(); await owner.locator('#ta-config [name="slug"]').fill('apple-qa');
    await owner.locator('#ta-config [name="nombre"]').fill(apple.nombre); await owner.locator('#ta-config [name="tipo"]').selectOption('iphone');
    await owner.locator('#ta-config [name="whatsapp"]').fill('+54 9 11 2345 6789'); await owner.locator('#ta-config [name="secciones"]').fill('Fundas\nAccesorios\nAuriculares');
    const configured = owner.waitForResponse(r => new URL(r.url()).pathname === '/api/tiendas/config' && r.request().method() === 'PUT');
    await owner.locator('#ta-config button[type="submit"]').click(); assert.equal((await configured).status(), 200);
    await owner.locator('.ta-share a').waitFor();
    await owner.locator('[data-ta-tab="catalogo"]').click(); await owner.locator('[data-ta-new]').click();
    await owner.locator('#ta-product-form [name="origen"]').selectOption('existente'); await owner.locator('#ta-product-form [name="producto_id"]').selectOption(core.id);
    await owner.locator('#ta-product-form [data-ta-model="iPhone 13 Pro"]').check(); await owner.locator('#ta-product-form [name="publicado"]').check();
    const created = owner.waitForResponse(r => new URL(r.url()).pathname === '/api/tiendas/productos' && r.request().method() === 'POST');
    await owner.locator('#ta-product-form button[type="submit"]').click(); const response = await created; assert.equal(response.status(), 201); main = await response.json();
    assert.equal(main.producto_id, core.id); assert.equal((await getProducto(core.id)).stock, 8);
    await owner.locator('#ta-media-files').waitFor(); await capture(owner, '01-dueno-tienda-escritorio');
  });

  await check('La galería recibe dos fotos y un video real y los sirve públicamente con rangos HTTP', async () => {
    await owner.locator('#ta-media-files').setInputFiles([{ name: 'frente-qa.png', mimeType: 'image/png', buffer: png }, { name: 'detalle-qa.png', mimeType: 'image/png', buffer: png }, { name: 'producto-qa.mp4', mimeType: 'video/mp4', buffer: video }]);
    await owner.waitForFunction(() => document.querySelectorAll('[data-ta-media-remove]').length === 3);
    const media = await db.prepare('SELECT id,tipo FROM tienda_media WHERE tienda_producto_id=? ORDER BY orden').all(main.id);
    assert.deepEqual(media.map(m => m.tipo), ['imagen', 'imagen', 'video']);
    const range = await fetch(base + '/api/tienda-media/' + media[2].id, { headers: { Range: 'bytes=0-31' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32); assert.equal(range.headers.get('content-type'), 'video/mp4');
    await publicPage.goto(base + '/tienda/apple-qa'); await publicPage.locator('#shopContent').waitFor({ state: 'visible' });
    assert.equal(await publicPage.locator('#productGrid [data-product]').count(), 2);
    await publicPage.locator('#modelFilter').selectOption('iPhone 13 Pro');
    assert.equal(await publicPage.locator('#productGrid [data-product]').count(), 1); assert.equal(await publicPage.locator(`[data-product="${p13.id}"]`).count(), 0);
    await capture(publicPage, '02-publica-iphone-filtro-escritorio');
    await publicPage.setViewportSize({ width: 390, height: 844 });
    await publicPage.locator(`[data-product="${main.id}"] .product-open`).click();
    assert.equal(await publicPage.locator('#galleryThumbs button').count(), 3);
    await publicPage.locator('#galleryThumbs button[aria-label="Ver video 3"]').click(); assert.equal(await publicPage.locator('#galleryStage video').count(), 1);
    await publicPage.locator('#galleryStage video').evaluate(async v => { v.preload = 'auto'; v.load(); await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(Error('El video no pudo cargarse')); }); });
    await capture(publicPage, '03-publica-galeria-video-movil');
    await publicPage.locator('#addDetailProduct').click(); await publicPage.locator('#closeProduct').click();
  });

  await check('La tienda de ropa filtra sección, talle y color y mantiene el carrito separado del negocio iPhone', async () => {
    await publicPage.goto(base + '/tienda/ropa-qa'); await publicPage.locator('#shopContent').waitFor({ state: 'visible' });
    assert.equal(await publicPage.locator('#cartCount').innerText(), '0');
    await publicPage.locator('#categoryChips [data-category="Jean"]').click(); await publicPage.locator('#sizeFilter').selectOption('42'); await publicPage.locator('#colorFilter').selectOption('Azul');
    assert.equal(await publicPage.locator('#productGrid [data-product]').count(), 1); assert.equal(await publicPage.locator(`[data-product="${jeanWeb.id}"]`).count(), 1);
    assert.equal(await publicPage.locator(`[data-product="${main.id}"]`).count(), 0); await capture(publicPage, '04-publica-ropa-filtros-movil');
    await publicPage.goto(base + '/tienda/apple-qa'); await publicPage.locator('#shopContent').waitFor({ state: 'visible' }); assert.equal(await publicPage.locator('#cartCount').innerText(), '1');
  });

  await check('El carrito permite corregir cantidad y enviar contacto argentino sin cobrar ni descontar stock hasta la confirmación', async () => {
    await publicPage.locator('#openCart').click();
    const row = publicPage.locator(`[data-cart-item="${main.id}"]`);
    await row.locator('[data-quantity="1"]').click(); await row.locator('[data-quantity="-1"]').click();
    await publicPage.locator('#orderName').fill('Compradora ficticia'); await publicPage.locator('#orderSurname').fill('Prueba QA');
    await publicPage.locator('#orderPhone').fill('11 2345 6789'); await publicPage.locator('#orderEmail').fill('compradora@tienda-qa.invalid');
    await publicPage.locator('#orderNote').fill('Pedido ficticio para retiro QA'); await publicPage.locator('#orderConsent').check();
    await capture(publicPage, '05-carrito-datos-movil');
    const created = publicPage.waitForResponse(r => new URL(r.url()).pathname === '/api/tienda-publica/apple-qa/pedidos' && r.request().method() === 'POST');
    await publicPage.locator('#submitOrder').click(); const response = await created; assert.equal(response.status(), 201); firstOrder = await response.json();
    await publicPage.locator('#orderSuccess').waitFor({ state: 'visible' }); assert.equal(firstOrder.total_centavos, 2500000);
    assert.equal((await getProducto(core.id)).stock, 8); assert.deepEqual(await snapshot(), financesBefore);
    const saved = await db.prepare('SELECT * FROM tienda_pedidos WHERE id=?').get(firstOrder.id); assert.equal(saved.estado, 'pendiente');
    assert.equal(saved.contacto.telefono, '+5491123456789'); assert.equal(saved.contacto.email, 'compradora@tienda-qa.invalid');
    assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM tienda_contactos WHERE pedido_id=?').get(firstOrder.id)).cantidad, 1);
    const storage = await publicPage.evaluate(() => JSON.stringify(localStorage)); assert.ok(!storage.includes('compradora@tienda-qa.invalid'));
    const visible = await (await fetch(base + '/api/tienda-publica/apple-qa')).json(); assert.ok(!JSON.stringify(visible).includes(saved.contacto.email));
    assert.equal((await fetch(base + '/api/tiendas/pedidos?negocio_id=' + apple.id)).status, 401);
    await capture(publicPage, '06-pedido-recibido-movil');
  });

  await check('El dueño confirma una sola vez y cancela restituyendo sólo el stock del pedido', async () => {
    await owner.setViewportSize({ width: 390, height: 844 }); await owner.locator('[data-ta-tab="pedidos"]').click();
    await owner.locator(`[data-ta-order="${firstOrder.id}"]`).click(); await owner.locator(`[data-ta-confirm="${firstOrder.id}"]`).waitFor();
    await capture(owner, '07-pedido-pendiente-admin-movil');
    const confirmed = owner.waitForResponse(r => new URL(r.url()).pathname.endsWith('/' + firstOrder.id + '/confirmar') && r.request().method() === 'POST');
    await owner.locator(`[data-ta-confirm="${firstOrder.id}"]`).evaluate(b => { b.click(); b.click(); });
    assert.equal((await confirmed).status(), 200); await owner.locator('#ta-order-detail .ta-tag').filter({ hasText: 'Confirmado' }).waitFor();
    assert.equal((await getProducto(core.id)).stock, 7);
    const attempt = requests.find(r => r.path.endsWith('/' + firstOrder.id + '/confirmar'));
    const repeated = await privateApi(owner, attempt.path.replace('/api', ''), 'POST', attempt.body); assert.equal(repeated.status, 200); assert.equal((await getProducto(core.id)).stock, 7);
    await owner.locator('#ta-order-detail details.ta-cancel summary').click(); await owner.locator('#ta-cancel-reason').fill('Cancelación ficticia QA');
    const cancelled = owner.waitForResponse(r => new URL(r.url()).pathname.endsWith('/' + firstOrder.id + '/cancelar') && r.request().method() === 'POST');
    await owner.locator(`[data-ta-cancel="${firstOrder.id}"]`).click(); assert.equal((await cancelled).status(), 200);
    await owner.locator('#ta-order-detail .ta-tag').filter({ hasText: 'Cancelado' }).waitFor(); assert.equal((await getProducto(core.id)).stock, 8);
    assert.deepEqual(await snapshot(), financesBefore); assert.equal((await getProducto(remera.id)).stock, otherStockBefore);
    await capture(owner, '08-pedido-cancelado-admin-movil');
  });

  await check('Cancelar un pendiente no mueve stock y el empleado de catálogo tiene acceso independiente a pedidos', async () => {
    const pedido = await crearPedidoPublico('apple-qa', { solicitud_id: randomUUID(), contacto: { nombre: 'Pendiente QA', apellido: 'Sin retiro', telefono: '1123456789', email: '' }, acepta_contacto: true, items: [{ producto_id: main.id, cantidad: 1 }] });
    await owner.locator('[data-ta-orders-refresh]').click(); await owner.locator(`[data-ta-order="${pedido.id}"]`).click();
    await owner.locator('#ta-order-detail details.ta-cancel summary').click(); await owner.locator('#ta-cancel-reason').fill('No confirmó disponibilidad QA');
    const cancellation = owner.waitForResponse(r => new URL(r.url()).pathname.endsWith('/' + pedido.id + '/cancelar') && r.request().method() === 'POST');
    await owner.locator(`[data-ta-cancel="${pedido.id}"]`).click(); assert.equal((await cancellation).status(), 200); assert.equal((await getProducto(core.id)).stock, 8);
    const staffContext = await context({ width: 390, height: 844 }); const employee = await staffContext.newPage(); employeePage = employee;
    await login(employee, staff); await store(employee, apple);
    assert.equal(await employee.locator('[data-ta-tab="tienda"]').count(), 0); assert.equal(await employee.locator('[data-ta-tab="pedidos"]').count(), 0);
    assert.equal((await privateApi(employee, '/tiendas/config', 'PUT', { negocio_id: apple.id, habilitada: false, solicitud_id: randomUUID() })).status, 403);
    assert.equal((await privateApi(employee, '/tiendas/pedidos?negocio_id=' + apple.id)).status, 403);
    await employee.locator('[data-ta-new]').click(); await employee.locator('#ta-product-form [name="nombre"]').fill('Producto borrador empleado QA'); await employee.locator('#ta-product-form [name="precio"]').fill('999');
    await employee.locator('#ta-product-form [name="stock"]').fill('3');
    const drafted = employee.waitForResponse(r => new URL(r.url()).pathname === '/api/tiendas/productos' && r.request().method() === 'POST');
    await employee.locator('#ta-product-form button[type="submit"]').click(); const result = await drafted; assert.equal(result.status(), 201); const draft = await result.json();
    assert.equal(draft.publicado, false); assert.equal((await getProducto(draft.producto_id)).stock, 3); await employee.locator('#ta-media-files').waitFor();
    await employee.waitForFunction(() => document.querySelector('#ta-product-form [data-ta-mutation]')?.disabled === false);
    await employee.locator('#ta-media-files').setInputFiles({ name: 'empleado-qa.png', mimeType: 'image/png', buffer: png });
    await employee.waitForFunction(() => document.querySelectorAll('[data-ta-media-remove]').length === 1);
    await capture(employee, '09-catalogo-empleado-movil');
    await asignarNegocio(staff.id, apple.id, { 'tienda.pedidos': true }); await employee.reload(); await employee.locator('#root').waitFor({ state: 'visible' }); await store(employee, apple); await employee.locator('[data-ta-tab="pedidos"]').waitFor();
    assert.equal(await employee.locator('[data-ta-new]').count(), 0); assert.equal((await privateApi(employee, '/tiendas/productos?negocio_id=' + apple.id)).status, 403);
    assert.equal((await privateApi(employee, '/tiendas/pedidos?negocio_id=' + apple.id)).status, 200);
    assert.equal((await privateApi(employee, '/tiendas/pedidos?negocio_id=' + ropa.id)).status, 403);
    await capture(employee, '10-pedidos-empleado-movil');
    assert.deepEqual(await snapshot(), financesBefore); assert.equal((await getProducto(core.id)).stock, 8); assert.equal((await getProducto(remera.id)).stock, otherStockBefore);
  });
  await check('Las pantallas de tienda y pedidos no producen errores JavaScript', async () => { assert.deepEqual(errors, []); });
  await Promise.all(['dueno', 'publica', 'empleado'].flatMap(name => ['png', 'html'].map(extension => fs.rm(path.join(output, `fallo-${name}.${extension}`), { force: true }))));
  console.log(`${results.length} E2E checks passed`);
} catch (error) {
  failed = error;
  for (const [name, page] of [['dueno', owner], ['publica', publicPage], ['empleado', employeePage]]) if (page) { await page.screenshot({ path: path.join(output, 'fallo-' + name + '.png'), fullPage: true }).catch(() => {}); await fs.writeFile(path.join(output, 'fallo-' + name + '.html'), await page.content()).catch(() => {}); }
} finally {
  await fs.writeFile(path.join(output, 'resultado.json'), JSON.stringify({ results, javascriptErrors: errors, captures, requests, rejectedResponses, externalRequestsBlocked: [...new Set(external)], ...(failed ? { error: failed.stack } : {}) }, null, 2));
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); await pool.end();
}
if (failed) throw failed;
