import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { auditar } from '../lib/audit.js';
import { text } from '../lib/validation.js';
import { nowAR, todayAR, diffDays } from '../lib/dates.js';
import { calcularMora } from '../lib/mora.js';
import { fechaPagoAR, normalizarFechaPago, reconstruirPagos } from '../lib/replayPagos.js';
import { crearComprobante } from '../repositories/comprobantes.js';
import { crearAplicacion, sumarSaldoFavor } from '../repositories/pagos.js';
import { recalcularEstadoCredito } from './pagosService.js';
import { sincronizarComision } from './comisionesService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const configMora = n => {
  const config = Object.fromEntries(['dias_gracia', 'mora_tipo', 'mora_valor', 'mora_periodo', 'mora_base', 'mora_acumulativa', 'orden_aplicacion_pago'].map(k => [k, n?.[k] ?? null]));
  config.orden_aplicacion_pago = parse(config.orden_aplicacion_pago) ?? config.orden_aplicacion_pago;
  if (config.mora_acumulativa !== null) config.mora_acumulativa = !!config.mora_acumulativa;
  return config;
};
const cuotaPlan = q => ({ id: q.id, numero: q.numero, monto_centavos: q.monto_centavos, fecha_vencimiento: q.fecha_vencimiento });
const plan = s => ({ credito: Object.fromEntries(['monto_total_centavos', 'entrega_inicial_centavos', 'saldo_financiado_centavos'].map(k => [k, s?.credito?.[k]])), cuotas: s?.cuotas?.map(cuotaPlan) });

function validarInput(input, guardar = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Datos de corrección inválidos');
  const campos = ['version', 'fecha_hora', 'recalcular', 'negocio_id', ...(guardar ? ['version_preview', 'motivo', 'solicitud_id', 'confirmar'] : [])];
  if (Object.keys(input).some(k => !campos.includes(k))) throw fail('Campo no editable en la corrección de fecha');
  if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw fail('Falta una versión válida del pago');
}

function fechaCanonica(value, credito) {
  const normalizada = normalizarFechaPago(value), fecha = normalizada.slice(0, 10);
  if (fecha > todayAR()) throw fail('La fecha del pago no puede estar en el futuro');
  if (fecha < credito.fecha_inicio) throw fail('La fecha del pago no puede ser anterior a la compra');
  return normalizada;
}

