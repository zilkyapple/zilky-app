import { db } from '../db/connection.js';
import { createHash } from 'node:crypto';
import { id } from '../lib/id.js';
import { addDays, todayAR } from '../lib/dates.js';
import { badRequest, dateISO, text } from '../lib/validation.js';
import { auditar } from '../lib/audit.js';
import { getCredito } from '../repositories/creditos.js';
import { getNegocio } from '../repositories/negocios.js';

export function listIncidencias(creditoId) {
  return db.prepare('SELECT * FROM credito_incidencias WHERE credito_id=? ORDER BY secuencia').all(creditoId);
}

const tiposEquipo = ['equipo_entregado','equipo_retirado'];
const errorIncidencia = (message,status) => Object.assign(new Error(message),{status});
const versionIncidencia = evento => createHash('sha256').update(JSON.stringify(evento)).digest('hex');

async function buscarIncidenciaEquipo({creditoId,clienteId,negocioId,incidenciaId},bloquear=false) {
  if (!negocioId) throw badRequest('negocio_id es requerido');
  let credito = await getCredito(creditoId);
  const pertenece = cr => cr && cr.cliente_id===clienteId && cr.negocio_id===negocioId;
  if (!pertenece(credito)) throw errorIncidencia('Operación no encontrada en este cliente y negocio',404);
  if (bloquear) {
    await db.lockClienteNegocio(clienteId,negocioId);
    credito = await db.prepare('SELECT * FROM creditos WHERE id=? FOR UPDATE').get(creditoId);
    if (!pertenece(credito)) throw errorIncidencia('Operación no encontrada en este cliente y negocio',404);
  }
  const evento = await db.prepare('SELECT * FROM credito_incidencias WHERE id=? AND credito_id=?'+(bloquear?' FOR UPDATE':'')).get(incidenciaId,creditoId);
  if (!evento) throw errorIncidencia('Incidencia no encontrada en esta operación',404);
  if (!tiposEquipo.includes(evento.tipo)) throw errorIncidencia('Solo se pueden corregir fechas de entrega o retiro de equipo',409);
  return {credito,evento};
}

export async function vistaIncidenciaEquipo(scope) {
  const {evento} = await buscarIncidenciaEquipo(scope);
  return {evento,version:versionIncidencia(evento)};
}

export async function corregirFechaIncidenciaEquipo({creditoId,clienteId,negocioId,incidenciaId,version,fecha,motivo,solicitudId,usuarioId}) {
  dateISO(fecha);
  const razon = text(motivo,'motivo de la corrección',2000);
  const solicitud = text(solicitudId,'identificador de solicitud',128);
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(solicitud)) throw badRequest('Identificador de solicitud inválido');
  if (typeof version!=='string' || !/^[a-f0-9]{64}$/.test(version)) throw badRequest('Falta una versión válida de la incidencia');
  const requestHash = createHash('sha256').update(JSON.stringify({version,fecha,motivo:razon})).digest('hex');
  return db.transaction(async()=>{
    const {credito,evento} = await buscarIncidenciaEquipo({creditoId,clienteId,negocioId,incidenciaId},true);
    const logs = await db.prepare("SELECT * FROM auditoria WHERE entidad='credito_incidencia' AND entidad_id=? AND accion='corregir_fecha_incidencia'").all(incidenciaId);
    const previo = logs.find(log=>JSON.parse(log.datos_nuevos).solicitud_id===solicitud);
    if (previo) {
      const guardado = JSON.parse(previo.datos_nuevos);
      if (guardado.requestHash!==requestHash || previo.empleado!==usuarioId) throw errorIncidencia('La solicitud ya se usó con otros datos',409);
      return {evento:guardado.evento,version:versionIncidencia(guardado.evento),reintentado:true};
    }
    if (version!==versionIncidencia(evento)) throw errorIncidencia('La incidencia cambió. Volvé a abrirla antes de guardar.',409);
    if (fecha<credito.fecha_inicio || fecha>todayAR()) throw badRequest('La fecha debe estar entre la compra y hoy');
    // Corregir la fecha conserva el hecho original, su motivo, actor y registro.
    // También se permite corregir historial si luego se desactivó su seguimiento.
    await db.prepare('UPDATE credito_incidencias SET fecha=? WHERE id=?').run(fecha,incidenciaId);
    const despues = await db.prepare('SELECT * FROM credito_incidencias WHERE id=?').get(incidenciaId);
    await auditar('credito_incidencia',incidenciaId,'corregir_fecha_incidencia',evento,
      {solicitud_id:solicitud,requestHash,evento:despues},usuarioId,razon);
    return {evento:despues,version:versionIncidencia(despues)};
  });
}

