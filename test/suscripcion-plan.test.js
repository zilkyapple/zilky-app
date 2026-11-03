import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_ZILKY, crearTerminosSuscripcion, prepararCheckoutMercadoPago, validarCheckoutMercadoPago, validarImportePagoSuscripcion } from '../src/services/suscripcionPlanService.js';

// Importes ARS ficticios exclusivamente para pruebas; no establecen tarifa comercial.
const config = { currency: 'ARS', amountCents: 100000, priceVersion: 'qa-only', approvedAt: '2026-10-16T00:00:00Z' };
const terms = crearTerminosSuscripcion(config);
const checkout = { terms, subscriptionId: 'subscription-qa', payerEmail: 'qa@example.test', backUrl: 'https://example.test/suscripcion' };
const expected = { terms, collectorId: '123', subscriptionId: 'subscription-qa' };
const paid = { id: 987, status: 'approved', collector_id: 123, external_reference: 'subscription-qa', currency_id: 'ARS', transaction_amount: 1000, transaction_amount_refunded: 0 };

test('plan USD20 mensual inmutable, sin alta ni prueba gratis implícitas', () => {
  assert.deepEqual(PLAN_ZILKY, { id: 'zilky-mensual-usd20-v1', currency: 'USD', amountCents: 2000, frequency: 1, frequencyType: 'months' });
  assert.ok(Object.isFrozen(PLAN_ZILKY));
  assert.ok(Object.isFrozen(terms));
  assert.equal(crearTerminosSuscripcion({ ...config, currency: 'USD', amountCents: 2000 }).amountCents, 2000);
});

test('rechaza moneda, precio y aprobación incompletos; no adivina conversión', () => {
  for (const bad of [{ currency: 'EUR' }, { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: NaN }, { amountCents: Infinity }, { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { approvedAt: '' }, { priceVersion: '' }, { currency: 'USD', amountCents: 20 }]) {
    assert.throws(() => crearTerminosSuscripcion({ ...config, ...bad }));
  }
});

test('checkout mensual pendiente sin capturar tarjetas ni confiar en precio del navegador', () => {
  const payload = prepararCheckoutMercadoPago(checkout);
  assert.deepEqual(payload.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 1000, currency_id: 'ARS' });
  assert.equal(payload.status, 'pending');
  assert.equal(payload.external_reference, 'subscription-qa');
  assert.equal(payload.card_token_id, undefined);
  assert.equal(payload.auto_recurring.repetitions, undefined);
  assert.throws(() => prepararCheckoutMercadoPago({ ...checkout, terms: crearTerminosSuscripcion({ ...config, currency: 'USD', amountCents: 2000 }) }));
  for (const bad of [{ backUrl: 'http://example.test' }, { backUrl: 'https://user:secret@example.test' }, { payerEmail: 'bad' }, { subscriptionId: '../another' }]) assert.throws(() => prepararCheckoutMercadoPago({ ...checkout, ...bad }));
});

test('sólo permite checkout del proveedor y contrato esperados', () => {
  const response = { id: 'provider-qa', external_reference: 'subscription-qa', init_point: 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=provider-qa' };
  assert.equal(validarCheckoutMercadoPago(response, 'subscription-qa').providerSubscriptionId, 'provider-qa');
  for (const bad of [{ external_reference: 'other' }, { id: 'other' }, { init_point: 'https://www.mercadopago.com.ar.evil.test/subscriptions/checkout?preapproval_id=provider-qa' }, { init_point: 'javascript:alert(1)' }]) assert.throws(() => validarCheckoutMercadoPago({ ...response, ...bad }, 'subscription-qa'));
});

test('validación de cobro rechaza pagos ajenos, impagos, moneda/precio distinto o reembolsados', () => {
  assert.deepEqual(validarImportePagoSuscripcion(paid, expected), { providerPaymentId: '987', amountCents: 100000, currency: 'ARS' });
  for (const bad of [{ status: 'pending' }, { status: 'authorized' }, { status: 'charged_back' }, { collector_id: 999 }, { external_reference: 'other' }, { currency_id: 'USD' }, { transaction_amount: 999 }, { transaction_amount: 1000.001 }, { transaction_amount: '1000' }, { transaction_amount_refunded: 1 }, { transaction_amount_refunded: undefined }, { id: null }]) assert.throws(() => validarImportePagoSuscripcion({ ...paid, ...bad }, expected));
});
