import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

// Los clientes son GLOBALES: un mismo cliente puede comprar en varios negocios y sigue
// siendo una única ficha. Lo que se aísla por negocio son las OPERACIONES (ventas,
// créditos, cuotas, pagos, comprobantes), nunca la identidad del cliente.
export async function crearCliente(data) {
  if (!data.nombre || !data.apellido) {
    const e = new Error('nombre y apellido son obligatorios'); e.status = 400; throw e;
  }
  const cId = id();
  await db.prepare(`
    INSERT INTO clientes (id, nombre, apellido, telefono, whatsapp, instagram, dni, direccion, ciudad, provincia, fecha_nacimiento, trabajo, frecuencia_pago, foto_url, notas)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    cId, data.nombre, data.apellido, data.telefono || null, data.whatsapp || data.telefono || null,
    normalizarInstagram(data.instagram), data.dni || null, data.direccion || null, data.ciudad || null, data.provincia || null,
    data.fecha_nacimiento || null, data.trabajo || null, data.frecuencia_pago || null,
    data.foto_url || null, data.notas || null
  );
  return getCliente(cId);
}

function normalizarInstagram(handle) {
  if (!handle) return null;
  const limpio = handle.trim().replace(/^@/, '');
  return limpio ? `@${limpio}` : null;
}

export async function getCliente(cId) {
  return db.prepare('SELECT * FROM clientes WHERE id = ?').get(cId);
}

export async function listClientes() {
  return db.prepare('SELECT * FROM clientes ORDER BY created_at DESC').all();
}

// negocioId es opcional: si se pasa, además de buscar por texto, sólo trae clientes que
// tengan al menos una operación (crédito) en ese negocio — un filtro, no una partición.
export async function buscarClientes(q, negocioId = null) {
  const like = `%${q}%`;
  if (negocioId) {
    return db.prepare(`
      SELECT DISTINCT cl.* FROM clientes cl JOIN creditos cr ON cr.cliente_id = cl.id
      WHERE cr.negocio_id = ? AND (cl.nombre ILIKE ? OR cl.apellido ILIKE ? OR cl.dni ILIKE ? OR cl.telefono ILIKE ? OR cl.instagram ILIKE ?)
      ORDER BY cl.nombre ASC LIMIT 25
    `).all(negocioId, like, like, like, like, like);
  }
  return db.prepare(`
    SELECT * FROM clientes
    WHERE nombre ILIKE ? OR apellido ILIKE ? OR dni ILIKE ? OR telefono ILIKE ? OR instagram ILIKE ?
    ORDER BY nombre ASC LIMIT 25
  `).all(like, like, like, like, like);
}

// Duplicados se chequean de forma global (no tiene sentido permitir el mismo DNI dos
// veces sólo porque se cargó desde otro negocio: es la misma persona).
export async function buscarDuplicados({ dni, telefono }) {
  if (!dni && !telefono) return [];
  return db.prepare(`
    SELECT * FROM clientes WHERE (dni IS NOT NULL AND dni = ?) OR (telefono IS NOT NULL AND telefono = ?)
  `).all(dni || '__none__', telefono || '__none__');
}

export async function actualizarSeguimiento(cId, { seguimiento_estado, seguimiento_nota, seguimiento_fecha }) {
  await db.prepare(`
    UPDATE clientes SET seguimiento_estado = ?, seguimiento_nota = ?, seguimiento_fecha = ? WHERE id = ?
  `).run(seguimiento_estado ?? null, seguimiento_nota ?? null, seguimiento_fecha ?? null, cId);
  return getCliente(cId);
}

// Clientes que, DENTRO DE UN NEGOCIO PUNTUAL, ya no tienen ninguna cuota pendiente pero
// sí tuvieron al menos una compra ahí — candidatos a recompra en ESE negocio. Es una
// vista financiera (por negocio), no cambia la ficha global del cliente.
export async function listClientesFinalizados(negocioId) {
  return db.prepare(`
    SELECT cl.*,
      (SELECT COUNT(*) FROM creditos cr WHERE cr.cliente_id = cl.id AND cr.negocio_id = ?) AS total_compras,
      (SELECT MAX(v.fecha) FROM ventas v WHERE v.cliente_id = cl.id AND v.negocio_id = ?) AS ultima_compra,
      (SELECT MAX(p.fecha_hora) FROM pagos p WHERE p.cliente_id = cl.id AND p.negocio_id = ? AND p.anulado = 0) AS ultimo_pago
    FROM clientes cl
    WHERE EXISTS (SELECT 1 FROM creditos cr WHERE cr.cliente_id = cl.id AND cr.negocio_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM cuotas cu JOIN creditos cr ON cr.id = cu.credito_id
        WHERE cr.cliente_id = cl.id AND cr.negocio_id = ? AND cu.saldo_pendiente_centavos > 0 AND cu.estado_manual IS NULL
      )
    ORDER BY ultima_compra DESC
  `).all(negocioId, negocioId, negocioId, negocioId, negocioId);
}
