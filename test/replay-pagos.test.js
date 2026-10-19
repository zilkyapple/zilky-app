import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarFechaPago, fechaPagoAR, reconstruirPagos } from '../src/lib/replayPagos.js';

const negocio = { dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 0, mora_periodo: 'semana', orden_aplicacion_pago: '["mora","capital"]' };
function datos() {
  const cuotas = ['2026-08-24', '2026-09-24', '2026-10-24', '2026-11-24', '2026-12-24', '2027-01-24'].map((fecha_vencimiento, i) => ({
    id: 'q' + (i + 1), numero: i + 1, credito_id: 'credito', monto_centavos: 15500000,
    saldo_pendiente_centavos: [0, 0, 2300000, 15500000, 15500000, 15500000][i], fecha_vencimiento,
    mora_generada_centavos: [1600000, 700000, 0, 0, 0, 0][i], mora_pagada_centavos: [1600000, 700000, 0, 0, 0, 0][i], mora_perdonada_centavos: 0,
  }));
  const pagos = ['2026-08-24T11:42:00-03:00', '2026-08-24T11:43:00-03:00', '2026-09-24T11:43:00-03:00'].map((fecha_hora, i) => ({ id: 'p' + i, fecha_hora, monto_centavos: 15500000, tipo: 'cuota', created_at: `2026-10-19 15:00:0${i}+00` }));
  return { credito: { id: 'credito', saldo_financiado_centavos: 93000000 }, cuotas, pagos, negocio };
}

test('replay: tres pagos de 155 mil recuperan 23 mil aplicados a mora congelada y dejan 465 mil', () => {
  const input = datos(), original = structuredClone(input);
  const r = reconstruirPagos(input);
  assert.deepEqual(r.cuotas.map(q => q.saldo_pendiente_centavos), [0, 0, 0, 15500000, 15500000, 15500000]);
  assert.equal(r.cuotas.reduce((s, q) => s + q.saldo_pendiente_centavos, 0), 46500000);
  assert.equal(r.cuotas.reduce((s, q) => s + q.mora_pagada_centavos, 0), 0);
  assert.equal(r.cuotas[1].fecha_saldada, '2026-08-24');
  assert.equal(r.cuotas[2].fecha_saldada, '2026-09-24');
  assert.deepEqual(input, original);
});

test('replay: fecha real corrige orden, cancelación y atraso sin duplicar entrega inicial', () => {
  const input = datos();
  input.pagos[1].fecha_hora = '2026-09-24T11:43:00-03:00';
  input.pagos[2].fecha_hora = '2026-10-24T11:43:00-03:00';
  input.pagos.reverse();
  input.pagos.push({ id: 'initial', tipo: 'entrega_inicial', monto_centavos: 18000000, fecha_hora: '2026-07-28T10:00:00-03:00' });
  const r = reconstruirPagos(input);
  assert.deepEqual(r.pagos.map(p => p.id), ['initial', 'p0', 'p1', 'p2']);
  assert.equal(r.pagos[0].aplicaciones.length, 0);
  assert.equal(r.pagos[0].remanente, 0);
  assert.equal(r.cuotas[2].fecha_saldada, '2026-10-24');
  assert.ok(r.cuotas.slice(0, 3).every(q => q.dias_atraso_al_pagar === 0));
});

test('replay: pagos anulados permanecen fuera de las distribuciones y saldo favor', () => {
  const input = datos(); input.pagos[0].anulado = 1;
  const r = reconstruirPagos(input);
  assert.equal(r.pagos.length, 2);
  assert.equal(r.cuotas.reduce((s, q) => s + q.saldo_pendiente_centavos, 0), 62000000);
  assert.equal(r.saldo_favor_generado_centavos, 0);
});

test('replay: conserva objetivos explícitos y devuelve excedente sin usarlo en otra cuota', () => {
  const input = datos();
  input.pagos = [{ ...input.pagos[0], monto_centavos: 20000000, objetivo_registrado: true, cuota_objetivo_id: 'q2' }];
  const r = reconstruirPagos(input);
  assert.equal(r.cuotas[0].saldo_pendiente_centavos, 15500000);
  assert.equal(r.cuotas[1].saldo_pendiente_centavos, 0);
  assert.equal(r.saldo_favor_generado_centavos, 4500000);
  assert.deepEqual(r.pagos[0].aplicaciones, [{ cuotaId: 'q2', capital: 15500000, mora: 0 }]);
});

test('replay: mora se calcula al día del dinero con capital y atraso coherentes', () => {
  const input = datos();
  input.negocio = { ...negocio, mora_tipo: 'fijo', mora_valor: 1000, mora_periodo: 'dia' };
  input.cuotas = input.cuotas.slice(0, 1);
  input.pagos = [{ ...input.pagos[0], fecha_hora: '2026-09-02T10:00:00-03:00', monto_centavos: 15700000 }];
  const r = reconstruirPagos(input);
  assert.equal(r.cuotas[0].saldo_pendiente_centavos, 0);
  assert.equal(r.cuotas[0].mora_pagada_centavos, 200000);
  assert.equal(r.cuotas[0].mora_generada_centavos, 200000);
  assert.equal(r.cuotas[0].dias_atraso_al_pagar, 9);
  assert.equal(r.saldo_favor_generado_centavos, 0);
});

test('replay: mismo instante desempata por creación e identidad', () => {
  const input = datos();
  input.pagos.forEach(p => { p.fecha_hora = '2026-08-24T10:00:00-03:00'; });
  input.pagos.reverse();
  assert.deepEqual(reconstruirPagos(input).pagos.map(p => p.id), ['p0', 'p1', 'p2']);
});

test('replay: conserva decisiones de cobranza al rechazar recálculo inseguro', () => {
  for (const cambio of [{ estado_manual: 'anulada' }, { mora_perdonada_centavos: 1000 }]) {
    const input = datos(); Object.assign(input.cuotas[0], cambio);
    assert.throws(() => reconstruirPagos(input), /conciliación/);
  }
});

test('fechas de dinero: usa día argentino incluso con entrada UTC y rechaza fechas inexistentes', () => {
  assert.equal(normalizarFechaPago('2026-08-25T01:15:32Z'), '2026-08-24T22:15:32-03:00');
  assert.equal(normalizarFechaPago('2026-08-25T01:15:32.123Z'), '2026-08-24T22:15:32.123-03:00');
  assert.equal(fechaPagoAR('2026-08-25T01:15:32Z'), '2026-08-24');
  for (const value of ['2026-02-30T10:00:00-03:00', '2026-08-24T24:00:00-03:00', '2026-08-24T10:60:00-03:00', '2026-08-24T10:00:00+15:00', '2026-08-24']) assert.throws(() => normalizarFechaPago(value));
});
