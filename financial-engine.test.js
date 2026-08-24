import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/connection.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente, buscarClientes, listClientesFinalizados } from '../src/repositories/clientes.js';
import { crearProducto } from '../src/repositories/productos.js';
import { listCuotasPorCredito } from '../src/repositories/cuotas.js';
import { getCredito } from '../src/repositories/creditos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { listaCobranza, calendarioMes, calendarioDia, resumenGeneral } from '../src/services/dashboardService.js';
import { listComprobantes } from '../src/repositories/comprobantes.js';
import { estadoCuota, calcularMora } from '../src/lib/mora.js';
import { todayAR, addDays } from '../src/lib/dates.js';

await migrate();
await pool.query(`
  TRUNCATE usuarios, comprobantes, pago_aplicaciones, pagos, saldo_favor, cuotas, creditos, venta_detalle, ventas, productos, clientes, negocios
  RESTART IDENTITY CASCADE
`);

const negApple = await crearNegocio({ nombre: 'Zilky Apple', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana' });
const negIndumentaria = await crearNegocio({ nombre: 'Zilky Indumentaria', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana' });
// Un mismo cliente, global, que compra en los dos negocios (el caso que pediste que funcione).
const cliente = await crearCliente({ nombre: 'Juan', apellido: 'Pérez', telefono: '1122334455' });

// ===== Motor financiero original (sin cambios) =====

test('Caso 1: pagos libres e irregulares cancelan la venta sin generar mora', async () => {
  const { credito } = await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: cliente.id, fecha: '2026-01-01', modalidad: 'libre',
    monto_total_centavos: 6_000_000, entrega_inicial_centavos: 1_000_000, plan: { fecha_limite: '2026-01-31' },
  });
  const pagos = [['2026-01-03', 500_000], ['2026-01-06', 1_000_000], ['2026-01-09', 400_000], ['2026-01-16', 1_500_000], ['2026-01-26', 1_600_000]];
  for (const [fecha, monto] of pagos) await registrarPago({ credito_id: credito.id, monto_centavos: monto, fecha_hora: `${fecha}T10:00:00-03:00` });
  const [cuota] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota.saldo_pendiente_centavos, 0);
  assert.equal(estadoCuota(cuota, negIndumentaria, '2026-02-15').estado, 'pagada_anticipada');
  assert.equal(calcularMora(cuota, negIndumentaria, '2026-02-15').pendiente, 0);
});

test('Caso 2: la mora respeta el período de gracia de 7 días (vence 10/08, mora desde 18/08)', () => {
  const cuota = { fecha_vencimiento: '2026-08-10', monto_centavos: 2_000_000, saldo_pendiente_centavos: 2_000_000, mora_pagada_centavos: 0, estado_manual: null };
  assert.equal(estadoCuota(cuota, negIndumentaria, '2026-08-17').estado, 'gracia');
  assert.equal(calcularMora(cuota, negIndumentaria, '2026-08-17').pendiente, 0);
  assert.equal(estadoCuota(cuota, negIndumentaria, '2026-08-18').estado, 'mora');
  assert.ok(calcularMora(cuota, negIndumentaria, '2026-08-18').pendiente > 0);
});

test('Caso 3: pagos semanales completan la primera cuota sin tocar la siguiente', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: '2026-02-01', modalidad: 'cuotas',
    monto_total_centavos: 12_600_000, entrega_inicial_centavos: 3_000_000,
    plan: { cantidad_cuotas: 6, valor_cuota_centavos: 1_600_000, fecha_primera_cuota: '2026-03-01', intervalo_dias: 30 },
  });
  const semanas = [['2026-02-10', 400_000], ['2026-02-17', 500_000], ['2026-02-24', 300_000], ['2026-03-01', 400_000]];
  for (const [fecha, monto] of semanas) await registrarPago({ credito_id: credito.id, monto_centavos: monto, fecha_hora: `${fecha}T09:00:00-03:00` });
  const [cuota1, cuota2] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota1.saldo_pendiente_centavos, 0);
  assert.equal(cuota2.saldo_pendiente_centavos, 1_600_000);
});

test('Caso 4: un pago mayor a la cuota se aplica primero a esa cuota y el resto a la siguiente', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: '2026-04-01', modalidad: 'cuotas',
    monto_total_centavos: 9_600_000, entrega_inicial_centavos: 0,
    plan: { cantidad_cuotas: 6, valor_cuota_centavos: 1_600_000, fecha_primera_cuota: '2026-04-01', intervalo_dias: 30 },
  });
  const resultado = await registrarPago({ credito_id: credito.id, monto_centavos: 2_500_000, fecha_hora: '2026-04-05T09:00:00-03:00' });
  const [cuota1, cuota2] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota1.saldo_pendiente_centavos, 0);
  assert.equal(cuota2.saldo_pendiente_centavos, 700_000);
  assert.equal(resultado.remanente, 0);
});

