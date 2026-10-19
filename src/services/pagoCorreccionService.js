import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { integer, dateISO } from '../lib/validation.js';
import { nowAR, todayAR, diffDays } from '../lib/dates.js';
import { auditar } from '../lib/audit.js';
import { distribuirPago } from '../lib/mora.js';
import { getCredito } from '../repositories/creditos.js';
import { getNegocio } from '../repositories/negocios.js';
import { listCuotasPorCredito, actualizarCuota } from '../repositories/cuotas.js';
import { getPago, crearPago, crearAplicacion, getSaldoFavor, sumarSaldoFavor } from '../repositories/pagos.js';
import { crearComprobante, anularComprobanteRow } from '../repositories/comprobantes.js';
import { recalcularEstadoCredito } from './pagosService.js';
import { sincronizarComision } from './comisionesService.js';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const importeAplicado = a => a.capital_centavos + a.interes_mora_centavos;
const sumaSaldo = cuotas => cuotas.reduce((sum, q) => sum + q.saldo_pendiente_centavos, 0);

export async function vistaCorreccionPago(pagoId) {
  const pago = await getPago(pagoId);
  if (!pago) throw error('Pago no encontrado', 404);
  const credito = pago.credito_id ? await getCredito(pago.credito_id) : null;
  if (!credito) throw error('Este pago no pertenece a una financiación editable', 409);
  const cuotas = await listCuotasPorCredito(credito.id);
  const pagos = await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(credito.id);
  const aplicaciones = await db.prepare('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(credito.id);
  const comprobantes = await db.prepare('SELECT * FROM comprobantes WHERE pago_id=? ORDER BY id').all(pagoId);
  const venta = await db.prepare('SELECT id,estado FROM ventas WHERE id=?').get(credito.venta_id);
  const devoluciones = await db.prepare('SELECT id FROM venta_devoluciones WHERE venta_id=? ORDER BY id').all(credito.venta_id);
  const negocio = await getNegocio(credito.negocio_id);
  const saldo_favor_centavos = await getSaldoFavor(credito.cliente_id, credito.negocio_id);
  const data = { pago, credito, cuotas, pagos, aplicaciones, comprobantes, venta, devoluciones, negocio, saldo_favor_centavos };
  return { ...data, version: hash(data) };
}

function validarDatos(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Datos inválidos');
  const keys = ['fecha_hora', 'monto_centavos', 'medio_pago', 'nota'];
  if (Object.keys(input).some(k => !keys.includes(k))) throw error('Campo de pago no editable');
  integer(input.monto_centavos, 'Importe del pago', { min: 1 });
  if (typeof input.fecha_hora !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.fecha_hora) || !Number.isFinite(Date.parse(input.fecha_hora))) throw error('Fecha de pago inválida');
  dateISO(input.fecha_hora.slice(0, 10));
  if (input.fecha_hora.slice(0, 10) > todayAR()) throw error('El pago no puede estar en el futuro');
  if (typeof input.medio_pago !== 'string' || !input.medio_pago.trim() || input.medio_pago.length > 100) throw error('Medio de pago inválido');
  if (typeof input.nota !== 'string' || input.nota.length > 4000) throw error('Nota inválida');
  return { fecha_hora: input.fecha_hora, monto_centavos: input.monto_centavos, medio_pago: input.medio_pago.trim(), nota: input.nota.trim() };
}

function validarVersion(version) {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw error('Actualizá la vista previa del pago');
}

