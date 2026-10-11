import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {todayAR} from '../lib/dates.js';
import {auditar} from '../lib/audit.js';
import {dateISO,integer,text} from '../lib/validation.js';
import {huella,fail,solicitudId} from '../lib/solicitud.js';
import {vendedorEnNegocio} from './comisionReglasService.js';
export const lockComisiones=n=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['comisiones:'+n]);
export async function fechaContable(n,u,fecha){
 const last=await db.prepare('SELECT max(mes) mes FROM comision_cierres WHERE negocio_id=? AND usuario_id=?').get(n,u);
 if(last.mes&&fecha.slice(0,7)<=last.mes){const d=new Date(last.mes+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);return [todayAR(),d.toISOString().slice(0,10)].sort().at(-1);}
 return fecha;
}
export async function generarComision(a,importe,fecha,motivo,key){
 await lockComisiones(a.negocio_id);const contable=await fechaContable(a.negocio_id,a.usuario_id,fecha);
 await db.prepare('INSERT INTO comision_generaciones(id,acuerdo_id,fecha,importe_centavos,motivo) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(key,a.id,contable,importe,motivo);
}
export async function ajustarComision(n,b,actor){
 solicitudId(b.solicitud_id);integer(b.importe_centavos,'ajuste',{min:-2147483647});if(!b.importe_centavos)throw fail('El ajuste no puede ser cero');const motivo=text(b.motivo,'motivo',1000);
 return db.transaction(async()=>{await lockComisiones(n);
 const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE id=? AND negocio_id=?').get(b.acuerdo_id,n);if(!a)throw fail('Acuerdo no encontrado',404);
 const old=await db.prepare('SELECT * FROM comision_ajustes WHERE id=?').get(b.solicitud_id);
 if(old){if(old.acuerdo_id!==a.id||old.importe_centavos!==b.importe_centavos||old.motivo!==motivo||old.autor!==actor)throw fail('Solicitud reutilizada',409);return old;}
 const fecha=await fechaContable(n,a.usuario_id,todayAR());
 await db.prepare('INSERT INTO comision_ajustes(id,acuerdo_id,importe_centavos,motivo,fecha,autor) VALUES(?,?,?,?,?,?)').run(b.solicitud_id,a.id,b.importe_centavos,motivo,fecha,actor);
 await db.prepare("INSERT INTO comision_eventos(id,acuerdo_id,fecha,importe_centavos,motivo,tipo,fecha_origen) VALUES(?,?,?,?,?,'ajuste',?)").run(id(),a.id,fecha,b.importe_centavos,motivo,todayAR());
 await generarComision(a,b.importe_centavos,fecha,motivo,'ajuste:'+b.solicitud_id);
 await auditar('comision_ajuste',b.solicitud_id,'registrar',null,b,actor,motivo);return {id:b.solicitud_id};});
}
export function rangoMes(mes){if(typeof mes!=='string'||!/^\d{4}-\d{2}$/.test(mes))throw fail('Mes inválido');dateISO(mes+'-01');const dt=new Date(mes+'-01T12:00:00Z');dt.setUTCMonth(dt.getUTCMonth()+1);dt.setUTCDate(0);return {desde:mes+'-01',hasta:dt.toISOString().slice(0,10)};}
export async function vistaCierre(n,u,mes){
 const {desde,hasta}=rangoMes(mes);await vendedorEnNegocio(n,u);
 const eventos=await db.prepare(`SELECT e.id,e.fecha,e.importe_centavos,e.motivo,e.tipo,a.venta_id,a.id acuerdo_id FROM comision_eventos e JOIN comision_acuerdos a ON a.id=e.acuerdo_id WHERE a.negocio_id=? AND a.usuario_id=? AND e.fecha<=? ORDER BY e.fecha,e.id`).all(n,u,hasta);
 const generados=await db.prepare(`SELECT g.* FROM comision_generaciones g JOIN comision_acuerdos a ON a.id=g.acuerdo_id WHERE a.negocio_id=? AND a.usuario_id=? AND g.fecha<=? ORDER BY g.fecha,g.id`).all(n,u,hasta);
 const pagos=await db.prepare('SELECT id,COALESCE(fecha_contable,fecha) fecha,importe_centavos,nota FROM comision_liquidaciones WHERE negocio_id=? AND usuario_id=? AND COALESCE(fecha_contable,fecha)<=? ORDER BY COALESCE(fecha_contable,fecha),id').all(n,u,hasta);
 const sum=rows=>rows.reduce((s,x)=>s+Number(x.importe_centavos),0),enMes=rows=>rows.filter(x=>x.fecha>=desde);
 const acuerdos=await db.prepare('SELECT a.id,v.fecha,a.detalle FROM comision_acuerdos a JOIN ventas v ON v.id=a.venta_id WHERE a.negocio_id=? AND a.usuario_id=? AND EXISTS(SELECT 1 FROM comision_eventos e WHERE e.acuerdo_id=a.id AND e.fecha>=? AND e.fecha<=?) ORDER BY v.fecha,a.id').all(n,u,desde,hasta);
 const productos=acuerdos.flatMap(a=>a.detalle.map(x=>({fecha:a.fecha,descripcion:x.descripcion||'Producto',cantidad:x.cantidad,comision_centavos:x.comision_centavos??(x.tipo==='fijo'?x.valor*x.cantidad:Math.round(x.precio_unitario_centavos*x.cantidad*x.valor/10000))})));
 const resumen={productos,mes,usuario_id:u,generada:sum(enMes(generados)),liquidable:sum(enMes(eventos)),pagada:sum(enMes(pagos)),saldo_anterior:sum(eventos.filter(x=>x.fecha<desde))-sum(pagos.filter(x=>x.fecha<desde)),saldo_pendiente:sum(eventos)-sum(pagos),pendiente_cobro:sum(generados)-sum(eventos),eventos:enMes(eventos),pagos:enMes(pagos)};
 return {resumen,version:huella({resumen,eventos,generados,pagos})};
}
export async function aprobarCierre(n,b,actor){
 const {hasta}=rangoMes(b.mes);if(hasta>=todayAR())throw fail('El cierre se aprueba después del último día del mes');
 return db.transaction(async()=>{await lockComisiones(n);
 const old=await db.prepare('SELECT * FROM comision_cierres WHERE negocio_id=? AND usuario_id=? AND mes=?').get(n,b.usuario_id,b.mes);
 if(old){if(old.version!==b.version)throw fail('Este mes ya fue aprobado con otra revisión',409);return old;}
 if(await db.prepare('SELECT 1 FROM comision_cierres WHERE negocio_id=? AND usuario_id=? AND mes>?').get(n,b.usuario_id,b.mes))throw fail('Ya hay un cierre posterior. No se pueden insertar cierres anteriores',409);
 const v=await vistaCierre(n,b.usuario_id,b.mes);if(v.version!==b.version)throw fail('Cambió la liquidación. Volvé a revisar antes de aprobar',409);
 const c={id:id(),negocio_id:n,usuario_id:b.usuario_id,mes:b.mes,resumen:v.resumen,version:v.version};
 await db.prepare("INSERT INTO comision_cierres(id,negocio_id,usuario_id,mes,estado,resumen,version,autor) VALUES(?,?,?,?,'aprobada',?::jsonb,?,?)").run(c.id,n,c.usuario_id,c.mes,JSON.stringify(c.resumen),c.version,actor);
 await auditar('comision_cierre',c.id,'aprobar',null,c,actor);return c;});
}
export async function publicarCierre(n,c,actor){return db.transaction(async()=>{await lockComisiones(n);
 const old=await db.prepare('SELECT * FROM comision_cierres WHERE id=? AND negocio_id=?').get(c,n);if(!old)throw fail('Liquidación no encontrada',404);if(old.estado==='publicada')return old;
 await db.prepare("UPDATE comision_cierres SET estado='publicada',publicado_at=now() WHERE id=?").run(c);
 await auditar('comision_cierre',c,'publicar',{estado:old.estado},{estado:'publicada'},actor);return {...old,estado:'publicada'};
 });}
export async function cierresVisibles(n,u,{admin=false,historial=false,detalle=false,total=true}={}){
 const rows=await db.prepare(`SELECT c.*,u.nombre FROM comision_cierres c JOIN usuarios u ON u.id=c.usuario_id WHERE c.negocio_id=? ${u?'AND c.usuario_id=?':''} ${admin?'':"AND c.estado='publicada'"} ORDER BY c.mes DESC,c.creado_at DESC`).all(...[n,...(u?[u]:[])]);
 const visibles=admin||historial?rows:rows.slice(0,1);
 return Promise.all(visibles.map(async c=>{
  const paid=await db.prepare('SELECT COALESCE(sum(importe_centavos),0) importe FROM comision_liquidaciones WHERE cierre_id=?').get(c.id);
  if(admin)return {...c,pagado_cierre:Number(paid.importe)};
  const r={id:c.id,mes:c.mes,estado:c.estado,publicado_at:c.publicado_at};
  // Explicit allow-list: closed-only employees never receive live totals, other sellers or per-product rates.
  if(total)Object.assign(r,{liquidable:c.resumen.liquidable,saldo_pendiente:c.resumen.saldo_pendiente,pagado_cierre:Number(paid.importe)});
  if(detalle){r.eventos=c.resumen.eventos.map(e=>({fecha:e.fecha,importe_centavos:e.importe_centavos,motivo:e.motivo}));r.productos=c.resumen.productos||[];}return r;
 }));
}
