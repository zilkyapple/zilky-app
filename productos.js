import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

// stock = null significa "no controlado" (el negocio eligió no llevar stock todavía).
export async function crearProducto(data) {
  const pId = id();
  const stock = data.stock === undefined || data.stock === null || data.stock === ''
    ? null
    : Number(data.stock);
  await db.prepare(`
    INSERT INTO productos (id, negocio_id, nombre, categoria, variante, sku, costo_centavos, precio_contado_centavos, precio_financiado_centavos, stock, stock_minimo, imei, estado, foto_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    pId, data.negocio_id, data.nombre, data.categoria || null, data.variante || null, data.sku || null,
    data.costo_centavos || 0, data.precio_contado_centavos || 0, data.precio_financiado_centavos || 0,
    stock, data.stock_minimo ?? 0, data.imei || null, data.estado || 'disponible', data.foto_url || null
  );
  return getProducto(pId);
}

export async function getProducto(pId) {
  return db.prepare('SELECT * FROM productos WHERE id = ?').get(pId);
}

export async function listProductos(negocioId) {
  return db.prepare('SELECT * FROM productos WHERE negocio_id = ? ORDER BY nombre ASC').all(negocioId);
}

// Nunca bloquea una venta por falta de stock: si el producto no lleva control de stock
// (stock=null) no toca nada; si lleva control y no alcanza, igual descuenta (puede
// quedar en negativo, a propósito, para que se note que hay que reponer) y devuelve
// una advertencia en vez de tirar un error.
export async function descontarStock(pId, cantidad) {
  const p = await getProducto(pId);
  if (!p) return { producto: null, advertencia: null };
  if (p.stock === null) return { producto: p, advertencia: null };

  const nuevoStock = p.stock - cantidad;
  await db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevoStock, pId);
  const actualizado = await getProducto(pId);
  const advertencia = nuevoStock < 0 ? `Quedaste sin stock de "${p.nombre}" (stock: ${nuevoStock}). Revisalo cuando puedas.` : null;
  return { producto: actualizado, advertencia };
}
