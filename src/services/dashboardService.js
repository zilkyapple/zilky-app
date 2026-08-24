import { db } from '../db/connection.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { listNegocios, getNegocio } from '../repositories/negocios.js';

function buildNegocioFilter(negocioId) {
  if (Array.isArray(negocioId) && negocioId.length > 0) {
    const placeholders = negocioId.map(() => '?').join(',');
    return { sql: `AND cr.negocio_id IN (${placeholders})`, params: negocioId };
  }
  if (negocioId) {
    return { sql: `AND cr.negocio_id = ?`, params: [negocioId] };
  }
  return { sql: '', params: [] };
}

async function cuotasEnriquecidas(negocioId = null) {
  const { sql: filterSql, params: filterParams } = buildNegocioFilter(negocioId);
  const sql = `
    SELECT cu.*, cr.negocio_id, cr.cliente_id, cr.modalidad, cr.venta_id,
           cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido, cl.telefono AS cliente_telefono,
           (SELECT COUNT(*) FROM cuotas c2 WHERE c2.credito_id = cu.credito_id) AS total_cuotas
    FROM cuotas cu
    JOIN creditos cr ON cr.id = cu.credito_id
    JOIN clientes cl ON cl.id = cr.cliente_id
    WHERE cu.saldo_pendiente_centavos > 0 AND cu.estado_manual IS NULL
    ${filterSql}
  `;
  const rows = await db.prepare(sql).all(...filterParams);
  const today = todayAR();
  const negocioCache = {};
  const out = [];
  for (const c of rows) {
    if (!negocioCache[c.negocio_id]) negocioCache[c.negocio_id] = await getNegocio(c.negocio_id);
    const negocio = negocioCache[c.negocio_id];
    const { estado, parcial } = estadoCuota(c, negocio, today);
    const mora = calcularMora(c, negocio, today);
    const diasAtraso = Math.max(0, diffDays(today, c.fecha_vencimiento));
    const diasHasta = diffDays(c.fecha_vencimiento, today);
    out.push({ ...c, estado, parcial, moraPendiente: mora.pendiente, moraAcumulada: mora.acumulada, diasAtraso, diasHasta });
  }
  return out;
}

