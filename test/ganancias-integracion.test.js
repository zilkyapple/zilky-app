import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { resumenGeneral } from '../src/services/dashboardService.js';
import { configurarComision, configurarProductoComision, resumenComisiones } from '../src/services/comisionesService.js';
import { ajustarComision } from '../src/services/comisionCierresService.js';
import { detalleVenta, devolverVenta } from '../src/services/ventasGestionService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { addMonths, todayAR } from '../src/lib/dates.js';

await migrate();
test.after(() => pool.end());

async function operacion({ valorCuota, entrega = 0, contado = false, comision = false }) {
  const negocio = await crearNegocio({ nombre: 'QA ganancias pactadas', mora_valor: 0 });
  const cliente = await crearCliente({ nombre: 'Ganancias', apellido: 'QA', negocio_id: negocio.id });
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto QA', costo_centavos: 80000 });
  let actor;
  if (comision) {
    actor = await crearUsuario({ email: `${randomUUID()}@ganancias.invalid`, password_hash: 'unused' });
    await configurarComision(negocio.id, { activa: true, visible_empleado: false, momento: 'venta' }, actor.id);
    await configurarProductoComision(negocio.id, producto.id, { tipo: 'fijo', valor: 2500 }, actor.id);
  }
  const primera = addMonths(todayAR().slice(0, 7) + '-01', 1);
  const venta = await crearVenta({
    negocio_id: negocio.id, cliente_id: cliente.id, fecha: todayAR(), modalidad: contado ? 'libre' : 'cuotas', usuario_id: actor?.id,
    items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 120000 }],
    entrega_inicial_centavos: contado ? 120000 : entrega,
    plan: contado ? {} : { cantidad_cuotas: 3, valor_cuota_centavos: valorCuota, fecha_primera_cuota: primera },
  });
  return { negocio, producto, venta, actor, mesCancelacion: addMonths(primera, 2).slice(0, 7) };
}

async function estadoFinanciero(venta) {
  return {
    venta: await db.prepare('SELECT * FROM ventas WHERE id=?').get(venta.venta.id),
    credito: await db.prepare('SELECT * FROM creditos WHERE id=?').get(venta.credito.id),
    cuotas: await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY numero').all(venta.credito.id),
    pagos: await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(venta.credito.id),
  };
}

for (const [valorCuota, capital, margen] of [[39000, 117000, 37000], [42000, 126000, 46000]]) {
  test(`Ganancias: cancelar un plan pactado de ${capital} realiza todo su margen sin alterar la venta`, async () => {
    const { negocio, venta, mesCancelacion } = await operacion({ valorCuota });
    assert.equal(venta.venta.monto_total_centavos, 120000);
    assert.equal(venta.cuotas.reduce((s, c) => s + c.monto_centavos, 0), capital);
    await registrarPago({ credito_id: venta.credito.id, monto_centavos: capital });
    const antes = await estadoFinanciero(venta);
    const resumen = await resumenGeneral(negocio.id);
    assert.deepEqual(await estadoFinanciero(venta), antes, 'El dashboard sólo lee; conserva venta, cuotas y cobros');
    assert.equal(antes.credito.estado, 'finalizado');
    assert.equal(antes.cuotas.reduce((s, c) => s + c.saldo_pendiente_centavos, 0), 0);
    assert.deepEqual({
      esperada: resumen.gananciaVentasRegistradasCentavos,
      realizada: resumen.gananciaRealizadaCentavos,
      pendiente: resumen.gananciaPendienteCentavos,
    }, { esperada: margen, realizada: margen, pendiente: 0 });
    assert.equal(resumen.gananciasPorMes.find(m => m.mes === mesCancelacion)?.esperadaCentavos, margen);
  });
}

test('Ganancias: la cancelación prevista de varias cuotas corresponde al último vencimiento', async () => {
  const { negocio, venta, mesCancelacion } = await operacion({ valorCuota: 40000 });
  assert.notEqual(venta.cuotas[0].fecha_vencimiento.slice(0, 7), mesCancelacion);
  const resumen = await resumenGeneral(negocio.id);
  assert.equal(resumen.gananciasPorMes.find(m => m.mes === mesCancelacion)?.esperadaCentavos, 40000);
  assert.equal(resumen.gananciasPorMes.find(m => m.mes === mesCancelacion)?.pendienteCentavos, 40000);
});

test('Ganancias: la entrega y los abonos parciales recuperan el costo histórico hasta cancelar el plan', async () => {
  const { negocio, producto, venta, mesCancelacion } = await operacion({ valorCuota: 35000, entrega: 12000 });
  await db.prepare('UPDATE productos SET costo_centavos=? WHERE id=?').run(90000, producto.id);
  assert.equal((await db.prepare('SELECT costo_unitario_centavos FROM venta_detalle WHERE venta_id=?').get(venta.venta.id)).costo_unitario_centavos, 80000);
  let resumen = await resumenGeneral(negocio.id);
  assert.equal(resumen.gananciaVentasRegistradasCentavos, 37000);
  assert.equal(resumen.gananciaRealizadaCentavos, 0);
  assert.equal(resumen.gananciasPorMes.find(m => m.mes === mesCancelacion)?.pendienteCentavos, 37000);
  await registrarPago({ credito_id: venta.credito.id, monto_centavos: 90000 });
  resumen = await resumenGeneral(negocio.id);
  assert.equal(resumen.gananciaRealizadaCentavos, 22000);
  assert.equal(resumen.gananciaPendienteCentavos, 15000);
  await registrarPago({ credito_id: venta.credito.id, monto_centavos: 15000 });
  resumen = await resumenGeneral(negocio.id);
  assert.equal(resumen.gananciaRealizadaCentavos, 37000);
  assert.equal(resumen.gananciaPendienteCentavos, 0);
});

