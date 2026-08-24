import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearUsuario({ email, password_hash, nombre, rol = 'administrador', activo = 1, invitacion_completada = 1 }) {
  const uId = id();
  await db.prepare(`INSERT INTO usuarios (id, email, password_hash, nombre, rol, activo, invitacion_completada) VALUES (?,?,?,?,?,?,?)`)
    .run(uId, email.toLowerCase().trim(), password_hash, nombre || null, rol, activo, invitacion_completada);
  return getUsuarioById(uId);
}

export async function getUsuarioPorEmail(email) {
  return db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
}

export async function getUsuarioById(uId) {
  return db.prepare('SELECT id, email, nombre, rol, activo, invitacion_completada, created_at FROM usuarios WHERE id = ?').get(uId);
}

export async function listUsuarios() {
  return db.prepare('SELECT id, email, nombre, rol, activo, invitacion_completada, created_at FROM usuarios ORDER BY created_at DESC').all();
}

export async function actualizarUsuario(uId, data) {
  const actual = await getUsuarioById(uId);
  if (!actual) return null;
  const merged = { ...actual, ...data };
  await db.prepare('UPDATE usuarios SET nombre = ?, email = ?, rol = ?, activo = ? WHERE id = ?')
    .run(merged.nombre, merged.email.toLowerCase().trim(), merged.rol, merged.activo, uId);
  return getUsuarioById(uId);
}

export async function setPassword(uId, password_hash) {
  await db.prepare('UPDATE usuarios SET password_hash = ?, invitacion_completada = 1 WHERE id = ?')
    .run(password_hash, uId);
  return getUsuarioById(uId);
}

export async function getUsuarioNegocios(uId) {
  return db.prepare('SELECT * FROM usuario_negocio WHERE usuario_id = ?').all(uId);
}

export async function asignarNegocio(uId, negocioId, permisos) {
  await db.prepare(`
    INSERT INTO usuario_negocio (usuario_id, negocio_id, permisos, activo)
    VALUES (?,?,?,1)
    ON CONFLICT(usuario_id, negocio_id) DO UPDATE SET permisos = ?, activo = 1
  `).run(uId, negocioId, JSON.stringify(permisos || {}), JSON.stringify(permisos || {}));
  return getUsuarioNegocios(uId);
}

export async function desactivarNegocio(uId, negocioId) {
  await db.prepare('UPDATE usuario_negocio SET activo = 0 WHERE usuario_id = ? AND negocio_id = ?')
    .run(uId, negocioId);
  return getUsuarioNegocios(uId);
}
