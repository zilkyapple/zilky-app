import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { auditar } from '../lib/audit.js';
import { text } from '../lib/validation.js';

const fallo = (message, status = 409) => Object.assign(new Error(message), { status });

// La identidad es global. Nunca borrar actividad de un negocio al quitar una ficha.
// Los FKs permanecen restrictivos: una nueva relación no contemplada falla cerrada.
export async function resumenEliminacion(clienteId, bloquear = false) {
  const cliente = await db.prepare('SELECT * FROM clientes WHERE id=?' + (bloquear ? ' FOR UPDATE' : '')).get(clienteId);
  if (!cliente) throw fallo('Cliente no encontrado', 404);
  const negocios = await db.prepare('SELECT negocio_id FROM cliente_negocio WHERE cliente_id=? ORDER BY negocio_id').all(clienteId);
  const { rows: [actividad] } = await db.query(`SELECT
    (SELECT COUNT(*)::int FROM ventas WHERE cliente_id=$1) AS operaciones,
    (SELECT COUNT(*)::int FROM creditos WHERE cliente_id=$1) AS financiaciones,
    (SELECT COUNT(*)::int FROM cuotas q JOIN creditos c ON c.id=q.credito_id WHERE c.cliente_id=$1) AS cuotas,
    (SELECT COUNT(*)::int FROM pagos WHERE cliente_id=$1) AS pagos,
    (SELECT COUNT(*)::int FROM comprobantes WHERE cliente_id=$1) AS comprobantes,
    (SELECT COUNT(*)::int FROM contratos WHERE cliente_id=$1) AS contratos,
    (SELECT COUNT(*)::int FROM recordatorios WHERE cliente_id=$1) AS recordatorios,
    (SELECT COUNT(*)::int FROM cobranza_gestion_eventos WHERE cliente_id=$1) AS gestiones,
    (SELECT COUNT(*)::int FROM cliente_negocio_cobranza WHERE cliente_id=$1) AS configuraciones_cobranza,
    (SELECT COUNT(*)::int FROM saldo_favor WHERE cliente_id=$1) AS saldos_favor,
    (SELECT COUNT(*)::int FROM auditoria WHERE entidad='cliente' AND entidad_id=$1) AS correcciones`, [clienteId]);
  const seguimiento = !!(cliente.seguimiento_estado || cliente.seguimiento_fecha || cliente.seguimiento_nota);
  const permitido = !seguimiento && Object.entries(actividad).every(([k,v]) => k === 'correcciones' || v === 0);
  const version = createHash('sha256').update(JSON.stringify({cliente,negocios,actividad,seguimiento})).digest('hex');
  return { cliente, negocios, actividad, seguimiento, permitido, version };
}

export async function eliminarClienteSinActividad({clienteId, version, confirmacion, motivo, solicitudId, usuarioId}) {
  const razon = text(motivo, 'motivo de eliminación', 2000);
  if (typeof solicitudId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(solicitudId)) throw fallo('Solicitud inválida',400);
  if (typeof version !== 'string' || confirmacion !== 'ELIMINAR') throw fallo('Confirmá escribiendo ELIMINAR',400);
  return db.transaction(async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['zilky:eliminar-cliente:'+clienteId]);
    const anterior = await db.prepare("SELECT datos_nuevos, empleado FROM auditoria WHERE entidad='cliente' AND entidad_id=? AND accion='eliminar_sin_actividad'").get(clienteId);
    if (anterior) {
      const dato = JSON.parse(anterior.datos_nuevos);
      if (dato.solicitudId === solicitudId && dato.version === version && anterior.empleado === usuarioId) return {eliminado:true};
      throw fallo('La ficha ya fue eliminada. Actualizá la lista.');
    }
    const r = await resumenEliminacion(clienteId,true);
    if (!r.permitido) throw fallo('No se puede eliminar: tiene operaciones o historial asociado. Conservamos la ficha y todos sus datos.');
    if (r.version !== version) throw fallo('La ficha cambió. Volvé a revisar la confirmación antes de eliminar.');
    // Copia de todos los datos básicos y vínculos en auditoría; los eventos anteriores
    // de edición permanecen. No se elimina ninguna tabla financiera ni seguimiento.
    await auditar('cliente',clienteId,'eliminar_sin_actividad',{cliente:r.cliente,negocios:r.negocios},{solicitudId,version},usuarioId,razon);
    await db.prepare('DELETE FROM cliente_negocio WHERE cliente_id=?').run(clienteId);
    await db.prepare('DELETE FROM clientes WHERE id=?').run(clienteId);
    return {eliminado:true};
  }).catch(error => {
    if (error.code === '23503') throw fallo('Apareció actividad asociada. No se eliminó ningún dato; volvé a revisar la ficha.');
    throw error;
  });
}
