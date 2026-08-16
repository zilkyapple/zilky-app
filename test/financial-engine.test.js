import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/connection.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { listCuotasPorCredito } from '../src/repositories/cuotas.js';
import { listCreditosPorCliente } from '../src/repositories/creditos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { estadoCuota, calcularMora } from '../src/lib/mora.js';

await migrate();
// Limpia la base de test antes de correr, para que los tests sean repetibles.
await pool.query(`
  TRUNCATE usuarios, pago_aplicaciones, pagos, saldo_favor, cuotas, creditos, venta_detalle, ventas, productos, clientes, negocios
  RESTART IDENTITY CASCADE
`);

const negApple = await crearNegocio({ nombre: 'Zilky Apple', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana' });
const negIndumentaria = await crearNegocio({ nombre: 'Zilky Indumentaria', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana' });
const cliente = await crearCliente({ nombre: 'Juan', apellido: 'Pérez', telefono: '1122334455', negocio_id: negIndumentaria.id });

// ---------------------------------------------------------------------------
// Caso 1: Ropa pagada por día -> se cancela sin mora con pagos libres e irregulares
// ---------------------------------------------------------------------------
test('Caso 1: pagos libres e irregulares cancelan la venta sin generar mora', async () => {
  const { credito } = await crearVenta({
    negocio_id: negIndumentaria.id,
    cliente_id: cliente.id,
    fecha: '2026-01-01',
    modalidad: 'libre',
    monto_total_centavos: 6_000_000, // $60.000
    entrega_inicial_centavos: 1_000_000, // $10.000
    plan: { fecha_limite: '2026-01-31' }, // 30 días
  });

  const pagos = [
    ['2026-01-03', 500_000],
    ['2026-01-06', 1_000_000],
    ['2026-01-09', 400_000],
    ['2026-01-16', 1_500_000],
    ['2026-01-26', 1_600_000],
  ];
  for (const [fecha, monto] of pagos) {
    await registrarPago({ credito_id: credito.id, monto_centavos: monto, fecha_hora: `${fecha}T10:00:00-03:00` });
  }

  const [cuota] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota.saldo_pendiente_centavos, 0, 'la cuota debe quedar totalmente saldada');

  const negocio = negIndumentaria;
  const estadoFinal = estadoCuota(cuota, negocio, '2026-02-15');
  assert.equal(estadoFinal.estado, 'pagada_anticipada', 'se terminó de pagar el 26/01, 5 días antes del vencimiento (31/01)');
  assert.equal(calcularMora(cuota, negocio, '2026-02-15').pendiente, 0, 'no debe haber mora: se pagó todo antes del vencimiento');
});

// ---------------------------------------------------------------------------
// Caso 2: Ropa vencida -> respeta 7 días de gracia, la mora arranca recién el día 8
// ---------------------------------------------------------------------------
test('Caso 2: la mora respeta el período de gracia de 7 días (vence 10/08, mora desde 18/08)', () => {
  const cuota = {
    fecha_vencimiento: '2026-08-10',
    monto_centavos: 2_000_000,
    saldo_pendiente_centavos: 2_000_000, // $20.000 pendientes al vencimiento
    mora_pagada_centavos: 0,
    estado_manual: null,
  };
  const negocio = negIndumentaria;

  assert.equal(estadoCuota(cuota, negocio, '2026-08-10').estado, 'vence_hoy');
  assert.equal(estadoCuota(cuota, negocio, '2026-08-11').estado, 'gracia');
  assert.equal(estadoCuota(cuota, negocio, '2026-08-17').estado, 'gracia', 'el día 17 todavía es gracia (7mo día)');
  assert.equal(calcularMora(cuota, negocio, '2026-08-17').pendiente, 0, 'no hay interés moratorio durante la gracia');

  assert.equal(estadoCuota(cuota, negocio, '2026-08-18').estado, 'mora', 'el día 18 ya es mora');
  assert.ok(calcularMora(cuota, negocio, '2026-08-18').pendiente > 0, 'el interés moratorio arranca el día 18');
});

// ---------------------------------------------------------------------------
// Caso 3: iPhone pagado semanalmente -> los pagos parciales completan la cuota vigente
// ---------------------------------------------------------------------------
test('Caso 3: pagos semanales completan la primera cuota sin tocar la siguiente', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id,
    cliente_id: cliente.id,
    fecha: '2026-02-01',
    modalidad: 'cuotas',
    monto_total_centavos: 12_600_000, // $300.000 + 6 x $160.000
    entrega_inicial_centavos: 3_000_000,
    plan: { cantidad_cuotas: 6, valor_cuota_centavos: 1_600_000, fecha_primera_cuota: '2026-03-01', intervalo_dias: 30 },
  });

  const semanas = [
    ['2026-02-10', 400_000],
    ['2026-02-17', 500_000],
    ['2026-02-24', 300_000],
    ['2026-03-01', 400_000],
  ];
  for (const [fecha, monto] of semanas) {
    await registrarPago({ credito_id: credito.id, monto_centavos: monto, fecha_hora: `${fecha}T09:00:00-03:00` });
  }

  const [cuota1, cuota2] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota1.saldo_pendiente_centavos, 0, 'la primera cuota debe quedar completa');
  assert.equal(cuota2.saldo_pendiente_centavos, 1_600_000, 'la segunda cuota no debe verse afectada');
});