// A correction is documentary. Later receipts keep their allocations and amounts.
// Reductions remove old excess first, then capital from the last allocation before mora.
// Increases allocate only the extra amount with the existing collection rules.
export function prepararCorreccionPago(before, datos) {
  const { pago, credito, negocio } = before;
  if (pago.anulado) throw error('El pago ya está anulado o corregido. Abrí el pago vigente.', 409);
  if (before.venta?.estado === 'anulada' || before.venta?.estado === 'devuelta' || before.devoluciones.length) throw error('La venta tiene una anulación o devolución; requiere conciliación antes de corregir pagos', 409);
  if (before.comprobantes.filter(c => c.estado !== 'anulado').length !== 1) throw error('El pago requiere conciliar sus comprobantes antes de corregirlo', 409);
  const entrega = pago.tipo === 'entrega_inicial';
  if (entrega && datos.monto_centavos !== pago.monto_centavos) throw error('Corregí el importe de la entrega inicial desde Corregir financiación para revisar también las cuotas', 409);
  const originales = before.aplicaciones.filter(a => a.pago_id === pago.id);
  if (entrega && originales.length) throw error('La entrega tiene aplicaciones inesperadas; requiere conciliación', 409);
  if (originales.some(a => !before.cuotas.some(q => q.id === a.cuota_id))) throw error('El pago tiene aplicaciones ajenas a la financiación', 409);
  const remanenteAnterior = entrega ? 0 : pago.monto_centavos - originales.reduce((sum, a) => sum + importeAplicado(a), 0);
  if (remanenteAnterior < 0) throw error('Las aplicaciones superan el importe del pago; requiere conciliación', 409);
  const nuevas = originales.map(a => ({ ...a })).sort((a, b) => before.cuotas.find(q => q.id === a.cuota_id).numero - before.cuotas.find(q => q.id === b.cuota_id).numero || a.id.localeCompare(b.id));
  const cuotas = before.cuotas.map(q => ({ ...q }));
  let remanenteNuevo = remanenteAnterior;
  const delta = datos.monto_centavos - pago.monto_centavos;
  if (delta < 0) {
    let quitar = -delta;
    const exceso = Math.min(quitar, remanenteNuevo);
    remanenteNuevo -= exceso;
    quitar -= exceso;
    for (const a of [...nuevas].reverse()) {
      for (const key of ['capital_centavos', 'interes_mora_centavos']) {
        const recorte = Math.min(quitar, a[key]);
        a[key] -= recorte;
        quitar -= recorte;
      }
    }
    if (quitar) throw error('No se pudo conciliar el importe corregido', 409);
  } else if (delta > 0) {
    // No replay of the old payment: outstanding balances already include every later payment.
    const extra = distribuirPago({ cuotas, monto: delta, negocio, today: datos.fecha_hora.slice(0, 10) });
    remanenteNuevo += extra.remanente;
    for (const a of extra.aplicaciones) {
      const old = nuevas.find(x => x.cuota_id === a.cuotaId);
      if (old) { old.capital_centavos += a.capital; old.interes_mora_centavos += a.mora; }
      else nuevas.push({ cuota_id: a.cuotaId, capital_centavos: a.capital, interes_mora_centavos: a.mora });
    }
  }
  // Rebuild from current balances, reversing only the old allocation and applying its replacement.
  const afectadas = new Set([...originales, ...nuevas].map(a => a.cuota_id));
  for (const q of cuotas) {
    if (!afectadas.has(q.id)) continue;
    const oldQ = before.cuotas.find(x => x.id === q.id);
    if (oldQ.estado_manual) throw error('La cuota tiene un estado manual; requiere conciliación antes de corregir este pago', 409);
    const old = originales.filter(a => a.cuota_id === q.id);
    const nuevo = nuevas.filter(a => a.cuota_id === q.id);
    q.saldo_pendiente_centavos = oldQ.saldo_pendiente_centavos + old.reduce((s, a) => s + a.capital_centavos, 0) - nuevo.reduce((s, a) => s + a.capital_centavos, 0);
    q.mora_pagada_centavos = (oldQ.mora_pagada_centavos || 0) + nuevo.reduce((s, a) => s + a.interes_mora_centavos, 0) - old.reduce((s, a) => s + a.interes_mora_centavos, 0);
    if (q.saldo_pendiente_centavos < 0 || q.saldo_pendiente_centavos > q.monto_centavos || q.mora_pagada_centavos < 0) throw error('Los saldos no se pueden conciliar; revisá las aplicaciones del pago', 409);
    if (q.saldo_pendiente_centavos > 0) { q.fecha_saldada = null; q.dias_atraso_al_pagar = null; }
    else {
      const fechas = before.aplicaciones.filter(a => a.cuota_id === q.id && a.pago_id !== pago.id && a.capital_centavos > 0).map(a => before.pagos.find(p => p.id === a.pago_id && !p.anulado)).filter(Boolean).map(p => String(p.fecha_hora).slice(0, 10));
      if (nuevo.some(a => a.capital_centavos > 0)) fechas.push(datos.fecha_hora.slice(0, 10));
      q.fecha_saldada = fechas.sort().at(-1) || oldQ.fecha_saldada;
      q.dias_atraso_al_pagar = q.fecha_saldada ? Math.max(0, diffDays(q.fecha_saldada, q.fecha_vencimiento)) : oldQ.dias_atraso_al_pagar;
    }
  }
  const saldoFavorNuevo = before.saldo_favor_centavos + remanenteNuevo - remanenteAnterior;
  if (saldoFavorNuevo < 0) throw error('El excedente de este pago ya se utilizó. Conciliá el saldo a favor antes de reducirlo.', 409);
  const aplicaciones = nuevas.filter(a => importeAplicado(a) > 0);
  if (!entrega && aplicaciones.reduce((s, a) => s + importeAplicado(a), remanenteNuevo) !== datos.monto_centavos) throw error('El importe y sus aplicaciones no coinciden', 409);
  const resumen = {
    monto_anterior_centavos: pago.monto_centavos, monto_nuevo_centavos: datos.monto_centavos,
    saldo_anterior_centavos: sumaSaldo(before.cuotas), saldo_posterior_centavos: sumaSaldo(cuotas),
    saldo_favor_anterior_centavos: before.saldo_favor_centavos, saldo_favor_posterior_centavos: saldoFavorNuevo,
    aplicaciones: before.cuotas.filter(q => afectadas.has(q.id)).map(q => ({
      cuota_id: q.id, numero: q.numero,
      capital_anterior_centavos: originales.filter(a => a.cuota_id === q.id).reduce((s, a) => s + a.capital_centavos, 0),
      capital_nuevo_centavos: aplicaciones.filter(a => a.cuota_id === q.id).reduce((s, a) => s + a.capital_centavos, 0),
      mora_anterior_centavos: originales.filter(a => a.cuota_id === q.id).reduce((s, a) => s + a.interes_mora_centavos, 0),
      mora_nueva_centavos: aplicaciones.filter(a => a.cuota_id === q.id).reduce((s, a) => s + a.interes_mora_centavos, 0),
    })),
    aviso: delta === 0 ? 'Se conserva la aplicación original a las cuotas. El comprobante anterior queda anulado y se emite uno corregido. La corrección no registra ingreso ni devolución de dinero en caja.' : 'Se corrige solamente este pago y se conservan los pagos posteriores. Al reducir, se descuenta primero el excedente y luego capital de la última cuota aplicada. Al aumentar, el adicional se aplica según las reglas de cobro. La caja conserva sus movimientos reales.',
  };
  return { datos, cuotas, aplicaciones, afectadas: [...afectadas], remanenteAnterior, remanenteNuevo, resumen, credito };
}

