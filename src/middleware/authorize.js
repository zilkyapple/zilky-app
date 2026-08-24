import { verificarToken } from '../lib/auth.js';
import { getUsuarioById, getUsuarioNegocios } from '../repositories/usuarios.js';
import { getInvitacionPorToken } from '../repositories/invitaciones.js';

export async function cargarUsuario(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.usuario = null;
    return next();
  }
  try {
    const payload = verificarToken(token);
    const usuario = await getUsuarioById(payload.sub);
    if (!usuario || !usuario.activo) {
      req.usuario = null;
      return next();
    }
    const negocios = await getUsuarioNegocios(usuario.id);
    req.usuario = {
      ...usuario,
      negocios: negocios || [],
      negocioIds: (negocios || []).filter((n) => n.activo).map((n) => n.negocio_id),
    };
    req.usuarioId = usuario.id;
    next();
  } catch {
    req.usuario = null;
    next();
  }
}

export function requireAuth(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Falta iniciar sesión' });
  next();
}

export function requirePermiso(permiso) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Falta iniciar sesión' });
    if (req.usuario.rol === 'administrador') return next();
    const negocioId = req.query.negocio_id || req.body.negocio_id || null;
    const tiene = tienePermisoEnNegocio(req, negocioId, permiso);
    if (!tiene) return res.status(403).json({ error: 'No tenés permiso para realizar esta acción' });
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Falta iniciar sesión' });
  if (req.usuario.rol !== 'administrador') return res.status(403).json({ error: 'Requiere administrador' });
  next();
}

export function scopeNegocios(req) {
  if (!req.usuario) return [];
  if (req.usuario.rol === 'administrador') return null; // null = todos
  return req.usuario.negocioIds || [];
}

export function validarScopeNegocio(req, negocioId) {
  if (!req.usuario) return false;
  if (req.usuario.rol === 'administrador') return true;
  if (!negocioId) return true;
  return req.usuario.negocioIds.includes(negocioId);
}

export function tienePermisoEnNegocio(req, negocioId, permiso) {
  if (!req.usuario) return false;
  if (req.usuario.rol === 'administrador') return true;
  if (!negocioId) {
    return req.usuario.negocios.some((n) => {
      if (!n.activo) return false;
      const p = parsePermisos(n.permisos);
      return p[permiso] === true;
    });
  }
  const asignacion = req.usuario.negocios.find((n) => n.negocio_id === negocioId);
  if (!asignacion || !asignacion.activo) return false;
  const p = parsePermisos(asignacion.permisos);
  return p[permiso] === true;
}

export function parsePermisos(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

// Para queries SQL con arrays de negocios (PostgreSQL ANY)
export function sqlInNegocios(sql, negocioId, scope, paramIndex = 1) {
  if (negocioId) {
    return { sql: sql.replace(/\{NEGOCIO_FILTER\}/g, 'AND negocio_id = $' + paramIndex), params: [negocioId] };
  }
  if (scope && Array.isArray(scope) && scope.length > 0) {
    return { sql: sql.replace(/\{NEGOCIO_FILTER\}/g, 'AND negocio_id = ANY($' + paramIndex + '::text[])'), params: [scope] };
  }
  return { sql: sql.replace(/\{NEGOCIO_FILTER\}/g, ''), params: [] };
}
