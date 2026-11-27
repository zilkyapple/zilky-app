// Edición de venta ("Cobranzas"): se activa solo con EDICION=saas. Sin esa
// variable la app funciona exactamente como siempre, con un único esquema.
export function modoSaaS() { return process.env.EDICION === 'saas'; }
export function precioMensualCentavos() {
  const pesos=Number(process.env.PRECIO_MENSUAL_ARS);
  return Number.isFinite(pesos) && pesos>0 ? Math.round(pesos*100) : null;
}
export function diasGracia() {
  const d=Number(process.env.DIAS_GRACIA ?? 10);
  return Number.isInteger(d) && d>=0 && d<=60 ? d : 10;
}
export function emailDuenaPlataforma() { return (process.env.PLATAFORMA_ADMIN_EMAIL||'').trim().toLowerCase() || null; }
export function urlApp() { return (process.env.APP_URL||'').replace(/\/+$/,''); }
export const MARCA = 'Cobranzas';
// Funciones que la dueña habilita para los clientes cuando lo decida.
export const FUNCIONES_OPCIONALES = ['tienda', 'tiendanube'];
