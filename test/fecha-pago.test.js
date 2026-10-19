import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio, actualizarNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { detalleVenta, devolverVenta } from '../src/services/ventasGestionService.js';
import { guardarCaja, abrirCaja, cerrarCaja } from '../src/services/cajaService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';

// setup-env.js exige una base local descartable terminada en _test antes de importar la conexión.
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a = await crearNegocio({ nombre: 'QA fechas de pago A', mora_valor: 0 });
const b = await crearNegocio({ nombre: 'QA fechas de pago B', mora_valor: 0 });
const admin = await crearUsuario({ email: 'admin@fecha-pago.invalid', password_hash: 'unused' });
const otroAdmin = await crearUsuario({ email: 'otro-admin@fecha-pago.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'empleado@fecha-pago.invalid', password_hash: 'unused', rol: 'empleado' });
await asignarNegocio(empleado.id, a.id, { 'clientes.ver': true, 'clientes.editar': true, 'pagos.registrar': true });
const hoy = todayAR();
const compra = addDays(hoy, -100);
const primera = addDays(hoy, -60);
const instante = (fecha, hora = '12:00:00') => `${fecha}T${hora}-03:00`;
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function api(path, user = admin, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${firmarToken(user)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const path = (pago, negocio = a) => `/pagos/${typeof pago === 'string' ? pago : pago.id}/correccion-fecha?negocio_id=${negocio.id}`;
const previewPath = (pago, negocio = a) => `/pagos/${typeof pago === 'string' ? pago : pago.id}/correccion-fecha/previsualizar?negocio_id=${negocio.id}`;
async function rows(table) {
  return (await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'saldo_favor' ? 'cliente_id,negocio_id' : 'id'}`)).rows;
}
async function finanzas() {
  const tables = ['ventas', 'creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'saldo_favor', 'productos', 'producto_historial', 'caja_sesiones', 'caja_asientos'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await rows(table)])));
}
async function estadoCredito(credito) {
  return {
    credito: (await pool.query('SELECT * FROM creditos WHERE id=$1', [credito.id])).rows[0],
    cuotas: (await pool.query('SELECT * FROM cuotas WHERE credito_id=$1 ORDER BY numero,id', [credito.id])).rows,
    pagos: (await pool.query('SELECT * FROM pagos WHERE credito_id=$1 ORDER BY id', [credito.id])).rows,
    aplicaciones: (await pool.query('SELECT ap.* FROM pago_aplicaciones ap JOIN pagos p ON p.id=ap.pago_id WHERE p.credito_id=$1 ORDER BY ap.id', [credito.id])).rows,
    comprobantes: (await pool.query('SELECT * FROM comprobantes WHERE credito_id=$1 ORDER BY id', [credito.id])).rows,
  };
}
async function auditoria(pago) {
  return (await pool.query("SELECT * FROM auditoria WHERE entidad='pago' AND entidad_id=$1 AND accion='corregir_fecha_pago' ORDER BY fecha_hora,id", [pago.id])).rows;
}
async function operacion({ negocio = a, cliente, cantidad = 3, valor = 100000, entrega = 0, items = [] } = {}) {
  cliente ||= await crearCliente({ nombre: 'Fecha pago', apellido: 'QA', negocio_id: negocio.id });
  const venta = await crearVenta({
    negocio_id: negocio.id, cliente_id: cliente.id, fecha: compra, modalidad: 'cuotas',
    monto_total_centavos: cantidad * valor + entrega, entrega_inicial_centavos: entrega, items,
    usuario_id: admin.id,
    plan: { cantidad_cuotas: cantidad, valor_cuota_centavos: valor, fecha_primera_cuota: primera },
  });
  return { ...venta, cliente, negocio };
}
async function pagar(venta, { fecha = primera, monto = 100000, cuota } = {}) {
  return registrarPago({ credito_id: venta.credito.id, monto_centavos: monto, fecha_hora: instante(fecha), cuota_id: cuota || null, usuario_id: admin.id });
}
async function vista(pago, negocio = a) {
  const response = await api(path(pago, negocio));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function previsualizar(pago, { fecha_hora = instante(addDays(primera, 1)), recalcular = false, negocio = a, version } = {}) {
  version ||= (await vista(pago, negocio)).version;
  const input = { version, fecha_hora, recalcular };
  const response = await api(previewPath(pago, negocio), admin, 'POST', input);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return {
    preview: response.body,
    body: {
      ...input, version_preview: response.body.version_preview, motivo: 'QA corregir fecha real de recepción',
      solicitud_id: randomUUID(), confirmar: true,
    },
  };
}
function importesCuotas(cuotas) {
  return cuotas.map(q => ({
    id: q.id, monto_centavos: q.monto_centavos, saldo_pendiente_centavos: q.saldo_pendiente_centavos,
    mora_generada_centavos: q.mora_generada_centavos, mora_pagada_centavos: q.mora_pagada_centavos,
    mora_perdonada_centavos: q.mora_perdonada_centavos, estado_manual: q.estado_manual,
  }));
}

test('Fecha de pago PG: reproduce los $23.000 de mora y reconstruye tres cuotas sin volver a cobrar ni tocar otra tienda o stock', async () => {
  const producto = await crearProducto({ negocio_id: a.id, nombre: 'iPhone QA fechas', stock: 8 });
  const venta = await operacion({ cantidad: 6, valor: 15500000, entrega: 18000000, items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 111000000 }] });
  const otra = await operacion({ negocio: b, cliente: venta.cliente });
  await pagar(otra, { monto: 12345 });
  // Simula la mora que la carga tardía había congelado antes de registrar pagos históricos.
  await pool.query('UPDATE cuotas SET mora_generada_centavos=$1 WHERE id=$2', [1600000, venta.cuotas[0].id]);
  await pool.query('UPDATE cuotas SET mora_generada_centavos=$1 WHERE id=$2', [700000, venta.cuotas[1].id]);
  const p1 = await pagar(venta, { monto: 15500000 });
  const p2 = await pagar(venta, { monto: 15500000 });
  const p3 = await pagar(venta, { monto: 15500000, fecha: addDays(primera, 30) });
  const antes = await estadoCredito(venta.credito);
  assert.equal(antes.cuotas.reduce((sum, q) => sum + q.saldo_pendiente_centavos, 0), 48800000);
  assert.equal(antes.cuotas[2].saldo_pendiente_centavos, 2300000);
  assert.equal(antes.aplicaciones.reduce((sum, ap) => sum + ap.interes_mora_centavos, 0), 2300000);
  const otraAntes = await estadoCredito(otra.credito);
  const stockAntes = { productos: await rows('productos'), historial: await rows('producto_historial') };
  const completaAntes = await finanzas();
  const info = await vista(p2.pago);
  assert.equal(info.recalculo_disponible, true);
  const { preview, body } = await previsualizar(p2.pago, { recalcular: true });
  assert.equal(preview.antes.capital_pendiente_centavos, 48800000);
  assert.equal(preview.despues.capital_pendiente_centavos, 46500000);
  assert.equal(preview.despues.mora_pendiente_centavos, 0);
  assert.equal(preview.despues.saldo_favor_centavos, 0);
  assert.deepEqual(await finanzas(), completaAntes, 'La vista previa no modifica dinero, recibos ni stock');
  const response = await api(path(p2.pago), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [0, 0, 0, 15500000, 15500000, 15500000]);
  assert.equal(despues.cuotas.reduce((sum, q) => sum + q.mora_pagada_centavos + q.mora_generada_centavos, 0), 0);
  assert.deepEqual(despues.pagos.map(p => [p.id, p.monto_centavos, p.anulado]), antes.pagos.map(p => [p.id, p.monto_centavos, p.anulado]));
  assert.equal(despues.pagos.find(p => p.id === p2.pago.id).fecha_hora, body.fecha_hora);
  assert.equal(despues.pagos.find(p => p.id === p1.pago.id).fecha_hora, p1.pago.fecha_hora);
  assert.equal(despues.pagos.find(p => p.id === p3.pago.id).fecha_hora, p3.pago.fecha_hora);
  for (const original of antes.comprobantes.filter(c => c.pago_id !== venta.entregaInicial.pago.id)) {
    const conservado = despues.comprobantes.find(c => c.id === original.id);
    assert.deepEqual({ fecha_hora: conservado.fecha_hora, monto_centavos: conservado.monto_centavos, numero: conservado.numero },
      { fecha_hora: original.fecha_hora, monto_centavos: original.monto_centavos, numero: original.numero });
    assert.equal(conservado.estado, 'anulado');
    const reemplazo = despues.comprobantes.find(c => c.comprobante_original_id === original.id && c.estado === 'emitido');
    assert.ok(reemplazo, 'Cada comprobante afectado conserva original y reemplazo documental');
    assert.equal(reemplazo.pago_id, original.pago_id);
    assert.equal(reemplazo.monto_centavos, original.monto_centavos);
  }
  const logs = await auditoria(p2.pago);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].empleado, admin.id);
  assert.equal(logs[0].motivo, body.motivo);
  assert.deepEqual(JSON.parse(logs[0].datos_anteriores).aplicaciones, antes.aplicaciones);
  assert.deepEqual(JSON.parse(logs[0].datos_nuevos).despues.aplicaciones, despues.aplicaciones);
  assert.deepEqual(await estadoCredito(otra.credito), otraAntes);
  assert.deepEqual({ productos: await rows('productos'), historial: await rows('producto_historial') }, stockAntes);
});

test('Fecha de pago PG: corregir sólo fecha conserva distribución, capital, mora y el importe cobrado', async () => {
  const venta = await operacion();
  const p = await pagar(venta, { monto: 50000 });
  const antes = await estadoCredito(venta.credito);
  const { preview, body } = await previsualizar(p.pago);
  assert.deepEqual(preview.antes, preview.despues);
  const response = await api(path(p.pago), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.deepEqual(despues.aplicaciones, antes.aplicaciones);
  assert.deepEqual(importesCuotas(despues.cuotas), importesCuotas(antes.cuotas));
  assert.equal(despues.pagos.length, antes.pagos.length);
  assert.equal(despues.pagos[0].monto_centavos, antes.pagos[0].monto_centavos);
  assert.equal(despues.pagos[0].fecha_hora, body.fecha_hora);
  assert.equal(despues.comprobantes.find(c => c.id === p.comprobante.id).estado, 'anulado');
  assert.equal(despues.comprobantes.filter(c => c.estado === 'emitido').length, 1);
});

test('Fecha de pago PG: sólo fecha actualiza cuándo se saldó una cuota y su atraso sin modificar las aplicaciones', async () => {
  const venta = await operacion();
  await pagar(venta, { monto: 50000 });
  const p = await pagar(venta, { monto: 50000, fecha: addDays(primera, 1) });
  const antes = await estadoCredito(venta.credito);
  assert.equal(antes.cuotas[0].fecha_saldada, addDays(primera, 1));
  assert.equal(antes.cuotas[0].dias_atraso_al_pagar, 1);
  const { body } = await previsualizar(p.pago, { fecha_hora: instante(addDays(primera, 3)) });
  const response = await api(path(p.pago), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.equal(despues.cuotas[0].fecha_saldada, addDays(primera, 3));
  assert.equal(despues.cuotas[0].dias_atraso_al_pagar, 3);
  assert.deepEqual(importesCuotas(despues.cuotas), importesCuotas(antes.cuotas));
  assert.deepEqual(despues.aplicaciones, antes.aplicaciones);
});

test('Fecha de pago PG: la entrega inicial permite corregir fecha sin volver a descontar capital ni generar saldo a favor', async () => {
  const venta = await operacion({ entrega: 100000 });
  const p = venta.entregaInicial.pago;
  const antes = await estadoCredito(venta.credito);
  const favorAntes = await rows('saldo_favor');
  const { body } = await previsualizar(p, { fecha_hora: instante(addDays(compra, 1)) });
  const response = await api(path(p), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.deepEqual(importesCuotas(despues.cuotas), importesCuotas(antes.cuotas));
  assert.deepEqual(despues.aplicaciones, antes.aplicaciones);
  assert.equal(despues.pagos.length, 1);
  assert.equal(despues.pagos[0].tipo, 'entrega_inicial');
  assert.equal(despues.pagos[0].monto_centavos, 100000);
  assert.equal(despues.credito.saldo_financiado_centavos, antes.credito.saldo_financiado_centavos);
  assert.deepEqual(await rows('saldo_favor'), favorAntes);
  assert.equal(despues.comprobantes.find(c => c.id === venta.entregaInicial.comprobante.id).estado, 'anulado');
});

test('Fecha de pago PG: normaliza ISO con zona horaria a la fecha argentina y rechaza fechas imposibles, futuras o anteriores a la compra', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const info = await vista(p.pago);
  const antes = await finanzas();
  for (const fecha_hora of ['', '24/08/2026', '2026-02-30T12:00:00-03:00', '2026-01-01T25:00:00-03:00', `${addDays(hoy, 1)}T12:00:00-03:00`, instante(addDays(compra, -1)), primera, null, 123]) {
    const response = await api(previewPath(p.pago), admin, 'POST', { version: info.version, fecha_hora, recalcular: false });
    assert.equal(response.status, 400, JSON.stringify({ fecha_hora, response }));
  }
  assert.deepEqual(await finanzas(), antes);
  const fecha_hora = `${addDays(primera, 2)}T01:00:00Z`;
  const { preview, body } = await previsualizar(p.pago, { fecha_hora });
  assert.equal(preview.fecha_hora, `${addDays(primera, 1)}T22:00:00-03:00`);
  const response = await api(path(p.pago), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await vista(p.pago)).pago.fecha_hora, preview.fecha_hora);
});

test('Fecha de pago PG: la confirmación requiere vista previa exacta, motivo, solicitud y campos permitidos', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const { body } = await previsualizar(p.pago);
  const antes = await finanzas();
  for (const extra of [
    { confirmar: false }, { confirmar: undefined }, { motivo: '' }, { motivo: ' ' }, { motivo: 'x'.repeat(2001) },
    { solicitud_id: 'corta' }, { solicitud_id: undefined }, { version: '' }, { version: undefined },
    { version_preview: '' }, { version_preview: undefined }, { monto_centavos: 1 }, { anulado: 1 }, { negocio_id: b.id },
    { recalcular: 'false' },
  ]) {
    const response = await api(path(p.pago), admin, 'PATCH', { ...body, ...extra });
    assert.equal(response.status, 400, JSON.stringify({ extra, response }));
  }
  for (const extra of [{ fecha_hora: instante(addDays(primera, 2)) }, { recalcular: true }, { version_preview: '0'.repeat(64) }]) {
    const response = await api(path(p.pago), admin, 'PATCH', { ...body, ...extra });
    assert.equal(response.status, 409, JSON.stringify({ extra, response }));
  }
  assert.deepEqual(await finanzas(), antes);
  assert.equal((await auditoria(p.pago)).length, 0);
});

test('Fecha de pago PG: versión anterior y cobro concurrente requieren volver a previsualizar', async () => {
  const venta = await operacion();
  const p = await pagar(venta, { monto: 30000 });
  const { body } = await previsualizar(p.pago, { recalcular: true });
  await pagar(venta, { monto: 20000, fecha: addDays(primera, 2) });
  const antes = await finanzas();
  assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 409);
  assert.equal((await api(previewPath(p.pago), admin, 'POST', { version: body.version, fecha_hora: body.fecha_hora, recalcular: true })).status, 409);
  assert.deepEqual(await finanzas(), antes);
  const first = await previsualizar(p.pago);
  const second = await previsualizar(p.pago, { fecha_hora: instante(addDays(primera, 3)) });
  const responses = await Promise.all([api(path(p.pago), admin, 'PATCH', first.body), api(path(p.pago), admin, 'PATCH', second.body)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await auditoria(p.pago)).length, 1);
});

test('Fecha de pago PG: doble envío y reintento no duplican recibos ni auditoría y no aceptan reutilizar la solicitud', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const { body } = await previsualizar(p.pago, { recalcular: true });
  const [first, duplicate] = await Promise.all([api(path(p.pago), admin, 'PATCH', body), api(path(p.pago), admin, 'PATCH', body)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal((await auditoria(p.pago)).length, 1);
  const despues = await finanzas();
  assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 200);
  assert.deepEqual(await finanzas(), despues);
  for (const extra of [{ fecha_hora: instante(addDays(primera, 5)) }, { motivo: 'Otro motivo QA' }]) {
    assert.equal((await api(path(p.pago), admin, 'PATCH', { ...body, ...extra })).status, 409);
  }
  assert.equal((await api(path(p.pago), otroAdmin, 'PATCH', body)).status, 409);
  assert.deepEqual(await finanzas(), despues);
});

test('Fecha de pago PG: un fallo de auditoría revierte fecha, cuotas, aplicaciones y reemplazos documentales', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const { body } = await previsualizar(p.pago, { recalcular: true });
  const antes = await finanzas();
  await pool.query("CREATE FUNCTION fecha_pago_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accion='corregir_fecha_pago' THEN RAISE EXCEPTION 'FECHA_PAGO_AUDIT_FORCED_FAILURE'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER fecha_pago_audit_fail_trigger BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION fecha_pago_audit_fail()');
  try {
    assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 500);
  } finally {
    await pool.query('DROP TRIGGER fecha_pago_audit_fail_trigger ON auditoria');
    await pool.query('DROP FUNCTION fecha_pago_audit_fail()');
  }
  assert.deepEqual(await finanzas(), antes);
  assert.equal((await auditoria(p.pago)).length, 0);
  assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 200, 'El rollback también revierte la solicitud idempotente');
});

test('Fecha de pago PG: empleados, otro negocio e IDs inexistentes no pueden ver, previsualizar ni corregir pagos', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const { body } = await previsualizar(p.pago);
  const antes = await finanzas();
  for (const [url, method, input] of [[path(p.pago), 'GET'], [previewPath(p.pago), 'POST', body], [path(p.pago), 'PATCH', body]]) {
    assert.equal((await api(url, empleado, method, input)).status, 403);
    assert.equal((await api(url.replace(a.id, b.id), admin, method, input)).status, 403);
    assert.equal((await api(url.replace(p.pago.id, 'pago-inexistente'), admin, method, input)).status, 404);
  }
  assert.deepEqual(await finanzas(), antes);
});

test('Fecha de pago PG: los pagos anulados no admiten corrección ni reconstrucción', async () => {
  const venta = await operacion();
  const p = await pagar(venta);
  const { body } = await previsualizar(p.pago);
  await anularComprobante(p.comprobante.id, { motivo: 'QA pago duplicado', usuarioId: admin.id });
  const antes = await finanzas();
  assert.equal((await api(path(p.pago))).status, 409);
  assert.equal((await api(previewPath(p.pago), admin, 'POST', body)).status, 409);
  assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 409);
  assert.deepEqual(await finanzas(), antes);
});

test('Fecha de pago PG: reconstruir conserva la cuota elegida explícitamente al cobrar', async () => {
  const venta = await operacion();
  const p = await pagar(venta, { cuota: venta.cuotas[2].id, monto: 50000 });
  const stored = (await pool.query('SELECT * FROM pagos WHERE id=$1', [p.pago.id])).rows[0];
  assert.equal(stored.cuota_objetivo_id, venta.cuotas[2].id);
  assert.equal(stored.objetivo_registrado, true);
  const { body } = await previsualizar(p.pago, { recalcular: true });
  const response = await api(path(p.pago), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [100000, 100000, 50000]);
  assert.deepEqual(despues.aplicaciones.map(ap => [ap.pago_id, ap.cuota_id, ap.capital_centavos]), [[p.pago.id, venta.cuotas[2].id, 50000]]);
});

test('Fecha de pago PG: sólo ajusta el delta de saldo a favor del crédito corregido y conserva el de otro crédito y tienda', async () => {
  const venta = await operacion({ cantidad: 1, valor: 100000 });
  const otroCredito = await operacion({ cliente: venta.cliente, cantidad: 1, valor: 100000 });
  const otraTienda = await operacion({ cliente: venta.cliente, negocio: b, cantidad: 1, valor: 100000 });
  await pagar(otroCredito, { monto: 120000 });
  await pagar(otraTienda, { monto: 130000 });
  await pool.query('UPDATE cuotas SET mora_generada_centavos=10000 WHERE id=$1', [venta.cuotas[0].id]);
  const p = await pagar(venta, { monto: 120000 });
  const antesOtro = await estadoCredito(otroCredito.credito);
  const antesTienda = await estadoCredito(otraTienda.credito);
  const antes = (await pool.query('SELECT * FROM saldo_favor WHERE cliente_id=$1 ORDER BY negocio_id', [venta.cliente.id])).rows;
  assert.equal(antes.find(s => s.negocio_id === a.id).monto_centavos, 30000);
  assert.equal(antes.find(s => s.negocio_id === b.id).monto_centavos, 30000);
  const { preview, body } = await previsualizar(p.pago, { recalcular: true });
  assert.equal(preview.despues.saldo_favor_centavos - preview.antes.saldo_favor_centavos, 10000);
  assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 200);
  const despues = (await pool.query('SELECT * FROM saldo_favor WHERE cliente_id=$1 ORDER BY negocio_id', [venta.cliente.id])).rows;
  assert.equal(despues.find(s => s.negocio_id === a.id).monto_centavos, 40000);
  assert.equal(despues.find(s => s.negocio_id === b.id).monto_centavos, 30000);
  assert.deepEqual(await estadoCredito(otroCredito.credito), antesOtro);
  assert.deepEqual(await estadoCredito(otraTienda.credito), antesTienda);
});

test('Fecha de pago PG: cambiar fecha conserva los asientos y el arqueo de una caja cerrada', async () => {
  const negocio = await crearNegocio({ nombre: 'QA fecha pago caja cerrada', mora_valor: 0 });
  const caja = await guardarCaja(null, { nombre: 'QA caja fecha', activa: true, arqueo: false, modalidad: 'negocio', negocios: [negocio.id] }, admin.id);
  const sesion = await abrirCaja(caja.id, { inicial: 1000, solicitud_id: randomUUID() }, admin.id);
  const venta = await operacion({ negocio });
  const p = await pagar(venta, { monto: 50000, fecha: hoy });
  await cerrarCaja(sesion.id, {}, admin.id);
  const antes = { sesiones: await rows('caja_sesiones'), asientos: await rows('caja_asientos') };
  const { body } = await previsualizar(p.pago, { fecha_hora: instante(addDays(hoy, -1)), negocio });
  const response = await api(path(p.pago, negocio), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual({ sesiones: await rows('caja_sesiones'), asientos: await rows('caja_asientos') }, antes);
});

for (const decision of ['estado_manual', 'mora_perdonada', 'devolucion']) {
  test(`Fecha de pago PG: ${decision} requiere conciliación para reconstruir, pero permite corregir sólo la fecha`, async () => {
    const venta = await operacion({ cantidad: 2, valor: 100000, items: [{ descripcion: 'Producto devolución QA', cantidad: 2, precio_unitario_centavos: 100000 }] });
    const p = await pagar(venta, { monto: 50000 });
    if (decision === 'estado_manual') {
      await pool.query("UPDATE cuotas SET estado_manual='incobrable' WHERE id=$1", [venta.cuotas[1].id]);
    } else if (decision === 'mora_perdonada') {
      await pool.query('UPDATE cuotas SET mora_generada_centavos=10000,mora_perdonada_centavos=10000 WHERE id=$1', [venta.cuotas[1].id]);
    } else {
      const detalle = await detalleVenta(a.id, venta.venta.id);
      await devolverVenta(a.id, venta.venta.id, {
        version: detalle.version, solicitud_id: randomUUID(), tipo: 'devolucion', motivo: 'QA devolución parcial', reponer: false,
        items: [{ id: detalle.items[0].id, cantidad: 1 }],
      }, admin.id);
    }
    const info = await vista(p.pago);
    assert.equal(info.recalculo_disponible, false);
    assert.ok(info.motivo_no_recalculo);
    const antes = await finanzas();
    const recalculo = await api(previewPath(p.pago), admin, 'POST', { version: info.version, fecha_hora: instante(addDays(primera, 1)), recalcular: true });
    assert.equal(recalculo.status, 409, JSON.stringify(recalculo.body));
    assert.deepEqual(await finanzas(), antes);
    const { body } = await previsualizar(p.pago);
    assert.equal((await api(path(p.pago), admin, 'PATCH', body)).status, 200);
    const despues = await finanzas();
    assert.deepEqual(despues.pago_aplicaciones, antes.pago_aplicaciones);
    assert.deepEqual(importesCuotas(despues.cuotas), importesCuotas(antes.cuotas));
  });
}

test('Fecha de pago PG: cambiar la política de mora después del cobro bloquea el recálculo y permite corregir sólo fecha', async () => {
  const negocio = await crearNegocio({ nombre: 'QA política histórica de pago', mora_valor: 0 });
  const venta = await operacion({ negocio });
  const p = await pagar(venta, { monto: 50000 });
  const guardado = (await pool.query('SELECT * FROM pagos WHERE id=$1', [p.pago.id])).rows[0];
  assert.equal(guardado.politica_mora.mora_valor, 0, 'El cobro conserva la política vigente al registrarse');
  const ordenGuardado = guardado.politica_mora.orden_aplicacion_pago;
  assert.deepEqual(typeof ordenGuardado === 'string' ? JSON.parse(ordenGuardado) : ordenGuardado, ['mora', 'capital']);
  await actualizarNegocio(negocio.id, { mora_valor: 1 });
  const info = await vista(p.pago, negocio);
  assert.equal(info.recalculo_disponible, false);
  assert.match(info.motivo_no_recalculo, /configuraci[oó]n de mora cambi[oó]/i);
  const antes = await finanzas();
  const bloqueado = await api(previewPath(p.pago, negocio), admin, 'POST', {
    version: info.version, fecha_hora: instante(addDays(primera, 1)), recalcular: true,
  });
  assert.equal(bloqueado.status, 409, JSON.stringify(bloqueado.body));
  assert.deepEqual(await finanzas(), antes);
  const { body } = await previsualizar(p.pago, { negocio });
  const response = await api(path(p.pago, negocio), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await finanzas();
  assert.deepEqual(despues.pago_aplicaciones, antes.pago_aplicaciones);
  assert.deepEqual(importesCuotas(despues.cuotas), importesCuotas(antes.cuotas));
  assert.deepEqual(despues.pagos.find(pago => pago.id === p.pago.id).politica_mora, guardado.politica_mora);
});

test('Fecha de pago PG: aprobar la reconstrucción adopta la política actual para pagos sin snapshot, incluso con destino conocido', async () => {
  const negocio = await crearNegocio({ nombre: 'QA adopción política de pagos anteriores', mora_valor: 0, dias_gracia: 3 });
  const venta = await operacion({ negocio });
  const dirigido = await pagar(venta, { monto: 50000, cuota: venta.cuotas[2].id });
  const automatico = await pagar(venta, { monto: 50000 });
  // Representa pagos anteriores a la migración de política, con y sin destino conocido.
  await pool.query('UPDATE pagos SET politica_mora=NULL WHERE id=$1', [dirigido.pago.id]);
  await pool.query('UPDATE pagos SET politica_mora=NULL,objetivo_registrado=FALSE,cuota_objetivo_id=NULL WHERE id=$1', [automatico.pago.id]);
  const antes = await estadoCredito(venta.credito);
  assert.equal(antes.pagos.find(p => p.id === dirigido.pago.id).objetivo_registrado, true);
  assert.equal((await vista(dirigido.pago, negocio)).recalculo_disponible, true);
  const { body } = await previsualizar(dirigido.pago, { negocio, recalcular: true });
  const response = await api(path(dirigido.pago, negocio), admin, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estadoCredito(venta.credito);
  assert.deepEqual(despues.pagos.map(p => [p.id, p.monto_centavos]), antes.pagos.map(p => [p.id, p.monto_centavos]));
  for (const pago of despues.pagos) {
    assert.equal(pago.objetivo_registrado, true);
    assert.equal(pago.politica_mora.mora_valor, 0);
    assert.equal(pago.politica_mora.dias_gracia, 3);
    assert.deepEqual(pago.politica_mora.orden_aplicacion_pago, ['mora', 'capital']);
  }
  assert.equal(despues.pagos.find(p => p.id === dirigido.pago.id).cuota_objetivo_id, venta.cuotas[2].id);
  assert.equal(despues.pagos.find(p => p.id === automatico.pago.id).cuota_objetivo_id, null);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [50000, 100000, 50000]);
  const log = (await auditoria(dirigido.pago))[0];
  assert.ok(JSON.parse(log.datos_anteriores).pagos.every(p => p.politica_mora === null));
  assert.ok(JSON.parse(log.datos_nuevos).despues.pagos.every(p => p.politica_mora?.dias_gracia === 3));
});
