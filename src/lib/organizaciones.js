import { db } from '../db/connection.js';

const fallo = (message, status) => Object.assign(new Error(message), { status });

// Mantener estos bloqueos dentro de la transacción que crea el negocio o
// administrador: una revocación concurrente no debe conceder nuevas altas.
export async function resolverOrganizacionAdministrada(usuarioId, organizacionId) {
  if (typeof usuarioId !== 'string' || !usuarioId) throw fallo('Requiere un administrador autorizado', 403);
  if (organizacionId !== undefined && (typeof organizacionId !== 'string' || !organizacionId || organizacionId.length > 100)) {
    throw fallo('organizacion_id inválido', 400);
  }
  const membresias = await db.prepare(`SELECT uo.organizacion_id FROM usuario_organizacion uo
    JOIN usuarios u ON u.id=uo.usuario_id
    WHERE uo.usuario_id=? AND uo.activo=1 AND uo.rol='administrador'
      AND u.activo=1 AND u.rol='administrador'
    ORDER BY uo.organizacion_id FOR SHARE OF u,uo`).all(usuarioId);
  if (organizacionId !== undefined) {
    if (!membresias.some(m => m.organizacion_id === organizacionId)) throw fallo('Sin autorización en esta organización', 403);
    return organizacionId;
  }
  if (!membresias.length) throw fallo('Sin una organización administrativa activa', 403);
  if (membresias.length !== 1) throw fallo('Elegí la organización para esta alta con organizacion_id', 409);
  return membresias[0].organizacion_id;
}
