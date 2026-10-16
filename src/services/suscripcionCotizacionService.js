import { crearTerminosSuscripcion, PLAN_ZILKY } from './suscripcionPlanService.js';

export const BLUE_URL = 'https://dolarapi.com/v1/dolares/blue';
const DAY = 86400000;

// Sólo consumir desde el servidor. Nunca aceptar cotización ni reloj del navegador.
// Hasta 4 días permite fines de semana/feriados; si excede, no inventar un precio.
export function cotizarSuscripcionBlue(data, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error('Reloj inválido');
  if (!data || data.casa !== 'blue' || data.moneda !== 'USD') throw new Error('Cotización no corresponde a dólar blue');
  const rate = data.venta;
  const rateCents = Math.round(rate * 100);
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(rateCents) || Math.abs(rate * 100 - rateCents) > 0.000001) throw new Error('Cotización vendedora inválida');
  const updated = typeof data.fechaActualizacion === 'string' ? Date.parse(data.fechaActualizacion) : NaN;
  if (!Number.isFinite(updated) || updated > now + 300000 || now - updated > 4 * DAY) throw new Error('Cotización desactualizada o fecha inválida');
  const amountCents = rateCents * (PLAN_ZILKY.amountCents / 100);
  if (!Number.isSafeInteger(amountCents)) throw new Error('Importe fuera de rango');
  const terms = crearTerminosSuscripcion({ currency: 'ARS', amountCents,
    priceVersion: `blue-venta-v1:${new Date(updated).toISOString()}:${rateCents}`,
    approvedAt: '2026-10-16T00:23:54Z' }); // autorización de la política, no del proveedor
  return Object.freeze({ ...terms, pricingPolicy: 'usd20-blue-venta-v1',
    rateCents, rateSource: BLUE_URL, rateUpdatedAt: new Date(updated).toISOString(),
    quotedAt: new Date(now).toISOString() });
}

export async function consultarPrecioBlue({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const response = await fetchImpl(BLUE_URL, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('No se pudo obtener la cotización; no generar cobro');
  return cotizarSuscripcionBlue(await response.json(), { now });
}