export async function previsualizarCorreccionPago(pagoId, input) {
  validarVersion(input.version);
  const datos = validarDatos(input.datos);
  const before = await vistaCorreccionPago(pagoId);
  if (before.version !== input.version) throw error('Los pagos o el plan cambiaron. Volvé a revisar la corrección.', 409);
  return { version: before.version, resumen: prepararCorreccionPago(before, datos).resumen };
}

async function avisarCaja(before, pago, actor, solicitudId) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('zilky:caja',0))");
  const config = await db.prepare('SELECT c.* FROM caja_config c JOIN caja_negocios n ON n.caja_id=c.id WHERE n.negocio_id=? AND c.activa').get(pago.negocio_id);
  if (!config) return;
  const concepto = `Corrección documental del pago ${before.pago.id}; reemplazo ${pago.id}. Fecha ${before.pago.fecha_hora} → ${pago.fecha_hora}; importe ${before.pago.monto_centavos} → ${pago.monto_centavos} centavos; medio ${before.pago.medio_pago} → ${pago.medio_pago}. No presume ingreso ni devolución de dinero.`;
  await db.prepare("INSERT INTO caja_asientos(id,caja_id,negocio_id,tipo,monto,medio,concepto,actor,solicitud_id,payload) VALUES(?,?,?,'correccion',?,'otro',?,?,?,?)").run(id(),config.id,pago.negocio_id,pago.monto_centavos-before.pago.monto_centavos,concepto,actor,solicitudId,JSON.stringify({original_id:before.pago.id,reemplazo_id:pago.id}));
}

