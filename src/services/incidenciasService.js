import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { addDays, todayAR } from '../lib/dates.js';
import { badRequest, dateISO, text } from '../lib/validation.js';
import { auditar } from '../lib/audit.js';
import { getCredito } from '../repositories/creditos.js';
import { getNegocio } from '../repositories/negocios.js';

export function listIncidencias(creditoId) {
  return db.prepare('SELECT * FROM credito_incidencias WHERE credito_id=? ORDER BY secuencia').all(creditoId);
}

// Solo inserciones. Anular un pago agrega un hecho; no borra lo ocurrido.
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
  if (!['equipo_entregado','equipo_retirado'].includes(tipo)) throw badRequest('Tipo de incidencia inválido');
  dateISO(fecha);
  const razon = text(motivo,'motivo',2000);
  const solicitud = text(solicitudId,'identificador de solicitud',128);
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(solicitud)) throw badRequest('Identificador de solicitud inválido');
  return db.transaction(async()=>{
    const cr=await getCredito(creditoId);
    if (!cr || cr.cliente_id!==clienteId || cr.negocio_id!==negocioId) throw Object.assign(new Error('Operación no encontrada en este cliente y negocio'),{status:404});
    await db.lockClienteNegocio(clienteId,negocioId);
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
