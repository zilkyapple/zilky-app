import { createHmac, timingSafeEqual } from 'node:crypto';
// Cliente mínimo de la API de Suscripciones de Mercado Pago. Las
// notificaciones nunca se creen tal cual: siempre se vuelve a consultar el
// estado real a la API con nuestras credenciales.
const API = 'https://api.mercadopago.com';
function accessToken() {
  const t = process.env.MP_ACCESS_TOKEN;
  if (!t) throw Object.assign(new Error('Mercado Pago todavía no está configurado'), { status: 503 });
  return t;
}
async function llamar(method, ruta, body) {
  const r = await fetch(API + ruta, {
    method,
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error('Mercado Pago rechazó la operación'), { status: 502, detalle: data });
  return data;
}
export function crearSuscripcion({ cuentaId, email, montoCentavos, backUrl }) {
  return llamar('POST', '/preapproval', {
    reason: 'Cobranzas · suscripción mensual',
    external_reference: cuentaId,
    payer_email: email,
    back_url: backUrl,
    status: 'pending',
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: montoCentavos / 100, currency_id: 'ARS' },
  });
}
export const obtenerSuscripcion = (id) => llamar('GET', `/preapproval/${encodeURIComponent(id)}`);
export const obtenerPagoAutorizado = (id) => llamar('GET', `/authorized_payments/${encodeURIComponent(id)}`);
// Firma de notificaciones (x-signature: "ts=...,v1=..."). Si no hay secreto
// configurado no se valida, pero igual se consulta el estado a la API.
export function firmaValida({ xSignature, xRequestId, dataId, secret = process.env.MP_WEBHOOK_SECRET }) {
  if (!secret) return true;
  const partes = Object.fromEntries(String(xSignature || '').split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p.length === 2));
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId || '') ? String(dataId).toLowerCase() : dataId;
  const manifiesto = `id:${id};request-id:${xRequestId};ts:${partes.ts};`;
  const esperado = createHmac('sha256', secret).update(manifiesto).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(String(partes.v1));
  return a.length === b.length && timingSafeEqual(a, b);
}