export async function corregirPago(pagoId, input, actor) {
  validarVersion(input.version);
  const datos = validarDatos(input.datos);
  if (typeof input.motivo !== 'string' || !input.motivo.trim() || input.motivo.length > 2000) throw error('Indicá un motivo de corrección (hasta 2000 caracteres)');
  if (typeof input.solicitud_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.solicitud_id)) throw error('Solicitud inválida');
  const motivo = input.motivo.trim();
  const requestHash = hash({ version: input.version, datos, motivo });
  return db.transaction(async () => {
    const inicial = await getPago(pagoId);
    if (!inicial) throw error('Pago no encontrado', 404);
    await db.lockClienteNegocio(inicial.cliente_id, inicial.negocio_id);
    await db.prepare('SELECT id FROM creditos WHERE id=? FOR UPDATE').get(inicial.credito_id);
    await db.prepare('SELECT id FROM negocios WHERE id=? FOR SHARE').get(inicial.negocio_id);
    const logs = await db.prepare("SELECT datos_nuevos,empleado FROM auditoria WHERE entidad='pago' AND entidad_id=? AND accion='corregir_pago'").all(pagoId);
    const repeated = logs.map(l => ({ ...l, data: JSON.parse(l.datos_nuevos) })).find(l => l.data.solicitud_id === input.solicitud_id);
    if (repeated) {
      if (repeated.data.requestHash !== requestHash || repeated.empleado !== actor) throw error('Solicitud reutilizada con otros datos', 409);
      return { id: pagoId, reemplazo_id: repeated.data.reemplazo_id, comprobante_id: repeated.data.comprobante_id, resumen: repeated.data.resumen, reintentado: true };
    }
    const before = await vistaCorreccionPago(pagoId);
    if (before.version !== input.version) throw error('Los pagos o el plan cambiaron. Volvé a revisar la corrección.', 409);
    const plan = prepararCorreccionPago(before, datos);
    await db.query("SELECT set_config('zilky.correccion_financiacion','1',true)");
    await db.prepare('UPDATE pagos SET anulado=1,motivo_anulacion=? WHERE id=?').run('Corrección documental: ' + motivo, pagoId);
    const originalReceipt = before.comprobantes.find(c => c.estado !== 'anulado');
    await anularComprobanteRow(originalReceipt.id, { motivo: 'Corrección documental: ' + motivo, usuarioId: actor, fecha: nowAR() });
    for (const q of plan.cuotas.filter(q => plan.afectadas.includes(q.id))) await actualizarCuota(q.id, q);
    const deltaFavor = plan.remanenteNuevo - plan.remanenteAnterior;
    if (deltaFavor) await sumarSaldoFavor(inicial.cliente_id, inicial.negocio_id, deltaFavor);
    const pago = await crearPago({ ...before.pago, ...datos, usuario_id: actor, saldo_anterior_centavos: plan.resumen.saldo_anterior_centavos, saldo_posterior_centavos: plan.resumen.saldo_posterior_centavos });
    for (const a of plan.aplicaciones) await crearAplicacion(pago.id, { cuotaId: a.cuota_id, capital: a.capital_centavos, mora: a.interes_mora_centavos });
    const comprobante = await crearComprobante({ pago_id: pago.id, negocio_id: pago.negocio_id, cliente_id: pago.cliente_id, venta_id: before.credito.venta_id, credito_id: pago.credito_id, monto_centavos: pago.monto_centavos, fecha_hora: pago.fecha_hora, medio_pago: pago.medio_pago, saldo_restante_centavos: plan.resumen.saldo_posterior_centavos, usuario_id: actor });
    await db.prepare('UPDATE comprobantes SET comprobante_original_id=? WHERE id=?').run(originalReceipt.id, comprobante.id);
    await avisarCaja(before, pago, actor, input.solicitud_id);
    await sincronizarComision(before.credito.id, todayAR(), 'Corrección documental de pago');
    await recalcularEstadoCredito(before.credito.id, before.negocio, todayAR(), actor);
    const result = { id: pagoId, reemplazo_id: pago.id, comprobante_id: comprobante.id, resumen: plan.resumen };
    await auditar('pago', pagoId, 'corregir_pago', before, { solicitud_id: input.solicitud_id, requestHash, datos, ...result }, actor, motivo);
    return result;
  });
}
