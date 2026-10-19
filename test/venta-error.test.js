import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { getSaldoFavor, sumarSaldoFavor } from '../src/repositories/pagos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago, registrarEntregaInicial } from '../src/services/pagosService.js';
import { detalleVenta, devolverVenta } from '../src/services/ventasGestionService.js';
import { vistaFinanciacion, corregirFinanciacion } from '../src/services/financiacionService.js';
import { guardarContacto } from '../src/services/contactosCobranzaService.js';
import { guardarCombo } from '../src/services/comisionReglasService.js';
import { configurarComision, configurarProductoComision } from '../src/services/comisionesService.js';
import { ajustarComision } from '../src/services/comisionCierresService.js';
import { guardarCaja, abrirCaja, cerrarCaja } from '../src/services/cajaService.js';
import { moverStock } from '../src/services/productosService.js';
import { resumenGeneral } from '../src/services/dashboardService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';

// setup-env.js rechaza bases remotas o sin sufijo _test antes de importar la conexión.
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@venta-error.invalid', password_hash: 'unused' });
const otroAdmin = await crearUsuario({ email: 'otro-admin@venta-error.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'empleado@venta-error.invalid', password_hash: 'unused', rol: 'empleado' });
const hoy = todayAR();
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
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${firmarToken(user)}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const path = f => `/ventas/${f.venta.id}/eliminar-error?negocio_id=${f.negocio.id}`;
async function filas(tabla) {
  return (await pool.query(`SELECT * FROM ${tabla} ORDER BY ${tabla === 'saldo_favor' ? 'cliente_id,negocio_id' : 'id'}`)).rows;
}
async function snapshot() {
  const tablas = ['ventas', 'venta_detalle', 'creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'saldo_favor',
    'productos', 'producto_historial', 'venta_devoluciones', 'comision_acuerdos', 'comision_eventos', 'comision_generaciones',
    'comision_liquidaciones', 'comision_cierres', 'caja_asientos', 'caja_sesiones', 'recordatorios', 'auditoria'];
  return Object.fromEntries(await Promise.all(tablas.map(async tabla => [tabla, await filas(tabla)])));
}
async function estado(credito) {
  return {
    credito: (await pool.query('SELECT * FROM creditos WHERE id=$1', [credito.id])).rows[0],
    cuotas: (await pool.query('SELECT * FROM cuotas WHERE credito_id=$1 ORDER BY numero,id', [credito.id])).rows,
    pagos: (await pool.query('SELECT * FROM pagos WHERE credito_id=$1 ORDER BY id', [credito.id])).rows,
    aplicaciones: (await pool.query('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=$1 ORDER BY a.id', [credito.id])).rows,
    comprobantes: (await pool.query('SELECT * FROM comprobantes WHERE credito_id=$1 ORDER BY id', [credito.id])).rows,
  };
}
async function logs(f) {
  return (await pool.query("SELECT * FROM auditoria WHERE entidad='venta' AND entidad_id=$1 AND accion='eliminar_error_carga' ORDER BY fecha_hora,id", [f.venta.id])).rows;
}
async function nuevaVenta(negocio, cliente, { producto, cantidad = 1, items, total = 100000, entrega = 0, vendedor = admin } = {}) {
  items ||= producto ? [{ producto_id: producto.id, cantidad, precio_unitario_centavos: total / cantidad }] : [];
  return crearVenta({
    negocio_id: negocio.id, cliente_id: cliente.id, fecha: hoy, modalidad: 'cuotas', items,
    monto_total_centavos: total, entrega_inicial_centavos: entrega, medio_pago_entrega: 'efectivo',
    usuario_id: admin.id, comision_usuario_id: vendedor.id,
    plan: { cantidad_cuotas: 1, valor_cuota_centavos: total - entrega, fecha_primera_cuota: addDays(hoy, 30) },
  });
}
async function fixture({ stock = 8, total = 100000, entrega = 0 } = {}) {
  const negocio = await crearNegocio({ nombre: 'QA venta cargada por error', mora_valor: 0 });
  const cliente = await crearCliente({ nombre: 'Venta', apellido: 'Error QA', negocio_id: negocio.id });
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto QA venta error', stock });
  const operacion = await nuevaVenta(negocio, cliente, { producto, total, entrega });
  return { ...operacion, negocio, cliente, producto };
}
async function cobrar(f, monto) {
  return registrarPago({ credito_id: f.credito.id, monto_centavos: monto, fecha_hora: `${hoy}T12:00:00-03:00`, usuario_id: admin.id });
}
async function vista(f) {
  const response = await api(path(f));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function solicitud(f, extra = {}) {
  return { negocio_id: f.negocio.id, version: (await vista(f)).version, solicitud_id: randomUUID(), motivo: 'QA venta duplicada cargada por error', confirmar: true, confirmar_pagos_erroneos: true, ...extra };
}
async function corregir(f, body = undefined) {
  return api(path(f), admin, 'POST', body || await solicitud(f));
}
async function movimiento(f, tipo, cantidad, stockEsperado) {
  return moverStock(f.producto.id, f.negocio.id, {
    tipo, cantidad, stock_esperado: stockEsperado, motivo: 'QA inventario posterior a la venta', solicitud_id: randomUUID(),
  }, admin.id);
}

test('Venta error PG: de 8 a 7, luego 6 por duplicado, restaura sólo a 7 y conserva la venta real; reintentos nunca llevan a 8', async () => {
  const real = await fixture();
  assert.equal((await getProducto(real.producto.id)).stock, 7);
  const duplicada = { ...await nuevaVenta(real.negocio, real.cliente, { producto: real.producto }), negocio: real.negocio, cliente: real.cliente, producto: real.producto };
  assert.equal((await getProducto(real.producto.id)).stock, 6);
  const contacto = await guardarContacto({ clienteId: real.cliente.id, negocioId: real.negocio.id, cuotaId: duplicada.cuotas[0].id, fecha: addDays(hoy, 1), nota: 'QA contacto del duplicado', solicitudId: randomUUID(), usuarioId: admin.id });
  const antesReal = await estado(real.credito);
  const antes = await snapshot();
  const preview = await vista(duplicada);
  assert.equal(preview.permitido, true);
  assert.equal(preview.capital_pendiente_centavos, 100000);
  assert.equal(preview.total_pagos_centavos, 0);
  assert.deepEqual(preview.pagos, []);
  assert.deepEqual(preview.productos.map(p => [p.id, p.cantidad_reponer, p.stock_actual, p.stock_despues]), [[real.producto.id, 1, 6, 7]]);
  assert.deepEqual(await snapshot(), antes, 'La vista previa no modifica stock ni registros financieros');
  const body = await solicitud(duplicada);
  const response = await corregir(duplicada, body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await getProducto(real.producto.id)).stock, 7);
  assert.deepEqual(await estado(real.credito), antesReal);
  const anulada = await estado(duplicada.credito);
  assert.equal(anulada.cuotas.length, 1);
  assert.equal(anulada.cuotas[0].saldo_pendiente_centavos, 0);
  assert.equal(anulada.cuotas[0].estado_manual, 'anulada');
  assert.equal((await pool.query('SELECT estado FROM recordatorios WHERE id=$1', [contacto.id])).rows[0].estado, 'cancelado');
  const venta = (await pool.query('SELECT * FROM ventas WHERE id=$1', [duplicada.venta.id])).rows[0];
  assert.equal(venta.estado, 'anulada');
  assert.equal(Number(venta.devolucion_centavos), venta.monto_total_centavos);
  assert.equal((await pool.query('SELECT * FROM venta_devoluciones WHERE venta_id=$1', [duplicada.venta.id])).rowCount, 0, 'Un error de carga no crea una devolución real');
  const despues = await snapshot();
  assert.equal((await corregir(duplicada, body)).status, 200);
  assert.deepEqual(await snapshot(), despues);
  assert.equal((await corregir(duplicada, { ...body, solicitud_id: randomUUID() })).status, 409);
  assert.equal((await corregir(duplicada, { ...body, motivo: 'Otro motivo QA' })).status, 409);
  assert.equal((await api(path(duplicada), otroAdmin, 'POST', body)).status, 409);
  assert.equal((await getProducto(real.producto.id)).stock, 7);
  assert.equal((await vista(duplicada)).permitido, false);
  const audit = await logs(duplicada);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].empleado, admin.id);
  assert.equal(audit[0].motivo, body.motivo);
  assert.equal(JSON.parse(audit[0].datos_anteriores).venta.id, duplicada.venta.id);
  assert.equal(JSON.parse(audit[0].datos_nuevos).solicitud_id, body.solicitud_id);
});