async function cargar(pagoId, bloquear = false) {
  let pago = await db.prepare('SELECT * FROM pagos WHERE id=?').get(pagoId);
  if (!pago) throw fail('Pago no encontrado', 404);
  if (!pago.credito_id) throw fail('El pago no tiene una financiación asociada', 409);
  let credito = await db.prepare('SELECT * FROM creditos WHERE id=?').get(pago.credito_id);
  if (!credito || credito.cliente_id !== pago.cliente_id || credito.negocio_id !== pago.negocio_id) throw fail('El pago no pertenece a esta financiación', 409);
  if (bloquear) {
    await db.lockClienteNegocio(credito.cliente_id, credito.negocio_id);
    credito = await db.prepare('SELECT * FROM creditos WHERE id=? FOR UPDATE').get(credito.id);
    pago = await db.prepare('SELECT * FROM pagos WHERE id=? FOR UPDATE').get(pagoId);
    if (!credito || !pago || pago.credito_id !== credito.id || credito.cliente_id !== pago.cliente_id || credito.negocio_id !== pago.negocio_id) throw fail('El pago cambió; volvé a abrir la corrección', 409);
  }
  const negocio = await db.prepare('SELECT * FROM negocios WHERE id=?' + (bloquear ? ' FOR SHARE' : '')).get(credito.negocio_id);
  if (!negocio) throw fail('Negocio no encontrado', 404);
  const venta = await db.prepare('SELECT * FROM ventas WHERE id=?').get(credito.venta_id);
  const cuotas = await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY numero,id').all(credito.id);
  const pagos = await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(credito.id);
  const aplicaciones = await db.prepare('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(credito.id);
  const comprobantes = await db.prepare('SELECT * FROM comprobantes WHERE credito_id=? ORDER BY id').all(credito.id);
  const devoluciones = await db.prepare('SELECT * FROM venta_devoluciones WHERE venta_id=? ORDER BY id').all(credito.venta_id);
  const saldo = await db.prepare('SELECT monto_centavos FROM saldo_favor WHERE cliente_id=? AND negocio_id=?').get(credito.cliente_id, credito.negocio_id);
  const auditoria = await db.prepare(`SELECT * FROM auditoria WHERE (entidad='credito' AND entidad_id=?)
    OR (entidad='pago' AND entidad_id IN (SELECT id FROM pagos WHERE credito_id=?))
    OR (entidad='cuota' AND entidad_id IN (SELECT id FROM cuotas WHERE credito_id=?))
    OR (entidad='negocio' AND entidad_id=?) ORDER BY fecha_hora,id`).all(credito.id, credito.id, credito.id, credito.negocio_id);
  const snapshot = { pago, credito, negocio, venta, cuotas, pagos, aplicaciones, comprobantes, devoluciones, saldo_favor_centavos: saldo?.monto_centavos || 0 };
  const version = hash({ ...snapshot, hoy: todayAR(), auditoria: auditoria.map(a => ({ id: a.id, hash: hash(a) })) });
  return { ...snapshot, auditoria, version };
}

function validarPago(s) {
  if (s.pago.anulado) throw fail('El pago está anulado y no se puede corregir', 409);
  if (!['cuota', 'entrega_inicial'].includes(s.pago.tipo || 'cuota')) throw fail('Este tipo de pago requiere conciliación', 409);
}

function motivoNoRecalculo(s) {
  if (s.devoluciones.length || ['anulada', 'devuelta', 'devolucion_parcial'].includes(s.venta?.estado)) return 'La venta tiene devoluciones o fue anulada; requiere conciliación para recalcular los pagos.';
  if (s.cuotas.some(q => q.estado_manual)) return 'Hay cuotas con estado manual; requiere conciliación para recalcular los pagos.';
  if (s.cuotas.some(q => q.mora_perdonada_centavos > 0) || s.auditoria.some(a => a.entidad === 'cuota' && a.accion === 'perdonar_mora')) return 'Hay mora perdonada; se conserva esa decisión y el recálculo requiere conciliación.';
  const cuotasPagadas = s.pagos.filter(p => !p.anulado && (p.tipo || 'cuota') === 'cuota');
  if (cuotasPagadas.some(p => p.politica_mora != null && hash(configMora(parse(p.politica_mora))) !== hash(configMora(s.negocio)))) return 'La configuración de mora cambió desde que se registraron pagos; requiere conciliación para recalcularlos.';
  const primeraCarga = Math.min(...cuotasPagadas.map(p => Date.parse(p.created_at || p.fecha_hora)));
  for (const a of s.auditoria) {
    const antes = parse(a.datos_anteriores), nuevos = parse(a.datos_nuevos), despues = nuevos?.despues || nuevos;
    if (a.accion === 'corregir_financiacion') {
      const habiaPagos = antes?.pagos?.some(p => !p.anulado && (p.tipo || 'cuota') === 'cuota') || Date.parse(a.fecha_hora) >= primeraCarga;
      if (habiaPagos && hash(plan(antes)) !== hash(plan(despues))) return 'El plan financiero se corrigió después de registrar pagos; requiere conciliación para recalcularlos.';
    }
    if (a.entidad === 'negocio' && Date.parse(a.fecha_hora) >= primeraCarga && antes && despues && hash(configMora(antes)) !== hash(configMora(despues))) return 'La configuración de mora cambió después de registrar pagos; requiere conciliación.';
    for (const conocido of [antes?.negocio, despues?.negocio]) {
      if (conocido && hash(configMora(conocido)) !== hash(configMora(s.negocio))) return 'La configuración de mora cambió desde una corrección anterior; requiere conciliación.';
    }
  }
  return null;
}

function advertencias(s, recalcular) {
  const avisos = ['La corrección conserva el dinero registrado y no genera movimientos de caja. Los comprobantes reemplazados quedan en el historial.'];
  if (recalcular) {
    avisos.push('La mora se recalculará con el plan y la configuración actuales del negocio.');
    if (s.pagos.some(p => !p.anulado && (p.tipo || 'cuota') === 'cuota' && !p.objetivo_registrado)) avisos.push('Los pagos anteriores se volverán a aplicar por orden de vencimiento; revisá las cuotas.');
    if (s.pagos.some(p => !p.anulado && (p.tipo || 'cuota') === 'cuota' && p.politica_mora == null)) avisos.push('Al confirmar se adopta la configuración actual para los pagos sin configuración histórica registrada.');
  } else avisos.push('Se actualizará la fecha de cancelación; se conserva cómo se aplicó el dinero.');
  return avisos;
}

function resumen(s) {
  return {
    capital_pendiente_centavos: s.cuotas.reduce((t, q) => t + q.saldo_pendiente_centavos, 0),
    mora_pendiente_centavos: s.cuotas.reduce((t, q) => t + calcularMora(q, s.negocio, todayAR()).pendiente, 0),
    saldo_favor_centavos: s.saldo_favor_centavos,
  };
}

function excedenteAnterior(s) {
  return s.pagos.filter(p => !p.anulado && (p.tipo || 'cuota') === 'cuota').reduce((suma, p) => {
    const aps = s.aplicaciones.filter(a => a.pago_id === p.id);
    if (aps.some(a => !s.cuotas.some(q => q.id === a.cuota_id))) throw fail('Hay aplicaciones de pagos ajenas al plan; requiere conciliación', 409);
    const aplicado = aps.reduce((t, a) => t + a.capital_centavos + a.interes_mora_centavos, 0);
    if (aplicado > p.monto_centavos || aplicado < 0) throw fail('Las aplicaciones de un pago requieren conciliación', 409);
    return suma + p.monto_centavos - aplicado;
  }, 0);
}

function proyectar(s, input) {
  validarPago(s);
  if (input.version !== s.version) throw fail('Los pagos o la financiación cambiaron. Volvé a revisar la corrección.', 409);
  if (typeof input.recalcular !== 'boolean') throw fail('Indicá si querés recalcular los pagos');
  const fechaHora = fechaCanonica(input.fecha_hora, s.credito);
  const pagosNuevos = s.pagos.map(p => p.id === s.pago.id ? { ...p, fecha_hora: fechaHora } : { ...p });
  let cuotasNuevas = s.cuotas.map(q => ({ ...q })), pagosRecalculados = null, saldoFavor = s.saldo_favor_centavos;
  if (input.recalcular) {
    const bloqueo = motivoNoRecalculo(s);
    if (bloqueo) throw fail(bloqueo, 409);
    const reconstruccion = reconstruirPagos({ credito: s.credito, cuotas: s.cuotas, pagos: pagosNuevos, negocio: s.negocio });
    cuotasNuevas = reconstruccion.cuotas;
    pagosRecalculados = reconstruccion.pagos;
    saldoFavor += reconstruccion.saldo_favor_generado_centavos - excedenteAnterior(s);
    if (!Number.isSafeInteger(saldoFavor) || saldoFavor < 0) throw fail('El saldo a favor anterior ya fue utilizado; requiere conciliación antes de recalcular.', 409);
  } else {
    // La fecha de cancelación es documental: se conserva la distribución de dinero.
    const vinculadas = new Set(s.aplicaciones.filter(a => a.pago_id === s.pago.id && a.capital_centavos > 0).map(a => a.cuota_id));
    for (const q of cuotasNuevas.filter(q => vinculadas.has(q.id) && q.saldo_pendiente_centavos <= 0 && !q.estado_manual)) {
      const ids = new Set(s.aplicaciones.filter(a => a.cuota_id === q.id && a.capital_centavos > 0).map(a => a.pago_id));
      const fechas = pagosNuevos.filter(p => !p.anulado && ids.has(p.id)).map(p => fechaPagoAR(p.fecha_hora)).sort();
      if (fechas.length) { q.fecha_saldada = fechas.at(-1); q.dias_atraso_al_pagar = Math.max(0, diffDays(q.fecha_saldada, q.fecha_vencimiento)); }
    }
  }
  const despues = { ...s, cuotas: cuotasNuevas, saldo_favor_centavos: saldoFavor };
  const publico = {
    version: s.version, fecha_hora: fechaHora, recalcular: input.recalcular,
    antes: resumen(s), despues: resumen(despues),
    cuotas: cuotasNuevas.map(q => {
      const vieja = s.cuotas.find(c => c.id === q.id);
      return { id: q.id, numero: q.numero, capital_antes_centavos: vieja.saldo_pendiente_centavos, capital_despues_centavos: q.saldo_pendiente_centavos,
        mora_antes_centavos: calcularMora(vieja, s.negocio, todayAR()).pendiente, mora_despues_centavos: calcularMora(q, s.negocio, todayAR()).pendiente };
    }),
    pagos_afectados: input.recalcular ? pagosNuevos.filter(p => !p.anulado).length : 1,
    advertencias: advertencias(s, input.recalcular),
  };
  return { publico: { ...publico, version_preview: hash(publico) }, cuotasNuevas, pagosNuevos, pagosRecalculados, saldoFavor };
}

export async function vistaCorreccionPago(pagoId) {
  const s = await cargar(pagoId);
  validarPago(s);
  const motivo = motivoNoRecalculo(s);
  return { pago: s.pago, credito: s.credito, version: s.version, recalculo_disponible: !motivo, motivo_no_recalculo: motivo, advertencias: advertencias(s, true) };
}

export async function previsualizarCorreccionPago(pagoId, input) {
  validarInput(input);
  return db.transaction(async () => proyectar(await cargar(pagoId, true), input).publico);
}

function snapshotAuditoria(s) {
  const { auditoria, version, ...datos } = s;
  return datos;
}

function firmaAplicaciones(aps) {
  return hash(aps.map(a => ({ cuota_id: a.cuota_id || a.cuotaId, capital: a.capital_centavos ?? a.capital, mora: a.interes_mora_centavos ?? a.mora })).sort((a, b) => a.cuota_id.localeCompare(b.cuota_id)));
}

async function reemplazarComprobantes(s, nuevos, actor, motivo) {
  const fechaAnulacion = nowAR();
  for (const nuevo of nuevos) {
    const anterior = s.pagos.find(p => p.id === nuevo.id);
    const emitidos = s.comprobantes.filter(c => c.pago_id === nuevo.id && c.estado !== 'anulado');
    const cambioFecha = anterior.fecha_hora !== nuevo.fecha_hora;
    const cambioSaldo = anterior.saldo_posterior_centavos !== nuevo.saldo_posterior_centavos;
    const cambioAplicaciones = nuevo.aplicaciones && firmaAplicaciones(s.aplicaciones.filter(a => a.pago_id === nuevo.id)) !== firmaAplicaciones(nuevo.aplicaciones);
    if (!cambioFecha && !cambioSaldo && !cambioAplicaciones) continue;
    for (const c of emitidos) await db.prepare("UPDATE comprobantes SET estado='anulado',anulado_motivo=?,anulado_por=?,anulado_fecha=? WHERE id=?").run('Corrección documental de pago: ' + motivo, actor, fechaAnulacion, c.id);
    const reemplazo = await crearComprobante({ pago_id: nuevo.id, negocio_id: nuevo.negocio_id, cliente_id: nuevo.cliente_id,
      venta_id: s.credito.venta_id, credito_id: s.credito.id, monto_centavos: nuevo.monto_centavos,
      fecha_hora: nuevo.fecha_hora, medio_pago: nuevo.medio_pago, saldo_restante_centavos: nuevo.saldo_posterior_centavos, usuario_id: actor });
    if (emitidos.length) await db.prepare('UPDATE comprobantes SET comprobante_original_id=? WHERE id=?').run(emitidos[0].id, reemplazo.id);
  }
}

async function aplicarRecalculo(s, p, actor, motivo) {
  // Las distribuciones anteriores quedan completas en el snapshot auditado.
  for (const pago of p.pagosRecalculados.filter(x => (x.tipo || 'cuota') === 'cuota')) {
    if (firmaAplicaciones(s.aplicaciones.filter(a => a.pago_id === pago.id)) !== firmaAplicaciones(pago.aplicaciones)) {
      await db.prepare('DELETE FROM pago_aplicaciones WHERE pago_id=?').run(pago.id);
      for (const ap of pago.aplicaciones) await crearAplicacion(pago.id, ap);
    }
    const anterior = s.pagos.find(x => x.id === pago.id);
    if (anterior.saldo_anterior_centavos !== pago.saldo_anterior_centavos || anterior.saldo_posterior_centavos !== pago.saldo_posterior_centavos) await db.prepare('UPDATE pagos SET saldo_anterior_centavos=?,saldo_posterior_centavos=? WHERE id=?').run(pago.saldo_anterior_centavos, pago.saldo_posterior_centavos, pago.id);
  }
  if (p.saldoFavor !== s.saldo_favor_centavos) await sumarSaldoFavor(s.credito.cliente_id, s.credito.negocio_id, p.saldoFavor - s.saldo_favor_centavos);
  for (const q of p.cuotasNuevas) {
    const vieja = s.cuotas.find(c => c.id === q.id);
    if (['saldo_pendiente_centavos', 'mora_generada_centavos', 'mora_pagada_centavos', 'fecha_saldada', 'dias_atraso_al_pagar'].some(k => q[k] !== vieja[k])) await db.prepare('UPDATE cuotas SET saldo_pendiente_centavos=?,mora_generada_centavos=?,mora_pagada_centavos=?,fecha_saldada=?,dias_atraso_al_pagar=? WHERE id=? AND credito_id=?').run(q.saldo_pendiente_centavos, q.mora_generada_centavos, q.mora_pagada_centavos, q.fecha_saldada, q.dias_atraso_al_pagar, q.id, s.credito.id);
  }
  await reemplazarComprobantes(s, p.pagosRecalculados, actor, motivo);
  await sincronizarComision(s.credito.id, todayAR(), motivo);
  await recalcularEstadoCredito(s.credito.id, s.negocio, todayAR(), actor);
}

export async function corregirFechaPago(pagoId, input, actor) {
  validarInput(input, true);
  const motivo = text(input.motivo, 'motivo de la corrección', 2000);
  if (typeof input.solicitud_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.solicitud_id)) throw fail('Solicitud inválida');
  if (input.confirmar !== true) throw fail('Confirmá la corrección después de revisar la vista previa');
  if (typeof input.version_preview !== 'string' || !/^[a-f0-9]{64}$/.test(input.version_preview)) throw fail('Revisá la vista previa antes de guardar');
  const requestHash = hash({ version: input.version, version_preview: input.version_preview, fecha_hora: input.fecha_hora, recalcular: input.recalcular, motivo });
  return db.transaction(async () => {
    const s = await cargar(pagoId, true);
    const previo = s.auditoria.find(a => a.entidad === 'pago' && a.entidad_id === pagoId && a.accion === 'corregir_fecha_pago' && parse(a.datos_nuevos)?.solicitud_id === input.solicitud_id);
    if (previo) {
      const datos = parse(previo.datos_nuevos);
      if (datos.requestHash !== requestHash || previo.empleado !== actor) throw fail('La solicitud ya se usó con otros datos', 409);
      return { ...datos.resultado, reintentado: true };
    }
    const p = proyectar(s, input);
    if (p.publico.version_preview !== input.version_preview) throw fail('La vista previa cambió. Volvé a revisar los importes.', 409);
    await db.prepare('UPDATE pagos SET fecha_hora=? WHERE id=?').run(p.publico.fecha_hora, pagoId);
    if (input.recalcular) {
      // La vista previa aprobada convierte el destino legacy desconocido en
      // una elección explícita de aplicación general por vencimiento.
      const politicaAprobada = JSON.stringify(configMora(s.negocio));
      for (const pago of s.pagos.filter(x => !x.anulado && (x.tipo || 'cuota') === 'cuota')) {
        if (!pago.objetivo_registrado) await db.prepare('UPDATE pagos SET objetivo_registrado=TRUE,cuota_objetivo_id=NULL,politica_mora=?::jsonb WHERE id=?').run(politicaAprobada, pago.id);
        else if (pago.politica_mora == null) await db.prepare('UPDATE pagos SET politica_mora=?::jsonb WHERE id=?').run(politicaAprobada, pago.id);
      }
      await aplicarRecalculo(s, p, actor, 'Corrección de fecha y distribución de pagos: ' + motivo);
    } else {
      for (const q of p.cuotasNuevas) {
        const vieja = s.cuotas.find(c => c.id === q.id);
        if (q.fecha_saldada !== vieja.fecha_saldada || q.dias_atraso_al_pagar !== vieja.dias_atraso_al_pagar) await db.prepare('UPDATE cuotas SET fecha_saldada=?,dias_atraso_al_pagar=? WHERE id=? AND credito_id=?').run(q.fecha_saldada, q.dias_atraso_al_pagar, q.id, s.credito.id);
      }
      await reemplazarComprobantes(s, p.pagosNuevos.filter(x => x.id === pagoId), actor, motivo);
    }
    const despues = await cargar(pagoId);
    const resultado = { pago: despues.pago, ...p.publico };
    await auditar('pago', pagoId, 'corregir_fecha_pago', snapshotAuditoria(s), {
      solicitud_id: input.solicitud_id, requestHash, fecha_hora: p.publico.fecha_hora, recalcular: input.recalcular,
      despues: snapshotAuditoria(despues), resultado,
    }, actor, motivo);
    return resultado;
  });
}

