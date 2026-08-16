import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearUsuario({ email, password_hash, nombre, rol = 'administrador' }) {
  const uId = id();
  await db.prepare(`
    INSERT INTO usuarios (id, email, password_hash, nombre, rol) VALUES (?,?,?,?,?)
  `).run(uId, email.toLowerCase().trim(), password_hash, nombre || null, rol);
  return getUsuarioById(uId);
}

export async function getUsuarioPorEmail(email) {
  return db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
}

export async function getUsuarioById(uId) {
  return db.prepare('SELECT id, email, nombre, rol, created_at FROM usuarios WHERE id = ?').get(uId);
}

export async function contarUsuarios() {
  const row = await db.prepare('SELECT COUNT(*)::int AS c FROM usuarios').get();
  return row.c;
}
