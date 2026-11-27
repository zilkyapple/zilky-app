import { ESQUEMA_CUENTA, entrarCuentaEnPeticion } from '../db/connection.js';
import { verificarToken } from '../lib/auth.js';
import { modoSaaS, diasGracia, emailDuenaPlataforma } from './config.js';
import { cuentaPorEsquema, funcionesHabilitadas } from './cuentas.js';
// Toma la cuenta del token y abre la conexión apuntando a su esquema.
export async function resolverCuenta(req, res, next) {
  req.cuenta = null;
  if (!modoSaaS()) return next();
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next();
  let payload;
  try { payload = verificarToken(h.slice(7)); } catch { return next(); }
  if (!ESQUEMA_CUENTA.test(payload?.ten || '')) return next();
  try {
    const cuenta = await cuentaPorEsquema(payload.ten);
    if (!cuenta) return next();
    req.cuenta = cuenta;
    await entrarCuentaEnPeticion(res, payload.ten, next);
  } catch (e) { next(e); }
}
export function cuentaHabilitada(cuenta, ahora = new Date()) {
  if (!cuenta) return false;
  if (['activa', 'exenta'].includes(cuenta.estado)) return true;
  if (cuenta.estado === 'pago_rechazado' && cuenta.rechazo_desde)
    return ahora.getTime() - new Date(cuenta.rechazo_desde).getTime() < diasGracia() * 86400000;
  return false;
}
export function exigirSuscripcionActiva(req, res, next) {
  if (!modoSaaS() || cuentaHabilitada(req.cuenta)) return next();
  res.status(402).json({ error: 'Tu suscripción no está activa', code: 'SUSCRIPCION_INACTIVA', estado: req.cuenta?.estado || null });
}
export function esDuenaPlataforma(req) {
  const email = emailDuenaPlataforma();
  return !!(modoSaaS() && email && req.cuenta && req.usuario?.rol === 'administrador' && req.usuario.email === email);
}
export function soloDuenaPlataforma(req, res, next) {
  if (!esDuenaPlataforma(req)) return res.status(404).json({ error: 'No encontrado' });
  next();
}
export async function funcionDisponible(req, clave) {
  if (!modoSaaS()) return true;
  if (req.cuenta?.estado === 'exenta') return true;
  return (await funcionesHabilitadas()).includes(clave);
}
// Funciones que la dueña habilita cuando quiere (tienda, Tiendanube).
export function exigirFuncion(clave) {
  return async (req, res, next) => {
    try { if (await funcionDisponible(req, clave)) return next(); res.status(404).json({ error: 'Función no disponible' }); }
    catch (e) { next(e); }
  };
}
// Rutas públicas que en la edición de venta no tienen cuenta asociada.
export function noDisponibleEnSaaS(req, res, next) {
  if (modoSaaS()) return res.status(404).json({ error: 'No disponible' });
  next();
}