// ---------------------------------------------------------------------------
// Caso 4: un pago superior al saldo de la cuota se derrama a la cuota siguiente
// ---------------------------------------------------------------------------
test('Caso 4: un pago mayor a la cuota se aplica primero a esa cuota y el resto a la siguiente', async () => {
  const { credito } = await crearVenta({
    negocio_id: negApple.id,
    cliente_id: cliente.id,
    fecha: '2026-04-01',
    modalidad: 'cuotas',
    monto_total_centavos: 9_600_000,
    entrega_inicial_centavos: 0,
    plan: { cantidad_cuotas: 6, valor_cuota_centavos: 1_600_000, fecha_primera_cuota: '2026-04-01', intervalo_dias: 30 },
  });

  const resultado = await registrarPago({ credito_id: credito.id, monto_centavos: 2_500_000, fecha_hora: '2026-04-05T09:00:00-03:00' });

  const [cuota1, cuota2] = await listCuotasPorCredito(credito.id);
  assert.equal(cuota1.saldo_pendiente_centavos, 0);
  assert.equal(cuota2.saldo_pendiente_centavos, 700_000, '160.000 - 90.000 de excedente = 70.000 pendientes');
  assert.equal(resultado.remanente, 0, 'no debe quedar saldo a favor, todo se aplicó a cuotas');
});

// ---------------------------------------------------------------------------
// Caso 5: mismo cliente, deuda separada por negocio pero visible en conjunto
// ---------------------------------------------------------------------------
test('Caso 5: el mismo cliente mantiene deudas separadas por negocio y consolidadas', async () => {
  const clienteMultinegocio = await crearCliente({ nombre: 'Ana', apellido: 'Gómez', telefono: '1155667788', negocio_id: negApple.id });

  await crearVenta({
    negocio_id: negApple.id, cliente_id: clienteMultinegocio.id, fecha: '2026-05-01',
    modalidad: 'unico', monto_total_centavos: 5_000_000, entrega_inicial_centavos: 0,
    plan: { fecha_limite: '2026-06-01' },
  });
  await crearVenta({
    negocio_id: negIndumentaria.id, cliente_id: clienteMultinegocio.id, fecha: '2026-05-01',
    modalidad: 'unico', monto_total_centavos: 800_000, entrega_inicial_centavos: 0,
    plan: { fecha_limite: '2026-06-01' },
  });

  const soloApple = await listCreditosPorCliente(clienteMultinegocio.id, negApple.id);
  const soloIndumentaria = await listCreditosPorCliente(clienteMultinegocio.id, negIndumentaria.id);
  const consolidado = await listCreditosPorCliente(clienteMultinegocio.id);

  assert.equal(soloApple.length, 1);
  assert.equal(soloApple[0].saldo_financiado_centavos, 5_000_000);
  assert.equal(soloIndumentaria.length, 1);
  assert.equal(soloIndumentaria[0].saldo_financiado_centavos, 800_000);
  assert.equal(consolidado.length, 2);
  const deudaTotal = consolidado.reduce((a, c) => a + c.saldo_financiado_centavos, 0);
  assert.equal(deudaTotal, 5_800_000, 'la deuda consolidada debe sumar $58.000');
});

test.after(async () => { await pool.end(); });