test('Stock: vender sin stock configurado nunca bloquea la venta', async () => {
  const producto = await crearProducto({ negocio_id: negIndumentaria.id, nombre: 'Remera sin stock', stock: null });
  assert.equal(producto.stock, null);
  const resultado = await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: cliente.id, fecha: '2026-07-01', modalidad: 'unico',
    items: [{ producto_id: producto.id, cantidad: 5, precio_unitario_centavos: 100_000 }],
    entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-07-31' },
  });
  assert.equal(resultado.advertencias.length, 0);
});

test('12. Stock insuficiente avisa pero NO bloquea la venta', async () => {
  const producto = await crearProducto({ negocio_id: negIndumentaria.id, nombre: 'Jean con poco stock', stock: 1 });
  const resultado = await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: cliente.id, fecha: '2026-07-01', modalidad: 'unico',
    items: [{ producto_id: producto.id, cantidad: 3, precio_unitario_centavos: 100_000 }],
    entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-07-31' },
  });
  assert.ok(resultado.venta);
  assert.equal(resultado.advertencias.length, 1);
});

// ===== Cliente global + operaciones aisladas por negocio =====

test('Cliente requiere nombre y apellido', async () => {
  await assert.rejects(() => crearCliente({ nombre: 'Sólo Nombre' }), /apellido/i);
});

test('DNI, teléfono e Instagram pueden quedar vacíos', async () => {
  const c = await crearCliente({ nombre: 'Sin Datos', apellido: 'Opcionales' });
  assert.equal(c.dni, null);
  assert.equal(c.telefono, null);
  assert.equal(c.instagram, null);
});

test('Instagram se normaliza con @', async () => {
  const c = await crearCliente({ nombre: 'Con', apellido: 'Insta', instagram: 'ulizilky' });
  assert.equal(c.instagram, '@ulizilky');
});

test('1. El mismo cliente puede comprar en dos negocios, y cada negocio ve SOLO lo suyo', async () => {
  const compartido = await crearCliente({ nombre: 'Compartido', apellido: 'EntreNegocios' });
  const hoy = todayAR();

  const { credito: credApple } = await crearVenta({
    negocio_id: negApple.id, cliente_id: compartido.id, fecha: hoy, modalidad: 'unico',
    monto_total_centavos: 1_000_000, entrega_inicial_centavos: 0, plan: { fecha_limite: addDays(hoy, 5) },
  });
  const { credito: credIndu } = await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: compartido.id, fecha: hoy, modalidad: 'unico',
    monto_total_centavos: 500_000, entrega_inicial_centavos: 0, plan: { fecha_limite: addDays(hoy, 5) },
  });
  await registrarPago({ credito_id: credApple.id, monto_centavos: 1_000_000, fecha_hora: `${hoy}T10:00:00-03:00` });
  await registrarPago({ credito_id: credIndu.id, monto_centavos: 500_000, fecha_hora: `${hoy}T11:00:00-03:00` });

  // El cliente es UNO SOLO (no se duplicó)
  const buscados = await buscarClientes('Compartido');
  assert.equal(buscados.length, 1);

  // Pero el dashboard/cobranza/comprobantes de cada negocio sólo ven lo propio
  const resumenApple = await resumenGeneral(negApple.id);
  const resumenIndu = await resumenGeneral(negIndumentaria.id);
  assert.equal(resumenApple.cobradoHoyCentavos, 1_000_000);
  assert.equal(resumenIndu.cobradoHoyCentavos, 500_000);

  const comprobantesApple = await listComprobantes(negApple.id);
  const comprobantesIndu = await listComprobantes(negIndumentaria.id);
  assert.ok(comprobantesApple.every((c) => c.negocio_id === negApple.id));
  assert.ok(comprobantesIndu.every((c) => c.negocio_id === negIndumentaria.id));
  assert.ok(!comprobantesApple.some((c) => credIndu.id === c.credito_id), 'Apple no debe ver comprobantes de Indumentaria');
});

test('4 y 5. Cuota vencida aparece en "vencidas" y cuota futura en "próximas"', async () => {
  const hoy = todayAR();
  const { credito: vencida } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: addDays(hoy, -40), modalidad: 'unico',
    monto_total_centavos: 1_000_000, entrega_inicial_centavos: 0, plan: { fecha_limite: addDays(hoy, -10) },
  });
  const { credito: proxima } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: hoy, modalidad: 'unico',
    monto_total_centavos: 500_000, entrega_inicial_centavos: 0, plan: { fecha_limite: addDays(hoy, 3) },
  });
  const cobranza = await listaCobranza(negApple.id, { ventanaDias: 7 });
  const [cuotaVencida] = await listCuotasPorCredito(vencida.id);
  const [cuotaProxima] = await listCuotasPorCredito(proxima.id);
  assert.ok(cobranza.vencidas.some((c) => c.id === cuotaVencida.id));
  assert.ok(cobranza.proximas.some((c) => c.id === cuotaProxima.id));
});

