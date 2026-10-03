import { db } from '../db/connection.js';
import { validarAsignaciones } from '../lib/asignaciones.js';
import { normalizarEmail, validarNombre, bloquearEmail, emailDuplicado, estadoInvitacion, asignacionesInvitacion, invitacionPublica } from '../lib/invitaciones.js';
import { getUsuarioPorEmail } from '../repositories/usuarios.js';
import { crearInvitacion, listInvitaciones, revocarInvitacion, getInvitacion, invalidarInvitacionesAnteriores } from '../repositories/invitaciones.js';
import { enviarInvitacionEmail, isEmailConfigured } from './emailService.js';
import { badRequest } from '../lib/validation.js';

async function crearDentroTransaccion({ email, nombre, negocios, organizacion_id, creado_por }) {
  email = normalizarEmail(email); validarNombre(nombre);
  if (!Array.isArray(negocios) || !negocios.length) throw badRequest('Debe asignar al menos un negocio con permisos');
  await bloquearEmail(email);
  if (await getUsuarioPorEmail(email)) throw emailDuplicado();
  await validarAsignaciones(negocios);
  const resultado = await crearInvitacion({ email, nombre, negocios, organizacion_id, creado_por });
  await invalidarInvitacionesAnteriores(email, resultado.invitacion.token_hash);
  return resultado;
}
async function enviarResultado(resultado) {
  let emailEnviado = false;
  let emailError = 'El envío de email no está configurado. Podés compartir el enlace de forma privada.';
  if (isEmailConfigured()) {
    try {
      await enviarInvitacionEmail({ email: resultado.invitacion.email, nombre: resultado.invitacion.nombre, token: resultado.token });
      emailEnviado = true; emailError = null;
    } catch {
      // El proveedor puede incluir credenciales o el enlace: nunca devolver ni registrar su error.
      emailError = 'No se pudo enviar el email. Podés compartir el enlace o regenerar y reenviar la invitación.';
    }
  }
  return { invitacion: invitacionPublica(resultado.invitacion), token: resultado.token, emailEnviado, emailError };
}
export async function invitarEmpleado(data) {
  return enviarResultado(await db.transaction(() => crearDentroTransaccion(data)));
}
export async function listarInvitaciones() {
  return (await listInvitaciones()).map(invitacionPublica);
}
async function bloquearPorId(invId) {
  const anterior = await getInvitacion(invId);
  if (!anterior) throw Object.assign(new Error('Invitación no encontrada'), { status: 404 });
  await bloquearEmail(anterior.email);
  return db.prepare('SELECT * FROM invitaciones WHERE id=? FOR UPDATE').get(invId);
}
export async function revocarInvitacionService(invId, revocadaPor) {
  return db.transaction(async () => {
    const inv = await bloquearPorId(invId);
    if (estadoInvitacion(inv) !== 'pendiente') throw badRequest('Solo se pueden revocar invitaciones pendientes');
    return invitacionPublica(await revocarInvitacion(invId, revocadaPor));
  });
}
export async function regenerarInvitacion(invId, creado_por) {
  const resultado = await db.transaction(async () => {
    const inv = await bloquearPorId(invId);
    if (inv.estado === 'usada') throw badRequest('No se puede regenerar una invitación ya usada');
    // Validar y crear primero: un fallo deja vigente el enlace anterior.
    return crearDentroTransaccion({ email: inv.email, nombre: inv.nombre, negocios: asignacionesInvitacion(inv), organizacion_id: inv.organizacion_id, creado_por });
  });
  return enviarResultado(resultado);
}
