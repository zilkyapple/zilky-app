import { diffDays, addDays } from './dates.js';

/**
 * Estados posibles de una cuota (sección 6 del spec).
 * Se calculan dinámicamente a partir de la fecha actual, nunca se "congelan" en la DB,
 * salvo los overrides manuales (refinanciada / anulada / incobrable).
 */
export function estadoCuota(cuota, negocio, today) {
  if (cuota.estado_manual) return cuota.estado_manual; // refinanciada | anulada | incobrable

  const pagada = cuota.saldo_pendiente_centavos <= 0;
  const parcial = !pagada && cuota.saldo_pendiente_centavos < cuota.monto_centavos;

  if (pagada) {
    // Se compara la fecha REAL en que se completó el pago contra el vencimiento (no la fecha de consulta).
    const fechaReferencia = cuota.fecha_saldada || today;
    const antesDeVencer = diffDays(cuota.fecha_vencimiento, fechaReferencia) > 0;
    return { estado: antesDeVencer ? 'pagada_anticipada' : 'pagada', parcial: false };
  }

  const diasGracia = negocio.dias_gracia ?? 7;
  const dias = diffDays(today, cuota.fecha_vencimiento); // >0 = vencida hace `dias` días

  let estado;
  if (dias < 0) estado = 'proxima';
  else if (dias === 0) estado = 'vence_hoy';
  else if (dias <= diasGracia) estado = 'gracia';
  else estado = 'mora';

  return { estado, parcial };
}

/**
 * Interés moratorio de una cuota, calculado SOLO sobre el saldo vencido (o el total,
 * según config del negocio) y SOLO a partir del día 8 posterior al vencimiento
 * (vencimiento + 7 días de gracia + 1). Nunca antes.
 */
export function calcularMora(cuota, negocio, today) {
  const { estado } = estadoCuota(cuota, negocio, today);
  if (estado !== 'mora') return { acumulada: 0, pendiente: 0, diasEnMora: 0 };

  const diasGracia = negocio.dias_gracia ?? 7;
  const inicioMora = addDays(cuota.fecha_vencimiento, diasGracia + 1);
  const diasEnMora = Math.max(0, diffDays(today, inicioMora) + 1);
  if (diasEnMora <= 0) return { acumulada: 0, pendiente: 0, diasEnMora: 0 };

  const base = negocio.mora_base === 'total' ? cuota.monto_centavos : cuota.saldo_pendiente_centavos;
  const periodoDias = negocio.mora_periodo === 'dia' ? 1 : negocio.mora_periodo === 'mes' ? 30 : 7;
  // Cualquier día dentro de un período ya devenga ese período completo (política de mora habitual).
  const periodos = Math.ceil(diasEnMora / periodoDias);

  let acumulada;
  if (negocio.mora_tipo === 'fijo') {
    acumulada = Math.round(negocio.mora_valor * 100) * periodos; // mora_valor en pesos -> centavos
  } else {
    const tasa = negocio.mora_valor / 100; // ej 2 -> 0.02
    acumulada = negocio.mora_acumulativa
      ? Math.round(base * (Math.pow(1 + tasa, periodos) - 1))
      : Math.round(base * tasa * periodos);
  }

  const pendiente = Math.max(0, acumulada - (cuota.mora_pagada_centavos || 0));
  return { acumulada, pendiente, diasEnMora };
}

/**
 * Distribuye un pago entre una lista de cuotas (ya ordenadas, la más antigua primero).
 * Orden por defecto: mora vencida -> capital de la cuota más antigua -> siguientes.
 * Devuelve las aplicaciones a persistir + el remanente (saldo a favor) si sobra dinero.
 * NO escribe en la base de datos: es una función pura, fácil de testear.
 */
export function distribuirPago({ cuotas, monto, negocio, today, cuotaObjetivoId = null }) {
  const orden = JSON.parse(negocio.orden_aplicacion_pago || '["mora","capital"]');
  let disponible = monto;
  const aplicaciones = [];

  const lista = cuotaObjetivoId
    ? cuotas.filter((c) => c.id === cuotaObjetivoId)
    : cuotas;

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
