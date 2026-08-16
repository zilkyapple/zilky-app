import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearProducto(data) {
  const pId = id();
  await db.prepare(`
    INSERT INTO productos (id, negocio_id, nombre, categoria, variante, sku, costo_centavos, precio_contado_centavos, precio_financiado_centavos, stock, stock_minimo, imei, estado, foto_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    pId, data.negocio_id, data.nombre, data.categoria || null, data.variante || null, data.sku || null,
    data.costo_centavos || 0, data.precio_contado_centavos || 0, data.precio_financiado_centavos || 0,
    data.stock ?? 1, data.stock_minimo ?? 0, data.imei || null, data.estado || 'disponible', data.foto_url || null
  );
  return getProducto(pId);
}

export async function getProducto(pId) {
  return db.prepare('SELECT * FROM productos WHERE id = ?').get(pId);
}

export async function listProductos(negocioId) {
  return db.prepare('SELECT * FROM productos WHERE negocio_id = ? ORDER BY nombre ASC').all(negocioId);
}

export async function descontarStock(pId, cantidad) {
  const p = await getProducto(pId);
  if (!p) return null;
  const nuevoStock = p.stock - cantidad;
  if (nuevoStock < 0) {
    const err = new Error(`Stock insuficiente para "${p.nombre}" (disponible: ${p.stock})`);
    err.code = 'STOCK_INSUFICIENTE';
    throw err;
  }
  await db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevoStock, pId);
  return getProducto(pId);
}
