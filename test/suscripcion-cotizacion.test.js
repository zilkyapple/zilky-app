import test from 'node:test';
import assert from 'node:assert/strict';
import { cotizarSuscripcionBlue, consultarPrecioBlue, BLUE_URL } from '../src/services/suscripcionCotizacionService.js';
const now = Date.parse('2026-10-16T00:25:00Z');
const rate = { casa: 'blue', moneda: 'USD', compra: 1500, venta: 1555, fechaActualizacion: '2026-10-15T18:00:00Z' };
test('USD20 a blue vendedor 1555 son ARS31100 sin usar compra', () => {
  const terms = cotizarSuscripcionBlue(rate, { now });
  assert.equal(terms.amountCents, 3110000);
  assert.equal(terms.currency, 'ARS');
  assert.equal(terms.rateCents, 155500);
  assert.equal(terms.rateSource, BLUE_URL);
  assert.ok(Object.isFrozen(terms));
});
test('una nueva cotización cambia el próximo precio sin mutar los términos previos', () => {
  const first = cotizarSuscripcionBlue(rate, { now });
  const second = cotizarSuscripcionBlue({ ...rate, venta: 1600 }, { now });
  assert.equal(second.amountCents, 3200000);
  assert.equal(first.amountCents, 3110000);
  assert.notEqual(first.priceVersion, second.priceVersion);
});
test('rechaza fuente equivocada, precio inválido y cotización vieja o futura', () => {
  for (const invalid of [{ casa: 'oficial' }, { moneda: 'ARS' }, { venta: '1555' }, { venta: 0 }, { venta: -1 }, { venta: Infinity }, { venta: 1555.123 }, { fechaActualizacion: '2026-10-10T00:00:00Z' }, { fechaActualizacion: '2026-10-17T00:00:00Z' }, { fechaActualizacion: null }]) assert.throws(() => cotizarSuscripcionBlue({ ...rate, ...invalid }, { now }));
});
test('tolera fin de semana con fecha de fuente conservada', () => {
  assert.equal(cotizarSuscripcionBlue(rate, { now: now + 2 * 86400000 }).rateUpdatedAt, '2026-10-15T18:00:00.000Z');
});
test('consulta endpoint fijo sin credenciales y falla sin precio alternativo inventado', async () => {
  const result = await consultarPrecioBlue({ now, fetchImpl: async (url, options) => {
    assert.equal(url, BLUE_URL); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => rate };
  } });
  assert.equal(result.amountCents, 3110000);
  await assert.rejects(consultarPrecioBlue({ now, fetchImpl: async () => ({ ok: false }) }));
  await assert.rejects(consultarPrecioBlue({ now, fetchImpl: async () => { throw new Error('timeout'); } }));
});
