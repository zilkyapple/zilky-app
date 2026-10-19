import test from 'node:test';
import assert from 'node:assert/strict';
import { proyectarCobros } from '../src/lib/proyeccionCobros.js';

const cuota = (fecha, saldo, extra = {}) => ({ fecha_vencimiento: fecha, saldo_pendiente_centavos: saldo, ...extra });
const fila = (mes, pendienteCentavos = 0, cuotas = 0, vencidoCentavos = 0) => ({ mes, pendienteCentavos, cuotas, vencidoCentavos });

test('Proyección: cuenta capital restante de cuotas parciales sin sumar mora ni descontar otra vez la entrega', () => {
  const p = proyectarCobros([
    cuota('2026-10-24', 13200000, { monto_centavos: 15500000, moraPendiente: 700000, mora_generada_centavos: 1600000, entrega_inicial_centavos: 18000000 }),
    cuota('2026-10-26', 15500000, { monto_centavos: 15500000, mora_pagada_centavos: 2300000 }),
    cuota('2026-11-24', 15500000, { monto_centavos: 15500000 }),
    cuota('2026-10-20', 0, { monto_centavos: 15500000, cuota_saldo: 0, moraPendiente: 700000, entrega_inicial_centavos: 18000000 }),
  ], '2026-10-19');
  assert.deepEqual(p.mesActual, fila('2026-10', 28700000, 2));
  assert.deepEqual(p.mesSiguiente, fila('2026-11', 15500000, 1));
  assert.equal(p.proximos7Dias.pendienteCentavos, 13200000);
  assert.equal(p.proximos14Dias.pendienteCentavos, 28700000);
  assert.equal(p.vencidoTotalCentavos, 0);
});

test('Proyección: este mes incluye todos sus vencimientos, mientras el vencido total también conserva meses anteriores', () => {
  const p = proyectarCobros([
    cuota('2026-09-30', 700), cuota('2026-10-01', 100), cuota('2026-10-18', 200),
    cuota('2026-10-19', 300), cuota('2026-10-31', 400), cuota('2026-11-01', 500),
  ], '2026-10-19');
  assert.deepEqual(p.mesActual, fila('2026-10', 1000, 4, 300));
  assert.equal(p.vencidoTotalCentavos, 1000);
  assert.deepEqual(p.meses, [fila('2026-10', 1000, 4, 300), fila('2026-11', 500, 1)]);
  assert.equal(p.proximos7Dias.pendienteCentavos, 300);
  assert.equal(p.proximos14Dias.pendienteCentavos, 1200);
});

test('Proyección: ventanas inclusivas de 7 y 14 días usan hoy a +6 y hoy a +13', () => {
  const p = proyectarCobros([
    cuota('2026-10-18', 10), cuota('2026-10-19', 20), cuota('2026-10-25', 40),
    cuota('2026-10-26', 80), cuota('2026-11-01', 160), cuota('2026-11-02', 320),
  ], '2026-10-19');
  assert.deepEqual(p.proximos7Dias, { desde: '2026-10-19', hasta: '2026-10-25', pendienteCentavos: 60, cuotas: 2 });
  assert.deepEqual(p.proximos14Dias, { desde: '2026-10-19', hasta: '2026-11-01', pendienteCentavos: 300, cuotas: 4 });
});

test('Proyección: cuotas pagadas, estados manuales y ventas anuladas o devueltas quedan excluidas', () => {
  const p = proyectarCobros([
    cuota('2026-10-20', 0, { moraPendiente: 50000, fecha_saldada: '2026-10-01' }),
    cuota('2026-10-20', 1000, { estado_manual: 'anulada' }),
    cuota('2026-10-20', 2000, { estado_manual: 'refinanciada' }),
    cuota('2026-10-20', 4000, { venta_estado: 'anulada' }),
    cuota('2026-10-20', 8000, { venta_estado: 'devuelta' }),
    cuota('2026-10-20', 1700, { venta_estado: 'devolucion_parcial' }),
    cuota('2026-10-20', 3300, { estado_manual: null, venta_estado: 'activa' }),
  ], '2026-10-19');
  assert.deepEqual(p.mesActual, fila('2026-10', 5000, 2));
  assert.equal(p.proximos7Dias.pendienteCentavos, 5000);
  assert.equal(p.proximos14Dias.cuotas, 2);
});

test('Proyección: meses ordenados y dispersos conservan cuotas de un plan a más de 15 meses', () => {
  const p = proyectarCobros([
    cuota('2028-01-24', 5000), cuota('2026-11-24', 2000), cuota('2026-09-24', 1000),
    cuota('2027-03-24', 3000), cuota('2040-01-24', 0), cuota('2050-01-24', 9000, { estado_manual: 'anulada' }),
  ], '2026-10-19');
  assert.equal(p.desdeMes, '2026-10');
  assert.equal(p.hastaMes, '2028-01');
  assert.deepEqual(p.meses, [fila('2026-11', 2000, 1), fila('2027-03', 3000, 1), fila('2028-01', 5000, 1)]);
  assert.deepEqual(p.mesActual, fila('2026-10'));
  assert.deepEqual(p.mesSiguiente, fila('2026-11', 2000, 1));
  assert.equal(p.vencidoTotalCentavos, 1000);
});

