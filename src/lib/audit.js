import { db } from '../db/connection.js';
import { id } from './id.js';
export async function auditar(entidad, entidadId, accion, anterior, nuevo, usuario=null, motivo=null) {
  await db.prepare(`INSERT INTO auditoria(id,entidad,entidad_id,accion,datos_anteriores,datos_nuevos,empleado,motivo)
    VALUES (?,?,?,?,?,?,?,?)`).run(id(),entidad,entidadId,accion,JSON.stringify(anterior),JSON.stringify(nuevo),usuario,motivo);
}
