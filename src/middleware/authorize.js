import { verificarToken } from '../lib/auth.js';
import { getUsuarioById, getUsuarioNegocios } from '../repositories/usuarios.js';
import { db } from '../db/connection.js';
export const PERMISOS = ['clientes.ver','clientes.editar','ventas.crear','pagos.registrar','productos.ver','costos.ver','cobranzas.ver','dashboard_financiero.ver','comprobantes.ver','comprobantes.anular','empleados.gestionar'];
export function parsePermisos(value) {
  try { const p=typeof value==='string'?JSON.parse(value):value; return p && typeof p==='object' && !Array.isArray(p)?p:{}; } catch { return {}; }
}
export async function cargarUsuario(req,res,next) {
  req.usuario=null;
  const header=req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  let payload;
  try { payload=verificarToken(header.slice(7)); } catch { return next(); }
  try {
    const usuario=await getUsuarioById(payload.sub);
    if (!usuario || usuario.activo!==1) return next();
    const negocios=await getUsuarioNegocios(usuario.id);
    req.usuario={...usuario,negocios,negocioIds:negocios.filter(n=>n.activo===1).map(n=>n.negocio_id)};
    req.usuarioId=usuario.id; next();
  } catch(e) { next(e); }
}
export function requireAuth(req,res,next) { if (!req.usuario) return res.status(401).json({error:'Falta iniciar sesión'}); next(); }
export function requireAdmin(req,res,next) { if (!req.usuario) return res.status(401).json({error:'Falta iniciar sesión'}); if(req.usuario.rol!=='administrador') return res.status(403).json({error:'Requiere administrador'}); next(); }
export function negocioSolicitado(req) {
  const q=req.query?.negocio_id,b=req.body?.negocio_id;
  if ((q!==undefined && (typeof q!=='string'||!q)) || (b!==undefined && (typeof b!=='string'||!b)) || (q && b && q!==b)) throw Object.assign(new Error('negocio_id inválido o contradictorio'),{status:400});
  return q||b||null;
}
export function scopeNegocios(req, permiso) {
  if (!req.usuario) return [];
  if(req.usuario.rol==='administrador') return null;
  // Etapa 3: las finanzas consolidadas son exclusivas del administrador,
  // incluso si una asignación antigua conserva este permiso.
  if (permiso === 'dashboard_financiero.ver') return [];
  return [...new Set(req.usuario.negocios.filter(n=>n.activo===1 && (!permiso || parsePermisos(n.permisos)[permiso]===true)).map(n=>n.negocio_id))];
}
export function tienePermisoEnNegocio(req, negocioId, permiso) {
  const scope=scopeNegocios(req,permiso);
  return scope===null || (negocioId ? scope.includes(negocioId) : scope.length>0);
}
export function validarScopeNegocio(req, negocioId) {
  const scope=scopeNegocios(req); return scope===null || (!!negocioId && scope.includes(negocioId));
}
export function exigirPermisoNegocio(req, negocioId, permiso) {
  const solicitado=negocioSolicitado(req);
  if (solicitado && solicitado!==negocioId) throw Object.assign(new Error('El recurso no pertenece al negocio solicitado'),{status:403});
  if (!negocioId || !tienePermisoEnNegocio(req,negocioId,permiso)) throw Object.assign(new Error('No tenés permiso en este negocio'),{status:403});
}
export function requirePermiso(permiso) {
  return (req,res,next)=>{ try {
    if (!req.usuario) return res.status(401).json({error:'Falta iniciar sesión'});
    if(!tienePermisoEnNegocio(req,negocioSolicitado(req),permiso)) return res.status(403).json({error:'No tenés permiso para realizar esta acción'});
    next();
  } catch(e) { next(e); } };
}
export function scopePara(req, permiso) {
  const solicitado=negocioSolicitado(req);
  if(solicitado) { exigirPermisoNegocio(req,solicitado,permiso); return [solicitado]; }
  return scopeNegocios(req,permiso);
}
export function scopeClientesOperativos(req) {
  const cobranza = scopePara(req, 'cobranzas.ver');
  const clientes = scopePara(req, 'clientes.ver');
  return cobranza === null ? clientes : clientes === null ? cobranza : cobranza.filter(id => clientes.includes(id));
}
export async function exigirCliente(req, clienteId, permiso) {
  const scope=scopePara(req,permiso);
  if(scope===null) return null;
  if(!scope.length) throw Object.assign(new Error('Sin acceso al cliente'),{status:403});
  const {rows}=await db.query('SELECT negocio_id FROM cliente_negocio WHERE cliente_id=$1 AND negocio_id=ANY($2::text[])',[clienteId,scope]);
  if(!rows.length) throw Object.assign(new Error('Cliente no encontrado o sin acceso'),{status:404});
  return rows.map(x=>x.negocio_id);
}
