import { crearInvitacion, listInvitaciones, revocarInvitacion, getInvitacion, limpiarInvitacionesVencidas, invalidarInvitacionesAnteriores } from '../repositories/invitaciones.js';

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

export async function invitarEmpleado({ email, nombre, negocios, organizacion_id, creado_por }) {
  if (!email) throw badRequest('email es obligatorio');
  if (!Array.isArray(negocios) || negocios.length === 0) throw badRequest('debe asignar al menos un negocio con permisos');
  await limpiarInvitacionesVencidas();
  const resultado = await crearInvitacion({ email, nombre, organizacion_id, negocios, creado_por });
  await invalidarInvitacionesAnteriores(email, resultado.invitacion.token_hash);
  return resultado;
}
export async function listarInvitaciones() { await limpiarInvitacionesVencidas(); return listInvitaciones(); }
export async function revocarInvitacionService(invId, revocadaPor) {
  const inv = await getInvitacion(invId);
  if (!inv) throw Object.assign(new Error('Invitación no encontrada'), { status: 404 });
  if (inv.estado !== 'pendiente') throw badRequest('Solo se pueden revocar invitaciones pendientes');
  return revocarInvitacion(invId, revocadaPor);
}
export async function regenerarInvitacion(invId, creado_por) {
  const inv = await getInvitacion(invId);
  if (!inv) throw Object.assign(new Error('Invitación no encontrada'), { status: 404 });
  if (inv.estado === 'usada') throw badRequest('No se puede regenerar una invitación ya usada');
  await revocarInvitacion(invId, creado_por);
  return invitarEmpleado({ email: inv.email, nombre: inv.nombre, negocios: JSON.parse(inv.negocios || '[]'), organizacion_id: inv.organizacion_id, creado_por });
}
