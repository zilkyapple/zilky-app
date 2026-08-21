import { diffDays, addDays } from './dates.js';

export function estadoCuota(cuota, negocio, today) {
  if (cuota.estado_manual) return { estado: cuota.estado_manual, parcial: false };

  const pagada = cuota.saldo_pendiente_centavos <= 0;
  const parcial = !pagada && cuota.saldo_pendiente_centavos < cuota.monto_centavos;

  if (pagada) {
    const fechaReferencia = cuota.fecha_saldada || today;
    const antesDeVencer = diffDays(cuota.fecha_vencimiento, fechaReferencia) > 0;
    return { estado: antesDeVencer ? 'pagada_anticipada' : 'pagada', parcial: false };
  }

  const diasGracia = negocio.dias_gracia ?? 7;
  const dias = diffDays(today, cuota.fecha_vencimiento);

  let estado;
  if (dias < 0) estado = 'proxima';
  else if (dias === 0) estado = 'vence_hoy';
  else if (dias <= diasGracia) estado = 'gracia';
  else estado = 'mora';

  return { estado, parcial };
}

export function calcularMora(cuota, negocio, today) {
  const { estado } = estadoCuota(cuota, negocio, today);
  if (estado !== 'mora') return { acumulada: 0, pendiente: 0, diasEnMora: 0 };

  const diasGracia = negocio.dias_gracia ?? 7;
  const inicioMora = addDays(cuota.fecha_vencimiento, diasGracia + 1);
  const diasEnMora = Math.max(0, diffDays(today, inicioMora) + 1);
  if (diasEnMora <= 0) return { acumulada: 0, pendiente: 0, diasEnMora: 0 };

  const base = negocio.mora_base === 'total' ? cuota.monto_centavos : cuota.saldo_pendiente_centavos;
  const periodoDias = negocio.mora_periodo === 'dia' ? 1 : negocio.mora_periodo === 'mes' ? 30 : 7;
  const periodos = Math.ceil(diasEnMora / periodoDias);

  let acumulada;
  if (negocio.mora_tipo === 'fijo') {
    acumulada = Math.round(negocio.mora_valor * 100) * periodos;
  } else {
    const tasa = negocio.mora_valor / 100;
    acumulada = negocio.mora_acumulativa
      ? Math.round(base * (Math.pow(1 + tasa, periodos) - 1))
      : Math.round(base * tasa * periodos);
  }

  const pendiente = Math.max(0, acumulada - (cuota.mora_pagada_centavos || 0));
  return { acumulada, pendiente, diasEnMora };
}

export function distribuirPago({ cuotas, monto, negocio, today, cuotaObjetivoId = null }) {
  const orden = JSON.parse(negocio.orden_aplicacion_pago || '["mora","capital"]');
  let disponible = monto;
  const aplicaciones = [];

  const lista = cuotaObjetivoId ? cuotas.filter((c) => c.id === cuotaObjetivoId) : cuotas;

  for (const cuota of lista) {
    if (disponible <= 0) break;
    if (cuota.saldo_pendiente_centavos <= 0) continue;

    let capitalAplicado = 0;
    let moraAplicada = 0;

    for (const paso of orden) {
      if (disponible <= 0) break;
      if (paso === 'mora') {
        const { pendiente } = calcularMora(cuota, negocio, today);
        const aplicar = Math.min(pendiente, disponible);
        if (aplicar > 0) {
          moraAplicada += aplicar;
          cuota.mora_pagada_centavos = (cuota.mora_pagada_centavos || 0) + aplicar;
          disponible -= aplicar;
        }
      } else if (paso === 'capital') {
        const aplicar = Math.min(cuota.saldo_pendiente_centavos, disponible);
        if (aplicar > 0) {
          capitalAplicado += aplicar;
          cuota.saldo_pendiente_centavos -= aplicar;
          disponible -= aplicar;
        }
      }
    }

    if (capitalAplicado > 0 || moraAplicada > 0) {
      aplicaciones.push({ cuotaId: cuota.id, capital: capitalAplicado, mora: moraAplicada });
    }
  }

  return { aplicaciones, remanente: disponible, cuotasActualizadas: cuotas };
}
