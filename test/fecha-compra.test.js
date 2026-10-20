import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays, addMonths } from '../src/lib/dates.js';
import { registrarPago } from '../src/services/pagosService.js';
import { configurarComision, configurarProductoComision, resumenComisiones } from '../src/services/comisionesService.js';
import { aprobarCierre, publicarCierre, rangoMes, vistaCierre } from '../src/services/comisionCierresService.js';

// setup-env sólo permite una base local descartable, terminada en _test.
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@fecha-compra.invalid', nombre: 'Dueño QA', password_hash: 'unused' });
const vendedor = await crearUsuario({ email: 'vendedor@fecha-compra.invalid', nombre: 'Vendedor QA', rol: 'empleado', password_hash: 'unused' });
const hoy = todayAR();
const inicioActual = `${hoy.slice(0, 7)}-01`;
const compra = `${addMonths(inicioActual, -3).slice(0, 7)}-10`;
const primera = addMonths(compra, 1);
const segunda = addMonths(compra, 2);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function postVenta(body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ventas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firmarToken(admin)}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function fixture(momento = 'venta') {
  const negocio = await crearNegocio({ nombre: `Fecha de compra ${randomUUID()}`, mora_valor: 0 });
  await asignarNegocio(vendedor.id, negocio.id, { 'ventas.crear': true, 'clientes.ver': true, 'productos.ver': true });
  const cliente = await crearCliente({ nombre: 'Cliente', apellido: 'Histórico QA', negocio_id: negocio.id });
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto QA', stock: 10, precio_financiado_centavos: 100000 });
  await configurarComision(negocio.id, { activa: true, visible_empleado: false, momento }, admin.id);
  await configurarProductoComision(negocio.id, producto.id, { tipo: 'fijo', valor: 10000 }, admin.id);
  const body = {
    negocio_id: negocio.id, cliente_id: cliente.id, comision_usuario_id: vendedor.id,
    fecha: compra, modalidad: 'cuotas', monto_total_centavos: 100000, entrega_inicial_centavos: 20000,
    medio_pago_entrega: 'efectivo', items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 100000 }],
    plan: { cantidad_cuotas: 2, valor_cuota_centavos: 40000, fecha_primera_cuota: primera, intervalo_dias: 30 },
    solicitud_id: randomUUID(),
  };
  return { negocio, cliente, producto, body };
}
async function crear(body) {
  const response = await postVenta(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
async function resumen(negocioId, mes) {
  const { desde, hasta } = rangoMes(mes);
  return resumenComisiones(negocioId, vendedor.id, desde, hasta);
}
async function acuerdo(ventaId) {
  return db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(ventaId);
}

test('Compra histórica: la fecha de venta y su comisión pertenecen al mes comprado, mientras las cuotas vencen después', async () => {
  const f = await fixture();
  const venta = await crear(f.body);
  assert.equal(venta.venta.fecha, compra);
  assert.equal(venta.credito.fecha_inicio, compra);
  assert.deepEqual(venta.cuotas.map(q => q.fecha_vencimiento), [primera, segunda]);
  assert.deepEqual(venta.cuotas.map(q => q.saldo_pendiente_centavos), [40000, 40000]);
  assert.equal(venta.credito.saldo_financiado_centavos, 80000);
  assert.equal(venta.entregaInicial.pago.fecha_hora, `${compra}T12:00:00-03:00`);
  assert.equal(venta.entregaInicial.comprobante.fecha_hora, `${compra}T12:00:00-03:00`);
  assert.equal(venta.entregaInicial.pago.monto_centavos, 20000);
  assert.equal((await getProducto(f.producto.id)).stock, 9);
  const a = await acuerdo(venta.venta.id);
  const altas = await db.prepare('SELECT * FROM comision_generaciones WHERE acuerdo_id=?').all(a.id);
  const eventos = await db.prepare('SELECT * FROM comision_eventos WHERE acuerdo_id=?').all(a.id);
  assert.equal(a.usuario_id, vendedor.id);
  assert.equal(altas.length, 1);
  assert.equal(altas[0].fecha, compra);
  assert.equal(altas[0].importe_centavos, 10000);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].fecha, compra);
  assert.equal(eventos[0].fecha_origen, compra);
  assert.equal(eventos[0].importe_centavos, 10000);
  assert.deepEqual((await resumen(f.negocio.id, compra.slice(0, 7))).totales, {
    generada: 10000, liquidable: 10000, pagada: 0, operaciones: 1,
  });
  assert.deepEqual((await resumen(f.negocio.id, primera.slice(0, 7))).totales, {
    generada: 0, liquidable: 0, pagada: 0, operaciones: 0,
  });
});

test('Compra histórica: reintentos conservan la misma fecha, recibo y stock; reutilizar la solicitud con otra fecha devuelve 409', async () => {
  const f = await fixture();
  const [uno, dos] = await Promise.all([postVenta(f.body), postVenta(f.body)]);
  assert.equal(uno.status, 201, JSON.stringify(uno.body));
  assert.equal(dos.status, 201, JSON.stringify(dos.body));
  assert.equal(uno.body.venta.id, dos.body.venta.id);
  assert.equal(uno.body.entregaInicial.pago.id, dos.body.entregaInicial.pago.id);
  assert.equal(uno.body.entregaInicial.comprobante.id, dos.body.entregaInicial.comprobante.id);
  assert.equal(uno.body.venta.fecha, compra);
  const otroDia = await postVenta({ ...f.body, fecha: addDays(compra, -1) });
  assert.equal(otroDia.status, 409, JSON.stringify(otroDia.body));
  assert.equal((await getProducto(f.producto.id)).stock, 9);
  const counts = await db.prepare(`SELECT
    (SELECT count(*)::int FROM ventas WHERE negocio_id=?) ventas,
    (SELECT count(*)::int FROM pagos WHERE negocio_id=?) pagos,
    (SELECT count(*)::int FROM comprobantes WHERE negocio_id=?) comprobantes,
    (SELECT count(*)::int FROM comision_acuerdos WHERE negocio_id=?) acuerdos,
    (SELECT count(*)::int FROM comision_generaciones g JOIN comision_acuerdos a ON a.id=g.acuerdo_id WHERE a.negocio_id=?) generaciones`).get(
    f.negocio.id, f.negocio.id, f.negocio.id, f.negocio.id, f.negocio.id,
  );
  assert.deepEqual(counts, { ventas: 1, pagos: 1, comprobantes: 1, acuerdos: 1, generaciones: 1 });
});

