import { db } from '../db/connection.js';
import { fail } from './solicitud.js';

// Canonical payments and receipts are the source of truth. Voided originals stay
// in this list so a receipt correction also invalidates a stale order preview.
export async function resumenCobrosPedido(pedido) {
  const rows = await db.prepare(`SELECT t.id,t.pago_id,t.comprobante_id,t.usuario_id,t.created_at,
    p.negocio_id,p.cliente_id,p.credito_id,p.tipo,p.monto_centavos,p.medio_pago,p.fecha_hora,p.nota,p.anulado,p.motivo_anulacion,
    c.numero,c.estado AS comprobante_estado,c.monto_centavos AS comprobante_monto_centavos,
    c.fecha_hora AS comprobante_fecha_hora,c.medio_pago AS comprobante_medio_pago,c.anulado_motivo,c.anulado_por,c.anulado_fecha
    FROM tienda_pedido_cobros t JOIN pagos p ON p.id=t.pago_id JOIN comprobantes c ON c.id=t.comprobante_id
    WHERE t.pedido_id=? AND t.negocio_id=? ORDER BY t.created_at,t.id`).all(pedido.id, pedido.negocio_id);
  const cobros = rows.map(r => ({ id: r.id, pago_id: r.pago_id, comprobante_id: r.comprobante_id, usuario_id: r.usuario_id,
    cliente_id: r.cliente_id, negocio_id: r.negocio_id, credito_id: r.credito_id, tipo: r.tipo,
    monto_centavos: r.monto_centavos, medio_pago: r.medio_pago, fecha_hora: r.fecha_hora, nota: r.nota,
    anulado: r.anulado, motivo_anulacion: r.motivo_anulacion, created_at: r.created_at,
    comprobante: { id: r.comprobante_id, numero: r.numero, estado: r.comprobante_estado,
      monto_centavos: r.comprobante_monto_centavos, fecha_hora: r.comprobante_fecha_hora, medio_pago: r.comprobante_medio_pago,
      anulado_motivo: r.anulado_motivo, anulado_por: r.anulado_por, anulado_fecha: r.anulado_fecha } }));
  let cobrado = 0;
  for (const c of cobros) {
    if (c.anulado || c.comprobante.estado === 'anulado') continue;
    cobrado += c.monto_centavos;
    if (!Number.isSafeInteger(c.monto_centavos) || c.monto_centavos <= 0 || !Number.isSafeInteger(cobrado)) throw fail('Los cobros del pedido requieren conciliación', 409);
  }
  const saldo = Math.max(0, pedido.total_centavos - cobrado);
  return { cobros, resumen_cobros: { cobrado_centavos: cobrado, saldo_centavos: saldo, estado: cobrado === 0 ? 'sin_cobrar' : saldo === 0 ? 'cobrado' : 'parcial' } };
}