export async function resumenGeneral(negocioId = null) {
  const today = todayAR();
  const mesActual = today.slice(0, 7);
  const cuotas = await cuotasEnriquecidas(negocioId);

  const porIngresarMes = cuotas.filter((c) => c.fecha_vencimiento.slice(0, 7) === mesActual).reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const porCobrarHoy = cuotas.filter((c) => c.estado === 'vence_hoy').reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const saldoPendienteTotal = cuotas.reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const saldoVencido = cuotas.filter((c) => c.diasHasta < 0).reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const enRiesgo = cuotas.filter((c) => c.estado === 'mora').reduce((a, c) => a + c.saldo_pendiente_centavos + c.moraPendiente, 0);
  const clientesEnMora = new Set(cuotas.filter((c) => c.estado === 'mora').map((c) => c.cliente_id)).size;
  const clientesVencidos = new Set(cuotas.filter((c) => c.diasHasta < 0).map((c) => c.cliente_id)).size;
  const clientesConDeuda = new Set(cuotas.map((c) => c.cliente_id)).size;

  const { sql: nf, params: np } = buildNegocioFilter(negocioId);
  const cajaHoyRow = await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,10) = ? ${nf.replace('cr.negocio_id', 'negocio_id')} AND anulado = 0`).get(today, ...np);
  const cajaMesRow = await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,7) = ? ${nf.replace('cr.negocio_id', 'negocio_id')} AND anulado = 0`).get(mesActual, ...np);
  const capitalColocadoRow = await db.prepare(`SELECT COALESCE(SUM(saldo_financiado_centavos),0) t FROM creditos WHERE 1=1 ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);
  const ventasVendidoRow = await db.prepare(`SELECT COALESCE(SUM(monto_total_centavos),0) t FROM ventas WHERE 1=1 ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);
  const clientesTotalesRow = negocioId
    ? await db.prepare(`SELECT COUNT(DISTINCT cliente_id)::int t FROM creditos WHERE 1=1 ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np)
    : await db.prepare(`SELECT COUNT(*)::int t FROM clientes`).get();
  const ventasActivasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos WHERE estado != 'finalizado' ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);
  const ventasFinalizadasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos WHERE estado = 'finalizado' ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);

  let porNegocio = null;
  if (!negocioId || (Array.isArray(negocioId) && negocioId.length > 1)) {
    porNegocio = [];
    const negocios = Array.isArray(negocioId) ? negocioId.map(id => ({ id })) : await listNegocios();
    for (const n of negocios) {
      const neg = await getNegocio(n.id);
      const r = await resumenGeneral(n.id);
      porNegocio.push({ negocio_id: n.id, nombre: neg.nombre, color: neg.color, ...r, porNegocio: undefined });
    }
  }

  return {
    vendidoTotalCentavos: ventasVendidoRow.t,
    cobradoHoyCentavos: cajaHoyRow.t,
    cobradoMesCentavos: cajaMesRow.t,
    porCobrarHoyCentavos: porCobrarHoy,
    porIngresarMesCentavos: porIngresarMes,
    saldoPendienteTotalCentavos: saldoPendienteTotal,
    saldoVencidoCentavos: saldoVencido,
    montoEnRiesgoCentavos: enRiesgo,
    clientesEnMora, clientesVencidos, clientesConDeuda,
    clientesTotales: clientesTotalesRow.t,
    capitalColocadoCentavos: capitalColocadoRow.t,
    ventasActivas: ventasActivasRow.t,
    ventasFinalizadas: ventasFinalizadasRow.t,
    cuotasPendientes: cuotas.length,
    porNegocio,
  };
}

export async function listaCobranza(negocioId = null, { ventanaDias = 7 } = {}) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const hoy = cuotas.filter((c) => c.diasHasta === 0);
  const proximas = cuotas.filter((c) => c.diasHasta > 0 && c.diasHasta <= ventanaDias);
  const vencidas = cuotas.filter((c) => c.diasHasta < 0).sort((a, b) => b.diasAtraso - a.diasAtraso);
  const todas = [...cuotas].sort((a, b) => (a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1));
  return { hoy, proximas, vencidas, todas, ventanaDias };
}

export async function calendarioMes(negocioId, mesISO) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const delMes = cuotas.filter((c) => c.fecha_vencimiento.slice(0, 7) === mesISO);
  const porDia = {};
  for (const c of delMes) {
    const dia = c.fecha_vencimiento;
    if (!porDia[dia]) porDia[dia] = { fecha: dia, cantidad: 0, montoCentavos: 0 };
    porDia[dia].cantidad += 1;
    porDia[dia].montoCentavos += c.saldo_pendiente_centavos;
  }
  return Object.values(porDia).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

export async function calendarioDia(negocioId, fechaISO) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  return cuotas.filter((c) => c.fecha_vencimiento === fechaISO);
}

export async function recordatoriosDeHoy(negocioId = null) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const negocioCache = {};
  const out = [];
  for (const c of cuotas) {
    if (!['proxima', 'vence_hoy'].includes(c.estado)) continue;
    if (!negocioCache[c.negocio_id]) negocioCache[c.negocio_id] = await getNegocio(c.negocio_id);
    let reglas = [];
    try { reglas = JSON.parse(negocioCache[c.negocio_id].recordatorio_dias || '[]'); } catch { reglas = []; }
    if (reglas.includes(c.diasHasta)) out.push({ ...c, diasAntes: c.diasHasta });
  }
  return out;
}

export async function perfilRiesgoCliente(clienteId, negocioId = null) {
  let pagosSql = `SELECT * FROM pagos WHERE cliente_id = ? AND anulado = 0`;
  const pagosArgs = [clienteId];
  if (Array.isArray(negocioId) && negocioId.length > 0) {
    const placeholders = negocioId.map(() => '?').join(',');
    pagosSql += ` AND negocio_id IN (${placeholders})`;
    pagosArgs.push(...negocioId);
  } else if (negocioId) {
    pagosSql += ` AND negocio_id = ?`;
    pagosArgs.push(negocioId);
  }
  pagosSql += ` ORDER BY fecha_hora ASC`;
  const pagos = await db.prepare(pagosSql).all(...pagosArgs);

  const todas = await cuotasEnriquecidas(negocioId);
  const cuotas = todas.filter((c) => c.cliente_id === clienteId);
  const enMora = cuotas.filter((c) => c.estado === 'mora').length;
  const enGracia = cuotas.filter((c) => c.estado === 'gracia').length;
  let nivel = 'bajo';
  const notas = [];
  if (enMora >= 2) { nivel = 'critico'; notas.push('Tiene varias cuotas en mora simultáneamente.'); }
  else if (enMora === 1) { nivel = 'alto'; notas.push('Tiene una cuota en mora activa.'); }
  else if (enGracia > 0) { nivel = 'medio'; notas.push('Tiene cuotas dentro del período de gracia.'); }
  else if (pagos.length > 0) { notas.push('Buen historial de pagos hasta el momento.'); }
  return { nivel, notas, pagosRegistrados: pagos.length, cuotasEnMora: enMora, cuotasEnGracia: enGracia };
}

export async function historialFinancieroCliente(clienteId, negocioId = null) {
  // Helper para construir filtro de negocio con placeholders ? (compatible array)
  function filtroNegocioSql(col, negocioId) {
    if (Array.isArray(negocioId) && negocioId.length > 0) {
      const placeholders = negocioId.map(() => '?').join(',');
      return { sql: `AND ${col} IN (${placeholders})`, params: negocioId };
    }
    if (negocioId) {
      return { sql: `AND ${col} = ?`, params: [negocioId] };
    }
    return { sql: '', params: [] };
  }

  const fv = filtroNegocioSql('negocio_id', negocioId);
  const fc = filtroNegocioSql('cr.negocio_id', negocioId);

  const argsVentas = [clienteId, ...fv.params];
  const argsCuotas = [clienteId, ...fc.params];
  const argsPagos = [clienteId, ...fv.params];
  const argsCreditos = [clienteId, ...fv.params];

  const compras = await db.prepare(`SELECT COUNT(*)::int t FROM ventas WHERE cliente_id = ? ${fv.sql}`).get(...argsVentas);
  const cuotasRow = await db.prepare(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0)::int AS pagadas,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0 AND cu.dias_atraso_al_pagar = 0)::int AS a_tiempo,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0 AND cu.dias_atraso_al_pagar > 0)::int AS tarde,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos > 0 AND cu.fecha_vencimiento < '${todayAR()}')::int AS vencidas_actualmente,
      COALESCE(SUM(cu.saldo_pendiente_centavos) FILTER (WHERE cu.saldo_pendiente_centavos > 0), 0) AS deuda_actual,
      COALESCE(AVG(cu.dias_atraso_al_pagar) FILTER (WHERE cu.dias_atraso_al_pagar IS NOT NULL), 0) AS atraso_promedio,
      COALESCE(MAX(cu.dias_atraso_al_pagar), 0) AS atraso_maximo
    FROM cuotas cu JOIN creditos cr ON cr.id = cu.credito_id
    WHERE cr.cliente_id = ? ${fc.sql}
  `).get(...argsCuotas);
  const cobradoRow = await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE cliente_id = ? AND anulado = 0 ${fv.sql}`).get(...argsPagos);
  const fechasRow = await db.prepare(`SELECT MAX(fecha) t FROM ventas WHERE cliente_id = ? ${fv.sql}`).get(...argsVentas);
  const ultimoPagoRow = await db.prepare(`SELECT MAX(fecha_hora) t FROM pagos WHERE cliente_id = ? AND anulado = 0 ${fv.sql}`).get(...argsPagos);
  const finalizadasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos WHERE cliente_id = ? ${fv.sql} AND estado = 'finalizado'`).get(...argsCreditos);

  return {
    cantidadCompras: compras.t,
    cuotasTotales: cuotasRow.total,
    cuotasPagadas: cuotasRow.pagadas,
    cuotasPagadasATiempo: cuotasRow.a_tiempo,
    cuotasPagadasTarde: cuotasRow.tarde,
    cuotasVencidasActualmente: cuotasRow.vencidas_actualmente,
    deudaActualCentavos: cuotasRow.deuda_actual,
    totalCobradoCentavos: cobradoRow.t,
    atrasoPromedioDias: Math.round(Number(cuotasRow.atraso_promedio) * 10) / 10,
    atrasoMaximoDias: cuotasRow.atraso_maximo,
    fechaUltimaCompra: fechasRow.t,
    fechaUltimoPago: ultimoPagoRow.t,
    comprasFinalizadas: finalizadasRow.t,
  };
}