// Uso interno al registrar pagos nuevos: únicamente contratos sin ajustes y con
// el objetivo de cada pago conocido. Los registros legacy requieren la vista
// previa y la confirmación explícita de corregirFechaPago.
export async function reconstruirCreditoSiHistorico(creditoId, actor, pagoId = null) {
  return db.transaction(async () => {
    const candidato = pagoId ? await db.prepare('SELECT * FROM pagos WHERE id=? AND credito_id=?').get(pagoId, creditoId)
      : await db.prepare("SELECT * FROM pagos WHERE credito_id=? AND anulado=0 AND tipo='cuota' ORDER BY created_at DESC,id DESC LIMIT 1").get(creditoId);
    if (!candidato || candidato.anulado || (candidato.tipo || 'cuota') !== 'cuota') return { recalculado: false };
    const s = await cargar(candidato.id, true);
    const activos = s.pagos.filter(p => !p.anulado && (p.tipo || 'cuota') === 'cuota');
    if (!activos.some(p => p.id !== candidato.id && Date.parse(p.fecha_hora) > Date.parse(candidato.fecha_hora))) return { recalculado: false };
    if (activos.some(p => !p.objetivo_registrado)) return { recalculado: false, requiere_revision: true, motivo: 'Hay pagos históricos sin destino registrado. Revisá la fecha desde el historial de pagos y confirmá la vista previa para recalcular.' };
    if (activos.some(p => p.politica_mora == null)) return { recalculado: false, requiere_revision: true, motivo: 'Hay pagos sin configuración histórica de mora registrada. Revisá la fecha desde el historial de pagos y confirmá la vista previa para recalcular.' };
    const bloqueo = motivoNoRecalculo(s);
    if (bloqueo) return { recalculado: false, requiere_revision: true, motivo: bloqueo };
    const r = reconstruirPagos({ credito: s.credito, cuotas: s.cuotas, pagos: s.pagos, negocio: s.negocio });
    const saldoFavor = s.saldo_favor_centavos + r.saldo_favor_generado_centavos - excedenteAnterior(s);
    if (!Number.isSafeInteger(saldoFavor) || saldoFavor < 0) return { recalculado: false, requiere_revision: true, motivo: 'El saldo a favor anterior ya fue utilizado; requiere conciliación antes de registrar este pago histórico.' };
    await aplicarRecalculo(s, { pagosRecalculados: r.pagos, cuotasNuevas: r.cuotas, saldoFavor }, actor, 'Aplicación cronológica de pago histórico');
    const despues = await cargar(candidato.id);
    await auditar('credito', creditoId, 'reconstruir_pagos_historicos', snapshotAuditoria(s), { pago_id: candidato.id, despues: snapshotAuditoria(despues) }, actor, 'Aplicación cronológica de pago histórico con destinos registrados');
    const comprobante = despues.comprobantes.find(c => c.pago_id === candidato.id && c.estado !== 'anulado');
    return { recalculado: true, pago: despues.pago, comprobante: comprobante ? { ...comprobante, tipo_pago: despues.pago.tipo } : null, estadoCredito: despues.credito.estado };
  });
}