// Los hechos financieros se agregan. Anular un pago no borra lo ocurrido.
export async function agregarIncidencia({ creditoId, tipo, fecha, clave, motivo=null, usuarioId=null, pagoId=null }) {
  return (await db.query(`INSERT INTO credito_incidencias
    (id,credito_id,tipo,fecha,clave,motivo,usuario_id,pago_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (credito_id,clave) DO NOTHING RETURNING *`,
    [id(),creditoId,tipo,fecha,clave,motivo,usuarioId,pagoId])).rows[0];
}

const deuda = c => c.saldo_pendiente_centavos + Math.max(0,(c.mora_generada_centavos||0)-(c.mora_pagada_centavos||0)-(c.mora_perdonada_centavos||0));
const vencidas = (cuotas, fecha) => cuotas.filter(c => deuda(c) > 0 && !c.estado_manual && c.fecha_vencimiento < fecha);

export async function registrarHistoriaPago({ credito, antes, despues, fecha, pagoId, usuarioId }) {
  const atrasadasAntes = vencidas(antes,fecha);
  const base = { creditoId:credito.id, pagoId, usuarioId };
  if (atrasadasAntes.length) {
    const ultima = await db.prepare(`SELECT tipo FROM credito_incidencias WHERE credito_id=?
      AND tipo NOT IN ('equipo_entregado','equipo_retirado') ORDER BY secuencia DESC LIMIT 1`).get(credito.id);
    if (ultima?.tipo !== 'atrasada') {
      const inicio = atrasadasAntes.map(c=>addDays(c.fecha_vencimiento,1)).sort()[0];
      await agregarIncidencia({...base,tipo:'atrasada',fecha:inicio,clave:`pago:${pagoId}:atrasada`});
    }
    if (!vencidas(despues,fecha).length) {
      await agregarIncidencia({...base,tipo:'regularizada',fecha,clave:`pago:${pagoId}:regularizada`});
    }
  }
  const quedabaSaldo = antes.some(c=>deuda(c)>0 && !c.estado_manual);
  const pagadas = despues.length>0 && despues.every(c=>deuda(c)<=0 && !c.estado_manual);
  if (quedabaSaldo && pagadas) {
    const ultimoVencimiento = despues.map(c=>c.fecha_vencimiento).sort().at(-1);
    const tipo = fecha < ultimoVencimiento ? 'cancelada_anticipadamente' : 'finalizada_correctamente';
    await agregarIncidencia({...base,tipo,fecha,clave:`pago:${pagoId}:finalizada`});
  }
}

export async function registrarIncidenciaEquipo({ creditoId, clienteId, negocioId, tipo, fecha, motivo, solicitudId, usuarioId }) {
  if (!tiposEquipo.includes(tipo)) throw badRequest('Tipo de incidencia inválido');
  dateISO(fecha);
  const razon = text(motivo,'motivo',2000);
  const solicitud = text(solicitudId,'identificador de solicitud',128);
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(solicitud)) throw badRequest('Identificador de solicitud inválido');
  return db.transaction(async()=>{
    let cr=await getCredito(creditoId);
    if (!cr || cr.cliente_id!==clienteId || cr.negocio_id!==negocioId) throw Object.assign(new Error('Operación no encontrada en este cliente y negocio'),{status:404});
    await db.lockClienteNegocio(clienteId,negocioId);
    cr=await db.prepare('SELECT * FROM creditos WHERE id=? FOR UPDATE').get(creditoId);
    if (!cr || cr.cliente_id!==clienteId || cr.negocio_id!==negocioId) throw Object.assign(new Error('Operación no encontrada en este cliente y negocio'),{status:404});
    const negocio=await getNegocio(negocioId);
    if (negocio.seguimiento_equipos!==1) throw Object.assign(new Error('El seguimiento de equipos no está habilitado en este negocio'),{status:409});
    if (fecha<cr.fecha_inicio || fecha>todayAR()) throw badRequest('La fecha debe estar entre la compra y hoy');
    const clave=`equipo:${solicitud}`;
    const existente=await db.prepare('SELECT * FROM credito_incidencias WHERE credito_id=? AND clave=?').get(creditoId,clave);
    if (existente) {
      if(existente.tipo!==tipo || existente.fecha!==fecha || existente.motivo!==razon) throw Object.assign(new Error('La solicitud ya se usó con otros datos'),{status:409});
      return existente;
    }
    const evento=await agregarIncidencia({creditoId,tipo,fecha,motivo:razon,clave,usuarioId});
    await auditar('credito',creditoId,'incidencia_equipo',null,evento,usuarioId,razon);
    return evento;
  });
}

