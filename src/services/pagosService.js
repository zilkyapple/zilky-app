import { nowAR } from '../lib/dates.js';
import { distribuirPago } from '../lib/mora.js';
import { getCredito, actualizarEstadoCredito } from '../repositories/creditos.js';
import { listCuotasPorCredito, actualizarCuota } from '../repositories/cuotas.js';
import { getNegocio } from '../repositories/negocios.js';
import { crearPago, crearAplicacion, sumarSaldoFavor } from '../repositories/pagos.js';
import { estadoCuota } from '../lib/mora.js';

export async function registrarPago(input) {
  const {
    credito_id, monto_centavos, fecha_hora = nowAR(), medio_pago = 'efectivo',
    caja = null, empleado = null, comprobante_url = null, nota = null, cuota_id = null,
  } = input;

  if (!credito_id) throw badRequest('credito_id es obligatorio');
  if (!monto_centavos || monto_centavos <= 0) throw badRequest('monto_centavos debe ser mayor a 0');

  const credito = await getCredito(credito_id);
  if (!credito) throw badRequest(`Crédito no encontrado: ${credito_id}`);

  const negocio = await getNegocio(credito.negocio_id);
  // La mora se calcula "a la fecha del pago" (por defecto, ahora mismo), para poder cargar pagos retroactivos correctamente.
  const today = fecha_hora.slice(0, 10);

  const todasLasCuotas = await listCuotasPorCredito(credito_id);
  const cuotasPendientes = todasLasCuotas.filter((c) => c.saldo_pendiente_centavos > 0 && !c.estado_manual);
  const saldoAnterior = cuotasPendientes.reduce((acc, c) => acc + c.saldo_pendiente_centavos, 0);

  if (cuotasPendientes.length === 0) {
    // Crédito ya saldado: todo el pago es saldo a favor.
    await sumarSaldoFavor(credito.cliente_id, credito.negocio_id, monto_centavos);
    const pago = await crearPago({
      negocio_id: credito.negocio_id, cliente_id: credito.cliente_id, credito_id, fecha_hora,
      monto_centavos, medio_pago, caja, empleado, comprobante_url, nota,
      saldo_anterior_centavos: 0, saldo_posterior_centavos: 0,
    });
    return { pago, aplicaciones: [], remanente: monto_centavos, saldoAnterior: 0, saldoPosterior: 0 };
  }

  const { aplicaciones, remanente, cuotasActualizadas } = distribuirPago({
    cuotas: cuotasPendientes, monto: monto_centavos, negocio, today, cuotaObjetivoId: cuota_id,
  });

  // Persistir cambios en cada cuota tocada (si recién ahora queda en $0, se guarda la fecha real de saldado)
  for (const cuota of cuotasActualizadas) {
    const seSaldoAhora = cuota.saldo_pendiente_centavos <= 0 && !cuota.fecha_saldada;
    await actualizarCuota(cuota.id, {
      saldo_pendiente_centavos: cuota.saldo_pendiente_centavos,
      mora_pagada_centavos: cuota.mora_pagada_centavos,
      fecha_saldada: seSaldoAhora ? today : cuota.fecha_saldada,
    });
  }

  const saldoPosterior = cuotasActualizadas.reduce((acc, c) => acc + c.saldo_pendiente_centavos, 0);

  if (remanente > 0) await sumarSaldoFavor(credito.cliente_id, credito.negocio_id, remanente);

  const pago = await crearPago({
    negocio_id: credito.negocio_id, cliente_id: credito.cliente_id, credito_id, fecha_hora,
    monto_centavos, medio_pago, caja, empleado, comprobante_url, nota,
    saldo_anterior_centavos: saldoAnterior, saldo_posterior_centavos: saldoPosterior,
  });

  for (const ap of aplicaciones) {
    if (ap.capital > 0 || ap.mora > 0) await crearAplicacion(pago.id, { cuotaId: ap.cuotaId, capital: ap.capital, mora: ap.mora });
  }

  // Recalcular estado general del crédito
  const cuotasFinal = await listCuotasPorCredito(credito_id);
  const todasPagadas = cuotasFinal.every((c) => c.saldo_pendiente_centavos <= 0 || c.estado_manual);
  let estadoGeneral = 'activo';
  if (todasPagadas) {
    estadoGeneral = 'finalizado';
  } else {
    const estados = cuotasFinal
      .filter((c) => c.saldo_pendiente_centavos > 0 && !c.estado_manual)
      .map((c) => estadoCuota(c, negocio, today).estado);
    if (estados.includes('mora')) estadoGeneral = 'en_mora';
    else if (estados.includes('gracia') || estados.includes('vence_hoy')) estadoGeneral = 'en_gracia';
  }
  await actualizarEstadoCredito(credito_id, estadoGeneral);

  return { pago, aplicaciones, remanente, saldoAnterior, saldoPosterior, estadoCredito: estadoGeneral };
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