test('Ganancias: una venta al contado usa la entrega completa sin necesitar cuotas', async () => {
  const { negocio, venta } = await operacion({ contado: true });
  assert.equal(venta.cuotas.length, 0);
  const resumen = await resumenGeneral(negocio.id);
  assert.equal(resumen.gananciaVentasRegistradasCentavos, 40000);
  assert.equal(resumen.gananciaRealizadaCentavos, 40000);
  assert.equal(resumen.gananciaPendienteCentavos, 0);
});

async function ajustar(operacion, importe) {
  const acuerdo = await db.prepare('SELECT id FROM comision_acuerdos WHERE venta_id=?').get(operacion.venta.venta.id);
  const datos = { solicitud_id: randomUUID(), acuerdo_id: acuerdo.id, importe_centavos: importe, motivo: 'QA ajuste de comisión' };
  await ajustarComision(operacion.negocio.id, datos, operacion.actor.id);
  await ajustarComision(operacion.negocio.id, datos, operacion.actor.id);
}

async function gananciasSinCambiarComisiones(operacion) {
  const leerComisiones = () => resumenComisiones(operacion.negocio.id, operacion.actor.id, '0001-01-01', '9999-12-31');
  const antes = { financiero: await estadoFinanciero(operacion.venta), comisiones: await leerComisiones() };
  const resumen = await resumenGeneral(operacion.negocio.id);
  assert.deepEqual({ financiero: await estadoFinanciero(operacion.venta), comisiones: await leerComisiones() }, antes,
    'Consultar ganancias conserva los cobros, las cuotas y el saldo del vendedor');
  return resumen;
}

for (const [ajuste, margen] of [[5000, 32500], [-1000, 38500]]) {
  test(`Ganancias: el ajuste de comisión ${ajuste} cambia el margen sin modificar el saldo del vendedor`, async () => {
    const operacionVenta = await operacion({ contado: true, comision: true });
    await ajustar(operacionVenta, ajuste);
    const resumen = await gananciasSinCambiarComisiones(operacionVenta);
    assert.deepEqual({ esperada: resumen.gananciaVentasRegistradasCentavos, realizada: resumen.gananciaRealizadaCentavos,
      pendiente: resumen.gananciaPendienteCentavos }, { esperada: margen, realizada: margen, pendiente: 0 });
  });
}

test('Ganancias: varios ajustes del mismo acuerdo se suman una vez, sin duplicar la comisión original', async () => {
  const operacionVenta = await operacion({ contado: true, comision: true });
  await ajustar(operacionVenta, 5000);
  await ajustar(operacionVenta, -1000);
  const resumen = await gananciasSinCambiarComisiones(operacionVenta);
  assert.equal(resumen.gananciaVentasRegistradasCentavos, 33500);
  assert.equal(resumen.gananciaRealizadaCentavos, 33500);
});

test('Ganancias: anular un cobro conserva el costo de comisión ajustado y deja el margen pendiente', async () => {
  const operacionVenta = await operacion({ valorCuota: 40000, comision: true });
  const pago = await registrarPago({ credito_id: operacionVenta.venta.credito.id, monto_centavos: 120000 });
  await ajustar(operacionVenta, 5000);
  await anularComprobante(pago.comprobante.id, { motivo: 'QA anulación de cobro', usuarioId: operacionVenta.actor.id });
  const resumen = await gananciasSinCambiarComisiones(operacionVenta);
  assert.deepEqual({ esperada: resumen.gananciaVentasRegistradasCentavos, realizada: resumen.gananciaRealizadaCentavos,
    pendiente: resumen.gananciaPendienteCentavos }, { esperada: 32500, realizada: 0, pendiente: 32500 });
});

test('Ganancias: una venta anulada queda fuera aunque conserve el acuerdo y sus ajustes para auditoría', async () => {
  const operacionVenta = await operacion({ contado: true, comision: true });
  await ajustar(operacionVenta, 5000);
  const detalle = await detalleVenta(operacionVenta.negocio.id, operacionVenta.venta.venta.id);
  await devolverVenta(operacionVenta.negocio.id, operacionVenta.venta.venta.id, {
    solicitud_id: randomUUID(), tipo: 'anulacion', motivo: 'QA anulación de venta', version: detalle.version, reponer: false,
  }, operacionVenta.actor.id);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM comision_ajustes j JOIN comision_acuerdos a ON a.id=j.acuerdo_id WHERE a.venta_id=?').get(detalle.venta.id)).n, 1);
  const resumen = await gananciasSinCambiarComisiones(operacionVenta);
  assert.equal(resumen.ventasConGananciaCalculada, 0);
  assert.equal(resumen.gananciaVentasRegistradasCentavos, 0);
  assert.equal(resumen.gananciaRealizadaCentavos, 0);
  assert.equal(resumen.gananciaPendienteCentavos, 0);
});
