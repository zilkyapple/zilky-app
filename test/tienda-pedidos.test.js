import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { firmarToken } from '../src/lib/auth.js';
import { normalizarTelefonoTienda } from '../src/services/tiendaPedidosService.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'pedidos-admin@qa.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'pedidos-empleado@qa.invalid', password_hash: 'unused', rol: 'empleado' });
const editor = await crearUsuario({ email: 'pedidos-editor@qa.invalid', password_hash: 'unused', rol: 'empleado' });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(r => server.close(r)); await pool.end(); });
async function api(url, { usuario = admin, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method,
    headers: { ...(usuario ? { Authorization: 'Bearer ' + firmarToken(usuario) } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
async function fixture({ stock = 8, precio = 25000, publicado = true, habilitada = true } = {}) {
  const n = await crearNegocio({ nombre: 'Pedidos QA ' + randomUUID().slice(0, 6), mora_valor: 0 });
  const producto = await crearProducto({ negocio_id: n.id, nombre: 'iPhone del inventario', stock, costo_centavos: 12345 });
  const slug = 'qa-' + randomUUID().slice(0, 12), webId = randomUUID();
  await pool.query('INSERT INTO tiendas_config(negocio_id,slug,habilitada,nombre) VALUES($1,$2,$3,$4)', [n.id, slug, habilitada, 'Tienda QA']);
  await pool.query('INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,publicado,precio_centavos) VALUES($1,$2,$3,$4,$5,$6)', [webId, n.id, producto.id, 'iPhone publicado', publicado, precio]);
  return { n, producto, webId, slug, precio };
}
function payload(f, extra = {}) {
  return { solicitud_id: randomUUID(), contacto: { nombre: 'Ana', apellido: 'Prueba', telefono: '+54 9 11 1234 5678', email: 'ana@qa.invalid' },
    items: [{ producto_id: f.webId, cantidad: 2 }], total_esperado_centavos: f.precio * 2, nota: 'Consultar entrega', acepta_contacto: true, ...extra };
}
async function pedir(f, body = payload(f)) {
  const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return { pedido: r.body, body };
}
async function detalle(f, pedidoId) {
  const r = await api(`/tiendas/pedidos/${pedidoId}?negocio_id=${f.n.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
}
async function accion(f, pedidoId, tipo, { version, solicitud_id = randomUUID(), usuario = admin } = {}) {
  version ||= (await detalle(f, pedidoId)).version;
  const body = { negocio_id: f.n.id, solicitud_id, version, ...(tipo === 'cancelar' ? { motivo: 'QA pedido cancelado' } : {}) };
  return api(`/tiendas/pedidos/${pedidoId}/${tipo}`, { usuario, method: 'POST', body });
}
async function stock(p) { return (await pool.query('SELECT stock FROM productos WHERE id=$1', [p.id])).rows[0].stock; }
async function tablas(names) { return Object.fromEntries(await Promise.all(names.map(async n => [n, (await pool.query(`SELECT * FROM ${n} ORDER BY id`)).rows]))); }
const financieras = ['ventas', 'creditos', 'cuotas', 'pagos', 'comprobantes', 'caja_asientos', 'comision_eventos'];

test('Tienda pedidos: recibe un pedido con precios del servidor y contacto separado, sin stock, venta, deuda ni caja', async () => {
  const f = await fixture();
  const cliente = await crearCliente({ nombre: 'Persona existente', apellido: 'Distinta', telefono: '+5491112345678', negocio_id: f.n.id });
  const antes = await tablas([...financieras, 'clientes']);
  const r = await pedir(f);
  assert.equal(r.pedido.estado, 'pendiente'); assert.equal(r.pedido.total_centavos, 50000);
  assert.equal(r.pedido.items[0].precio_unitario_centavos, 25000); assert.equal(r.pedido.items[0].producto_id, f.webId);
  assert.match(r.pedido.codigo, /^WEB-/); assert.equal(await stock(f.producto), 8);
  assert.doesNotMatch(JSON.stringify(r.pedido), /Ana|Prueba|telefono|email|contacto|12345|costo/);
  assert.deepEqual(await tablas([...financieras, 'clientes']), antes);
  const privado = await detalle(f, r.pedido.id);
  assert.equal(privado.pedido.contacto.telefono, '+5491112345678');
  assert.equal(privado.stock[0].stock_despues, 6);
  assert.equal((await pool.query('SELECT * FROM tienda_contactos WHERE pedido_id=$1', [r.pedido.id])).rows.length, 1);
  assert.equal((await pool.query('SELECT nombre FROM clientes WHERE id=$1', [cliente.id])).rows[0].nombre, 'Persona existente');
  assert.equal((await pool.query("SELECT count(*)::int n FROM producto_historial WHERE tipo IN ('pedido_web','cancelar_pedido_web')")).rows[0].n, 0);
});

test('Tienda pedidos: reintento público exacto recupera el recibo original incluso si cambian precio, publicación o habilitación', async () => {
  const f = await fixture(), r = await pedir(f);
  await pool.query('UPDATE tienda_productos SET precio_centavos=99999,publicado=FALSE WHERE id=$1', [f.webId]);
  await pool.query('UPDATE tiendas_config SET habilitada=FALSE WHERE negocio_id=$1', [f.n.id]);
  const antes = await tablas(['tienda_pedidos', 'tienda_pedido_items', 'tienda_contactos']);
  const repetido = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: r.body });
  assert.equal(repetido.status, 201); assert.deepEqual(repetido.body, r.pedido);
  assert.deepEqual(await tablas(['tienda_pedidos', 'tienda_pedido_items', 'tienda_contactos']), antes);
  const alterado = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: { ...r.body, nota: 'Otro pedido' } });
  assert.equal(alterado.status, 409);
});

test('Tienda pedidos: carrito con precio esperado viejo devuelve 409 antes de guardar contacto o pedido', async () => {
  const f = await fixture(), body = payload(f);
  await pool.query('UPDATE tienda_productos SET precio_centavos=30000 WHERE id=$1', [f.webId]);
  const antes = await tablas(['tienda_pedidos', 'tienda_pedido_items', 'tienda_contactos']);
  const r = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body });
  assert.equal(r.status, 409); assert.match(r.body.error, /precios cambiaron/);
  assert.deepEqual(await tablas(['tienda_pedidos', 'tienda_pedido_items', 'tienda_contactos']), antes);
  assert.equal(await stock(f.producto), 8);
});

test('Tienda pedidos: campos desconocidos, cantidades, contacto y consentimiento se validan sin datos parciales', async () => {
  const f = await fixture(), base = payload(f);
  const invalidos = [
    { ...base, contacto: { ...base.contacto, nombre: '' } }, { ...base, contacto: { ...base.contacto, apellido: '' } },
    { ...base, contacto: { ...base.contacto, telefono: '123' } }, { ...base, contacto: { ...base.contacto, email: 'email malo' } },
    { ...base, contacto: { ...base.contacto, cliente_id: 'otro' } }, { ...base, acepta_contacto: false },
    { ...base, total_centavos: 1 }, { ...base, solicitud_id: 'incorrecta' }, { ...base, items: [] },
    { ...base, items: [{ producto_id: f.webId, cantidad: 0 }] }, { ...base, items: [{ producto_id: f.webId, cantidad: 1.5 }] },
    { ...base, items: [{ producto_id: f.webId, cantidad: 2, precio_centavos: 1 }] }, { ...base, items: [...base.items, ...base.items] },
  ];
  for (const body of invalidos) assert.equal((await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int n FROM tienda_pedidos WHERE negocio_id=$1', [f.n.id])).rows[0].n, 0);
  for (const telefono of ['+54 9 11 1234-5678', '+54 11 1234 5678', '11 1234 5678', '011 15 1234 5678']) assert.equal(normalizarTelefonoTienda(telefono), '+5491112345678');
});

test('Tienda pedidos: rechaza productos privados, de otro negocio, sin stock y tiendas deshabilitadas', async () => {
  const a = await fixture(), b = await fixture();
  assert.equal((await api(`/tienda-publica/${a.slug}/pedidos`, { usuario: null, method: 'POST', body: payload(a, { items: [{ producto_id: b.webId, cantidad: 1 }] }) })).status, 409);
  await pool.query('UPDATE tienda_productos SET publicado=FALSE WHERE id=$1', [a.webId]);
  assert.equal((await api(`/tienda-publica/${a.slug}/pedidos`, { usuario: null, method: 'POST', body: payload(a) })).status, 409);
  await pool.query('UPDATE tienda_productos SET publicado=TRUE WHERE id=$1', [a.webId]);
  await pool.query('UPDATE productos SET stock=0 WHERE id=$1', [a.producto.id]);
  assert.equal((await api(`/tienda-publica/${a.slug}/pedidos`, { usuario: null, method: 'POST', body: payload(a) })).status, 409);
  await pool.query('UPDATE tiendas_config SET habilitada=FALSE WHERE negocio_id=$1', [b.n.id]);
  assert.equal((await api(`/tienda-publica/${b.slug}/pedidos`, { usuario: null, method: 'POST', body: payload(b) })).status, 404);
});

test('Tienda pedidos: confirmación simultánea y repetida descuenta una vez y conserva el comprobante privado original', async () => {
  const f = await fixture(), r = await pedir(f), vista = await detalle(f, r.pedido.id);
  const solicitud_id = randomUUID();
  const antes = await tablas(financieras);
  const respuestas = await Promise.all([accion(f, r.pedido.id, 'confirmar', { version: vista.version, solicitud_id }), accion(f, r.pedido.id, 'confirmar', { version: vista.version, solicitud_id })]);
  assert.deepEqual(respuestas.map(r => r.status), [200, 200]); assert.deepEqual(respuestas[0].body, respuestas[1].body);
  assert.equal(await stock(f.producto), 6); assert.equal(respuestas[0].body.pedido.estado, 'confirmado');
  assert.deepEqual(await tablas(financieras), antes);
  const movimientos = (await pool.query("SELECT * FROM producto_historial WHERE producto_id=$1 AND tipo='pedido_web'", [f.producto.id])).rows;
  assert.equal(movimientos.length, 1); assert.equal(movimientos[0].venta_id, null); assert.equal(movimientos[0].detalles.pedido_id, r.pedido.id);
  assert.equal((await accion(f, r.pedido.id, 'confirmar', { version: (await detalle(f, r.pedido.id)).version })).status, 409);
  const recibo = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: r.body });
  assert.deepEqual(recibo.body, r.pedido, 'El recibo público sigue siendo el original sin revelar estado privado');
});

test('Tienda pedidos: cancelar pendiente no mueve stock y no permite reabrir ni confirmar después', async () => {
  const f = await fixture(), r = await pedir(f);
  const cancelado = await accion(f, r.pedido.id, 'cancelar');
  assert.equal(cancelado.status, 200); assert.equal(cancelado.body.pedido.estado, 'cancelado'); assert.equal(await stock(f.producto), 8);
  assert.deepEqual(cancelado.body.pedido.stock_reposiciones, []);
  assert.equal((await pool.query('SELECT count(*)::int n FROM producto_historial WHERE producto_id=$1', [f.producto.id])).rows[0].n, 0);
  assert.equal((await accion(f, r.pedido.id, 'confirmar')).status, 409);
  assert.equal((await accion(f, r.pedido.id, 'cancelar')).status, 409);
});

test('Tienda pedidos: cancelar confirmado repone la cantidad realmente descontada una vez sobre el stock actual', async () => {
  const f = await fixture(), r = await pedir(f);
  assert.equal((await accion(f, r.pedido.id, 'confirmar')).status, 200);
  await pool.query('UPDATE productos SET stock=10 WHERE id=$1', [f.producto.id]);
  const vista = await detalle(f, r.pedido.id), solicitud_id = randomUUID();
  assert.equal(vista.stock[0].stock_despues, 12);
  const respuestas = await Promise.all([accion(f, r.pedido.id, 'cancelar', { version: vista.version, solicitud_id }), accion(f, r.pedido.id, 'cancelar', { version: vista.version, solicitud_id })]);
  assert.deepEqual(respuestas.map(r => r.status), [200, 200]); assert.equal(await stock(f.producto), 12);
  assert.equal(respuestas[0].body.pedido.stock_movimientos[0].cantidad, 2);
  assert.equal(respuestas[0].body.pedido.stock_reposiciones[0].cantidad, 2);
  assert.equal((await pool.query("SELECT count(*)::int n FROM producto_historial WHERE producto_id=$1 AND tipo='cancelar_pedido_web'", [f.producto.id])).rows[0].n, 1);
});

test('Tienda pedidos: dos pendientes no reservan y no pueden confirmar por encima del stock disponible', async () => {
  const f = await fixture();
  const cuerpo = () => payload(f, { items: [{ producto_id: f.webId, cantidad: 5 }], total_esperado_centavos: f.precio * 5 });
  const a = await pedir(f, cuerpo()), b = await pedir(f, cuerpo());
  assert.equal(await stock(f.producto), 8);
  const va = await detalle(f, a.pedido.id), vb = await detalle(f, b.pedido.id);
  const resultado = await Promise.all([accion(f, a.pedido.id, 'confirmar', { version: va.version }), accion(f, b.pedido.id, 'confirmar', { version: vb.version })]);
  assert.deepEqual(resultado.map(r => r.status).sort(), [200, 409]); assert.equal(await stock(f.producto), 3);
  const pendiente = resultado[0].status === 409 ? a : b;
  const actual = await detalle(f, pendiente.pedido.id); assert.equal(actual.stock[0].insuficiente, true);
  assert.equal((await accion(f, pendiente.pedido.id, 'confirmar', { version: actual.version })).status, 409);
  assert.equal(await stock(f.producto), 3);
});

test('Tienda pedidos: confirma y revierte componentes congelados del combo aunque luego cambie su composición', async () => {
  const f = await fixture({ stock: null }), otro = await crearProducto({ negocio_id: f.n.id, nombre: 'Accesorio', stock: 5 });
  const pieza = await crearProducto({ negocio_id: f.n.id, nombre: 'Pieza original', stock: 8 });
  await pool.query('INSERT INTO producto_combo_componentes(combo_id,producto_id,cantidad) VALUES($1,$2,2),($1,$3,1)', [f.producto.id, pieza.id, otro.id]);
  const r = await pedir(f);
  await pool.query('UPDATE producto_combo_componentes SET cantidad=3 WHERE combo_id=$1', [f.producto.id]);
  assert.equal((await accion(f, r.pedido.id, 'confirmar')).status, 200);
  assert.equal(await stock(pieza), 4); assert.equal(await stock(otro), 3); assert.equal(await stock(f.producto), null);
  assert.equal((await accion(f, r.pedido.id, 'cancelar')).status, 200);
  assert.equal(await stock(pieza), 8); assert.equal(await stock(otro), 5);
});

test('Tienda pedidos: stock no controlado no se inventa ni se repone si se activa después de confirmar', async () => {
  const f = await fixture({ stock: null }), r = await pedir(f);
  assert.equal((await accion(f, r.pedido.id, 'confirmar')).status, 200); assert.equal(await stock(f.producto), null);
  await pool.query('UPDATE productos SET stock=7 WHERE id=$1', [f.producto.id]);
  assert.equal((await accion(f, r.pedido.id, 'cancelar')).status, 200); assert.equal(await stock(f.producto), 7);
});

test('Tienda pedidos: el permiso se limita al mismo negocio y los datos de contacto no tienen consulta pública', async () => {
  const a = await fixture(), b = await fixture(), ra = await pedir(a), rb = await pedir(b);
  await asignarNegocio(empleado.id, a.n.id, { 'tienda.pedidos': true });
  await asignarNegocio(editor.id, a.n.id, { 'tienda.editar': true });
  assert.equal((await api(`/tiendas/pedidos?negocio_id=${a.n.id}`, { usuario: empleado })).status, 200);
  assert.equal((await api(`/tiendas/pedidos?negocio_id=${b.n.id}`, { usuario: empleado })).status, 403);
  assert.equal((await api(`/tiendas/pedidos/${rb.pedido.id}?negocio_id=${a.n.id}`, { usuario: empleado })).status, 404);
  assert.equal((await api(`/tiendas/pedidos?negocio_id=${a.n.id}`, { usuario: editor })).status, 403);
  assert.equal((await api(`/tiendas/productos?negocio_id=${a.n.id}`, { usuario: editor })).status, 200, 'El router de pedidos no bloquea el catálogo de otro permiso');
  assert.equal((await api(`/tiendas/pedidos/${ra.pedido.id}?negocio_id=${a.n.id}`, { usuario: null })).status, 401);
  const publica = await api(`/tienda-publica/${a.slug}/pedidos/${ra.pedido.id}`, { usuario: null });
  assert.notEqual(publica.status, 200); assert.doesNotMatch(JSON.stringify(publica.body), /ana@qa|12345678/);
});

test('Tienda pedidos: exporta contactos del negocio autorizado y neutraliza fórmulas, comillas y delimitadores de CSV', async () => {
  const f = await fixture(), otro = await fixture();
  const contacto = { nombre: '=SUM(1;2)', apellido: 'O"Connor;\nQA', telefono: '+5491112345678', email: '=correo@qa.invalid' };
  await pedir(f, payload(f, { contacto })); await pedir(otro, payload(otro, { contacto: { ...contacto, nombre: 'NO INCLUIR' } }));
  const r = await api(`/tiendas/contactos.csv?negocio_id=${f.n.id}`);
  assert.equal(r.status, 200); assert.match(r.body, /"'=SUM\(1;2\)"/); assert.match(r.body, /"O""Connor;\nQA"/);
  assert.match(r.body, /"'\+5491112345678"/); assert.match(r.body, /"'=correo@qa.invalid"/); assert.doesNotMatch(r.body, /NO INCLUIR/);
  assert.match(r.headers.get('content-type'), /text\/csv/);
});

test('Tienda pedidos: un fallo de auditoría revierte stock, estado y movimientos y permite reintentar', async () => {
  const f = await fixture(), r = await pedir(f), vista = await detalle(f, r.pedido.id), solicitud_id = randomUUID();
  const antes = await tablas(['productos', 'tienda_pedidos', 'producto_historial']);
  await pool.query("CREATE FUNCTION tienda_pedido_qa_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entidad='tienda_pedido' AND NEW.accion='confirmar' THEN RAISE EXCEPTION 'TIENDA_PEDIDO_FORCED_FAILURE'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER tienda_pedido_qa_audit_fail_trigger BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION tienda_pedido_qa_audit_fail()');
  try { assert.equal((await accion(f, r.pedido.id, 'confirmar', { version: vista.version, solicitud_id })).status, 500); }
  finally { await pool.query('DROP TRIGGER tienda_pedido_qa_audit_fail_trigger ON auditoria'); await pool.query('DROP FUNCTION tienda_pedido_qa_audit_fail()'); }
  assert.deepEqual(await tablas(['productos', 'tienda_pedidos', 'producto_historial']), antes);
  assert.equal((await accion(f, r.pedido.id, 'confirmar', { version: vista.version, solicitud_id })).status, 200);
});

test('Tienda pedidos: limita pedidos públicos nuevos y permite recuperar una solicitud anterior sin consumir el límite', async () => {
  const f = await fixture({ stock: 100 }); let primero;
  for (let i = 0; i < 10; i++) { const r = await pedir(f); primero ||= r; }
  const limitado = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: payload(f) });
  assert.equal(limitado.status, 429); assert.equal(limitado.headers.get('retry-after'), '900');
  const repetido = await api(`/tienda-publica/${f.slug}/pedidos`, { usuario: null, method: 'POST', body: primero.body });
  assert.equal(repetido.status, 201); assert.deepEqual(repetido.body, primero.pedido);
  assert.equal((await pool.query('SELECT count(*)::int n FROM tienda_pedidos WHERE negocio_id=$1', [f.n.id])).rows[0].n, 10);
});
