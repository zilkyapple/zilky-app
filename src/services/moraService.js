import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { calcularMora } from '../lib/mora.js';
import { todayAR } from '../lib/dates.js';
import { auditar } from '../lib/audit.js';
import { getCuota } from '../repositories/cuotas.js';
import { getCredito } from '../repositories/creditos.js';
import { getNegocio } from '../repositories/negocios.js';
import { recalcularEstadoCredito } from './pagosService.js';
const error = (message,status=400) => Object.assign(new Error(message),{status});
export async function vistaMora(cuotaId) {
  const cuota=await getCuota(cuotaId);
  if(!cuota) throw error('Cuota no encontrada',404);
  const credito=await getCredito(cuota.credito_id), negocio=await getNegocio(credito.negocio_id);
  const mora=calcularMora(cuota,negocio,todayAR());
  const version=createHash('sha256').update(JSON.stringify({cuota,mora,hoy:todayAR()})).digest('hex');
  return {cuota,credito,mora,version};
}
export async function perdonarMora(cuotaId, input, usuarioId) {
  const {motivo,version,solicitud_id}=input;
  if(typeof motivo!=='string'||!motivo.trim()||motivo.length>2000) throw error('Indicá un motivo (hasta 2000 caracteres)');
  if(typeof version!=='string'||!/^[a-f0-9]{64}$/.test(version)) throw error('Actualizá la vista previa');
  if(typeof solicitud_id!=='string'||!/^[a-f0-9-]{36}$/i.test(solicitud_id)) throw error('Solicitud inválida');
  return db.transaction(async()=>{
    const inicial=await vistaMora(cuotaId);
    await db.lockClienteNegocio(inicial.credito.cliente_id,inicial.credito.negocio_id);
    await db.prepare('SELECT id FROM cuotas WHERE id=? FOR UPDATE').get(cuotaId);
    const logs=await db.prepare("SELECT datos_nuevos,empleado,motivo FROM auditoria WHERE entidad='cuota' AND entidad_id=? AND accion='perdonar_mora'").all(cuotaId);
    const repetido=logs.find(x=>JSON.parse(x.datos_nuevos).solicitud_id===solicitud_id);
    if(repetido) {
      const data=JSON.parse(repetido.datos_nuevos);
      if(data.version!==version||repetido.empleado!==usuarioId||repetido.motivo!==motivo.trim()) throw error('Solicitud ya utilizada con otros datos',409);
      return data;
    }
    const actual=await vistaMora(cuotaId);
    if(actual.version!==version) throw error('La cuota o la mora cambió. Revisá nuevamente el importe.',409);
    if(actual.mora.pendiente<=0||actual.cuota.estado_manual) throw error('No hay mora pendiente para perdonar',409);
    const perdonada=actual.mora.perdonada+actual.mora.pendiente;
    await db.prepare('UPDATE cuotas SET mora_generada_centavos=?, mora_perdonada_centavos=? WHERE id=?').run(actual.mora.acumulada,perdonada,cuotaId);
    const data={solicitud_id,version,importe_centavos:actual.mora.pendiente,fecha:todayAR(),mora_generada_centavos:actual.mora.acumulada,mora_perdonada_centavos:perdonada};
    await auditar('cuota',cuotaId,'perdonar_mora',actual.cuota,data,usuarioId,motivo.trim());
    await recalcularEstadoCredito(actual.credito.id,await getNegocio(actual.credito.negocio_id),todayAR(),usuarioId);
    return data;
  });
}