test('Venta error PG: doble envío concurrente repone una sola vez y dos solicitudes distintas no duplican la corrección', async () => {
  for (const mismoId of [true, false]) {
    const f = await fixture();
    const body = await solicitud(f);
    const segundo = mismoId ? body : { ...body, solicitud_id: randomUUID() };
    const respuestas = await Promise.all([corregir(f, body), corregir(f, segundo)]);
    assert.deepEqual(respuestas.map(r => r.status).sort(), mismoId ? [200, 200] : [200, 409]);
    assert.equal((await getProducto(f.producto.id)).stock, 8);
    assert.equal((await logs(f)).length, 1);
  }
});

test('Venta error PG: repone componentes que se descontaron realmente aunque cambie la receta del combo', async () => {
  const negocio = await crearNegocio({ nombre: 'QA combo histórico error', mora_valor: 0 });
  const cliente = await crearCliente({ nombre: 'Combo', apellido: 'QA', negocio_id: negocio.id });
  const p1 = await crearProducto({ negocio_id: negocio.id, nombre: 'Componente uno', stock: 8 });
  const p2 = await crearProducto({ negocio_id: negocio.id, nombre: 'Componente dos', stock: 9 });
  const nuevo = await crearProducto({ negocio_id: negocio.id, nombre: 'Componente receta nueva', stock: 10 });
  const combo = await crearProducto({ negocio_id: negocio.id, nombre: 'Combo QA' });
  await guardarCombo(negocio.id, combo.id, { componentes: [{ producto_id: p1.id, cantidad: 1 }, { producto_id: p2.id, cantidad: 2 }] }, admin.id);
  const f = { ...await nuevaVenta(negocio, cliente, { total: 300000, items: [
    { producto_id: combo.id, cantidad: 2, precio_unitario_centavos: 100000 },
    { producto_id: p1.id, cantidad: 1, precio_unitario_centavos: 100000 },
  ] }), negocio };
  assert.equal((await getProducto(p1.id)).stock, 5);
  assert.equal((await getProducto(p2.id)).stock, 5);
  const historial = (await pool.query("SELECT * FROM producto_historial WHERE venta_id=$1 AND tipo='venta' ORDER BY id", [f.venta.id])).rows;
  await guardarCombo(negocio.id, combo.id, { componentes: [{ producto_id: nuevo.id, cantidad: 4 }] }, admin.id);
  const preview = await vista(f);
  assert.deepEqual(preview.productos.map(p => [p.id, p.cantidad_reponer]).sort(), [[p1.id, 3], [p2.id, 4]].sort());
  const response = await corregir(f);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await getProducto(p1.id)).stock, 8);
  assert.equal((await getProducto(p2.id)).stock, 9);
  assert.equal((await getProducto(nuevo.id)).stock, 10);
  assert.deepEqual((await pool.query("SELECT * FROM producto_historial WHERE venta_id=$1 AND tipo='venta' ORDER BY id", [f.venta.id])).rows, historial);
});

