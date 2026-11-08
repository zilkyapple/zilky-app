import { db } from '../db/connection.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { listNegocios, getNegocio } from '../repositories/negocios.js';
import { proyectarCobros } from '../lib/proyeccionCobros.js';
import { calcularGanancias } from '../lib/ganancias.js';

function buildNegocioFilter(negocioId) {
  if (Array.isArray(negocioId) && negocioId.length === 0) return {sql:'AND FALSE',params:[]};
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
    SELECT cu.*, cr.negocio_id, cr.cliente_id, cr.modalidad, cr.venta_id, v.estado AS venta_estado,
           COALESCE(cc.gestion_especial,0) AS gestion_especial, cc.proximo_contacto, COALESCE(cc.modo,'revisar') AS cobranza_modo,
           cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido, cl.telefono AS cliente_telefono,
           (SELECT COUNT(*) FROM cuotas c2 WHERE c2.credito_id = cu.credito_id) AS total_cuotas
    FROM cuotas cu
    JOIN creditos cr ON cr.id = cu.credito_id
    LEFT JOIN ventas v ON v.id=cr.venta_id
    JOIN clientes cl ON cl.id = cr.cliente_id
    JOIN cliente_negocio cn ON cn.cliente_id=cr.cliente_id AND cn.negocio_id=cr.negocio_id
    LEFT JOIN cliente_negocio_cobranza cc ON cc.cliente_id=cr.cliente_id AND cc.negocio_id=cr.negocio_id
    WHERE (cu.saldo_pendiente_centavos > 0 OR cu.mora_generada_centavos > cu.mora_pagada_centavos + cu.mora_perdonada_centavos) AND cu.estado_manual IS NULL
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
  const capitalColocadoRow = await db.prepare(`SELECT COALESCE(SUM(cr.saldo_financiado_centavos),0) t FROM creditos cr LEFT JOIN ventas v ON v.id=cr.venta_id WHERE COALESCE(v.estado,'activa') NOT IN ('anulada','devuelta') ${nf}`).get(...np);
  const ventasVendidoRow = await db.prepare(`SELECT COALESCE(SUM(monto_total_centavos-devolucion_centavos),0) t FROM ventas WHERE 1=1 ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);
  // Confirming a web order is its sale; collecting it does not create another
  // venta or a financing agreement. Pending/cancelled orders are not sales.
  const pedidosVendidoRow = await db.prepare(`SELECT COALESCE(SUM(total_centavos),0) t FROM tienda_pedidos WHERE estado='confirmado' ${nf.replace('cr.negocio_id', 'negocio_id')}`).get(...np);
  // Solo ventas presenciales completas con costos congelados. Las anteriores a la
  // migración, las devoluciones y los pedidos web no tienen costo histórico fiable.
  // No sumar pagos a esta cifra: las cuotas son cobros de una misma venta.
  const gananciaRows = await db.prepare(`
    WITH costo_venta AS (
      SELECT d.venta_id,
             SUM(d.cantidad * d.costo_unitario_centavos) AS costo_centavos,
             COUNT(*) AS lineas,
             COUNT(*) FILTER (WHERE d.costo_unitario_centavos IS NULL OR d.costo_unitario_centavos <= 0) AS sin_costo
      FROM venta_detalle d GROUP BY d.venta_id
    ), ajustes_comision AS (
      SELECT acuerdo_id, SUM(importe_centavos) AS importe_centavos
      FROM comision_ajustes GROUP BY acuerdo_id
    ), comision_venta AS (
      SELECT a.venta_id, SUM(a.total_centavos + COALESCE(j.importe_centavos,0)) AS comision_centavos
      FROM comision_acuerdos a
      LEFT JOIN ajustes_comision j ON j.acuerdo_id=a.id
      GROUP BY a.venta_id
    )
    SELECT v.id,v.fecha,
           -- El capital pactado puede diferir del precio original de los productos.
           v.entrega_inicial_centavos + COALESCE((
             SELECT SUM(cu.monto_centavos) FROM creditos cr JOIN cuotas cu ON cu.credito_id=cr.id WHERE cr.venta_id=v.id
           ),0) AS precio_centavos,
           c.costo_centavos,COALESCE(a.comision_centavos,0) AS comision_centavos,
           (SELECT MAX(cu.fecha_vencimiento) FROM creditos cr JOIN cuotas cu ON cu.credito_id=cr.id WHERE cr.venta_id=v.id) AS vencimiento
    FROM ventas v
    JOIN costo_venta c ON c.venta_id=v.id
    LEFT JOIN comision_venta a ON a.venta_id=v.id
    WHERE c.lineas>0 AND c.sin_costo=0 AND v.estado='activa'
      AND v.devolucion_centavos=0 ${nf.replace('cr.negocio_id','v.negocio_id')}
  `).all(...np);
  const pagosGanancia = await db.prepare(`
    SELECT cr.venta_id,p.fecha_hora,
      CASE WHEN p.tipo='entrega_inicial' THEN p.monto_centavos ELSE COALESCE(pa.capital_centavos,0) END AS capital_centavos
    FROM pagos p JOIN creditos cr ON cr.id=p.credito_id
    LEFT JOIN (SELECT pago_id,SUM(capital_centavos) AS capital_centavos FROM pago_aplicaciones GROUP BY pago_id) pa ON pa.pago_id=p.id
    WHERE p.anulado=0 AND cr.venta_id IS NOT NULL ${nf}
    ORDER BY p.fecha_hora,p.id
  `).all(...np);
  const ganancias=calcularGanancias(gananciaRows,pagosGanancia);
  const ventasSinCostoRow=await db.prepare(`
    SELECT COUNT(*) AS n FROM ventas v WHERE v.estado='activa'
      AND NOT EXISTS (SELECT 1 FROM venta_detalle d WHERE d.venta_id=v.id AND d.costo_unitario_centavos>0)
      ${nf.replace('cr.negocio_id','v.negocio_id')}
  `).get(...np);
  const clientesTotalesRow = negocioId
    ? await db.prepare(`SELECT COUNT(DISTINCT cr.cliente_id)::int t FROM creditos cr JOIN clientes cl ON cl.id=cr.cliente_id WHERE cl.consumidor_final_negocio IS NULL ${nf}`).get(...np)
    : await db.prepare(`SELECT COUNT(*)::int t FROM clientes WHERE consumidor_final_negocio IS NULL`).get();
  const ventasActivasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos cr LEFT JOIN ventas v ON v.id=cr.venta_id WHERE cr.estado != 'finalizado' AND COALESCE(v.estado,'activa') NOT IN ('anulada','devuelta') ${nf}`).get(...np);
  const ventasFinalizadasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos cr LEFT JOIN ventas v ON v.id=cr.venta_id WHERE cr.estado = 'finalizado' AND COALESCE(v.estado,'activa') NOT IN ('anulada','devuelta') ${nf}`).get(...np);

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
    vendidoTotalCentavos: Number(ventasVendidoRow.t) + Number(pedidosVendidoRow.t),
    gananciaVentasRegistradasCentavos: ganancias.esperadaCentavos,
    gananciaRealizadaCentavos: ganancias.realizadaCentavos,
    gananciaPendienteCentavos: ganancias.pendienteCentavos,
    gananciasPorMes: ganancias.meses,
    ventasConGananciaCalculada: gananciaRows.length,
    ventasSinCostoHistorico: Number(ventasSinCostoRow.n),
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
    proyeccionCobros: proyectarCobros(cuotas, today),
    porNegocio,
  };
}

export async function listaCobranza(negocioId = null, { ventanaDias = 7 } = {}) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const normales=cuotas.filter(c=>c.gestion_especial!==1);
  const hoy = normales.filter((c) => c.diasHasta === 0);
  const proximas = normales.filter((c) => c.diasHasta > 0 && c.diasHasta <= ventanaDias);
  const vencidas = normales.filter((c) => c.diasHasta < 0).sort((a, b) => b.diasAtraso - a.diasAtraso);
  const todas = [...cuotas].sort((a, b) => (a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1));
  const agrupados=new Map();
  for(const c of cuotas.filter(c=>c.gestion_especial===1)) {
    const key=JSON.stringify([c.cliente_id,c.negocio_id]);
    if(!agrupados.has(key))agrupados.set(key,{cliente_id:c.cliente_id,negocio_id:c.negocio_id,cliente_nombre:c.cliente_nombre,
      cliente_apellido:c.cliente_apellido,cliente_telefono:c.cliente_telefono,proximo_contacto:c.proximo_contacto,deudaCentavos:0,cuotas:0});
    const g=agrupados.get(key);g.deudaCentavos+=c.saldo_pendiente_centavos+c.moraPendiente;g.cuotas++;
  }
  const especial=[...agrupados.values()].sort((a,b)=>(a.proximo_contacto||'').localeCompare(b.proximo_contacto||''));
  const contactos=[];
  const {sql:contactFilter,params:contactParams}=buildNegocioFilter(negocioId);
  const pendientes=await db.prepare(`SELECT r.* FROM recordatorios r JOIN creditos cr ON cr.id=r.credito_id WHERE r.estado='pendiente' ${contactFilter} ORDER BY r.fecha_contacto,r.created_at`).all(...contactParams);
  const porCuota=new Map(cuotas.map(c=>[c.id,c]));
  for(const r of pendientes) {const c=porCuota.get(r.cuota_id);if(c && c.cliente_id===r.cliente_id && c.negocio_id===r.negocio_id)contactos.push({id:r.id,cliente_id:c.cliente_id,negocio_id:c.negocio_id,cliente_nombre:c.cliente_nombre,cliente_apellido:c.cliente_apellido,fecha_contacto:r.fecha_contacto,fecha_vencimiento:c.fecha_vencimiento,numero:c.numero,modo:c.cobranza_modo});}
  return { hoy, proximas, vencidas, especial, todas, ventanaDias, contactos };
}

export async function calendarioMes(negocioId, mesISO, { incluirMontos = true } = {}) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const delMes = cuotas.filter((c) => c.gestion_especial!==1 && c.fecha_vencimiento.slice(0, 7) === mesISO);
  const porDia = {};
  for (const c of delMes) {
    const dia = c.fecha_vencimiento;
    if (!porDia[dia]) porDia[dia] = { fecha: dia, cantidad: 0, ...(incluirMontos ? { montoCentavos: 0 } : {}) };
    porDia[dia].cantidad += 1;
    if (incluirMontos) porDia[dia].montoCentavos += c.saldo_pendiente_centavos;
  }
  return Object.values(porDia).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

export async function calendarioDia(negocioId, fechaISO) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  return cuotas.filter((c) => c.gestion_especial!==1 && c.fecha_vencimiento === fechaISO);
}

export async function recordatoriosDeHoy(negocioId = null) {
  const cuotas = await cuotasEnriquecidas(negocioId);
  const negocioCache = {};
  const {sql:contactFilter,params:contactParams}=buildNegocioFilter(negocioId);
  const programadas=new Set((await db.prepare(`SELECT r.cuota_id FROM recordatorios r JOIN creditos cr ON cr.id=r.credito_id WHERE r.estado='pendiente' ${contactFilter}`).all(...contactParams)).map(r=>r.cuota_id));
  const out = [];
  for (const c of cuotas) {
    if(c.gestion_especial===1 || c.cobranza_modo==='pausada')continue;
    if(programadas.has(c.id))continue;
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
  if(Array.isArray(negocioId) && negocioId.length===0) pagosSql+=' AND FALSE';
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
    if(Array.isArray(negocioId) && !negocioId.length) return {sql:'AND FALSE',params:[]};
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
  const fp = filtroNegocioSql('tp.negocio_id', negocioId);

  const argsVentas = [clienteId, ...fv.params];
  const argsCuotas = [clienteId, ...fc.params];
  const argsPagos = [clienteId, ...fv.params];
  const argsCreditos = [clienteId, ...fv.params];

  const compras = await db.prepare(`SELECT COUNT(*)::int t FROM ventas WHERE cliente_id = ? AND estado NOT IN ('anulada','devuelta') ${fv.sql}`).get(...argsVentas);
  const cuotasRow = await db.prepare(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0)::int AS pagadas,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0 AND cu.dias_atraso_al_pagar = 0)::int AS a_tiempo,
      COUNT(*) FILTER (WHERE cu.saldo_pendiente_centavos <= 0 AND cu.dias_atraso_al_pagar > 0)::int AS tarde,
      COUNT(*) FILTER (WHERE (cu.saldo_pendiente_centavos > 0 OR cu.mora_generada_centavos > cu.mora_pagada_centavos + cu.mora_perdonada_centavos) AND cu.estado_manual IS NULL AND cu.fecha_vencimiento < '${todayAR()}')::int AS vencidas_actualmente,
      COALESCE(SUM(cu.saldo_pendiente_centavos) FILTER (WHERE (cu.saldo_pendiente_centavos > 0 OR cu.mora_generada_centavos > cu.mora_pagada_centavos + cu.mora_perdonada_centavos) AND cu.estado_manual IS NULL), 0) AS deuda_actual,
      COALESCE(AVG(cu.dias_atraso_al_pagar) FILTER (WHERE cu.dias_atraso_al_pagar IS NOT NULL), 0) AS atraso_promedio,
      COALESCE(MAX(cu.dias_atraso_al_pagar), 0) AS atraso_maximo
    FROM cuotas cu JOIN creditos cr ON cr.id = cu.credito_id LEFT JOIN ventas v ON v.id=cr.venta_id
    WHERE cr.cliente_id = ? AND COALESCE(v.estado,'activa') NOT IN ('anulada','devuelta') ${fc.sql}
  `).get(...argsCuotas);
  const cobradoRow = await db.prepare(`SELECT COALESCE(SUM(monto_centavos),0) t FROM pagos WHERE cliente_id = ? AND anulado = 0 ${fv.sql}`).get(...argsPagos);
  const fechasRow = await db.prepare(`SELECT MAX(fecha) t FROM ventas WHERE cliente_id = ? AND estado NOT IN ('anulada','devuelta') ${fv.sql}`).get(...argsVentas);
  const ultimoPagoRow = await db.prepare(`SELECT MAX(fecha_hora) t FROM pagos WHERE cliente_id = ? AND anulado = 0 ${fv.sql}`).get(...argsPagos);
  const finalizadasRow = await db.prepare(`SELECT COUNT(*)::int t FROM creditos cr LEFT JOIN ventas v ON v.id=cr.venta_id WHERE cr.cliente_id = ? ${fc.sql} AND cr.estado = 'finalizado' AND COALESCE(v.estado,'activa') NOT IN ('anulada','devuelta')`).get(...argsCreditos);
  const pedidosRow = await db.prepare(`
    SELECT COUNT(*)::int AS compras, MAX(substr(tp.confirmado_fecha,1,10)) AS ultima_compra,
      COUNT(*) FILTER (WHERE tp.total_centavos > 0 AND COALESCE((
        SELECT SUM(p.monto_centavos)
        FROM tienda_pedido_cobros tc
        JOIN pagos p ON p.id=tc.pago_id AND p.negocio_id=tp.negocio_id AND p.cliente_id=tp.cliente_id
        JOIN comprobantes c ON c.id=tc.comprobante_id AND c.pago_id=p.id
          AND c.negocio_id=tp.negocio_id AND c.cliente_id=tp.cliente_id
        WHERE tc.pedido_id=tp.id AND tc.negocio_id=tp.negocio_id
          AND p.tipo='pedido_web' AND p.credito_id IS NULL AND p.anulado=0 AND c.estado<>'anulado'
      ),0) >= tp.total_centavos)::int AS finalizadas
    FROM tienda_pedidos tp
    WHERE tp.cliente_id=? AND tp.estado='confirmado' ${fp.sql}
  `).get(clienteId, ...fp.params);
  const ultimaCompra = [fechasRow.t, pedidosRow.ultima_compra].filter(Boolean).sort().at(-1) || null;

  return {
    cantidadCompras: compras.t + pedidosRow.compras,
    cuotasTotales: cuotasRow.total,
    cuotasPagadas: cuotasRow.pagadas,
    cuotasPagadasATiempo: cuotasRow.a_tiempo,
    cuotasPagadasTarde: cuotasRow.tarde,
    cuotasVencidasActualmente: cuotasRow.vencidas_actualmente,
    deudaActualCentavos: cuotasRow.deuda_actual,
    totalCobradoCentavos: cobradoRow.t,
    atrasoPromedioDias: Math.round(Number(cuotasRow.atraso_promedio) * 10) / 10,
    atrasoMaximoDias: cuotasRow.atraso_maximo,
    fechaUltimaCompra: ultimaCompra,
    fechaUltimoPago: ultimoPagoRow.t,
    comprasFinalizadas: finalizadasRow.t + pedidosRow.finalizadas,
  };
}
