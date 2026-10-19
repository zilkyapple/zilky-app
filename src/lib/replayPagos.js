import { distribuirPago } from './mora.js';
import { diffDays } from './dates.js';
import { dateISO } from './validation.js';

const fail = message => Object.assign(new Error(message), { status: 409 });
const sumar = values => {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw fail('Los importes del crédito están fuera de rango');
  return total;
};

export function fechaPagoAR(fechaHora) {
  const fecha = new Date(fechaHora);
  if (!Number.isFinite(fecha.getTime())) throw fail('Un pago tiene una fecha inválida; requiere conciliación');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(fecha);
}

export function normalizarFechaPago(value) {
  const invalida = () => Object.assign(new Error('Fecha y hora del pago inválidas'), { status: 400 });
  if (typeof value !== 'string') throw invalida();
  const partesHora = value.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!partesHora || +partesHora[1] > 23 || +partesHora[2] > 59 || +partesHora[3] > 59 || !Number.isFinite(Date.parse(value))) throw invalida();
  dateISO(value.slice(0, 10));
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offset && (+offset[2] > 14 || +offset[3] > 59 || (+offset[2] === 14 && +offset[3] !== 0))) throw invalida();
  const instante = new Date(value);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante).reduce((r, p) => ({ ...r, [p.type]: p.value }), {});
  const ms = instante.getUTCMilliseconds();
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}${ms ? '.' + String(ms).padStart(3, '0') : ''}-03:00`;
}

export function ordenarPagos(pagos) {
  return [...pagos].sort((a, b) => Date.parse(a.fecha_hora) - Date.parse(b.fecha_hora)
    || Date.parse(a.created_at || a.fecha_hora) - Date.parse(b.created_at || b.fecha_hora)
    || String(a.id).localeCompare(String(b.id)));
}

// Simulación pura: no modifica los objetos recibidos ni registra cobros. El
// llamador debe conciliar devoluciones, condonaciones y cambios contractuales.
export function reconstruirPagos({ credito, cuotas, pagos, negocio }) {
  let orden;
  try { orden = JSON.parse(negocio.orden_aplicacion_pago || '["mora","capital"]'); }
  catch { throw fail('El orden de aplicación de pagos del negocio es inválido'); }
  if (!Array.isArray(orden) || orden.length !== 2 || new Set(orden).size !== 2 || !orden.includes('capital') || !orden.includes('mora')) {
    throw fail('El orden de aplicación de pagos del negocio es inválido');
  }
  const finales = cuotas.map(c => {
    if (c.estado_manual || c.mora_perdonada_centavos > 0) throw fail('El crédito tiene decisiones de cobranza que requieren conciliación');
    if (!Number.isSafeInteger(c.monto_centavos) || c.monto_centavos <= 0) throw fail('El plan contiene un importe inválido');
    return { ...c, saldo_pendiente_centavos: c.monto_centavos, mora_generada_centavos: 0,
      mora_pagada_centavos: 0, mora_perdonada_centavos: 0, fecha_saldada: null, dias_atraso_al_pagar: null };
  }).sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento) || a.numero - b.numero || a.id.localeCompare(b.id));
  const resultados = [];
  for (const pago of ordenarPagos(pagos.filter(p => !p.anulado))) {
    if (!Number.isSafeInteger(pago.monto_centavos) || pago.monto_centavos <= 0) throw fail('Un pago tiene un importe inválido');
    const fecha = fechaPagoAR(pago.fecha_hora);
    if (pago.tipo === 'entrega_inicial') {
      resultados.push({ ...pago, aplicaciones: [], remanente: 0,
        saldo_anterior_centavos: credito.saldo_financiado_centavos, saldo_posterior_centavos: credito.saldo_financiado_centavos });
      continue;
    }
    if (pago.tipo && pago.tipo !== 'cuota') throw fail('El crédito tiene un tipo de pago que requiere conciliación');
    const saldoAnterior = sumar(finales.map(c => c.saldo_pendiente_centavos));
    const objetivo = pago.objetivo_registrado ? pago.cuota_objetivo_id : null;
    if (objetivo && !finales.some(c => c.id === objetivo)) throw fail('El destino de un pago no pertenece al plan actual');
    const result = distribuirPago({ cuotas: finales, monto: pago.monto_centavos, negocio, today: fecha, cuotaObjetivoId: objetivo });
    for (const cuota of finales) {
      if (cuota.saldo_pendiente_centavos <= 0 && !cuota.fecha_saldada) {
        cuota.fecha_saldada = fecha;
        cuota.dias_atraso_al_pagar = Math.max(0, diffDays(fecha, cuota.fecha_vencimiento));
      }
    }
    resultados.push({ ...pago, aplicaciones: result.aplicaciones, remanente: result.remanente,
      saldo_anterior_centavos: saldoAnterior, saldo_posterior_centavos: sumar(finales.map(c => c.saldo_pendiente_centavos)) });
  }
  return { cuotas: finales, pagos: resultados, saldo_favor_generado_centavos: sumar(resultados.map(p => p.remanente)) };
}