test('Venta error PG: activar stock después de una venta sin control no inventa una unidad para reponer', async () => {
  const f = await fixture({ stock: null });
  await movimiento(f, 'conteo', 5, null);
  const preview = await vista(f);
  assert.equal(preview.productos.reduce((sum, p) => sum + p.cantidad_reponer, 0), 0);
  assert.equal((await corregir(f)).status, 200);
  assert.equal((await getProducto(f.producto.id)).stock, 5);
});

test('Venta error PG: si el control de stock se desactivó, conserva null y explica la revisión manual', async () => {
  const f = await fixture({ stock: 5 });
  await movimiento(f, 'sin_control', null, 4);
  const preview = await vista(f);
  assert.equal(preview.productos.reduce((sum, p) => sum + p.cantidad_reponer, 0), 0);
  assert.ok(preview.advertencias.length > 0);
  assert.equal((await corregir(f)).status, 200);
  assert.equal((await getProducto(f.producto.id)).stock, null);
});

test('Venta error PG: una venta manual sin producto no aumenta el inventario', async () => {
  const negocio = await crearNegocio({ nombre: 'QA error manual', mora_valor: 0 });
  const cliente = await crearCliente({ nombre: 'Manual', apellido: 'QA', negocio_id: negocio.id });
  await crearProducto({ negocio_id: negocio.id, nombre: 'Producto ajeno a la venta', stock: 8 });
  const f = { ...await nuevaVenta(negocio, cliente, { items: [{ descripcion: 'Carga manual', cantidad: 1, precio_unitario_centavos: 100000 }] }), negocio };
  const productos = await filas('productos');
  assert.deepEqual((await vista(f)).productos, []);
  assert.equal((await corregir(f)).status, 200);
  assert.deepEqual(await filas('productos'), productos);
});

