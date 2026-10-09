import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {auditar} from '../lib/audit.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const money=(v)=>{if(!Number.isSafeInteger(v)||v<0||v>1000000000000)throw error('Importe inválido');return v;};
const texto=(v)=>{if(typeof v!=='string'||!v.trim()||v.length>1000)throw error('Indicá nombre o concepto (hasta 1000 caracteres)');return v.trim();};
const request=(v)=>{if(typeof v!=='string'||!/^[a-f0-9-]{36}$/i.test(v))throw error('Solicitud inválida');return v;};
async function lock(){await db.query("SELECT pg_advisory_xact_lock(hashtextextended('zilky:caja',0))");}
async function config(cid){const c=await db.prepare('SELECT * FROM caja_config WHERE id=?').get(cid);if(!c)throw error('Caja no encontrada',404);return c;}
export async function listarCajas(){
 return db.prepare(`SELECT c.*,COALESCE((SELECT json_agg(json_build_object('id',n.id,'nombre',n.nombre)) FROM caja_negocios cn JOIN negocios n ON n.id=cn.negocio_id WHERE cn.caja_id=c.id),'[]') negocios FROM caja_config c ORDER BY c.created_at`).all();
}
export async function guardarCaja(cid,input,actor){return db.transaction(async()=>{
 await lock(); const before=cid?await config(cid):null;
 const nombre=texto(input.nombre);
 if(typeof input.activa!=='boolean'||typeof input.arqueo!=='boolean'||!['negocio','empleado'].includes(input.modalidad))throw error('Configuración inválida');
 const ns=input.negocios;
 if(!Array.isArray(ns)||(!ns.length&&input.activa)||ns.length>100||ns.some(x=>typeof x!=='string')||new Set(ns).size!==ns.length)throw error('Elegí uno o más negocios');
 if(before&&input.version!==before.version)throw error('La configuración cambió; actualizá la página',409);
 if(before&&(await db.prepare('SELECT id FROM caja_sesiones WHERE caja_id=? AND cierre IS NULL').get(cid)))throw error('Cerrá los períodos abiertos antes de cambiar la configuración',409);
 const found=await db.query('SELECT id,organizacion_id FROM negocios WHERE id=ANY($1::text[])',[ns]);
 if(found.rows.length!==ns.length||new Set(found.rows.map(n=>n.organizacion_id)).size>1)throw error('Los negocios deben existir y pertenecer a la misma organización');
 const assigned=await db.query('SELECT negocio_id FROM caja_negocios WHERE negocio_id=ANY($1::text[]) AND caja_id<>$2',[ns,cid||'']);
 if(assigned.rowCount)throw error('Un negocio ya pertenece a otra caja; retiralo de esa configuración primero',409);
 const newId=cid||id();
 if(before)await db.prepare('UPDATE caja_config SET nombre=?,activa=?,arqueo=?,modalidad=?,version=version+1 WHERE id=?').run(nombre,input.activa,input.arqueo,input.modalidad,newId);
 else await db.prepare('INSERT INTO caja_config(id,nombre,activa,arqueo,modalidad) VALUES(?,?,?,?,?)').run(newId,nombre,input.activa,input.arqueo,input.modalidad);
 const oldNs=before?await db.prepare('SELECT negocio_id FROM caja_negocios WHERE caja_id=?').all(newId):[];
 await db.prepare('DELETE FROM caja_negocios WHERE caja_id=?').run(newId);
 for(const n of ns)await db.prepare('INSERT INTO caja_negocios(negocio_id,caja_id) VALUES(?,?)').run(n,newId);
 await auditar('caja',newId,'configurar',{...before,negocios:oldNs},input,actor);
 return config(newId);
});}
export async function abrirCaja(cid,input,actor){return db.transaction(async()=>{
 await lock();const c=await config(cid);if(!c.activa)throw error('Caja desactivada');
 const inicial=money(input.inicial);const rid=request(input.solicitud_id);
 const responsable=input.responsable_id||actor;
 const u=await db.prepare('SELECT id FROM usuarios WHERE id=? AND activo=1').get(responsable);if(!u)throw error('Responsable inválido');
 if(c.modalidad==='empleado'&&responsable!==actor){
  const negocios=await db.prepare('SELECT negocio_id FROM caja_negocios WHERE caja_id=?').all(cid);
  const asignados=await db.prepare('SELECT negocio_id FROM usuario_negocio WHERE usuario_id=? AND activo=1').all(responsable);
  if(negocios.some(n=>!asignados.some(a=>a.negocio_id===n.negocio_id)))throw error('El responsable no tiene acceso a todos los negocios de esta caja');
 }
 const old=await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(rid);
 if(old){if(old.caja_id!==cid||old.responsable_id!==responsable||old.inicial!==inicial)throw error('Solicitud reutilizada',409);return old;}
 const clave=c.modalidad==='negocio'?'negocio':responsable;
 if(await db.prepare('SELECT id FROM caja_sesiones WHERE caja_id=? AND clave=? AND cierre IS NULL').get(cid,clave))throw error('Ya existe un período abierto',409);
 await db.prepare('INSERT INTO caja_sesiones(id,caja_id,responsable_id,clave,inicial,arqueo) VALUES(?,?,?,?,?,?)').run(rid,cid,responsable,clave,inicial,c.arqueo);
 await auditar('caja',cid,'abrir',null,{sesion_id:rid,inicial,responsable},actor);
 return db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(rid);
});}
async function sesion(sid){const s=await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(sid);if(!s)throw error('Período no encontrado',404);return s;}
export async function detalleCaja(cid){
 const c=await config(cid);
 const sesiones=await db.prepare(`SELECT s.*,u.nombre responsable FROM caja_sesiones s JOIN usuarios u ON u.id=s.responsable_id WHERE caja_id=? ORDER BY apertura DESC`).all(cid);
 const movimientos=await db.prepare(`SELECT a.*,n.nombre negocio FROM caja_asientos a JOIN negocios n ON n.id=a.negocio_id WHERE caja_id=? ORDER BY fecha DESC,id`).all(cid);
 for(const s of sesiones){s.medios={};for(const m of movimientos.filter(m=>m.sesion_id===s.id))s.medios[m.medio]=(s.medios[m.medio]||0)+m.monto;s.efectivo_esperado=s.cierre?s.esperado:s.inicial+(s.medios.efectivo||0);}
 return {...c,sesiones,movimientos};
}
export async function movimientoCaja(sid,input,actor){return db.transaction(async()=>{
 await lock();const s=await sesion(sid);const c=await config(s.caja_id);
 const rid=request(input.solicitud_id),monto=money(input.monto);if(!monto)throw error('El importe debe ser mayor a cero');
 if(!['ingreso','egreso'].includes(input.tipo)||!['efectivo','transferencia','tarjeta','otro'].includes(input.medio))throw error('Movimiento inválido');
 const concepto=texto(input.concepto),payload=JSON.stringify([sid,input.negocio_id,input.tipo,monto,input.medio,concepto,actor]);
 const old=await db.prepare('SELECT * FROM caja_asientos WHERE solicitud_id=?').get(rid);if(old){if(old.payload!==payload)throw error('Solicitud reutilizada',409);return old;}
 if(s.cierre||!c.activa)throw error('El período está cerrado o la caja desactivada',409);
 if(!await db.prepare('SELECT negocio_id FROM caja_negocios WHERE caja_id=? AND negocio_id=?').get(c.id,input.negocio_id))throw error('Negocio no incluido en esta caja');
 const aid=id();await db.prepare('INSERT INTO caja_asientos(id,caja_id,sesion_id,negocio_id,tipo,monto,medio,concepto,actor,solicitud_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(aid,c.id,sid,input.negocio_id,input.tipo,input.tipo==='egreso'?-monto:monto,input.medio,concepto,actor,rid,payload);
 await auditar('caja',c.id,'movimiento',null,{id:aid,...input},actor);
 return db.prepare('SELECT * FROM caja_asientos WHERE id=?').get(aid);
});}
export async function cerrarCaja(sid,input,actor){return db.transaction(async()=>{
 await lock();const s=await sesion(sid);
 const contado=s.arqueo?money(input.contado):null;
 const notas=typeof input.notas==='string'?input.notas.trim():'';if(notas.length>1000)throw error('Observación demasiado larga');
 if(s.cierre){if(s.contado!==contado||s.notas!==notas||s.cerrado_por!==actor)throw error('El cierre ya está guardado',409);return s;}
 const sum=await db.prepare("SELECT COALESCE(SUM(monto),0) total FROM caja_asientos WHERE sesion_id=? AND medio='efectivo'").get(sid);
 const esperado=s.inicial+sum.total;
 if(s.arqueo&&contado!==esperado&&!notas)throw error('Agregá una observación para la diferencia de arqueo');
 await db.prepare('UPDATE caja_sesiones SET cierre=now(),contado=?,esperado=?,diferencia=?,cerrado_por=?,notas=? WHERE id=?').run(contado,esperado,contado===null?null:contado-esperado,actor,notas,sid);
 await auditar('caja',s.caja_id,'cerrar',s,{sesion_id:sid,esperado,contado,notas},actor);
 return sesion(sid);
});}
// Called inside the payment transaction. No config means no cash module effects.
// Pending entries stay visible when no matching period is open; future openings do not silently absorb them.
export async function capturarPagoCaja(pago,actor,tipo='cobro'){
 if((await db.query("SELECT current_setting('zilky.correccion_financiacion',true) valor")).rows[0].valor==='1')return;
 await lock();
 let c;
 if(tipo==='anulacion'){
  const original=await db.prepare("SELECT caja_id FROM caja_asientos WHERE pago_id=? AND tipo='cobro'").get(pago.id);if(!original)return;
  c=await config(original.caja_id);
 }else c=await db.prepare('SELECT c.* FROM caja_config c JOIN caja_negocios n ON n.caja_id=c.id WHERE n.negocio_id=? AND c.activa').get(pago.negocio_id);
 if(!c)return;
 const clave=c.modalidad==='negocio'?'negocio':actor;
 const abierta=c.activa&&tipo==='cobro'?await db.prepare('SELECT id FROM caja_sesiones WHERE caja_id=? AND clave=? AND cierre IS NULL').get(c.id,clave):null;
 await db.prepare('INSERT INTO caja_asientos(id,caja_id,sesion_id,negocio_id,pago_id,tipo,monto,medio,concepto,actor) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pago_id,tipo) DO NOTHING').run(id(),c.id,abierta?.id||null,pago.negocio_id,pago.id,tipo,tipo==='anulacion'?-pago.monto_centavos:pago.monto_centavos,pago.medio_pago||'otro',tipo==='anulacion'?'Pago anulado: pendiente confirmar si se devolvió dinero':'Cobro registrado',actor||null);
}

export async function resolverPendiente(aid,input,actor){return db.transaction(async()=>{
 await lock();const a=await db.prepare('SELECT * FROM caja_asientos WHERE id=?').get(aid);if(!a)throw error('Movimiento no encontrado',404);
 const motivo=texto(input.motivo);
 if(typeof input.aplicar!=='boolean')throw error('Elegí cómo conciliar el movimiento');
 const resolucion=JSON.stringify({aplicar:input.aplicar,sesion_id:input.aplicar?input.sesion_id:null,motivo});
 if(a.resuelto){if(a.resolucion!==resolucion||a.resuelto_por!==actor)throw error('El movimiento ya fue conciliado',409);return a;}
 if(a.sesion_id)throw error('El movimiento ya pertenece a un período',409);
 let sid=null;
 if(input.aplicar&&a.tipo==='correccion')throw error('La corrección es documental: registrá un ingreso o egreso manual si hubo movimiento real y conciliá este aviso sin afectar el período');
 if(input.aplicar){const s=await sesion(input.sesion_id);if(s.caja_id!==a.caja_id||s.cierre)throw error('Elegí un período abierto de esta caja');sid=s.id;}
 await db.prepare('UPDATE caja_asientos SET sesion_id=?,resuelto=true,resuelto_por=?,resolucion=? WHERE id=?').run(sid,actor,resolucion,aid);
 await auditar('caja',a.caja_id,'conciliar',a,{...input,motivo},actor,motivo);
 return db.prepare('SELECT * FROM caja_asientos WHERE id=?').get(aid);
});}
export async function avisarCorreccionCaja(negocioId,creditoId,delta,actor){
 if(!delta)return;
 await lock();const c=await db.prepare('SELECT c.* FROM caja_config c JOIN caja_negocios n ON n.caja_id=c.id WHERE n.negocio_id=? AND c.activa').get(negocioId);if(!c)return;
 await db.prepare("INSERT INTO caja_asientos(id,caja_id,negocio_id,tipo,monto,medio,concepto,actor) VALUES(?,?,?,'correccion',?,'otro',?,?)").run(id(),c.id,negocioId,delta,'Corrección documental de entrega inicial ('+creditoId+'). No presume movimiento de dinero; revisar si requiere ajuste manual.',actor);
}