test('Proyección: el horizonte mínimo cubre 12 meses aunque no haya cuotas o todas estén vencidas', () => {
  for (const cuotas of [[], [cuota('2026-09-01', 1000)]]) {
    const p = proyectarCobros(cuotas, '2026-10-19');
    assert.equal(p.fechaCorte, '2026-10-19');
    assert.equal(p.desdeMes, '2026-10');
    assert.equal(p.hastaMes, '2027-09');
    assert.deepEqual(p.meses, []);
    assert.deepEqual(p.mesActual, fila('2026-10'));
    assert.deepEqual(p.mesSiguiente, fila('2026-11'));
  }
});

test('Proyección: fin de mes, cambio de año y febrero bisiesto conservan límites de calendario', () => {
  const casos = [
    ['2026-12-31', '2027-01', '2027-01-06', '2027-01-13', '2027-11'],
    ['2027-01-31', '2027-02', '2027-02-06', '2027-02-13', '2027-12'],
    ['2027-02-28', '2027-03', '2027-03-06', '2027-03-13', '2028-01'],
    ['2028-02-29', '2028-03', '2028-03-06', '2028-03-13', '2029-01'],
    ['2026-03-31', '2026-04', '2026-04-06', '2026-04-13', '2027-02'],
  ];
  for (const [corte, siguiente, fin7, fin14, horizonte] of casos) {
    const p = proyectarCobros([], corte);
    assert.equal(p.mesSiguiente.mes, siguiente, corte);
    assert.equal(p.proximos7Dias.hasta, fin7, corte);
    assert.equal(p.proximos14Dias.hasta, fin14, corte);
    assert.equal(p.hastaMes, horizonte, corte);
  }
});

test('Proyección: fecha argentina inyectada produce el mismo resultado con distintas zonas horarias del servidor', () => {
  const zonaOriginal = process.env.TZ;
  const cuotas = [cuota('2026-12-31', 1000), cuota('2027-01-01', 2000), cuota('2027-01-07', 4000)];
  const esperado = proyectarCobros(cuotas, '2026-12-31');
  try {
    for (const zona of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'America/Argentina/Buenos_Aires']) {
      process.env.TZ = zona;
      assert.deepEqual(proyectarCobros(cuotas, '2026-12-31'), esperado, zona);
    }
  } finally {
    if (zonaOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = zonaOriginal;
  }
  assert.equal(esperado.proximos7Dias.pendienteCentavos, 3000);
  assert.equal(esperado.proximos14Dias.pendienteCentavos, 7000);
});

test('Proyección: no modifica cuotas ni su orden al ordenar meses y calcular acumulados', () => {
  const cuotas = [cuota('2027-02-01', 2000, { numero: 2 }), cuota('2026-10-20', 1000, { numero: 1 })];
  const original = structuredClone(cuotas);
  cuotas.forEach(Object.freeze);
  Object.freeze(cuotas);
  const p = proyectarCobros(cuotas, '2026-10-19');
  assert.deepEqual(cuotas, original);
  assert.deepEqual(p.meses.map(m => m.mes), ['2026-10', '2027-02']);
});

test('Proyección: conserva centavos enteros seguros y rechaza saldos negativos, fraccionarios o inválidos', () => {
  const p = proyectarCobros([cuota('2026-10-20', Number.MAX_SAFE_INTEGER)], '2026-10-19');
  assert.equal(p.mesActual.pendienteCentavos, Number.MAX_SAFE_INTEGER);
  for (const importe of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, '100', true, 1n]) {
    assert.throws(() => proyectarCobros([cuota('2026-10-20', importe)], '2026-10-19'), RangeError);
  }
  assert.equal(proyectarCobros([cuota('2026-10-20', 1), cuota('2026-10-20', 2)], '2026-10-19').mesActual.pendienteCentavos, 3);
});

test('Proyección: detecta overflow en acumulados del mes, vencidos y ventanas que cruzan de mes', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.throws(() => proyectarCobros([cuota('2026-10-20', max), cuota('2026-10-21', 1)], '2026-10-19'), RangeError);
  assert.throws(() => proyectarCobros([cuota('2026-08-01', max), cuota('2026-09-01', 1)], '2026-10-19'), RangeError);
  assert.throws(() => proyectarCobros([cuota('2026-10-31', max), cuota('2026-11-01', 1)], '2026-10-31'), RangeError);
});