async function fixtureFinanciero() {
  const negocio = await crearNegocio({ nombre: 'QA pagos erróneos y caja', mora_valor: 0 });
  const otroNegocio = await crearNegocio({ nombre: 'QA otra tienda conservada', mora_valor: 0 });
  const cliente = await crearCliente({ nombre: 'Pagos', apellido: 'QA', negocio_id: negocio.id });
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto financiero QA', stock: 8 });
  const creditoReal = await nuevaVenta(negocio, cliente);
  await registrarPago({ credito_id: creditoReal.credito.id, monto_centavos: 110000, fecha_hora: `${hoy}T12:00:00-03:00`, usuario_id: admin.id });
  const otraTienda = await nuevaVenta(otroNegocio, cliente);
  await registrarPago({ credito_id: otraTienda.credito.id, monto_centavos: 130000, fecha_hora: `${hoy}T12:00:00-03:00`, usuario_id: admin.id });
  await asignarNegocio(empleado.id, negocio.id, { 'ventas.crear': true, 'clientes.ver': true, 'pagos.registrar': true });
  await configurarComision(negocio.id, { activa: true, visible_empleado: false, momento: 'venta' }, admin.id);
  await configurarProductoComision(negocio.id, producto.id, { tipo: 'fijo', valor: 2500 }, admin.id);
  const caja = await guardarCaja(null, { nombre: 'QA caja de error', activa: true, arqueo: false, modalidad: 'negocio', negocios: [negocio.id] }, admin.id);
  const sesion = await abrirCaja(caja.id, { inicial: 1000, solicitud_id: randomUUID() }, admin.id);
  const f = { ...await nuevaVenta(negocio, cliente, { producto, total: 200000, entrega: 50000, vendedor: empleado }), negocio, cliente, producto };
  await cobrar(f, 25000);
  await cobrar(f, 145000);
  await pool.query('UPDATE cuotas SET mora_generada_centavos=4000 WHERE id=$1', [f.cuotas[0].id]);
  await cerrarCaja(sesion.id, {}, admin.id);
  return { ...f, caja, sesion, otroNegocio, creditoReal, otraTienda };
}

