import { nowAR } from '../lib/dates.js';
import { getComprobante, anularComprobanteRow, listComprobantes } from '../repositories/comprobantes.js';
import { listAplicacionesPorPago, anularPago, sumarSaldoFavor, getPago } from '../repositories/pagos.js';
import { getCuota, actualizarCuota } from '../repositories/cuotas.js';
import { getCredito } from '../repositories/creditos.js';
import { getNegocio } from '../repositories/negocios.js';
import { recalcularEstadoCredito } from './pagosService.js';

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

export async function verComprobantes(negocioId, clienteId) {
  return listComprobantes(negocioId, { clienteId });
}

// Anular NUNCA edita el comprobante ni el pago original: los marca como anulados,
// guarda quién/cuándo/por qué, y devuelve a las cuotas el saldo que habían cancelado
// (incluida la mora ya paga), para que la deuda vuelva a reflejar la realidad.
export async function anularComprobante(comprobanteId, { motivo, usuarioId }) {
  const comprobante = await getComprobante(comprobanteId);
  if (!comprobante) throw badRequest('Comprobante no encontrado');
  if (comprobante.estado === 'anulado') throw badRequest('Ese comprobante ya estaba anulado');
  if (!motivo) throw badRequest('El motivo de anulación es obligatorio');

  const pago = await getPago(comprobante.pago_id);
  const aplicaciones = await listAplicacionesPorPago(pago.id);

  for (const ap of aplicaciones) {
    const cuota = await getCuota(ap.cuota_id);
    if (!cuota) continue;
    const nuevoSaldo = cuota.saldo_pendiente_centavos + ap.capital_centavos;
    const nuevaMoraPagada = Math.max(0, (cuota.mora_pagada_centavos || 0) - ap.interes_mora_centavos);
    const reabrir = nuevoSaldo > 0;
    await actualizarCuota(cuota.id, {
      saldo_pendiente_centavos: nuevoSaldo,
      mora_pagada_centavos: nuevaMoraPagada,
      fecha_saldada: reabrir ? null : cuota.fecha_saldada,
      dias_atraso_al_pagar: reabrir ? null : cuota.dias_atraso_al_pagar,
    });
  }

  const totalAplicado = aplicaciones.reduce((a, ap) => a + ap.capital_centavos + ap.interes_mora_centavos, 0);
  const remanenteOriginal = pago.monto_centavos - totalAplicado;
  if (remanenteOriginal > 0) {
    await sumarSaldoFavor(pago.cliente_id, pago.negocio_id, -remanenteOriginal);
  }

  await anularPago(pago.id, motivo);
  const fecha = nowAR();
  await anularComprobanteRow(comprobanteId, { motivo, usuarioId, fecha });

  if (pago.credito_id) {
    const credito = await getCredito(pago.credito_id);
    const negocio = await getNegocio(credito.negocio_id);
    await recalcularEstadoCredito(credito.id, negocio, fecha.slice(0, 10));
  }

  return getComprobante(comprobanteId);
}
