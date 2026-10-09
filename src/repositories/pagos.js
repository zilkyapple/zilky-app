import {capturarPagoCaja} from '../services/cajaService.js';
import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearPago(data) {
  const pId = id();
  await db.prepare(`
    INSERT INTO pagos (id, negocio_id, cliente_id, credito_id, fecha_hora, monto_centavos, medio_pago, caja, empleado, comprobante_url, nota, saldo_anterior_centavos, saldo_posterior_centavos, tipo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    pId, data.negocio_id, data.cliente_id, data.credito_id || null, data.fecha_hora,
    data.monto_centavos, data.medio_pago || 'efectivo', data.caja || null, data.empleado || null,
    data.comprobante_url || null, data.nota || null, data.saldo_anterior_centavos, data.saldo_posterior_centavos, data.tipo || 'cuota'
  );
  const pago=await getPago(pId);
  await capturarPagoCaja(pago,data.usuario_id);
  return pago;
}
export async function getPago(pId) { return db.prepare('SELECT * FROM pagos WHERE id = ?').get(pId); }
export async function crearAplicacion(pagoId, { cuotaId, capital, mora }) {
  const aId = id();
  await db.prepare(`
    INSERT INTO pago_aplicaciones (id, pago_id, cuota_id, capital_centavos, interes_mora_centavos) VALUES (?,?,?,?,?)
  `).run(aId, pagoId, cuotaId, capital, mora);
}
export async function listPagosPorCredito(creditoId) { return db.prepare('SELECT * FROM pagos WHERE credito_id = ? ORDER BY fecha_hora ASC').all(creditoId); }
export async function listPagosPorCliente(clienteId) { return db.prepare('SELECT * FROM pagos WHERE cliente_id = ? ORDER BY fecha_hora DESC').all(clienteId); }
export async function listAplicacionesPorPago(pagoId) { return db.prepare('SELECT * FROM pago_aplicaciones WHERE pago_id = ?').all(pagoId); }
export async function anularPago(pagoId, motivo, actor) {
  await db.prepare('UPDATE pagos SET anulado = 1, motivo_anulacion = ? WHERE id = ?').run(motivo || null, pagoId);
  const pago=await getPago(pagoId);
  await capturarPagoCaja(pago,actor,'anulacion');
  return pago;
}
export async function getSaldoFavor(clienteId, negocioId) {
  const row = await db.prepare('SELECT monto_centavos FROM saldo_favor WHERE cliente_id = ? AND negocio_id = ?').get(clienteId, negocioId);
  return row ? row.monto_centavos : 0;
}
export async function sumarSaldoFavor(clienteId, negocioId, delta) {
  const { rows } = await db.query(`INSERT INTO saldo_favor(cliente_id,negocio_id,monto_centavos)
    VALUES ($1,$2,$3) ON CONFLICT(cliente_id,negocio_id)
    DO UPDATE SET monto_centavos=saldo_favor.monto_centavos+EXCLUDED.monto_centavos RETURNING monto_centavos`,[clienteId,negocioId,delta]);
  return rows[0].monto_centavos;
}
