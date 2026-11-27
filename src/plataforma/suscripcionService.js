import bcrypt from 'bcryptjs';
import { db, conCuenta } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { crearUsuario } from '../repositories/usuarios.js';
import { crearNegocio } from '../repositories/negocios.js';
import { firmarToken } from '../lib/auth.js';
import { normalizarEmail, validarPassword } from '../lib/invitaciones.js';
import { id as nuevoId } from '../lib/id.js';
import { emailDuenaPlataforma, urlApp } from './config.js';
import { precioActualCentavos } from './precio.js';
import { nuevoEsquema, insertarCuenta, actualizarCuenta, esquemaPorEmail, cuentaPorId, cuentaPorPreapproval } from './cuentas.js';
import { crearSuscripcion, crearSuscripcionConTarjeta, obtenerSuscripcion, obtenerPagoAutorizado, cambiarMontoSuscripcion } from './mercadopago.js';
import { listarCuentas } from './cuentas.js';

const fallo = (status, msg) => Object.assign(new Error(msg), { status });
// Mercado Pago solo deja pagar con la cuenta del correo indicado: si la
// persona usa otro correo en Mercado Pago, lo guardamos aparte.
export function emailDePago(valor, emailCuenta) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const e = normalizarEmail(valor);
  return e === emailCuenta ? null : e;
}
function texto(valor, campo, max, obligatorio = true) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (obligatorio && !v) throw fallo(400, `Completá ${campo}`);
  if (v.length > max) throw fallo(400, `${campo} es demasiado largo`);
  return v || null;
}

// Alta de una cuenta nueva: su esquema con todas las tablas, la dueña como
// administradora, su primer negocio y, si no es la dueña de la plataforma,
// el link de pago de Mercado Pago. Sin pago la cuenta queda bloqueada.
export async function registrarCuenta(body = {}) {
  const permitidos = ['nombre', 'negocio', 'email', 'email_pago', 'telefono', 'password'];
  if (Object.keys(body).some(k => !permitidos.includes(k))) throw fallo(400, 'Campo no permitido');
  const nombre = texto(body.nombre, 'tu nombre', 120);
  const negocio = texto(body.negocio, 'el nombre del negocio', 80);
  const telefono = texto(body.telefono, 'el teléfono', 30);
  if (!/^[+\d][\d\s()-]{5,29}$/.test(telefono)) throw fallo(400, 'Teléfono inválido');
  const email = normalizarEmail(body.email);
  validarPassword(body.password);
  const email_pago = emailDePago(body.email_pago, email);
  if (await esquemaPorEmail(email)) throw fallo(409, 'Ya existe una cuenta con ese email');
  const exenta = email === emailDuenaPlataforma();
  if (!exenta && !(await precioActualCentavos())) throw fallo(503, 'Las altas todavía no están habilitadas');

  const esquema = nuevoEsquema();
  let cuenta;
  try { cuenta = await insertarCuenta({ esquema, nombre, negocio_nombre: negocio, email, email_pago, telefono, estado: exenta ? 'exenta' : 'pendiente_pago' }); }
  catch (e) { if (e.code === '23505') throw fallo(409, 'Ya existe una cuenta con ese email'); throw e; }
  let token;
  try {
    await db.query(`CREATE SCHEMA "${esquema}"`);
    const password_hash = await bcrypt.hash(body.password, 10);
    token = await conCuenta(esquema, async () => {
      await migrate();
      const usuario = await crearUsuario({ email, password_hash, nombre });
      await crearNegocio({ nombre: negocio });
      return firmarToken(usuario);
    });
  } catch (e) {
    await db.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`).catch(() => {});
    await db.query('DELETE FROM public.plataforma_cuentas WHERE id=$1', [cuenta.id]).catch(() => {});
    throw e;
  }
  let init_point = null, pago_error = null;
  if (!exenta) {
    try { init_point = await linkDePago(cuenta); }
    catch (e) { pago_error = (e.status && e.status < 500) || e.publico ? e.message : 'No pudimos generar el link de pago. Probá de nuevo desde la app.'; }
  }
  return { token, estado: exenta ? 'exenta' : 'pendiente_pago', init_point, pago_error };
}

// Link de Mercado Pago para pagar (o volver a pagar) la suscripción.
export async function linkDePago(cuenta) {
  if (cuenta.estado === 'exenta') throw fallo(400, 'Esta cuenta no paga suscripción');
  const monto = await precioActualCentavos();
  // Un link pendiente se reutiliza solo si es del precio vigente.
  if (cuenta.mp_init_point && cuenta.mp_estado === 'pending' && cuenta.mp_monto_centavos === monto) return cuenta.mp_init_point;
  if (!monto) throw fallo(503, 'Falta configurar el precio');
  const base = urlApp();
  if (!base.startsWith('https://')) throw fallo(503, 'Falta configurar la dirección de la app');
  const pre = await crearSuscripcion({ cuentaId: cuenta.id, email: cuenta.email_pago || cuenta.email, montoCentavos: monto, backUrl: `${base}/app#/suscripcion` });
  await actualizarCuenta(cuenta.id, { mp_preapproval_id: pre.id, mp_estado: pre.status || 'pending', mp_init_point: pre.init_point, mp_monto_centavos: monto });
  return pre.init_point;
}

// Pago con tarjeta desde nuestra página: queda autorizada y se cobra sola cada mes.
export async function pagarConTarjeta(cuenta, { token, email } = {}) {
  if (cuenta.estado === 'exenta') throw fallo(400, 'Esta cuenta no paga suscripción');
  if (cuenta.estado === 'activa') throw fallo(409, 'Tu suscripción ya está al día');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(token)) throw fallo(400, 'Faltan los datos de la tarjeta');
  const payer = email ? normalizarEmail(email) : cuenta.email;
  const monto = await precioActualCentavos();
  if (!monto) throw fallo(503, 'Falta configurar el precio');
  const base = urlApp();
  if (!base.startsWith('https://')) throw fallo(503, 'Falta configurar la dirección de la app');
  const pre = await crearSuscripcionConTarjeta({ cuentaId: cuenta.id, email: payer, cardTokenId: token, montoCentavos: monto, backUrl: `${base}/app#/suscripcion` });
  const cambios = { mp_preapproval_id: pre.id, mp_estado: pre.status, mp_init_point: null, mp_monto_centavos: monto };
  if (pre.status === 'authorized') Object.assign(cambios, { estado: 'activa', rechazo_desde: null });
  await registrarEvento(cuenta.id, 'suscripcion', pre.id, pre.status, { status: pre.status, medio: 'tarjeta' });
  const c = await actualizarCuenta(cuenta.id, cambios);
  return { estado: c.estado, mp_estado: pre.status };
}

