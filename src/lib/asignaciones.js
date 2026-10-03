import { db } from '../db/connection.js';
import { PERMISOS } from '../middleware/authorize.js';
import { badRequest } from './validation.js';
export async function validarAsignaciones(negocios) {
  if(!Array.isArray(negocios)) throw badRequest('negocios debe ser una lista');
  const ids=new Set();
  for(const a of negocios) {
    if(!a || Object.keys(a).some(k=>!['negocio_id','permisos'].includes(k)) || typeof a.negocio_id!=='string'||ids.has(a.negocio_id)) throw badRequest('Asignación de negocio inválida o duplicada');
    ids.add(a.negocio_id);
    if(!await db.prepare('SELECT id FROM negocios WHERE id=?').get(a.negocio_id)) throw badRequest('Negocio no encontrado');
    if(!a.permisos || typeof a.permisos!=='object'||Array.isArray(a.permisos)) throw badRequest('Permisos inválidos');
    for(const [p,v] of Object.entries(a.permisos)) if(!PERMISOS.includes(p)||typeof v!=='boolean') throw badRequest('Permiso desconocido o valor inválido');
  }
}
