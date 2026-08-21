import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearCredito(data) {
  const crId = id();
  await db.prepare(`
    INSERT INTO creditos (id, venta_id, negocio_id, cliente_id, modalidad, monto_total_centavos, entrega_inicial_centavos, saldo_financiado_centavos, fecha_inicio, estado)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    crId, data.venta_id, data.negocio_id, data.cliente_id, data.modalidad,
    data.monto_total_centavos, data.entrega_inicial_centavos || 0, data.saldo_financiado_centavos,
    data.fecha_inicio, 'activo'
  );
  return getCredito(crId);
}
export async function getCredito(crId) { return db.prepare('SELECT * FROM creditos WHERE id = ?').get(crId); }
export async function listCreditosPorCliente(clienteId, negocioId = null) {
  if (negocioId) return db.prepare('SELECT * FROM creditos WHERE cliente_id = ? AND negocio_id = ? ORDER BY fecha_inicio DESC').all(clienteId, negocioId);
  return db.prepare('SELECT * FROM creditos WHERE cliente_id = ? ORDER BY fecha_inicio DESC').all(clienteId);
}
export async function listCreditos(negocioId = null) {
  if (negocioId) return db.prepare('SELECT * FROM creditos WHERE negocio_id = ? ORDER BY fecha_inicio DESC').all(negocioId);
  return db.prepare('SELECT * FROM creditos ORDER BY fecha_inicio DESC').all();
}
export async function actualizarEstadoCredito(crId, estado) {
  await db.prepare('UPDATE creditos SET estado = ? WHERE id = ?').run(estado, crId);
}