async function registrarEvento(cuentaId, tipo, recursoId, estado, detalle) {
  await db.query('INSERT INTO public.plataforma_eventos_pago (id,cuenta_id,tipo,recurso_id,estado,detalle) VALUES ($1,$2,$3,$4,$5,$6)',
    [nuevoId(), cuentaId, tipo, String(recursoId), estado || null, detalle ? JSON.stringify(detalle) : null]);
}

// Notificación de Mercado Pago: se consulta el estado real y se actualiza la cuenta.
export async function procesarNotificacion({ tipo, recursoId }) {
  if (!recursoId) return { ignorada: true };
  if (['subscription_preapproval', 'preapproval'].includes(tipo)) {
    const pre = await obtenerSuscripcion(recursoId);
    let cuenta = await cuentaPorPreapproval(pre.id);
    if (!cuenta && pre.external_reference) {
      const porRef = await cuentaPorId(pre.external_reference);
      const pagador = String(pre.payer_email || '').toLowerCase();
      if (porRef && [porRef.email, porRef.email_pago].includes(pagador)) cuenta = porRef;
    }
    if (!cuenta) return { ignorada: true };
    await registrarEvento(cuenta.id, 'suscripcion', pre.id, pre.status, { status: pre.status });
    const cambios = { mp_preapproval_id: pre.id, mp_estado: pre.status };
    if (cuenta.estado !== 'exenta') {
      if (pre.status === 'authorized' && ['pendiente_pago', 'bloqueada', 'cancelada'].includes(cuenta.estado)) Object.assign(cambios, { estado: 'activa', rechazo_desde: null });
      else if (pre.status === 'cancelled') cambios.estado = 'cancelada';
      else if (pre.status === 'paused') cambios.estado = 'bloqueada';
    }
    await actualizarCuenta(cuenta.id, cambios);
    return { cuenta_id: cuenta.id, estado: cambios.estado || cuenta.estado };
  }
  if (['subscription_authorized_payment', 'authorized_payment'].includes(tipo)) {
    const ap = await obtenerPagoAutorizado(recursoId);
    const cuenta = ap?.preapproval_id ? await cuentaPorPreapproval(ap.preapproval_id) : null;
    if (!cuenta) return { ignorada: true };
    const estadoPago = ap.payment?.status || null;
    await registrarEvento(cuenta.id, 'pago', ap.id || recursoId, estadoPago, { status: ap.status, payment_status: estadoPago });
    if (cuenta.estado === 'exenta') return { cuenta_id: cuenta.id, estado: 'exenta' };
    const ahora = new Date().toISOString();
    if (estadoPago === 'approved') {
      await actualizarCuenta(cuenta.id, { estado: 'activa', ultimo_pago_en: ahora, primer_pago_en: cuenta.primer_pago_en || ahora, rechazo_desde: null });
      return { cuenta_id: cuenta.id, estado: 'activa' };
    }
    if (['rejected', 'cancelled'].includes(estadoPago) && ['activa', 'pago_rechazado'].includes(cuenta.estado)) {
      await actualizarCuenta(cuenta.id, { estado: 'pago_rechazado', rechazo_desde: cuenta.rechazo_desde || ahora });
      return { cuenta_id: cuenta.id, estado: 'pago_rechazado' };
    }
    return { cuenta_id: cuenta.id, estado: cuenta.estado };
  }
  return { ignorada: true };
}

// Aplica el precio vigente a todas las suscripciones de Mercado Pago que
// siguen vivas. Los links pendientes se regeneran con el precio nuevo.
export async function aplicarPrecioASuscripciones() {
  const monto = await precioActualCentavos();
  if (!monto) throw fallo(400, 'Primero definí el precio');
  const resultado = { actualizadas: 0, sin_cambios: 0, errores: [] };
  for (const c of await listarCuentas()) {
    if (c.estado === 'exenta' || !c.mp_preapproval_id) continue;
    if (c.mp_monto_centavos === monto) { resultado.sin_cambios++; continue; }
    if (c.mp_estado === 'pending') { await actualizarCuenta(c.id, { mp_init_point: null }); resultado.actualizadas++; continue; }
    if (!['authorized', 'paused'].includes(c.mp_estado)) continue;
    try { await cambiarMontoSuscripcion(c.mp_preapproval_id, monto); await actualizarCuenta(c.id, { mp_monto_centavos: monto }); resultado.actualizadas++; }
    catch { resultado.errores.push(c.email); }
  }
  return { ...resultado, precio_centavos: monto };
}

export async function cambiarEmailDePago(cuenta, valor) {
  const email_pago = emailDePago(valor, cuenta.email);
  if ((email_pago || null) === (cuenta.email_pago || null)) return cuenta;
  return actualizarCuenta(cuenta.id, { email_pago, mp_init_point: null });
}
