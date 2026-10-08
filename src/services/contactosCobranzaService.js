import { db } from '../db/connection.js';
import { auditar } from '../lib/audit.js';
import { badRequest, dateISO, text } from '../lib/validation.js';
import { nowAR, todayAR } from '../lib/dates.js';
import { calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';

const conflicto = () => Object.assign(new Error('El seguimiento cambió. Actualizá la ficha.'), {status:409});
const solicitud = v => {
  if(typeof v!=='string'||!/^[a-zA-Z0-9-]{16,128}$/.test(v)) throw badRequest('Identificador de solicitud inválido');
  return v;
};
async function vinculo(clienteId,negocioId) {
  await db.lockClienteNegocio(clienteId,negocioId);
  if(!await db.prepare('SELECT 1 FROM cliente_negocio WHERE cliente_id=? AND negocio_id=?').get(clienteId,negocioId))
    throw Object.assign(new Error('Cliente no encontrado en este negocio'),{status:404});
}
export async function contactosCliente(clienteId,negocios=null) {
  const {rows}=await db.query(`SELECT r.*,cu.numero,cu.fecha_vencimiento AS vencimiento_actual,
    u.nombre AS autor FROM recordatorios r LEFT JOIN cuotas cu ON cu.id=r.cuota_id
    LEFT JOIN usuarios u ON u.id=r.created_by WHERE r.cliente_id=$1
    AND ($2::text[] IS NULL OR r.negocio_id=ANY($2::text[])) ORDER BY r.fecha_contacto,r.created_at`,[clienteId,negocios]);
  for(const r of rows) r.historial=(await db.prepare(`SELECT a.accion,a.fecha_hora,a.motivo,a.datos_anteriores,a.datos_nuevos,u.nombre AS autor
    FROM auditoria a LEFT JOIN usuarios u ON u.id=a.empleado WHERE a.entidad='contacto_cobranza' AND a.entidad_id=? ORDER BY a.fecha_hora,a.id`).all(r.id));
  return rows;
}
export async function cambiarModo({clienteId,negocioId,modo,anterior,nota,usuarioId}) {
  if(!['automatico','revisar','pausada'].includes(modo)) throw badRequest('Modo inválido');
  const motivo=text(nota,'motivo');
  return db.transaction(async()=>{
    await vinculo(clienteId,negocioId);
    const config=await db.prepare('SELECT * FROM cliente_negocio_cobranza WHERE cliente_id=? AND negocio_id=?').get(clienteId,negocioId);
    const actual=config?.modo||'revisar';
    if(actual!==anterior) throw conflicto();
    if(actual===modo)return {modo};
    await db.prepare(`INSERT INTO cliente_negocio_cobranza(cliente_id,negocio_id,modo) VALUES(?,?,?)
      ON CONFLICT(cliente_id,negocio_id) DO UPDATE SET modo=EXCLUDED.modo`).run(clienteId,negocioId,modo);
    await auditar('cobranza_modo',clienteId,'cambiar_modo',{negocio_id:negocioId,modo:actual},{negocio_id:negocioId,modo},usuarioId,motivo);
    return {modo};
  });
}
export async function guardarContacto({clienteId,negocioId,cuotaId,fecha,nota,solicitudId,usuarioId}) {
  const uid=solicitud(solicitudId),motivo=text(nota,'nota');
  dateISO(fecha,'próximo contacto');
  return db.transaction(async()=>{
    await vinculo(clienteId,negocioId);
    const previo=await db.prepare('SELECT * FROM recordatorios WHERE id=?').get(uid);
    if(previo) {
      if(previo.cliente_id!==clienteId||previo.negocio_id!==negocioId||previo.cuota_id!==cuotaId||previo.fecha_contacto!==fecha||previo.nota!==motivo)throw conflicto();
      return previo;
    }
    if(fecha<todayAR())throw badRequest('El próximo contacto no puede estar en el pasado');
    const cuota=await db.prepare(`SELECT cu.*,cr.cliente_id,cr.negocio_id FROM cuotas cu JOIN creditos cr ON cr.id=cu.credito_id
      WHERE cu.id=? AND cr.cliente_id=? AND cr.negocio_id=?`).get(cuotaId,clienteId,negocioId);
    if(!cuota)throw Object.assign(new Error('Cuota no encontrada en este cliente y negocio'),{status:404});
    const negocio=await getNegocio(negocioId);
    if(cuota.estado_manual||(cuota.saldo_pendiente_centavos<=0&&calcularMora(cuota,negocio,todayAR()).pendiente<=0))throw badRequest('La cuota no tiene deuda pendiente');
    if(await db.prepare("SELECT 1 FROM recordatorios WHERE cuota_id=? AND estado='pendiente'").get(cuotaId))throw Object.assign(new Error('La cuota ya tiene un contacto pendiente. Reprogramalo desde su historial.'),{status:409});
    await db.prepare(`INSERT INTO recordatorios(id,cliente_id,negocio_id,credito_id,cuota_id,tipo,fecha_contacto,fecha_vencimiento_real,nota,created_by)
      VALUES(?,?,?,?,?,'seguimiento',?,?,?,?)`).run(uid,clienteId,negocioId,cuota.credito_id,cuotaId,fecha,cuota.fecha_vencimiento,motivo,usuarioId);
    const nuevo=await db.prepare('SELECT * FROM recordatorios WHERE id=?').get(uid);
    await auditar('contacto_cobranza',uid,'programar',null,nuevo,usuarioId,motivo);
    return nuevo;
  });
}
export async function actualizarContacto({clienteId,negocioId,contactoId,accion,fecha,nota,version,usuarioId}) {
  if(!['reprogramar','realizado','cancelar'].includes(accion))throw badRequest('Acción inválida');
  const motivo=text(nota,'resultado o motivo');
  if(accion==='reprogramar') {dateISO(fecha,'próximo contacto');if(fecha<todayAR())throw badRequest('El próximo contacto no puede estar en el pasado');}
  return db.transaction(async()=>{
    await vinculo(clienteId,negocioId);
    const r=await db.prepare('SELECT * FROM recordatorios WHERE id=? AND cliente_id=? AND negocio_id=?').get(contactoId,clienteId,negocioId);
    if(!r)throw Object.assign(new Error('Contacto no encontrado'),{status:404});
    if(r.estado!=='pendiente'||version!==JSON.stringify([r.fecha_contacto,r.reprogramado_fecha,r.nota]))throw conflicto();
    if(accion==='reprogramar')await db.prepare('UPDATE recordatorios SET fecha_contacto=?,nueva_fecha_contacto=?,reprogramado_fecha=?,reprogramado_por=?,nota=? WHERE id=?').run(fecha,fecha,nowAR(),usuarioId,motivo,r.id);
    else await db.prepare('UPDATE recordatorios SET estado=?,omitido_fecha=?,omitido_por=?,omitido_motivo=? WHERE id=?').run(accion==='realizado'?'realizado':'cancelado',nowAR(),usuarioId,motivo,r.id);
    const nuevo=await db.prepare('SELECT * FROM recordatorios WHERE id=?').get(r.id);
    await auditar('contacto_cobranza',r.id,accion,r,nuevo,usuarioId,motivo);
    return nuevo;
  });
}
// Se ejecuta dentro de la transacción financiera y con el mismo bloqueo cliente/negocio.
export async function cancelarContactosSaldados(creditoId,negocio,today,usuarioId) {
  const pendientes=await db.prepare(`SELECT cu.* FROM recordatorios r JOIN cuotas cu ON cu.id=r.cuota_id
    WHERE r.credito_id=? AND r.estado='pendiente'`).all(creditoId);
  for(const c of pendientes) {
    if(!c.estado_manual&&(c.saldo_pendiente_centavos>0||calcularMora(c,negocio,today).pendiente>0))continue;
    const rs=await db.prepare("SELECT * FROM recordatorios WHERE cuota_id=? AND estado='pendiente'").all(c.id);
    for(const r of rs) {
      await db.prepare("UPDATE recordatorios SET estado='cancelado_pago',omitido_fecha=?,omitido_por=?,omitido_motivo=? WHERE id=?")
        .run(nowAR(),usuarioId,'Cuota saldada',r.id);
      await auditar('contacto_cobranza',r.id,'cancelado_pago',r,{...r,estado:'cancelado_pago'},usuarioId,'Cuota saldada');
    }
  }
}