test('Comisión al cobrar: se genera en la compra y se habilita proporcionalmente en las fechas reales de entrega y pagos', async () => {
  const f = await fixture('cobro');
  const venta = await crear(f.body);
  let compraResumen = await resumen(f.negocio.id, compra.slice(0, 7));
  assert.equal(compraResumen.totales.generada, 10000);
  assert.equal(compraResumen.totales.liquidable, 2000, 'La entrega inicial habilita sólo su proporción');
  assert.equal((await resumen(f.negocio.id, primera.slice(0, 7))).totales.liquidable, 0, 'El vencimiento no implica cobro');
  await registrarPago({ credito_id: venta.credito.id, cuota_id: venta.cuotas[0].id, monto_centavos: 40000, fecha_hora: `${primera}T09:30:00-03:00`, usuario_id: admin.id });
  await registrarPago({ credito_id: venta.credito.id, cuota_id: venta.cuotas[1].id, monto_centavos: 40000, fecha_hora: `${segunda}T09:30:00-03:00`, usuario_id: admin.id });
  compraResumen = await resumen(f.negocio.id, compra.slice(0, 7));
  assert.equal(compraResumen.totales.generada, 10000);
  assert.equal(compraResumen.totales.liquidable, 2000);
  for (const fecha of [primera, segunda]) {
    const r = await resumen(f.negocio.id, fecha.slice(0, 7));
    assert.equal(r.totales.generada, 0);
    assert.equal(r.totales.liquidable, 4000);
    assert.equal(r.eventos.length, 1);
    assert.equal(r.eventos[0].fecha_origen, fecha);
  }
  const a = await acuerdo(venta.venta.id);
  const generaciones = await db.prepare('SELECT * FROM comision_generaciones WHERE acuerdo_id=?').all(a.id);
  assert.equal(generaciones.length, 1, 'Los cobros no vuelven a generar la comisión acordada');
  assert.equal(generaciones[0].fecha, compra);
  assert.equal((await db.prepare('SELECT estado FROM creditos WHERE id=?').get(venta.credito.id)).estado, 'finalizado');
});

test('Compra cargada después de un cierre: conserva la fecha real y el cierre original, con comisión contable en período abierto', async () => {
  const f = await fixture();
  const mesCompra = compra.slice(0, 7);
  await crear({ ...f.body, fecha: `${mesCompra}-05`, solicitud_id: randomUUID() });
  const preview = await vistaCierre(f.negocio.id, vendedor.id, mesCompra);
  const cierre = await aprobarCierre(f.negocio.id, { usuario_id: vendedor.id, mes: mesCompra, version: preview.version }, admin.id);
  await publicarCierre(f.negocio.id, cierre.id, admin.id);
  const original = await db.prepare('SELECT * FROM comision_cierres WHERE id=?').get(cierre.id);
  const compraTardia = `${mesCompra}-15`;
  const venta = await crear({ ...f.body, fecha: compraTardia, solicitud_id: randomUUID() });
  assert.equal(venta.venta.fecha, compraTardia);
  assert.equal(venta.credito.fecha_inicio, compraTardia);
  assert.equal(venta.entregaInicial.pago.fecha_hora, `${compraTardia}T12:00:00-03:00`);
  const a = await acuerdo(venta.venta.id);
  const generacion = await db.prepare('SELECT * FROM comision_generaciones WHERE acuerdo_id=?').get(a.id);
  const evento = await db.prepare('SELECT * FROM comision_eventos WHERE acuerdo_id=?').get(a.id);
  assert.equal(generacion.fecha, hoy);
  assert.equal(evento.fecha, hoy);
  assert.equal(evento.fecha_origen, compraTardia);
  assert.equal(generacion.importe_centavos, 10000);
  assert.equal(evento.importe_centavos, 10000);
  assert.deepEqual(await db.prepare('SELECT * FROM comision_cierres WHERE id=?').get(cierre.id), original);
  assert.equal((await vistaCierre(f.negocio.id, vendedor.id, mesCompra)).resumen.liquidable, 10000);
  assert.equal((await resumen(f.negocio.id, hoy.slice(0, 7))).totales.liquidable, 10000);
});

test('Fecha de compra inválida rechaza la venta completa y no descuenta stock ni crea comisiones o cobros', async () => {
  const f = await fixture();
  for (const fecha of ['2026-02-30', `${compra}T12:00:00-03:00`, '', null]) {
    const response = await postVenta({ ...f.body, fecha, solicitud_id: randomUUID() });
    assert.equal(response.status, 400, `${String(fecha)}: ${JSON.stringify(response.body)}`);
  }
  assert.equal((await getProducto(f.producto.id)).stock, 10);
  for (const tabla of ['ventas', 'pagos', 'comision_acuerdos']) {
    const row = await db.prepare(`SELECT count(*)::int cantidad FROM ${tabla} WHERE negocio_id=?`).get(f.negocio.id);
    assert.equal(row.cantidad, 0, tabla);
  }
});
