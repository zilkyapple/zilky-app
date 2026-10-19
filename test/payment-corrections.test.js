import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { getPago, getSaldoFavor } from '../src/repositories/pagos.js';
import { listCuotasPorCredito } from '../src/repositories/cuotas.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { vistaCorreccionPago, previsualizarCorreccionPago, corregirPago } from '../src/services/pagoCorreccionService.js';
import { configurarComision, configurarProductoComision, resumenComisiones, liquidarComision } from '../src/services/comisionesService.js';
import { guardarCaja, abrirCaja, detalleCaja, resolverPendiente } from '../src/services/cajaService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const n = await crearNegocio({ nombre: 'QA corregir pagos', mora_valor: 0 });
const otro = await crearNegocio({ nombre: 'QA otro negocio', mora_valor: 0 });
const admin = await crearUsuario({ email: 'admin@corregirpago.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'empleado@corregirpago.invalid', password_hash: 'unused', rol: 'empleado' });
await asignarNegocio(empleado.id, n.id, { 'pagos.registrar': true, 'clientes.ver': true, 'clientes.editar': true });
const hoy = todayAR();
const fecha = offset => `${addDays(hoy, offset)}T12:00:00-03:00`;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
async function api(path, method = 'GET', body, user = admin) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + firmarToken(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
}
async function sale(overrides = {}, negocio = n) {
  const cliente = await crearCliente({ nombre: 'Histórico', apellido: 'QA', negocio_id: negocio.id });
  return crearVenta({ negocio_id: negocio.id, cliente_id: cliente.id, fecha: addDays(hoy, -200), modalidad: 'cuotas', monto_total_centavos: 30000, usuario_id: admin.id, plan: { cantidad_cuotas: 3, valor_cuota_centavos: 10000, fecha_primera_cuota: addDays(hoy, 10) }, ...overrides });
}
const pay = (s, monto, offset = -10) => registrarPago({ credito_id: s.credito.id, monto_centavos: monto, fecha_hora: fecha(offset), medio_pago: 'efectivo', usuario_id: admin.id });
async function body(payment, changes = {}) {
  const v = await vistaCorreccionPago(payment.pago.id);
  return { version: v.version, motivo: 'Fecha e importe del cuaderno revisados', solicitud_id: randomUUID(), datos: { fecha_hora: payment.pago.fecha_hora, monto_centavos: payment.pago.monto_centavos, medio_pago: payment.pago.medio_pago, nota: payment.pago.nota || '', ...changes } };
}
async function snapshot() {
  const out = {};
  for (const t of ['creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'saldo_favor', 'auditoria', 'caja_asientos', 'comision_eventos']) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY 1,2`)).rows;
  return out;
}

test('Corregir fecha preserva pago/recibo originales, cuotas pagadas y aplicaciones posteriores', async () => {
  const s = await sale(), first = await pay(s, 6000, -40), later = await pay(s, 4000, -20);
  const originalApps = await db.prepare('SELECT * FROM pago_aplicaciones WHERE pago_id=? ORDER BY id').all(first.pago.id);
  const laterBefore = await getPago(later.pago.id);
  const b = await body(first, { fecha_hora: fecha(-30), medio_pago: 'transferencia' });
  const preview = await previsualizarCorreccionPago(first.pago.id, b);
  assert.equal(preview.resumen.saldo_anterior_centavos, 20000);
  assert.equal(preview.resumen.saldo_posterior_centavos, 20000);
  const result = await corregirPago(first.pago.id, b, admin.id);
  assert.equal((await getPago(first.pago.id)).anulado, 1);
  assert.equal((await getPago(first.pago.id)).fecha_hora, fecha(-40));
  assert.equal((await getPago(result.reemplazo_id)).fecha_hora, fecha(-30));
  assert.deepEqual(await getPago(later.pago.id), laterBefore);
  assert.deepEqual(await db.prepare('SELECT * FROM pago_aplicaciones WHERE pago_id=? ORDER BY id').all(first.pago.id), originalApps);
  const qs = await listCuotasPorCredito(s.credito.id);
  assert.equal(qs[0].saldo_pendiente_centavos, 0);
  assert.equal(qs[0].fecha_saldada, addDays(hoy, -20));
  const oldReceipt = await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(first.comprobante.id);
  assert.equal(oldReceipt.estado, 'anulado'); assert.equal(oldReceipt.fecha_hora, fecha(-40));
  const newReceipt = await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(result.comprobante_id);
  assert.equal(newReceipt.comprobante_original_id, oldReceipt.id);
  const audit = await db.prepare("SELECT * FROM auditoria WHERE entidad_id=? AND accion='corregir_pago'").get(first.pago.id);
  assert.equal(audit.empleado, admin.id); assert.equal(JSON.parse(audit.datos_nuevos).reemplazo_id, result.reemplazo_id);
});

test('Cuota saldada actualiza fecha real aunque el pago corregido se mueva después de pagos posteriores', async () => {
  const s = await sale(), a = await pay(s, 5000, -40);
  await pay(s, 5000, -20);
  await corregirPago(a.pago.id, await body(a, { fecha_hora: fecha(-5) }), admin.id);
  assert.equal((await listCuotasPorCredito(s.credito.id))[0].fecha_saldada, addDays(hoy, -5));
});

test('Reducir pago antiguo reabre solamente su capital, conserva los pagos posteriores y no duplica deuda', async () => {
  const s = await sale(), a = await pay(s, 7000, -40), b = await pay(s, 8000, -20);
  const originalLaterApps = await db.prepare('SELECT * FROM pago_aplicaciones WHERE pago_id=? ORDER BY id').all(b.pago.id);
  const result = await corregirPago(a.pago.id, await body(a, { monto_centavos: 4000 }), admin.id);
  assert.equal(result.resumen.saldo_posterior_centavos, 18000);
  const qs = await listCuotasPorCredito(s.credito.id);
  assert.equal(qs[0].saldo_pendiente_centavos, 3000); assert.equal(qs[0].fecha_saldada, null);
  assert.equal(qs[1].saldo_pendiente_centavos, 5000);
  assert.deepEqual(await db.prepare('SELECT * FROM pago_aplicaciones WHERE pago_id=? ORDER BY id').all(b.pago.id), originalLaterApps);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM creditos WHERE id=?').get(s.credito.id)).n, 1);
});

test('Aumentar un pago conserva lo aplicado y aplica solo el adicional a cuotas aún pendientes', async () => {
  const s = await sale(), a = await pay(s, 5000, -40);
  await pay(s, 8000, -20);
  const b = await body(a, { monto_centavos: 7000 });
  const p = await previsualizarCorreccionPago(a.pago.id, b);
  assert.equal(p.resumen.aplicaciones[0].capital_nuevo_centavos, 5000);
  assert.equal(p.resumen.aplicaciones[1].capital_nuevo_centavos, 2000);
  await corregirPago(a.pago.id, b, admin.id);
  assert.deepEqual((await listCuotasPorCredito(s.credito.id)).map(q => q.saldo_pendiente_centavos), [0, 5000, 10000]);
});

test('Corregir solo fecha no recalcula ni borra mora cobrada, incluso si la fecha correcta era anterior', async () => {
  const negocio = await crearNegocio({ nombre: 'QA mora histórica', dias_gracia: 0, mora_tipo: 'fijo', mora_valor: 500, mora_periodo: 'mes' });
  const s = await sale({ modalidad: 'unico', monto_total_centavos: 100000, plan: { fecha_limite: addDays(hoy, -10) } }, negocio);
  const a = await pay(s, 70000, -5);
  assert.equal(a.aplicaciones[0].mora, 50000);
  const b = await body(a, { fecha_hora: fecha(-30) });
  const preview = await previsualizarCorreccionPago(a.pago.id, b);
  assert.equal(preview.resumen.aplicaciones[0].mora_nueva_centavos, 50000);
  await corregirPago(a.pago.id, b, admin.id);
  const q = (await listCuotasPorCredito(s.credito.id))[0];
  assert.equal(q.mora_pagada_centavos, 50000); assert.equal(q.saldo_pendiente_centavos, 80000);
});

test('La reducción conserva mora cobrada mientras alcanza el importe y recorta primero el último capital', async () => {
  const negocio = await crearNegocio({ nombre: 'QA mora recorte', dias_gracia: 0, mora_tipo: 'fijo', mora_valor: 500, mora_periodo: 'mes' });
  const s = await sale({ modalidad: 'unico', monto_total_centavos: 100000, plan: { fecha_limite: addDays(hoy, -10) } }, negocio), a = await pay(s, 70000, -5);
  const result = await corregirPago(a.pago.id, await body(a, { monto_centavos: 55000 }), admin.id);
  assert.equal(result.resumen.aplicaciones[0].capital_nuevo_centavos, 5000);
  assert.equal(result.resumen.aplicaciones[0].mora_nueva_centavos, 50000);
});

test('Excedente se reduce antes de capital y el saldo a favor utilizado bloquea sin cambios', async () => {
  const s = await sale(), a = await pay(s, 32000);
  const result = await corregirPago(a.pago.id, await body(a, { monto_centavos: 31000 }), admin.id);
  assert.equal(await getSaldoFavor(s.credito.cliente_id, n.id), 1000);
  assert.equal(result.resumen.saldo_posterior_centavos, 0);
  const nuevo = { pago: await getPago(result.reemplazo_id) };
  await db.prepare('UPDATE saldo_favor SET monto_centavos=0 WHERE cliente_id=? AND negocio_id=?').run(s.credito.cliente_id, n.id);
  const b = await body(nuevo, { monto_centavos: 30000 }), before = await snapshot();
  await assert.rejects(corregirPago(nuevo.pago.id, b, admin.id), /excedente.*utilizó/);
  assert.deepEqual(await snapshot(), before);
});

test('Entrega inicial permite fecha anterior al retiro, sin alterar plan, y requiere editor del plan para cambiar monto', async () => {
  const s = await sale({ entrega_inicial_centavos: 6000, plan: { cantidad_cuotas: 3, valor_cuota_centavos: 8000, fecha_primera_cuota: addDays(hoy, 10) } });
  const qBefore = await listCuotasPorCredito(s.credito.id);
  const p = s.entregaInicial;
  await assert.rejects(corregirPago(p.pago.id, await body(p, { monto_centavos: 5000 }), admin.id), /Corregir financiación/);
  const result = await corregirPago(p.pago.id, await body(p, { fecha_hora: fecha(-220) }), admin.id);
  assert.equal((await getPago(result.reemplazo_id)).tipo, 'entrega_inicial');
  assert.equal((await getPago(result.reemplazo_id)).fecha_hora, fecha(-220));
  assert.deepEqual(await listCuotasPorCredito(s.credito.id), qBefore);
  assert.equal((await db.prepare('SELECT entrega_inicial_centavos FROM creditos WHERE id=?').get(s.credito.id)).entrega_inicial_centavos, 6000);
});

test('Backend exige administrador, respeta negocio solicitado y rechaza campos ajenos', async () => {
  const s = await sale(), p = await pay(s, 1000), path = `/pagos/${p.pago.id}/correccion`, b = await body(p);
  for (const [suffix, method] of [['', 'GET'], ['/vista', 'POST'], ['', 'PATCH']]) assert.equal((await api(path + suffix, method, method === 'GET' ? undefined : b, empleado)).status, 403);
  assert.equal((await api(path + '?negocio_id=' + otro.id)).status, 403);
  assert.equal((await api(path, 'PATCH', { ...b, negocio_id: otro.id })).status, 403);
  assert.equal((await api(path, 'PATCH', { ...b, datos: { ...b.datos, cliente_id: 'otro' } })).status, 400);
  assert.equal((await api(path + '/vista', 'POST', b)).status, 200);
  assert.equal((await api(path, 'PATCH', b)).status, 200);
});

test('Reintentos exactos son únicos; petición reutilizada o versión desactualizada rechaza', async () => {
  const s = await sale(), p = await pay(s, 5000), b = await body(p, { monto_centavos: 4000 });
  const result = await corregirPago(p.pago.id, b, admin.id);
  const repeated = await corregirPago(p.pago.id, b, admin.id);
  assert.equal(result.reemplazo_id, repeated.reemplazo_id); assert.equal(repeated.reintentado, true);
  assert.equal((await db.prepare("SELECT count(*)::int n FROM auditoria WHERE entidad_id=? AND accion='corregir_pago'").get(p.pago.id)).n, 1);
  await assert.rejects(corregirPago(p.pago.id, { ...b, datos: { ...b.datos, monto_centavos: 3000 } }, admin.id), /reutilizada/);
  const current = { pago: await getPago(result.reemplazo_id) }, stale = await body(current, { monto_centavos: 3500 });
  await pay(s, 1000);
  await assert.rejects(corregirPago(current.pago.id, stale, admin.id), /cambiaron/);
});

test('Corrección documental conserva caja, agrega aviso incluso al cambiar solo fecha y ajusta comisión por diferencia', async () => {
  const negocio = await crearNegocio({ nombre: 'QA caja comisión', mora_valor: 0 });
  const caja = await guardarCaja(null, { nombre: 'QA caja', activa: true, arqueo: false, modalidad: 'negocio', negocios: [negocio.id] }, admin.id);
  const sesion = await abrirCaja(caja.id, { inicial: 0, solicitud_id: randomUUID() }, admin.id);
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'QA producto', stock: 10, precio_financiado_centavos: 30000 });
  await configurarComision(negocio.id, { activa: true, visible_empleado: false, momento: 'cobro' }, admin.id);
  await configurarProductoComision(negocio.id, producto.id, { tipo: 'porcentaje', valor: 1000 }, admin.id);
  const s = await sale({ items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 30000 }] }, negocio);
  const p = await pay(s, 10000, 0);
  const summary = () => resumenComisiones(negocio.id, null, '0001-01-01', '9999-12-31');
  await liquidarComision(negocio.id, { usuario_id: admin.id, importe_centavos: 500, fecha: hoy, nota: 'Pago QA existente', solicitud_id: randomUUID() }, admin.id);
  const stockBefore = await db.prepare('SELECT stock FROM productos WHERE id=?').get(producto.id);
  const cashBefore = (await detalleCaja(caja.id)).movimientos.filter(x => x.tipo !== 'correccion');
  const p2 = await corregirPago(p.pago.id, await body(p, { monto_centavos: 8000 }), admin.id);
  assert.equal((await summary()).balances[0].generado, 800);
  assert.equal((await summary()).balances[0].pagado, 500);
  const second = { pago: await getPago(p2.reemplazo_id) }, eventsBefore = (await summary()).eventos.length;
  const p3 = await corregirPago(second.pago.id, await body(second, { fecha_hora: fecha(-5) }), admin.id);
  assert.equal((await summary()).eventos.length, eventsBefore);
  const cash = await detalleCaja(caja.id);
  assert.deepEqual(cash.movimientos.filter(x => x.tipo !== 'correccion'), cashBefore);
  assert.equal(cash.sesiones.find(x => x.id === sesion.id).efectivo_esperado, 10000);
  assert.equal(cash.movimientos.filter(x => x.tipo === 'correccion').length, 2);
  const notice = cash.movimientos.find(x => x.tipo === 'correccion' && x.monto === 0);
  assert.equal(notice.sesion_id, null);
  await assert.rejects(resolverPendiente(notice.id, { aplicar: true, sesion_id: sesion.id, motivo: 'QA' }, admin.id), /documental/);
  assert.deepEqual(await db.prepare('SELECT stock FROM productos WHERE id=?').get(producto.id), stockBefore);
  await anularComprobante(p3.comprobante_id, { motivo: 'QA anulación del pago corregido', usuarioId: admin.id });
  const cashAfterVoid = await detalleCaja(caja.id);
  const reversal = cashAfterVoid.movimientos.find(x => x.pago_id === p3.reemplazo_id && x.tipo === 'anulacion');
  assert.equal(reversal.monto, -8000); assert.equal(reversal.sesion_id, null);
  assert.equal(cashAfterVoid.sesiones.find(x => x.id === sesion.id).efectivo_esperado, 10000);
  assert.equal((await summary()).balances[0].pagado, 500);
});

test('Fallo de auditoría revierte pago, recibos, cuotas, aplicaciones y saldo a favor en conjunto', async () => {
  const s = await sale(), p = await pay(s, 6000), b = await body(p, { monto_centavos: 35000 });
  const before = await snapshot();
  await db.exec("CREATE OR REPLACE FUNCTION qa_correccion_pago_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accion='corregir_pago' THEN RAISE EXCEPTION 'QA_CORRECCION_ROLLBACK'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_correccion_pago_fail BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION qa_correccion_pago_fail()");
  try { await assert.rejects(corregirPago(p.pago.id, b, admin.id), /QA_CORRECCION_ROLLBACK/); assert.deepEqual(await snapshot(), before); }
  finally { await db.exec('DROP TRIGGER qa_correccion_pago_fail ON auditoria; DROP FUNCTION qa_correccion_pago_fail()'); }
});
