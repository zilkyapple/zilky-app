import { db, pool } from '../db/connection.js';
import { id } from '../lib/id.js';

// Numeración única real: usa una secuencia de Postgres (nextval es atómico incluso con
// escrituras concurrentes), formateada como ZLK-YYYYMMDD-NNNNNN.
async function siguienteNumero(fechaISO) {
  const { rows } = await pool.query("SELECT nextval('comprobantes_seq') AS n");
  const n = rows[0].n.toString().padStart(6, '0');
  const fecha = fechaISO.slice(0, 10).replace(/-/g, '');
  return `ZLK-${fecha}-${n}`;
}

export async function crearComprobante(data) {
  const cId = id();
  const numero = await siguienteNumero(data.fecha_hora);
  await db.prepare(`
    INSERT INTO comprobantes (id, numero, pago_id, negocio_id, cliente_id, venta_id, credito_id, monto_centavos, fecha_hora, medio_pago, saldo_restante_centavos, usuario_id, estado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'emitido')
  `).run(
    cId, numero, data.pago_id, data.negocio_id, data.cliente_id, data.venta_id || null, data.credito_id || null,
    data.monto_centavos, data.fecha_hora, data.medio_pago || null, data.saldo_restante_centavos ?? null, data.usuario_id || null
  );
  return getComprobante(cId);
}

export async function getComprobante(cId) {
  return db.prepare('SELECT * FROM comprobantes WHERE id = ?').get(cId);
}

export async function getComprobantePorPago(pagoId) {
  return db.prepare('SELECT * FROM comprobantes WHERE pago_id = ?').get(pagoId);
}

export async function listComprobantes(negocioId, { clienteId = null, limit = 50 } = {}) {
  if (clienteId) {
    return db.prepare('SELECT * FROM comprobantes WHERE negocio_id = ? AND cliente_id = ? ORDER BY fecha_hora DESC LIMIT ?').all(negocioId, clienteId, limit);
  }
  return db.prepare('SELECT * FROM comprobantes WHERE negocio_id = ? ORDER BY fecha_hora DESC LIMIT ?').all(negocioId, limit);
}

// Nunca se edita un comprobante emitido. Anular deja el original intacto y agrega
// los datos de la anulación (fecha, quién, motivo) — trazabilidad completa.
export async function anularComprobanteRow(cId, { motivo, usuarioId, fecha }) {
  await db.prepare(`
    UPDATE comprobantes SET estado = 'anulado', anulado_motivo = ?, anulado_por = ?, anulado_fecha = ? WHERE id = ?
  `).run(motivo || null, usuarioId || null, fecha, cId);
  return getComprobante(cId);
}
