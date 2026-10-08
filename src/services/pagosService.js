import {db} from '../db/connection.js';
import { registrarHistoriaPago } from './incidenciasService.js';
import {integer,dateISO} from '../lib/validation.js';
import {auditar} from '../lib/audit.js';
import { nowAR, diffDays } from '../lib/dates.js';
import { distribuirPago, estadoCuota, calcularMora } from '../lib/mora.js';
import { getCredito, actualizarEstadoCredito } from '../repositories/creditos.js';
import { listCuotasPorCredito, actualizarCuota } from '../repositories/cuotas.js';
import { getNegocio } from '../repositories/negocios.js';
import { crearPago, crearAplicacion, sumarSaldoFavor } from '../repositories/pagos.js';
import { crearComprobante } from '../repositories/comprobantes.js';

export async function registrarPago(input) {
  return db.transaction(async () => {
  const {
    credito_id, monto_centavos, fecha_hora = nowAR(), medio_pago = 'efectivo',
    caja = null, empleado = null, comprobante_url = null, nota = null, cuota_id = null, usuario_id = null,
  } = input;

  if (!credito_id) throw badRequest('credito_id es obligatorio');
  if (!monto_centavos || monto_centavos <= 0) throw badRequest('monto_centavos debe ser mayor a 0');

  integer(monto_centavos,'monto_centavos',{min:1});
  if(typeof fecha_hora!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(fecha_hora) || !Number.isFinite(Date.parse(fecha_hora))) throw badRequest('fecha_hora inválida');
  dateISO(fecha_hora.slice(0,10));
  const credito = await getCredito(credito_id);
  if (!credito) throw badRequest(`Crédito no encontrado: ${credito_id}`);

  await db.lockClienteNegocio(credito.cliente_id,credito.negocio_id);
  await db.prepare('SELECT id FROM creditos WHERE id=? FOR UPDATE').get(credito_id);
  const negocio = await getNegocio(credito.negocio_id);
  const today = fecha_hora.slice(0, 10);

  const todasLasCuotas = await listCuotasPorCredito(credito_id);
  const cuotasAntesDelPago = todasLasCuotas.map(c=>({...c}));
  const cuotasPendientes = todasLasCuotas.filter((c) => (c.saldo_pendiente_centavos > 0 || calcularMora(c, negocio, today).pendiente > 0) && !c.estado_manual);
  if(cuota_id && !cuotasPendientes.some(c=>c.id===cuota_id)) throw badRequest('La cuota indicada no está pendiente en este crédito');
  const saldoAnterior = cuotasPendientes.reduce((acc, c) => acc + c.saldo_pendiente_centavos, 0);

  if (cuotasPendientes.length === 0) {
    await sumarSaldoFavor(credito.cliente_id, credito.negocio_id, monto_centavos);
    const pago = await crearPago({
      negocio_id: credito.negocio_id, cliente_id: credito.cliente_id, credito_id, fecha_hora,
      monto_centavos, medio_pago, caja, empleado, comprobante_url, nota,
      saldo_anterior_centavos: 0, saldo_posterior_centavos: 0,
    });
    const comprobante = await crearComprobante({
      pago_id: pago.id, negocio_id: credito.negocio_id, cliente_id: credito.cliente_id, venta_id: credito.venta_id,
      credito_id, monto_centavos, fecha_hora, medio_pago, saldo_restante_centavos: 0, usuario_id,
    });
    await auditar('pago',pago.id,'crear',null,pago,usuario_id);
    return { pago, comprobante, aplicaciones: [], remanente: monto_centavos, saldoAnterior: 0, saldoPosterior: 0 };
  }

  const { aplicaciones, remanente, cuotasActualizadas } = distribuirPago({
    cuotas: cuotasPendientes, monto: monto_centavos, negocio, today, cuotaObjetivoId: cuota_id,
  });

  for (const cuota of cuotasActualizadas) {
    const seSaldoAhora = cuota.saldo_pendiente_centavos <= 0 && !cuota.fecha_saldada;
    // Al día en que se termina de pagar la cuota, se congela el atraso que tuvo (si tuvo).
    // Este dato queda para siempre en el historial, aunque después el estado pase a "pagada".
    const diasAtraso = seSaldoAhora ? Math.max(0, diffDays(today, cuota.fecha_vencimiento)) : undefined;
    await actualizarCuota(cuota.id, {
      saldo_pendiente_centavos: cuota.saldo_pendiente_centavos,
      mora_pagada_centavos: cuota.mora_pagada_centavos,
      mora_generada_centavos: cuota.mora_generada_centavos,
      fecha_saldada: seSaldoAhora ? today : cuota.fecha_saldada,
      dias_atraso_al_pagar: diasAtraso,
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

  const comprobante = await crearComprobante({
    pago_id: pago.id, negocio_id: credito.negocio_id, cliente_id: credito.cliente_id, venta_id: credito.venta_id,
    credito_id, monto_centavos, fecha_hora, medio_pago, saldo_restante_centavos: saldoPosterior, usuario_id,
  });

  const estadoCredito = await recalcularEstadoCredito(credito_id, negocio, today);
  await registrarHistoriaPago({credito,antes:cuotasAntesDelPago,despues:await listCuotasPorCredito(credito_id),fecha:today,pagoId:pago.id,usuarioId:usuario_id});

  await auditar('pago',pago.id,'crear',null,pago,usuario_id);
  return { pago, comprobante, aplicaciones, remanente, saldoAnterior, saldoPosterior, estadoCredito };
  });
}

export async function recalcularEstadoCredito(creditoId, negocio, today) {
  const cuotasFinal = await listCuotasPorCredito(creditoId);
  const todasPagadas = cuotasFinal.every((c) => (c.saldo_pendiente_centavos <= 0 && calcularMora(c, negocio, today).pendiente <= 0) || c.estado_manual);
  let estadoGeneral = 'activo';
  if (todasPagadas) {
    estadoGeneral = 'finalizado';
  } else {
    const estados = cuotasFinal
      .filter((c) => (c.saldo_pendiente_centavos > 0 || calcularMora(c, negocio, today).pendiente > 0) && !c.estado_manual)
      .map((c) => estadoCuota(c, negocio, today).estado);
    if (estados.includes('mora')) estadoGeneral = 'en_mora';
    else if (estados.includes('gracia') || estados.includes('vence_hoy')) estadoGeneral = 'en_gracia';
  }
  await actualizarEstadoCredito(creditoId, estadoGeneral);
  return estadoGeneral;
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

// La entrega ya se descontó al originar el crédito: no aplicar a cuotas ni a saldo a favor.
export async function registrarEntregaInicial({credito_id,monto_centavos,fecha_hora,medio_pago,usuario_id}) {
  return db.transaction(async()=>{
    const credito=await getCredito(credito_id);
    if(!credito) throw badRequest('Crédito no encontrado');
    integer(monto_centavos,'entrega inicial',{min:1});
    if(monto_centavos!==credito.entrega_inicial_centavos) throw badRequest('Entrega no coincide con el financiamiento');
    await db.lockClienteNegocio(credito.cliente_id,credito.negocio_id);
    const pago=await crearPago({negocio_id:credito.negocio_id,cliente_id:credito.cliente_id,credito_id,
      monto_centavos,fecha_hora,medio_pago,tipo:'entrega_inicial',saldo_anterior_centavos:credito.saldo_financiado_centavos,saldo_posterior_centavos:credito.saldo_financiado_centavos});
    const comprobante=await crearComprobante({pago_id:pago.id,negocio_id:credito.negocio_id,cliente_id:credito.cliente_id,credito_id,venta_id:credito.venta_id,
      monto_centavos,fecha_hora,medio_pago,saldo_restante_centavos:credito.saldo_financiado_centavos,usuario_id});
    await auditar('pago',pago.id,'entrega_inicial',null,pago,usuario_id);
    return {pago,comprobante};
  });
}
