import { db } from '../db/connection.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { listNegocios, getNegocio } from '../repositories/negocios.js';

async function cuotasEnriquecidas(negocioId = null) {
  const sql = `
    SELECT cu.*, cr.negocio_id, cr.cliente_id, cr.modalidad,
           cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido, cl.telefono AS cliente_telefono
    FROM cuotas cu
    JOIN creditos cr ON cr.id = cu.credito_id
    JOIN clientes cl ON cl.id = cr.cliente_id
    WHERE cu.saldo_pendiente_centavos > 0 AND cu.estado_manual IS NULL
    ${negocioId ? 'AND cr.negocio_id = ?' : ''}
  `;
  const rows = negocioId ? await db.prepare(sql).all(negocioId) : await db.prepare(sql).all();
  const today = todayAR();
  const negocioCache = {};
  const out = [];
  for (const c of rows) {
    if (!negocioCache[c.negocio_id]) negocioCache[c.negocio_id] = await getNegocio(c.negocio_id);
    const negocio = negocioCache[c.negocio_id];
    const { estado, parcial } = estadoCuota(c, negocio, today);
    const mora = calcularMora(c, negocio, today);
    const diasAtraso = Math.max(0, diffDays(today, c.fecha_vencimiento));
    out.push({ ...c, estado, parcial, moraPendiente: mora.pendiente, moraAcumulada: mora.acumulada, diasAtraso });
  }
  return out;
}

export async function resumenGeneral(negocioId = null) {
  const today = todayAR();
  const mesActual = today.slice(0, 7); // YYYY-MM

  const cuotas = await cuotasEnriquecidas(negocioId);

  const porIngresarMes = cuotas.filter((c) => c.fecha_vencimiento.slice(0, 7) === mesActual)
    .reduce((a, c) => a + c.saldo_pendiente_centavos, 0);

  const saldoPendienteTotal = cuotas.reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const saldoVencido = cuotas.filter((c) => ['vence_hoy', 'gracia', 'mora'].includes(c.estado))
    .reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  const enRiesgo = cuotas.filter((c) => c.estado === 'mora').reduce((a, c) => a + c.saldo_pendiente_centavos + c.moraPendiente, 0);

  const clientesEnMora = new Set(cuotas.filter((c) => c.estado === 'mora').map((c) => c.cliente_id)).size;

  const cajaHoyRow = negocioId
    ? await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,10) = ? AND negocio_id = ? AND anulado = 0`).get(today, negocioId)
    : await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,10) = ? AND anulado = 0`).get(today);

  const cajaMesRow = negocioId
    ? await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,7) = ? AND negocio_id = ? AND anulado = 0`).get(mesActual, negocioId)
    : await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE substr(fecha_hora,1,7) = ? AND anulado = 0`).get(mesActual);

  const capitalColocadoRow = negocioId
    ? await db.prepare(`SELECT COALESCE(SUM(saldo_financiado_centavos),0) t FROM creditos WHERE negocio_id = ?`).get(negocioId)
    : await db.prepare(`SELECT COALESCE(SUM(saldo_financiado_centavos),0) t FROM creditos`).get();

  const clientesTotalesRow = negocioId
    ? await db.prepare(`SELECT COUNT(DISTINCT cliente_id) t FROM creditos WHERE negocio_id = ?`).get(negocioId)
    : await db.prepare(`SELECT COUNT(DISTINCT id) t FROM clientes`).get();

  let porNegocio = null;
  if (!negocioId) {
    porNegocio = [];
    for (const n of await listNegocios()) {
      const r = await resumenGeneral(n.id);
      porNegocio.push({ negocio_id: n.id, nombre: n.nombre, color: n.color, ...r, porNegocio: undefined });
    }
  }

  return {
    porIngresarMesCentavos: porIngresarMes,
    cobradoHoyCentavos: cajaHoyRow.t,
    cobradoMesCentavos: cajaMesRow.t,
    saldoPendienteTotalCentavos: saldoPendienteTotal,
    saldoVencidoCentavos: saldoVencido,
    montoEnRiesgoCentavos: enRiesgo,
    clientesEnMora,
    clientesTotales: clientesTotalesRow.t,
    capitalColocadoCentavos: capitalColocadoRow.t,
    cuotasPendientes: cuotas.length,
    porNegocio,
  };
}

export async function listaCobranza(negocioId = null) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const buckets = {
    vencenHoy: [], vencenManana: [], estaSemana: [], esteMes: [],
    atrasados: [], mas30: [], mas60: [], mas90: [],
  };
  for (const c of cuotas) {
    if (c.estado === 'vence_hoy') buckets.vencenHoy.push(c);
    else if (c.estado === 'proxima') {
      const dias = -diffDays(todayAR(), c.fecha_vencimiento);
      if (dias === 1) buckets.vencenManana.push(c);
      else if (dias <= 7) buckets.estaSemana.push(c);
      else if (dias <= 31) buckets.esteMes.push(c);
    } else if (c.estado === 'gracia' || c.estado === 'mora') {
      buckets.atrasados.push(c);
      if (c.diasAtraso > 90) buckets.mas90.push(c);
      else if (c.diasAtraso > 60) buckets.mas60.push(c);
      else if (c.diasAtraso > 30) buckets.mas30.push(c);
    }
  }
  return buckets;
}

export async function perfilRiesgoCliente(clienteId) {
  const pagos = await db.prepare(`SELECT * FROM pagos WHERE cliente_id = ? AND anulado = 0 ORDER BY fecha_hora ASC`).all(clienteId);
  const todas = await cuotasEnriquecidas();
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
