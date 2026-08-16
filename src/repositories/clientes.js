import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearCliente(data) {
  const cId = id();
  await db.prepare(`
    INSERT INTO clientes (id, nombre, apellido, telefono, whatsapp, dni, direccion, ciudad, provincia, fecha_nacimiento, trabajo, frecuencia_pago, foto_url, notas)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    cId, data.nombre, data.apellido || null, data.telefono || null, data.whatsapp || data.telefono || null,
    data.dni || null, data.direccion || null, data.ciudad || null, data.provincia || null,
    data.fecha_nacimiento || null, data.trabajo || null, data.frecuencia_pago || null,
    data.foto_url || null, data.notas || null
  );
  return getCliente(cId);
}

export async function getCliente(cId) {
  return db.prepare('SELECT * FROM clientes WHERE id = ?').get(cId);
}

export async function listClientes() {
  return db.prepare('SELECT * FROM clientes ORDER BY created_at DESC').all();
}

export async function buscarClientes(q) {
  const like = `%${q}%`;
  return db.prepare(`
    SELECT * FROM clientes
    WHERE nombre ILIKE ? OR apellido ILIKE ? OR dni ILIKE ? OR telefono ILIKE ?
    ORDER BY nombre ASC LIMIT 25
  `).all(like, like, like, like);
}

// Detección simple de duplicados por DNI o teléfono exacto (sección 11).
export async function buscarDuplicados({ dni, telefono }) {
  if (!dni && !telefono) return [];
  return db.prepare(`
    SELECT * FROM clientes WHERE (dni IS NOT NULL AND dni = ?) OR (telefono IS NOT NULL AND telefono = ?)
  `).all(dni || '__none__', telefono || '__none__');
}
