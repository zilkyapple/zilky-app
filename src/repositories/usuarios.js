import { db, esquemaActual } from '../db/connection.js';
import { id } from '../lib/id.js';

// Edición de venta: el correo es único en toda la plataforma y el directorio
// dice a qué cuenta pertenece, para saber dónde buscarlo al iniciar sesión.
function emailEnUso(error) {
  if (error?.code === '23505') return Object.assign(new Error('Ya existe una cuenta con ese email'), { status: 409 });
  return error;
}
async function reservarEmailEnDirectorio(email) {
  const esquema = esquemaActual();
  if (!esquema) return;
  try { await db.query('INSERT INTO public.plataforma_directorio (email, esquema) VALUES ($1,$2)', [email, esquema]); }
  catch (error) { throw emailEnUso(error); }
}

export async function crearUsuario({ email, password_hash, nombre, rol = 'administrador', activo = 1, invitacion_completada = 1 }) {
  const uId = id();
  const normalizado = email.toLowerCase().trim();
  await db.transaction(async () => {
    await reservarEmailEnDirectorio(normalizado);
    await db.prepare(`INSERT INTO usuarios (id, email, password_hash, nombre, rol, activo, invitacion_completada) VALUES (?,?,?,?,?,?,?)`)
      .run(uId, normalizado, password_hash, nombre || null, rol, activo, invitacion_completada);
  });
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
  const nuevoEmail = merged.email.toLowerCase().trim();
  await db.transaction(async () => {
    const esquema = esquemaActual();
    if (esquema && nuevoEmail !== actual.email) {
      try { await db.query('UPDATE public.plataforma_directorio SET email=$1 WHERE email=$2 AND esquema=$3', [nuevoEmail, actual.email, esquema]); }
      catch (error) { throw emailEnUso(error); }
    }
    await db.prepare('UPDATE usuarios SET nombre = ?, email = ?, rol = ?, activo = ? WHERE id = ?')
      .run(merged.nombre, nuevoEmail, merged.rol, merged.activo, uId);
  });
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
