import { diffDays } from './dates.js';

// Solo recibe cuotas del scope ya autorizado. No modifica capital, fechas ni pagos.
export function resumenVencimientos(cuotas, hoy) {
  const pendientes = cuotas.filter(c => !c.estado_manual && (c.saldo_pendiente_centavos > 0 || c.moraPendiente > 0));
  const vencidas = pendientes.filter(c => c.fecha_vencimiento < hoy);
  const actuales = pendientes.filter(c => c.fecha_vencimiento === hoy);
  const futuras = pendientes.filter(c => c.fecha_vencimiento > hoy);
  const primeraFecha = lista => lista.reduce((f, c) => !f || c.fecha_vencimiento < f ? c.fecha_vencimiento : f, null);
  const saldo = lista => lista.reduce((s, c) => s + c.saldo_pendiente_centavos + Math.max(0, c.moraPendiente || 0), 0);
  const vencimientoVencido = primeraFecha(vencidas), proximoVencimiento = primeraFecha(futuras);
  return {
    vencimientoVencido, diasAtrasoVencimiento: vencimientoVencido ? diffDays(hoy, vencimientoVencido) : null,
    proximoVencimiento, diasHastaVencimiento: proximoVencimiento ? diffDays(proximoVencimiento, hoy) : null,
    cuotasVencidas: vencidas.length, cuotasVencenHoy: actuales.length,
    saldoVencidoCentavos: saldo(vencidas), saldoVenceHoyCentavos: saldo(actuales),
    saldoExigibleCentavos: saldo(vencidas) + saldo(actuales),
  };
}
