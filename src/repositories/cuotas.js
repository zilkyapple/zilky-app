import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearCuota(data) {
  const cId = id();
  await db.prepare(`
    INSERT INTO cuotas (id, credito_id, numero, monto_centavos, saldo_pendiente_centavos, fecha_vencimiento)
    VALUES (?,?,?,?,?,?)
  `).run(cId, data.credito_id, data.numero, data.monto_centavos, data.monto_centavos, data.fecha_vencimiento);
  return getCuota(cId);
}

export async function getCuota(cId) {
  return db.prepare('SELECT * FROM cuotas WHERE id = ?').get(cId);
}

export async function listCuotasPorCredito(creditoId) {
  return db.prepare('SELECT * FROM cuotas WHERE credito_id = ? ORDER BY numero ASC').all(creditoId);
}

// Todas las cuotas con saldo pendiente de un negocio (o de todos), para cobranza/dashboard.
export async function listCuotasPendientes(negocioId = null) {
  const sql = `
    SELECT cu.*, cr.negocio_id, cr.cliente_id, cr.modalidad
    FROM cuotas cu
    JOIN creditos cr ON cr.id = cu.credito_id
    WHERE cu.saldo_pendiente_centavos > 0 AND cu.estado_manual IS NULL
    ${negocioId ? 'AND cr.negocio_id = ?' : ''}
    ORDER BY cu.fecha_vencimiento ASC
  `;
  return negocioId ? db.prepare(sql).all(negocioId) : db.prepare(sql).all();
}

export async function actualizarCuota(cId, { saldo_pendiente_centavos, mora_pagada_centavos, estado_manual, fecha_saldada }) {
  const actual = await getCuota(cId);
  await db.prepare(`
    UPDATE cuotas SET saldo_pendiente_centavos = ?, mora_pagada_centavos = ?, estado_manual = ?, fecha_saldada = ? WHERE id = ?
  `).run(
    saldo_pendiente_centavos ?? actual.saldo_pendiente_centavos,
    mora_pagada_centavos ?? actual.mora_pagada_centavos,
    estado_manual !== undefined ? estado_manual : actual.estado_manual,
    fecha_saldada !== undefined ? fecha_saldada : actual.fecha_saldada,
    cId
  );
  return getCuota(cId);
}
