import {createHash} from 'node:crypto';
import {db} from '../db/connection.js';
import {integer,dateISO} from '../lib/validation.js';
import {auditar} from '../lib/audit.js';
import {todayAR,nowAR,diffDays} from '../lib/dates.js';
import {getCredito} from '../repositories/creditos.js';
import {getNegocio} from '../repositories/negocios.js';
import {listCuotasPorCredito,crearCuota} from '../repositories/cuotas.js';
import {calcularMora} from '../lib/mora.js';
import {recalcularEstadoCredito,registrarEntregaInicial} from './pagosService.js';
const err=(m,status=400)=>Object.assign(new Error(m),{status});
export async function vistaFinanciacion(id) {
  const credito=await getCredito(id);if(!credito)throw err('Financiación no encontrada',404);
  const venta=await db.prepare('SELECT * FROM ventas WHERE id=?').get(credito.venta_id);
  const cuotas=await listCuotasPorCredito(id);
  const pagos=await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(id);
  const aplicaciones=await db.prepare('SELECT pa.* FROM pago_aplicaciones pa JOIN cuotas cu ON cu.id=pa.cuota_id WHERE cu.credito_id=? ORDER BY pa.id').all(id);
  const data={credito,venta,cuotas,pagos,aplicaciones};
  return {...data,version:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}
export async function corregirFinanciacion(id,input,actor) {
  const {version,motivo,solicitud_id,datos}=input;
  if(typeof motivo!=='string'||!motivo.trim()||motivo.length>2000)throw err('Indicá un motivo de corrección');
  if(typeof solicitud_id!=='string'||!/^[a-f0-9-]{36}$/i.test(solicitud_id))throw err('Solicitud inválida');
  if(!datos||typeof datos!=='object'||Array.isArray(datos))throw err('Datos inválidos');
  const keys=['monto_total_centavos','entrega_inicial_centavos','fecha_inicio','producto_descripcion','condiciones','cuotas'];
  if(Object.keys(datos).some(k=>!keys.includes(k)))throw err('Campo no editable');
  integer(datos.monto_total_centavos,'importe',{min:1});integer(datos.entrega_inicial_centavos,'entrega');
  if(datos.entrega_inicial_centavos>datos.monto_total_centavos)throw err('La entrega supera el importe');
  dateISO(datos.fecha_inicio);if(datos.fecha_inicio>todayAR())throw err('La compra no puede estar en el futuro');
  for(const key of ['producto_descripcion','condiciones'])if(typeof datos[key]!=='string'||datos[key].length>4000)throw err('Descripción o condiciones inválidas');
  if(!Array.isArray(datos.cuotas)||datos.cuotas.length>600)throw err('Plan inválido');
  for(const q of datos.cuotas){integer(q.monto_centavos,'importe de cuota',{min:1});dateISO(q.fecha_vencimiento);if(q.fecha_vencimiento<datos.fecha_inicio)throw err('El vencimiento no puede ser anterior a la compra');}
  if(datos.monto_total_centavos>datos.entrega_inicial_centavos&&!datos.cuotas.length)throw err('El saldo requiere al menos una cuota');
  return db.transaction(async()=>{
    const first=await getCredito(id);if(!first)throw err('Financiación no encontrada',404);
    await db.lockClienteNegocio(first.cliente_id,first.negocio_id);
    await db.prepare('SELECT id FROM creditos WHERE id=? FOR UPDATE').get(id);
    const logs=await db.prepare("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion'").all(id);
    const requestHash=createHash('sha256').update(JSON.stringify({version,datos,motivo:motivo.trim()})).digest('hex');
    const log=logs.find(l=>JSON.parse(l.datos_nuevos).solicitud_id===solicitud_id);
    if(log){const old=JSON.parse(log.datos_nuevos);if(old.requestHash!==requestHash||log.empleado!==actor)throw err('Solicitud reutilizada con otros datos',409);return {id,reintentado:true};}
    const before=await vistaFinanciacion(id);if(before.version!==version)throw err('La financiación cambió. Volvé a revisar el plan.',409);
    if(before.pagos.length&&input.confirmar_correccion_pagos!==true)throw err('Confirmá que revisaste los pagos y comprobantes existentes');
    if(before.cuotas.some(q=>q.estado_manual))throw err('Esta operación tiene cuotas con estado manual y requiere conciliación',409);
    if(before.pagos.some(p=>!p.anulado&&String(p.fecha_hora).slice(0,10)<datos.fecha_inicio))throw err('La compra no puede ser posterior a un pago existente',409);
    const negocio=await getNegocio(first.negocio_id);
    const ids=datos.cuotas.filter(q=>q.id).map(q=>q.id);
    if(new Set(ids).size!==ids.length||ids.some(id=>!before.cuotas.some(q=>q.id===id)))throw err('Cuotas inválidas o de otra financiación');
    const eliminadas=before.cuotas.filter(q=>!ids.includes(q.id));
    if(eliminadas.some(q=>before.aplicaciones.some(a=>a.cuota_id===q.id)||q.fecha_saldada||calcularMora(q,negocio,todayAR()).acumulada>0))throw err('No se pueden quitar cuotas con pagos o mora; conservá esas cuotas en el plan',409);
    for(const q of datos.cuotas.filter(q=>q.id)){
      const old=before.cuotas.find(x=>x.id===q.id),abonado=old.monto_centavos-old.saldo_pendiente_centavos;
      if(q.monto_centavos<abonado)throw err('El importe corregido es menor al capital cobrado. Requiere conciliar el excedente.',409);
      if(old.fecha_saldada&&(q.monto_centavos!==old.monto_centavos||q.fecha_vencimiento!==old.fecha_vencimiento))throw err('Conservá las cuotas saldadas; corregí únicamente las pendientes',409);
    }
    // Originales y vínculos completos permanecen en auditoría; pagos/aplicaciones no se borran.
    for(const q of eliminadas)await db.prepare('DELETE FROM cuotas WHERE id=?').run(q.id);
    for(let i=0;i<datos.cuotas.length;i++){
      const q=datos.cuotas[i],old=before.cuotas.find(x=>x.id===q.id);
      if(old){
        const saldo=q.monto_centavos-old.monto_centavos+old.saldo_pendiente_centavos;
        let saldada=old.fecha_saldada,atraso=old.dias_atraso_al_pagar;
        if(saldo===0&&!saldada){
          const pagosCapital=before.aplicaciones.filter(a=>a.cuota_id===q.id&&a.capital_centavos>0).map(a=>before.pagos.find(p=>p.id===a.pago_id&&!p.anulado)).filter(Boolean);
          saldada=pagosCapital.map(p=>String(p.fecha_hora).slice(0,10)).sort().at(-1);
          if(!saldada)throw err('No se pudo conciliar la fecha del capital cobrado',409);
          atraso=Math.max(0,diffDays(saldada,old.fecha_vencimiento));
        }
        await db.prepare('UPDATE cuotas SET numero=?,monto_centavos=?,saldo_pendiente_centavos=?,fecha_vencimiento=?,mora_generada_centavos=?,fecha_saldada=?,dias_atraso_al_pagar=? WHERE id=?').run(i+1,q.monto_centavos,saldo,q.fecha_vencimiento,calcularMora(old,negocio,todayAR()).acumulada,saldada,atraso,q.id);
      }
      else await crearCuota({credito_id:id,numero:i+1,monto_centavos:q.monto_centavos,fecha_vencimiento:q.fecha_vencimiento});
    }
    await db.prepare('UPDATE creditos SET monto_total_centavos=?,entrega_inicial_centavos=?,saldo_financiado_centavos=?,fecha_inicio=?,producto_descripcion=?,condiciones=? WHERE id=?').run(datos.monto_total_centavos,datos.entrega_inicial_centavos,datos.monto_total_centavos-datos.entrega_inicial_centavos,datos.fecha_inicio,datos.producto_descripcion.trim(),datos.condiciones.trim(),id);
    await db.prepare('UPDATE ventas SET monto_total_centavos=?,entrega_inicial_centavos=?,fecha=? WHERE id=?').run(datos.monto_total_centavos,datos.entrega_inicial_centavos,datos.fecha_inicio,first.venta_id);
    if(datos.entrega_inicial_centavos!==before.credito.entrega_inicial_centavos){
      const entrega=before.pagos.find(p=>p.tipo==='entrega_inicial'&&!p.anulado);
      if(entrega){
        await db.prepare('UPDATE pagos SET anulado=1,motivo_anulacion=? WHERE id=?').run('Corrección de entrega: '+motivo.trim(),entrega.id);
        await db.prepare("UPDATE comprobantes SET estado='anulado',anulado_motivo=?,anulado_por=?,anulado_fecha=? WHERE pago_id=? AND estado<>'anulado'").run('Corrección de entrega: '+motivo.trim(),actor,nowAR(),entrega.id);
      }
      if(datos.entrega_inicial_centavos>0)await registrarEntregaInicial({credito_id:id,monto_centavos:datos.entrega_inicial_centavos,fecha_hora:entrega?.fecha_hora||`${datos.fecha_inicio}T12:00:00-03:00`,medio_pago:entrega?.medio_pago||'no_especificado',usuario_id:actor});
    }
    await recalcularEstadoCredito(id,negocio,todayAR());
    await auditar('credito',id,'corregir_financiacion',before,{solicitud_id,requestHash,datos,despues:await vistaFinanciacion(id)},actor,motivo.trim());
    return {id};
  });
}