test('Venta error PG: anula entrega y pagos conservando originales, resta sólo su excedente, revierte comisión y deja aviso documental sin tocar caja cerrada ni otra tienda', async () => {
  const f = await fixtureFinanciero();
  const antes = await estado(f.credito);
  const realAntes = await estado(f.creditoReal.credito);
  const otraAntes = await estado(f.otraTienda.credito);
  const sesiones = await filas('caja_sesiones');
  const asientos = await filas('caja_asientos');
  const eventos = await filas('comision_eventos');
  const generaciones = await filas('comision_generaciones');
  assert.equal(await getSaldoFavor(f.cliente.id, f.negocio.id), 30000);
  assert.equal(await getSaldoFavor(f.cliente.id, f.otroNegocio.id), 30000);
  assert.equal((await resumenGeneral(f.negocio.id)).cobradoHoyCentavos, 330000);
  const preview = await vista(f);
  assert.equal(preview.total_pagos_centavos, 220000);
  assert.equal(preview.pagos.length, 3);
  const body = await solicitud(f);
  const response = await corregir(f, body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await estado(f.credito);
  assert.equal(despues.pagos.length, antes.pagos.length);
  assert.deepEqual(despues.pagos.map(p => [p.id, p.tipo, p.monto_centavos, p.fecha_hora]), antes.pagos.map(p => [p.id, p.tipo, p.monto_centavos, p.fecha_hora]));
  assert.ok(despues.pagos.every(p => p.anulado === 1));
  assert.deepEqual(despues.aplicaciones, antes.aplicaciones);
  assert.deepEqual(despues.comprobantes.map(c => [c.id, c.numero, c.monto_centavos, c.fecha_hora]), antes.comprobantes.map(c => [c.id, c.numero, c.monto_centavos, c.fecha_hora]));
  assert.ok(despues.comprobantes.every(c => c.estado === 'anulado'));
  assert.ok(despues.cuotas.every(q => q.estado_manual === 'anulada' && q.saldo_pendiente_centavos === 0));
  assert.ok(despues.cuotas.every(q => q.mora_pagada_centavos + q.mora_perdonada_centavos >= q.mora_generada_centavos));
  assert.equal(await getSaldoFavor(f.cliente.id, f.negocio.id), 10000);
  assert.equal(await getSaldoFavor(f.cliente.id, f.otroNegocio.id), 30000);
  const resumen = await resumenGeneral(f.negocio.id);
  assert.equal(resumen.cobradoHoyCentavos, 110000);
  assert.equal(resumen.capitalColocadoCentavos, 100000, 'El financiamiento erróneo deja de contar como capital colocado');
  assert.equal(resumen.ventasFinalizadas, 1, 'Sólo permanece la venta real finalizada');
  assert.equal(resumen.vendidoTotalCentavos, 100000);
  const ficha = await api(`/clientes/${f.cliente.id}?negocio_id=${f.negocio.id}`);
  assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
  assert.equal(ficha.body.historial.cantidadCompras, 1);
  assert.equal(ficha.body.historial.cuotasTotales, 1);
  assert.equal(ficha.body.historial.cuotasPagadas, 1);
  assert.equal(ficha.body.historial.comprasFinalizadas, 1);
  assert.equal(ficha.body.historial.totalCobradoCentavos, 110000);
  assert.deepEqual(await estado(f.creditoReal.credito), realAntes);
  assert.deepEqual(await estado(f.otraTienda.credito), otraAntes);
  assert.deepEqual(await filas('caja_sesiones'), sesiones);
  const despuesAsientos = await filas('caja_asientos');
  for (const asiento of asientos) assert.deepEqual(despuesAsientos.find(a => a.id === asiento.id), asiento);
  const avisos = despuesAsientos.filter(a => !asientos.some(anterior => anterior.id === a.id));
  assert.equal(avisos.length, 3);
  assert.ok(avisos.every(a => a.tipo === 'correccion' && a.sesion_id === null && a.monto < 0));
  assert.equal(avisos.reduce((sum, a) => sum + a.monto, 0), -220000);
  assert.deepEqual(avisos.map(a => a.pago_id).sort(), antes.pagos.map(p => p.id).sort());
  const acuerdo = (await pool.query('SELECT * FROM comision_acuerdos WHERE venta_id=$1', [f.venta.id])).rows[0];
  const despuesEventos = await filas('comision_eventos');
  const despuesGeneraciones = await filas('comision_generaciones');
  for (const original of eventos) assert.deepEqual(despuesEventos.find(e => e.id === original.id), original);
  for (const original of generaciones) assert.deepEqual(despuesGeneraciones.find(e => e.id === original.id), original);
  assert.equal(despuesEventos.filter(e => e.acuerdo_id === acuerdo.id).reduce((sum, e) => sum + Number(e.importe_centavos), 0), 0);
  assert.equal(despuesGeneraciones.filter(e => e.acuerdo_id === acuerdo.id).reduce((sum, e) => sum + Number(e.importe_centavos), 0), 0);
  const audit = (await logs(f))[0];
  assert.deepEqual(JSON.parse(audit.datos_anteriores).aplicaciones, antes.aplicaciones);
  assert.deepEqual(JSON.parse(audit.datos_nuevos).despues.aplicaciones, despues.aplicaciones);
  const unaVez = await snapshot();
  assert.equal((await corregir(f, body)).status, 200);
  assert.deepEqual(await snapshot(), unaVez);
});

test('Venta error PG: una venta al contado anulada no permite recrear su entrega ni corregir la financiación', async () => {
  const f = await fixture({ total: 100000, entrega: 100000 });
  assert.equal(f.cuotas.length, 0);
  const financiacion = await vistaFinanciacion(f.credito.id);
  assert.equal((await corregir(f)).status, 200);
  const antes = await snapshot();
  const correccionPath = `/ventas/creditos/${f.credito.id}/correccion?negocio_id=${f.negocio.id}`;
  assert.equal((await api(correccionPath)).status, 409);
  const response = await api(correccionPath, admin, 'PATCH', {
    version: financiacion.version, solicitud_id: randomUUID(), motivo: 'QA intento de reabrir entrega anulada', confirmar_correccion_pagos: true,
    datos: { monto_total_centavos: 100000, entrega_inicial_centavos: 100000, fecha_inicio: hoy,
      producto_descripcion: '', condiciones: '', cuotas: [] },
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  await assert.rejects(() => registrarEntregaInicial({
    credito_id: f.credito.id, monto_centavos: 100000, fecha_hora: `${hoy}T12:00:00-03:00`, medio_pago: 'efectivo', usuario_id: admin.id,
  }), error => error.status === 409);
  assert.deepEqual(await snapshot(), antes);
  assert.equal((await getProducto(f.producto.id)).stock, 8);
  const despues = await estado(f.credito);
  assert.equal(despues.pagos.length, 1);
  assert.equal(despues.pagos[0].anulado, 1);
  assert.equal(despues.comprobantes.length, 1);
  assert.equal(despues.comprobantes[0].estado, 'anulado');
});

test('Venta error PG: un excedente ya consumido requiere conciliación y no crea deuda ni saldo a favor ficticios', async () => {
  const f = await fixture();
  await cobrar(f, 120000);
  await sumarSaldoFavor(f.cliente.id, f.negocio.id, -20000);
  const preview = await vista(f);
  assert.equal(preview.permitido, false);
  assert.ok(preview.motivo_bloqueo);
  const antes = await snapshot();
  assert.equal((await corregir(f)).status, 409);
  assert.deepEqual(await snapshot(), antes);
});

test('Venta error PG: una reposición, un pago o un cambio de saldo a favor invalidan la vista previa anterior', async () => {
  const f = await fixture();
  for (const cambio of [() => movimiento(f, 'reposicion', 2, 7), () => cobrar(f, 1000), () => sumarSaldoFavor(f.cliente.id, f.negocio.id, 1)]) {
    const body = await solicitud(f);
    await cambio();
    const antes = await snapshot();
    assert.equal((await corregir(f, body)).status, 409);
    assert.deepEqual(await snapshot(), antes);
  }
  assert.equal((await getProducto(f.producto.id)).stock, 9);
  assert.equal((await corregir(f)).status, 200);
  assert.equal((await getProducto(f.producto.id)).stock, 10);
});

test('Venta error API: requiere administrador, negocio coherente y confirmación explícita de los pagos erróneos', async () => {
  const f = await fixture({ entrega: 10000 });
  const otro = await crearNegocio({ nombre: 'QA scope venta error', mora_valor: 0 });
  await asignarNegocio(empleado.id, f.negocio.id, { 'ventas.crear': true, 'pagos.registrar': true, 'clientes.ver': true });
  const body = await solicitud(f);
  const antes = await snapshot();
  for (const method of ['GET', 'POST']) {
    assert.equal((await api(path(f), null, method, method === 'POST' ? body : undefined)).status, 401);
    assert.equal((await api(path(f), empleado, method, method === 'POST' ? body : undefined)).status, 403);
  }
  const wrong = await api(path(f).replace(f.negocio.id, otro.id));
  assert.ok([403, 404].includes(wrong.status));
  assert.equal((await api(path(f).replace(f.venta.id, 'venta-inexistente'))).status, 404);
  assert.equal((await api(`/ventas/${f.venta.id}/eliminar-error`)).status, 400);
  for (const extra of [
    { negocio_id: otro.id }, { confirmar: false }, { confirmar: undefined }, { confirmar_pagos_erroneos: false },
    { confirmar_pagos_erroneos: undefined }, { version: '' }, { version: undefined }, { solicitud_id: 'corta' },
    { motivo: ' ' }, { motivo: 'x'.repeat(2001) }, { monto_total_centavos: 1 }, { reponer: false },
  ]) {
    const response = await corregir(f, { ...body, ...extra });
    assert.equal(response.status, 400, JSON.stringify({ extra, response }));
  }
  assert.deepEqual(await snapshot(), antes);
});

for (const tipo of ['devolucion', 'estado_manual', 'mora_perdonada', 'ajuste_comision', 'aplicaciones_inconsistentes', 'financiacion_corregida_despues_de_pagos']) {
  test(`Venta error PG: ${tipo} previo requiere conciliación y no altera dinero ni existencias`, async () => {
    const f = await fixture();
    if (tipo === 'devolucion') {
      const detalle = await detalleVenta(f.negocio.id, f.venta.id);
      await devolverVenta(f.negocio.id, f.venta.id, { version: detalle.version, solicitud_id: randomUUID(), tipo: 'devolucion', motivo: 'QA devolución previa', reponer: true, items: [{ id: detalle.items[0].id, cantidad: 1 }] }, admin.id);
    } else if (tipo === 'estado_manual') {
      await pool.query("UPDATE cuotas SET estado_manual='incobrable' WHERE id=$1", [f.cuotas[0].id]);
    } else if (tipo === 'mora_perdonada') {
      await pool.query('UPDATE cuotas SET mora_generada_centavos=1000,mora_perdonada_centavos=1000 WHERE id=$1', [f.cuotas[0].id]);
    } else if (tipo === 'ajuste_comision') {
      await configurarComision(f.negocio.id, { activa: true, visible_empleado: false, momento: 'venta' }, admin.id);
      await configurarProductoComision(f.negocio.id, f.producto.id, { tipo: 'fijo', valor: 2500 }, admin.id);
      const segunda = await nuevaVenta(f.negocio, f.cliente, { producto: f.producto });
      Object.assign(f, segunda);
      const acuerdo = (await pool.query('SELECT * FROM comision_acuerdos WHERE venta_id=$1', [f.venta.id])).rows[0];
      await ajustarComision(f.negocio.id, { acuerdo_id: acuerdo.id, solicitud_id: randomUUID(), importe_centavos: 500, motivo: 'QA incentivo manual previo' }, admin.id);
    } else if (tipo === 'aplicaciones_inconsistentes') {
      const pago = await cobrar(f, 50000);
      await pool.query('UPDATE pago_aplicaciones SET capital_centavos=60000 WHERE pago_id=$1', [pago.pago.id]);
    } else {
      await cobrar(f, 25000);
      const preview = await vistaFinanciacion(f.credito.id);
      await corregirFinanciacion(f.credito.id, {
        version: preview.version, solicitud_id: randomUUID(), motivo: 'QA importe corregido después del pago', confirmar_correccion_pagos: true,
        datos: { monto_total_centavos: 110000, entrega_inicial_centavos: 0, fecha_inicio: preview.credito.fecha_inicio,
          producto_descripcion: '', condiciones: '', cuotas: preview.cuotas.map(q => ({ id: q.id, monto_centavos: 110000, fecha_vencimiento: q.fecha_vencimiento })) },
      }, admin.id);
    }
    const preview = await vista(f);
    assert.equal(preview.permitido, false);
    assert.ok(preview.motivo_bloqueo);
    const antes = await snapshot();
    assert.equal((await corregir(f)).status, 409);
    assert.deepEqual(await snapshot(), antes);
  });
}

test('Venta error PG: si falla la auditoría se revierten reposición, pagos, saldo, comisión y avisos de caja', async () => {
  const f = await fixtureFinanciero();
  const body = await solicitud(f);
  const antes = await snapshot();
  await pool.query("CREATE FUNCTION venta_error_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accion='eliminar_error_carga' THEN RAISE EXCEPTION 'VENTA_ERROR_AUDIT_FORCED_FAILURE'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER venta_error_audit_fail_trigger BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION venta_error_audit_fail()');
  try {
    assert.equal((await corregir(f, body)).status, 500);
  } finally {
    await pool.query('DROP TRIGGER venta_error_audit_fail_trigger ON auditoria');
    await pool.query('DROP FUNCTION venta_error_audit_fail()');
  }
  assert.deepEqual(await snapshot(), antes);
  assert.equal((await logs(f)).length, 0);
  assert.equal((await corregir(f, body)).status, 200, 'El rollback deja disponible el mismo identificador de solicitud');
});
