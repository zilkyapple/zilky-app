// Facturación de la plataforma Zilky. No pertenece a ventas ni cobranzas del negocio.
// Base preparatoria: no monta rutas, crea cargos ni habilita acceso a la aplicación.
export const PLAN_ZILKY = Object.freeze({
  id: 'zilky-mensual-usd20-v1', currency: 'USD', amountCents: 2000,
  frequency: 1, frequencyType: 'months'
});

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} requerido`);
  return value.trim();
}

function httpsUrl(value, label) {
  const url = new URL(required(value, label));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} debe usar HTTPS`);
  return url;
}

/** Configuración exclusivamente del servidor; nunca recibirla del formulario de pago.
 * El importe ARS es una cotización aprobada, no una conversión automática inventada.
 * Los términos se conservan en cada contratación antes de contactar al procesador.
 */
export function crearTerminosSuscripcion({ currency, amountCents, priceVersion, approvedAt }) {
  if (!['USD', 'ARS'].includes(currency)) throw new Error('Moneda no configurada');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Importe inválido');
  if (currency === 'USD' && amountCents !== PLAN_ZILKY.amountCents) throw new Error('El plan cuesta USD 20 por mes');
  if (typeof approvedAt !== 'string' || !Number.isFinite(Date.parse(approvedAt))) throw new Error('Falta aprobación de moneda e importe');
  return Object.freeze({
    planId: PLAN_ZILKY.id, referenceCurrency: 'USD', referenceAmountCents: 2000,
    currency, amountCents, frequency: 1, frequencyType: 'months',
    priceVersion: required(priceVersion, 'Versión del precio'), approvedAt
  });
}

/** Checkout alojado: el servidor no recibe números de tarjeta ni CVV.
 * Esta primera variante se limita a la moneda ARS documentada para la cuenta argentina.
 * USD requiere confirmar un procesador/cuenta que permita liquidar ese contrato.
 */
export function prepararCheckoutMercadoPago({ terms, subscriptionId, payerEmail, backUrl }) {
  const validated = crearTerminosSuscripcion(terms);
  if (validated.currency !== 'ARS') throw new Error('Cobro USD pendiente de verificar con el procesador');
  const reference = required(subscriptionId, 'Identificador de suscripción');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(reference)) throw new Error('Identificador inválido');
  if (typeof payerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) throw new Error('Email inválido');
  return {
    reason: 'Zilky — suscripción mensual', external_reference: reference,
    payer_email: payerEmail, status: 'pending',
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: validated.amountCents / 100, currency_id: validated.currency },
    back_url: httpsUrl(backUrl, 'URL de regreso').href
  };
}

export function validarCheckoutMercadoPago(response, subscriptionId) {
  if (!response || response.external_reference !== subscriptionId || typeof response.id !== 'string' || !response.id) throw new Error('Respuesta de checkout no asociada');
  const url = httpsUrl(response.init_point, 'Checkout');
  if (url.hostname !== 'www.mercadopago.com.ar' || url.port || url.pathname !== '/subscriptions/checkout' || url.searchParams.get('preapproval_id') !== response.id) throw new Error('Destino de checkout inválido');
  return Object.freeze({ providerSubscriptionId: response.id, checkoutUrl: url.href });
}

/** Sólo para un pago consultado desde la API del proveedor con credenciales del servidor.
 * Nunca pasar aquí el cuerpo de un webhook ni los parámetros de la URL de regreso.
 * Esta validación NO activa membresías: falta transacción/ledger idempotente y vínculo
 * autorizado entre payment ID, factura recurrente y providerSubscriptionId.
 */
export function validarImportePagoSuscripcion(payment, { terms, collectorId, subscriptionId }) {
  const validated = crearTerminosSuscripcion(terms);
  const collector = required(collectorId, 'Cuenta receptora');
  const reference = required(subscriptionId, 'Identificador de suscripción');
  if (!payment || !['string', 'number'].includes(typeof payment.id) || !String(payment.id)) throw new Error('Pago sin identificador');
  if (payment.status !== 'approved') throw new Error('Pago no aprobado');
  if (String(payment.collector_id) !== collector || payment.external_reference !== reference) throw new Error('Pago de otra cuenta o suscripción');
  if (payment.currency_id !== validated.currency) throw new Error('Moneda incorrecta');
  const amount = payment.transaction_amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount * 100 - validated.amountCents) > 0.000001) throw new Error('Importe incorrecto');
  if (typeof payment.transaction_amount_refunded !== 'number' || payment.transaction_amount_refunded !== 0) throw new Error('Reembolso pendiente de conciliación');
  return Object.freeze({ providerPaymentId: String(payment.id), amountCents: validated.amountCents, currency: validated.currency });
}