test('6. El calendario devuelve correctamente los vencimientos de cada fecha', async () => {
  await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: cliente.id, fecha: '2026-08-01', modalidad: 'unico',
    monto_total_centavos: 300_000, entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-08-18' },
  });
  const mes = await calendarioMes(negIndumentaria.id, '2026-08');
  const dia18 = mes.find((d) => d.fecha === '2026-08-18');
  assert.ok(dia18);
  assert.equal(dia18.cantidad, 1);
  const detalle = await calendarioDia(negIndumentaria.id, '2026-08-18');
  assert.equal(detalle.length, 1);
  assert.equal(detalle[0].cliente_id, cliente.id);
});

test('7 y 8. Registrar pago conserva fecha real y días de atraso, y no se borra al pagar tarde', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: '2026-03-01', modalidad: 'unico',
    monto_total_centavos: 1_000_000, entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-03-10' },
  });
  await registrarPago({ credito_id: credito.id, monto_centavos: 1_000_000, fecha_hora: '2026-03-15T10:00:00-03:00' }); // 5 días tarde
  const [cuota] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota.saldo_pendiente_centavos, 0);
  assert.equal(cuota.dias_atraso_al_pagar, 5);
  assert.equal(cuota.fecha_saldada, '2026-03-15');
  assert.equal(estadoCuota(cuota, negApple, '2026-06-01').estado, 'pagada');
  assert.equal(cuota.dias_atraso_al_pagar, 5, 'el dato de atraso no se borra aunque el estado ya sea "pagada"');
});

test('9. Un pago genera un comprobante único', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: '2026-05-01', modalidad: 'unico',
    monto_total_centavos: 200_000, entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-05-31' },
  });
  const r1 = await registrarPago({ credito_id: credito.id, monto_centavos: 100_000, fecha_hora: '2026-05-05T10:00:00-03:00' });
  const r2 = await registrarPago({ credito_id: credito.id, monto_centavos: 100_000, fecha_hora: '2026-05-06T10:00:00-03:00' });
  assert.ok(r1.comprobante.numero.startsWith('ZLK-'));
  assert.notEqual(r1.comprobante.numero, r2.comprobante.numero);
});

test('10. Un comprobante anulado conserva el original y revierte el saldo', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id, cliente_id: cliente.id, fecha: '2026-06-01', modalidad: 'unico',
    monto_total_centavos: 500_000, entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-06-30' },
  });
  const { comprobante } = await registrarPago({ credito_id: credito.id, monto_centavos: 500_000, fecha_hora: '2026-06-10T10:00:00-03:00' });
  let [cuota] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota.saldo_pendiente_centavos, 0);

  const anulado = await anularComprobante(comprobante.id, { motivo: 'Error de carga', usuarioId: 'test-user' });
  assert.equal(anulado.estado, 'anulado');
  assert.equal(anulado.numero, comprobante.numero);

  [cuota] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota.saldo_pendiente_centavos, 500_000);
  assert.equal(cuota.fecha_saldada, null);
});

test('11. Finalizar todas las cuotas mueve al cliente a "clientes finalizados" DE ESE NEGOCIO', async () => {
  const clienteFinal = await crearCliente({ nombre: 'Finaliza', apellido: 'Compra' });
  const { credito } = await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: clienteFinal.id, fecha: '2026-07-01', modalidad: 'unico',
    monto_total_centavos: 100_000, entrega_inicial_centavos: 0, plan: { fecha_limite: '2026-07-31' },
  });
  await registrarPago({ credito_id: credito.id, monto_centavos: 100_000, fecha_hora: '2026-07-15T10:00:00-03:00' });
  const creditoFinal = await getCredito(credito.id);
  assert.equal(creditoFinal.estado, 'finalizado');
  const finalizadosIndu = await listClientesFinalizados(negIndumentaria.id);
  assert.ok(finalizadosIndu.some((c) => c.id === clienteFinal.id));
});

test('13. Los dashboards calculan lo COBRADO con pagos reales, no con ventas creadas', async () => {
  const negTemporal = await crearNegocio({ nombre: 'Negocio Dashboard Test' });
  const hoy = todayAR();
  const { credito } = await crearVenta({
    negocio_id: negTemporal.id, cliente_id: cliente.id, fecha: hoy, modalidad: 'unico',
    monto_total_centavos: 900_000, entrega_inicial_centavos: 0, plan: { fecha_limite: addDays(hoy, 30) },
  });
  let resumen = await resumenGeneral(negTemporal.id);
  assert.equal(resumen.cobradoHoyCentavos, 0, 'crear una venta sin pagar no debe sumar como cobrado');
  assert.equal(resumen.vendidoTotalCentavos, 900_000);

  await registrarPago({ credito_id: credito.id, monto_centavos: 300_000, fecha_hora: `${hoy}T12:00:00-03:00` });
  resumen = await resumenGeneral(negTemporal.id);
  assert.equal(resumen.cobradoHoyCentavos, 300_000);
});

test.after(async () => { await pool.end(); });
