import bcrypt from 'bcryptjs';
import { db, conCuenta } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { crearUsuario } from '../repositories/usuarios.js';
import { crearNegocio } from '../repositories/negocios.js';
import { firmarToken } from '../lib/auth.js';
import { normalizarEmail, validarPassword } from '../lib/invitaciones.js';
import { id as nuevoId } from '../lib/id.js';
import { precioMensualCentavos, emailDuenaPlataforma, urlApp } from './config.js';
import { nuevoEsquema, insertarCuenta, actualizarCuenta, esquemaPorEmail, cuentaPorId, cuentaPorPreapproval } from './cuentas.js';
import { crearSuscripcion, obtenerSuscripcion, obtenerPagoAutorizado } from './mercadopago.js';

const fallo = (status, msg) => Object.assign(new Error(msg), { status });
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
  const permitidos = ['nombre', 'negocio', 'email', 'telefono', 'password'];
  if (Object.keys(body).some(k => !permitidos.includes(k))) throw fallo(400, 'Campo no permitido');
  const nombre = texto(body.nombre, 'tu nombre', 120);
  const negocio = texto(body.negocio, 'el nombre del negocio', 80);
  const telefono = texto(body.telefono, 'el teléfono', 30);
  if (!/^[+\d][\d\s()-]{5,29}$/.test(telefono)) throw fallo(400, 'Teléfono inválido');
  const email = normalizarEmail(body.email);
  validarPassword(body.password);
  if (await esquemaPorEmail(email)) throw fallo(409, 'Ya existe una cuenta con ese email');
  const exenta = email === emailDuenaPlataforma();
  if (!exenta && !precioMensualCentavos()) throw fallo(503, 'Las altas todavía no están habilitadas');

  const esquema = nuevoEsquema();
  let cuenta;
  try { cuenta = await insertarCuenta({ esquema, nombre, negocio_nombre: negocio, email, telefono, estado: exenta ? 'exenta' : 'pendiente_pago' }); }
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
    catch (e) { pago_error = e.status && e.status < 500 ? e.message : 'No pudimos generar el link de pago. Probá de nuevo desde la app.'; }
  }
  return { token, estado: exenta ? 'exenta' : 'pendiente_pago', init_point, pago_error };
}

// Link de Mercado Pago para pagar (o volver a pagar) la suscripción.
export async function linkDePago(cuenta) {
  if (cuenta.estado === 'exenta') throw fallo(400, 'Esta cuenta no paga suscripción');
  if (cuenta.mp_init_point && cuenta.mp_estado === 'pending') return cuenta.mp_init_point;
  const monto = precioMensualCentavos();
  if (!monto) throw fallo(503, 'Falta configurar el precio');
  const base = urlApp();
  if (!base.startsWith('https://')) throw fallo(503, 'Falta configurar la dirección de la app');
  const pre = await crearSuscripcion({ cuentaId: cuenta.id, email: cuenta.email, montoCentavos: monto, backUrl: `${base}/#/suscripcion` });
  await actualizarCuenta(cuenta.id, { mp_preapproval_id: pre.id, mp_estado: pre.status || 'pending', mp_init_point: pre.init_point });
  return pre.init_point;
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
      if (porRef && porRef.email === String(pre.payer_email || '').toLowerCase()) cuenta = porRef;
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
