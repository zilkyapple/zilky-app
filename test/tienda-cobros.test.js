import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { firmarToken } from '../src/lib/auth.js';
import { guardarConfigTienda, crearProductoTienda } from '../src/services/tiendasService.js';
import { crearPedidoPublico, detallePedidoTienda, confirmarPedidoTienda, cancelarPedidoTienda } from '../src/services/tiendaPedidosService.js';
import { guardarCaja, abrirCaja, cerrarCaja, detalleCaja } from '../src/services/cajaService.js';
import { resumenGeneral } from '../src/services/dashboardService.js';
import { fechaPagoAR } from '../src/lib/replayPagos.js';
import { addDays } from '../src/lib/dates.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@cobros-web.invalid', nombre: 'Dueño QA', password_hash: 'unused' });
const token = firmarToken(admin);
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
async function api(path, user = token, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const ruta = f => `/tiendas/pedidos/${f.pedido.id}/cobros?negocio_id=${f.negocio.id}`;
const rutaAnular = (f, c) => `/tiendas/pedidos/${f.pedido.id}/cobros/${c.id}/anular?negocio_id=${f.negocio.id}`;
async function fixture({ pendiente = false, caja = false } = {}) {
  const negocio = await crearNegocio({ nombre: 'Cobros web ' + randomUUID(), mora_valor: 0 });
  let cajaConfig, sesion;
  if (caja) {
    cajaConfig = await guardarCaja(null, { nombre: 'Caja cobros QA', activa: true, arqueo: false, modalidad: 'negocio', negocios: [negocio.id] }, admin.id);
    sesion = await abrirCaja(cajaConfig.id, { inicial: 1000, solicitud_id: randomUUID() }, admin.id);
  }
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto cobro QA', stock: 8, precio_contado_centavos: 100000 });
  const slug = 'qa-' + randomUUID();
  await guardarConfigTienda(negocio.id, { negocio_id: negocio.id, slug, habilitada: true, solicitud_id: randomUUID() }, admin.id);
  const web = await crearProductoTienda(negocio.id, { negocio_id: negocio.id, producto_id: producto.id, publicado: true, solicitud_id: randomUUID() }, admin.id);
  const pedido = await crearPedidoPublico(slug, { solicitud_id: randomUUID(), contacto: { nombre: 'Comprador QA', apellido: 'Cobro web', telefono: '1123456789', email: 'comprador@web.invalid' },
    acepta_contacto: true, items: [{ producto_id: web.id, cantidad: 1 }] });
  if (!pendiente) {
    const v = await detallePedidoTienda(negocio.id, pedido.id);
    await confirmarPedidoTienda(negocio.id, pedido.id, { negocio_id: negocio.id, version: v.version, solicitud_id: randomUUID() }, admin.id);
  }
  return { negocio, producto, pedido, cajaConfig, sesion };
}
const detalle = f => detallePedidoTienda(f.negocio.id, f.pedido.id);
async function cuerpo(f, monto = 40000, extra = {}) {
  return { negocio_id: f.negocio.id, version: (await detalle(f)).version, solicitud_id: randomUUID(), monto_centavos: monto, medio_pago: 'efectivo', ...extra };
}
async function cobrar(f, monto = 40000, extra = {}, user = token) {
  const response = await api(ruta(f), user, 'POST', await cuerpo(f, monto, extra));
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
}
async function snapshot() {
  const tables = ['clientes', 'cliente_negocio', 'ventas', 'creditos', 'cuotas', 'productos', 'producto_historial', 'pagos', 'pago_aplicaciones', 'comprobantes',
    'saldo_favor', 'comision_acuerdos', 'comision_generaciones', 'comision_eventos', 'caja_sesiones', 'caja_asientos', 'tienda_pedidos', 'tienda_pedido_cobros'];
  return Object.fromEntries(await Promise.all(tables.map(async tabla => [tabla, await db.prepare(`SELECT * FROM ${tabla} ORDER BY ${['cliente_negocio', 'saldo_favor'].includes(tabla) ? 'cliente_id,negocio_id' : 'id'}`).all()])));
}
async function noFinanciacion() {
  const tables = ['ventas', 'creditos', 'cuotas', 'pago_aplicaciones', 'saldo_favor', 'comision_acuerdos', 'comision_generaciones', 'comision_eventos'];
  return Object.fromEntries(await Promise.all(tables.map(async t => [t, (await db.query('SELECT * FROM ' + t)).rows])));
}

test('Cobro web: crea cliente sólo al cobrar, conserva stock y usa pago/recibo canónicos sin financiación ni saldo a favor', async () => {
  const f = await fixture({ caja: true });
  const antes = await noFinanciacion();
  const clientesAntes = (await db.prepare('SELECT count(*)::int cantidad FROM clientes').get()).cantidad;
  assert.equal((await detalle(f)).pedido.cliente_id, null);
  const r = await cobrar(f, 40000, { nota: 'Dinero entregado QA' });
  assert.deepEqual(r.resumen_cobros, { cobrado_centavos: 40000, saldo_centavos: 60000, estado: 'parcial' });
  assert.equal(r.cobros.length, 1);
  const c = r.cobros[0], pago = await db.prepare('SELECT * FROM pagos WHERE id=?').get(c.pago_id);
  assert.equal(pago.tipo, 'pedido_web'); assert.equal(pago.credito_id, null); assert.equal(pago.monto_centavos, 40000);
  assert.equal(c.comprobante.estado, 'emitido'); assert.ok(c.comprobante.numero.startsWith('ZLK-'));
  const receipt = await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(c.comprobante_id);
  assert.equal(receipt.credito_id, null); assert.equal(receipt.venta_id, null); assert.equal(receipt.saldo_restante_centavos, 60000);
  assert.equal((await getProducto(f.producto.id)).stock, 7);
  assert.deepEqual(await noFinanciacion(), antes);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM clientes').get()).cantidad, clientesAntes + 1);
  const cliente = await db.prepare('SELECT * FROM clientes WHERE id=?').get(r.pedido.cliente_id);
  assert.equal(cliente.nombre, 'Comprador QA'); assert.equal(cliente.telefono, '+5491123456789');
  const full = await cobrar(f, 60000, { medio_pago: 'transferencia' });
  assert.equal(full.pedido.cliente_id, cliente.id); assert.equal(full.resumen_cobros.estado, 'cobrado'); assert.equal(full.resumen_cobros.saldo_centavos, 0);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM clientes').get()).cantidad, clientesAntes + 1);
  const dash = await resumenGeneral(f.negocio.id); assert.equal(dash.cobradoHoyCentavos, 100000); assert.equal(dash.cobradoMesCentavos, 100000);
  const cash = await detalleCaja(f.cajaConfig.id); assert.equal(cash.sesiones[0].efectivo_esperado, 41000); assert.equal(cash.sesiones[0].medios.transferencia, 60000);
});

test('Cobro web: idempotencia concurrente y saldo evitan duplicados, sobrepagos y escrituras desde versiones viejas', async () => {
  const f = await fixture();
  const body = await cuerpo(f, 70000);
  const responses = await Promise.all([api(ruta(f), token, 'POST', body), api(ruta(f), token, 'POST', body)]);
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  assert.equal(responses[0].body.cobros[0].pago_id, responses[1].body.cobros[0].pago_id);
  assert.equal((await detalle(f)).cobros.length, 1);
  const before = await snapshot();
  assert.equal((await api(ruta(f), token, 'POST', { ...body, monto_centavos: 60000 })).status, 409);
  assert.equal((await api(ruta(f), token, 'POST', { ...body, solicitud_id: randomUUID() })).status, 409);
  assert.equal((await api(ruta(f), token, 'POST', await cuerpo(f, 40000))).status, 409);
  assert.deepEqual(await snapshot(), before);
  await cobrar(f, 30000); assert.equal((await detalle(f)).resumen_cobros.estado, 'cobrado');
  assert.equal((await api(ruta(f), token, 'POST', await cuerpo(f, 1))).status, 409);
});

test('Cobro web: requiere pedido confirmado, importe positivo, fecha real válida y efectivo o transferencia', async () => {
  const pending = await fixture({ pendiente: true });
  assert.equal((await api(ruta(pending), token, 'POST', await cuerpo(pending))).status, 409);
  const f = await fixture();
  const before = await snapshot();
  for (const extra of [{ monto_centavos: 0 }, { monto_centavos: -1 }, { monto_centavos: 0.5 }, { medio_pago: 'tarjeta' }, { fecha_hora: null },
    { fecha_hora: '2026-02-30T12:00:00-03:00' }, { fecha_hora: new Date(Date.now() + 86400000).toISOString() },
    { fecha_hora: addDays(fechaPagoAR((await detalle(f)).pedido.created_at), -1) + 'T23:59:59-03:00' }, { stock: 20 }, { credito_id: randomUUID() }]) {
    const r = await api(ruta(f), token, 'POST', await cuerpo(f, 40000, extra)); assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.deepEqual(await snapshot(), before);
  const anticipado = await cobrar(f, 10000, { fecha_hora: fechaPagoAR((await detalle(f)).pedido.created_at) + 'T00:00:00-03:00' });
  assert.equal(anticipado.cobros[0].fecha_hora.slice(11, 19), '00:00:00', 'Registra la transferencia real anterior a la confirmación del mismo día');
});

test('Cobro web: permisos de pedido y cobro deben coincidir en el negocio y nunca se infieren de otros negocios', async () => {
  const f = await fixture(), otro = await crearNegocio({ nombre: 'Otro cobro QA' });
  const employee = await crearUsuario({ email: randomUUID() + '@cobro-perm.invalid', password_hash: 'unused', rol: 'empleado' }), jwt = firmarToken(employee);
  for (const permisos of [{ 'tienda.pedidos': true }, { 'pagos.registrar': true }]) {
    await asignarNegocio(employee.id, f.negocio.id, permisos);
    assert.equal((await api(ruta(f), jwt, 'POST', await cuerpo(f))).status, 403);
  }
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.pedidos': true }); await asignarNegocio(employee.id, otro.id, { 'pagos.registrar': true });
  assert.equal((await api(ruta(f), jwt, 'POST', await cuerpo(f))).status, 403);
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.pedidos': true, 'pagos.registrar': true });
  const r = await cobrar(f, 10000, {}, jwt); assert.equal(r.cobros[0].usuario_id, employee.id);
  assert.equal((await api(ruta(f), null, 'POST', await cuerpo(f))).status, 401);
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.pedidos': true });
  assert.equal((await api(ruta(f), jwt, 'POST', await cuerpo(f))).status, 403, 'Revoca inmediatamente con el mismo JWT');
});

test('Cobro web: nunca fusiona por teléfono; sólo vincula un cliente existente con permiso y relación en ese negocio', async () => {
  const f = await fixture();
  const mismoTelefono = await crearCliente({ nombre: 'Otro nombre', apellido: 'Identidad distinta', telefono: '+5491123456789', negocio_id: f.negocio.id });
  const nuevo = await cobrar(f, 10000); assert.notEqual(nuevo.pedido.cliente_id, mismoTelefono.id);
  const existing = await fixture(), ajeno = await crearNegocio({ nombre: 'Cliente ajeno' });
  const otherClient = await crearCliente({ nombre: 'Ajeno', apellido: 'QA', negocio_id: ajeno.id });
  const employee = await crearUsuario({ email: randomUUID() + '@link.invalid', password_hash: 'unused', rol: 'empleado' }), jwt = firmarToken(employee);
  await asignarNegocio(employee.id, existing.negocio.id, { 'tienda.pedidos': true, 'pagos.registrar': true });
  assert.equal((await api(ruta(existing), jwt, 'POST', await cuerpo(existing, 10000, { cliente_id: otherClient.id }))).status, 403);
  await asignarNegocio(employee.id, existing.negocio.id, { 'tienda.pedidos': true, 'pagos.registrar': true, 'clientes.ver': true });
  assert.equal((await api(ruta(existing), jwt, 'POST', await cuerpo(existing, 10000, { cliente_id: otherClient.id }))).status, 403);
  await vincularClienteNegocio(otherClient.id, existing.negocio.id);
  const linked = await cobrar(existing, 10000, { cliente_id: otherClient.id }, jwt); assert.equal(linked.pedido.cliente_id, otherClient.id);
  assert.equal((await api(ruta(existing), token, 'POST', await cuerpo(existing, 10000, { cliente_id: mismoTelefono.id }))).status, 409);
});

test('Cobro web: cancelación conserva pagos reales y anulación auditable reabre saldo sin alterar stock o cajas cerradas', async () => {
  const f = await fixture({ caja: true });
  const paid = await cobrar(f, 100000), c = paid.cobros[0], original = await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(c.comprobante_id);
  await cerrarCaja(f.sesion.id, {}, admin.id);
  const closed = await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(f.sesion.id);
  const cancel = await cancelarPedidoTienda(f.negocio.id, f.pedido.id, { negocio_id: f.negocio.id, version: paid.version, solicitud_id: randomUUID(), motivo: 'Cancelado después del cobro QA' }, admin.id);
  assert.equal(cancel.resumen_cobros.cobrado_centavos, 100000); assert.equal(cancel.cobros[0].anulado, 0); assert.equal((await getProducto(f.producto.id)).stock, 8);
  const v = await detalle(f), body = { negocio_id: f.negocio.id, version: v.version, solicitud_id: randomUUID(), motivo: 'Corregir cobro duplicado QA' };
  const generic = await api('/comprobantes/' + c.comprobante_id + '/anular', token, 'POST', { motivo: 'Ruta incorrecta QA', negocio_id: f.negocio.id });
  assert.equal(generic.status, 409); assert.match(generic.body.error, /pedido de la tienda/);
  const response = await api(rutaAnular(f, c), token, 'POST', body); assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.resumen_cobros.cobrado_centavos, 0); assert.equal(response.body.cobros[0].anulado, 1);
  const receipt = await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(c.comprobante_id);
  assert.equal(receipt.numero, original.numero); assert.equal(receipt.fecha_hora, original.fecha_hora); assert.equal(receipt.monto_centavos, original.monto_centavos); assert.equal(receipt.estado, 'anulado');
  assert.deepEqual(await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(f.sesion.id), closed);
  const reversal = await db.prepare("SELECT * FROM caja_asientos WHERE pago_id=? AND tipo='anulacion'").get(c.pago_id);
  assert.equal(reversal.sesion_id, null); assert.equal(reversal.monto, -100000);
  assert.equal((await getProducto(f.producto.id)).stock, 8);
  const beforeRetry = await snapshot(); assert.equal((await api(rutaAnular(f, c), token, 'POST', body)).status, 200); assert.deepEqual(await snapshot(), beforeRetry);
  assert.equal((await api(rutaAnular(f, c), token, 'POST', { ...body, motivo: 'Otro motivo' })).status, 409);
  assert.equal((await db.prepare('SELECT count(*)::int cantidad FROM saldo_favor WHERE cliente_id=? AND negocio_id=?').get(paid.pedido.cliente_id, f.negocio.id)).cantidad, 0);
  assert.equal((await resumenGeneral(f.negocio.id)).cobradoHoyCentavos, 0);
  assert.equal((await api(ruta(f), token, 'POST', await cuerpo(f))).status, 409, 'No cobra un pedido cancelado');
});

test('Cobro web: recibos canónicos modifican la versión y cada anulación requiere permiso y pedido correctos', async () => {
  const f = await fixture(), otro = await fixture();
  const paid = await cobrar(f), c = paid.cobros[0];
  const employee = await crearUsuario({ email: randomUUID() + '@void.invalid', rol: 'empleado', password_hash: 'unused' }), jwt = firmarToken(employee);
  const body = { negocio_id: f.negocio.id, solicitud_id: randomUUID(), version: paid.version, motivo: 'Corrección QA' };
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.pedidos': true });
  assert.equal((await api(rutaAnular(f, c), jwt, 'POST', body)).status, 403);
  await asignarNegocio(employee.id, f.negocio.id, { 'tienda.pedidos': true, 'comprobantes.anular': true });
  await db.prepare('UPDATE comprobantes SET medio_pago=? WHERE id=?').run('transferencia', c.comprobante_id);
  const nueva = await detalle(f);
  assert.notEqual(nueva.version, paid.version, 'El medio del comprobante canónico también invalida la revisión anterior');
  // Payment data, receipt state, dates and amounts are all guarded; amount is a
  // documentary change deliberately made by this isolated legacy fixture.
  await db.prepare('UPDATE comprobantes SET monto_centavos=monto_centavos+1 WHERE id=?').run(c.comprobante_id);
  assert.notEqual((await detalle(f)).version, nueva.version);
  assert.equal((await api(rutaAnular(f, c), jwt, 'POST', body)).status, 409);
  assert.equal((await api(rutaAnular(otro, c), token, 'POST', { ...body, negocio_id: otro.negocio.id, version: (await detalle(otro)).version })).status, 404);
  await db.prepare('UPDATE comprobantes SET monto_centavos=?,medio_pago=? WHERE id=?').run(c.monto_centavos, c.medio_pago, c.comprobante_id);
  const valido = { ...body, solicitud_id: randomUUID(), version: (await detalle(f)).version };
  const anulado = await api(rutaAnular(f, c), jwt, 'POST', valido);
  assert.equal(anulado.status, 200, JSON.stringify(anulado.body));
  assert.equal(anulado.body.cobros[0].comprobante.anulado_por, employee.id);
});

test('Cobro web: cobro y cancelación concurrentes se serializan sin cobrar un pedido cancelado ni reponer stock dos veces', async () => {
  const f = await fixture();
  const cobrarBody = await cuerpo(f, 10000);
  const cancelarBody = { negocio_id: f.negocio.id, version: cobrarBody.version, solicitud_id: randomUUID(), motivo: 'Cancelación concurrente QA' };
  const [cobro, cancelacion] = await Promise.all([
    api(ruta(f), token, 'POST', cobrarBody),
    api(`/tiendas/pedidos/${f.pedido.id}/cancelar?negocio_id=${f.negocio.id}`, token, 'POST', cancelarBody),
  ]);
  assert.ok((cobro.status === 201 && cancelacion.status === 409) || (cobro.status === 409 && cancelacion.status === 200), JSON.stringify([cobro, cancelacion]));
  const final = await detalle(f);
  assert.equal(final.resumen_cobros.cobrado_centavos, cobro.status === 201 ? 10000 : 0);
  assert.equal(final.cobros.length, cobro.status === 201 ? 1 : 0);
  assert.equal(final.pedido.estado, cancelacion.status === 200 ? 'cancelado' : 'confirmado');
  assert.equal((await getProducto(f.producto.id)).stock, cancelacion.status === 200 ? 8 : 7);
});

test('Cobro web: fallo de auditoría revierte cliente nuevo, pago, recibo, enlace y asiento de caja en la misma transacción', async () => {
  const f = await fixture({ caja: true }), before = await snapshot();
  await db.exec(`CREATE FUNCTION qa_rechazar_cobro_web() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accion='registrar_cobro' THEN RAISE EXCEPTION 'QA rollback cobro web'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER qa_rechazar_cobro_web BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION qa_rechazar_cobro_web();`);
  try { const r = await api(ruta(f), token, 'POST', await cuerpo(f)); assert.equal(r.status, 500); assert.deepEqual(await snapshot(), before); }
  finally { await db.exec('DROP TRIGGER qa_rechazar_cobro_web ON auditoria; DROP FUNCTION qa_rechazar_cobro_web();'); }
});
