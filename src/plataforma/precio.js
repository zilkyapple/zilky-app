import { db } from '../db/connection.js';
import { precioMensualCentavos as precioDeEntorno } from './config.js';
// Precio de la suscripción: la dueña lo define en dólares con la cotización
// del día y la app lo cobra en pesos (Mercado Pago cobra en ARS). El
// resultado se redondea a la centena de pesos. Sin ajuste guardado se usa
// PRECIO_MENSUAL_ARS.
export function pesosDesdeDolares(usd, cotizacion) {
  return Math.round((usd * cotizacion) / 100) * 100 * 100;
}
export async function ajustePrecio() {
  const { rows } = await db.query("SELECT valor, actualizado_en FROM public.plataforma_ajustes WHERE clave='precio'");
  const v = rows[0]?.valor;
  if (!v || !(v.usd > 0) || !(v.cotizacion > 0)) return null;
  return { usd: Number(v.usd), cotizacion: Number(v.cotizacion), centavos: pesosDesdeDolares(Number(v.usd), Number(v.cotizacion)), actualizado_en: rows[0].actualizado_en };
}
export async function precioActualCentavos() {
  return (await ajustePrecio())?.centavos ?? precioDeEntorno();
}
export async function guardarPrecio({ usd, cotizacion }) {
  if (typeof usd !== 'number' || !(usd >= 1 && usd <= 1000)) throw Object.assign(new Error('Precio en dólares inválido'), { status: 400 });
  if (typeof cotizacion !== 'number' || !(cotizacion >= 100 && cotizacion <= 100000)) throw Object.assign(new Error('Cotización inválida'), { status: 400 });
  await db.query(`INSERT INTO public.plataforma_ajustes (clave, valor) VALUES ('precio', $1)
    ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, actualizado_en=now()`, [JSON.stringify({ usd, cotizacion })]);
  return ajustePrecio();
}
