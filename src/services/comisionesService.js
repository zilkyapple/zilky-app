import {resolverRegla} from './comisionReglasService.js';
import {lockComisiones,fechaContable,generarComision} from './comisionCierresService.js';
import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {todayAR} from '../lib/dates.js';
import {integer,dateISO} from '../lib/validation.js';
import {auditar} from '../lib/audit.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function configuracionComision(n) {
 if(!await db.prepare('SELECT id FROM negocios WHERE id=?').get(n))throw fail('Elegí un negocio',404);
 return await db.prepare('SELECT * FROM comision_config WHERE negocio_id=?').get(n)||{negocio_id:n,activa:false,visible_empleado:false,momento:'venta'};
}
export async function configurarComision(n,b,actor) {
 if(typeof b.activa!=='boolean'||typeof b.visible_empleado!=='boolean'||!['venta','cobro'].includes(b.momento))throw fail('Configuración inválida');
 return db.transaction(async()=>{const old=await configuracionComision(n);
 await db.prepare(`INSERT INTO comision_config(negocio_id,activa,visible_empleado,momento) VALUES(?,?,?,?) ON CONFLICT(negocio_id) DO UPDATE SET activa=excluded.activa,visible_empleado=excluded.visible_empleado,momento=excluded.momento`).run(n,b.activa,b.visible_empleado,b.momento);
 await auditar('comision_config',n,'configurar',old,b,actor);return configuracionComision(n);});
}
export async function configurarProductoComision(n,p,b,actor) {
 if(!['fijo','porcentaje'].includes(b.tipo))throw fail('Tipo inválido');integer(b.valor,'comisión',{min:0,max:b.tipo==='porcentaje'?10000:1000000000});
 return db.transaction(async()=>{const product=await db.prepare('SELECT * FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(p,n);if(!product)throw fail('Producto no encontrado',404);
 const old=await db.prepare('SELECT * FROM comision_producto WHERE producto_id=?').get(p);
 await db.prepare('INSERT INTO comision_producto(producto_id,tipo,valor) VALUES(?,?,?) ON CONFLICT(producto_id) DO UPDATE SET tipo=excluded.tipo,valor=excluded.valor').run(p,b.tipo,b.valor);
 await auditar('comision_producto',p,'configurar',old,b,actor);return b;});
}
const ratio=(a,b,c)=>Number((BigInt(a)*BigInt(b)*2n+BigInt(c))/(2n*BigInt(c)));
export function calcularComision(items) {
 let total=0;for(const x of items){const importe=x.tipo==='porcentaje'?ratio(x.precio_unitario_centavos*x.cantidad,x.valor,10000):x.cantidad*x.valor;integer(importe,'importe de comisión');total+=importe;}
 integer(total,'total comisión');return total;
}
// Called inside sale transaction. Rules and beneficiary are frozen, never inferred from a free-text employee name.
export async function acordarComision(ventaId,actor) {
 const v=await db.prepare('SELECT * FROM ventas WHERE id=?').get(ventaId),cfg=await configuracionComision(v.negocio_id);
 if(!cfg.activa||!actor)return;
 await lockComisiones(v.negocio_id);
 const lineas=await db.prepare('SELECT * FROM venta_detalle WHERE venta_id=? ORDER BY id').all(ventaId),items=[];
 for(const d of lineas){
   const regla=d.producto_id?await resolverRegla(v.negocio_id,d.producto_id,actor,d.componentes.length?'combo':v.canal):{tipo:'fijo',valor:0};
   // A combo is a single commercial line; its components move stock, never accrue again.
   items.push({...d,...regla,comision_centavos:calcularComision([{...d,...regla}])});
 }
 const total=calcularComision(items);if(!total)return;
 const cr=await db.prepare('SELECT * FROM creditos WHERE venta_id=?').get(ventaId);
 const qs=await db.prepare('SELECT COALESCE(sum(monto_centavos),0) AS monto FROM cuotas WHERE credito_id=?').get(cr.id);
 const base=Number(qs.monto)+cr.entrega_inicial_centavos;
 if(!Number.isSafeInteger(base)||base<=0)throw fail('Base de comisión inválida');
 const acuerdoId=id();
 await db.prepare('INSERT INTO comision_acuerdos(id,venta_id,negocio_id,usuario_id,momento,base_centavos,total_centavos,detalle) VALUES(?,?,?,?,?,?,?,?::jsonb)').run(acuerdoId,ventaId,v.negocio_id,actor,cfg.momento,base,total,JSON.stringify(items));
 await generarComision({id:acuerdoId,negocio_id:v.negocio_id,usuario_id:actor},total,v.fecha,'Venta registrada','alta:'+acuerdoId);
 await sincronizarComision(cr.id,v.fecha,'Venta registrada');
}
// Appends deltas; a voided payment reverses its earned commission without erasing history or settlements.
export async function sincronizarComision(creditoId,fecha=todayAR(),motivo='Actualización de cobro') {
 const scope=await db.prepare('SELECT negocio_id FROM creditos WHERE id=?').get(creditoId);if(!scope)return;await lockComisiones(scope.negocio_id);
 const a=await db.prepare('SELECT a.* FROM comision_acuerdos a JOIN creditos c ON c.venta_id=a.venta_id WHERE c.id=? FOR UPDATE OF a').get(creditoId);if(!a)return;
 const devs=await db.prepare('SELECT detalle,importe_centavos FROM venta_devoluciones WHERE venta_id=?').all(a.venta_id);
 const devComision=devs.reduce((sum,d)=>sum+Number(d.detalle.comision_revertida_centavos||0),0);
 const devBase=devs.reduce((sum,d)=>sum+Number(d.detalle.base_reducida_centavos||0),0);
 const total=Math.max(0,Number(a.total_centavos)-devComision),base=Math.max(0,Number(a.base_centavos)-devBase);
 let objetivo=total;
 if(a.momento==='cobro'){
  const row=await db.prepare(`SELECT COALESCE(sum(CASE WHEN p.tipo='entrega_inicial' THEN p.monto_centavos ELSE COALESCE((SELECT sum(pa.capital_centavos) FROM pago_aplicaciones pa WHERE pa.pago_id=p.id),0) END),0) AS capital FROM pagos p WHERE p.credito_id=? AND p.anulado=0`).get(creditoId);
  objetivo=base?ratio(total,Math.min(Number(row.capital),base),base):0;
 }
 const old=await db.prepare("SELECT COALESCE(sum(importe_centavos),0) AS total FROM comision_eventos WHERE acuerdo_id=? AND tipo='devengo'").get(a.id);
 const delta=objetivo-Number(old.total);if(delta)await db.prepare('INSERT INTO comision_eventos(id,acuerdo_id,fecha,importe_centavos,motivo,fecha_origen) VALUES(?,?,?,?,?,?)').run(id(),a.id,await fechaContable(a.negocio_id,a.usuario_id,fecha),delta,motivo,fecha);
}
export async function resumenComisiones(n,usuario,desde,hasta) {
 dateISO(desde);dateISO(hasta);if(desde>hasta)throw fail('Rango inválido');
 const params=[n],filter=usuario?' AND a.usuario_id=?':'';if(usuario)params.push(usuario);
 const eventos=await db.prepare(`SELECT e.*,a.usuario_id,u.nombre,a.venta_id,a.momento FROM comision_eventos e JOIN comision_acuerdos a ON a.id=e.acuerdo_id JOIN usuarios u ON u.id=a.usuario_id WHERE a.negocio_id=?${filter} ORDER BY e.fecha DESC,e.creado_at DESC`).all(...params);
 const pagos=await db.prepare(`SELECT l.*,u.nombre FROM comision_liquidaciones l JOIN usuarios u ON u.id=l.usuario_id WHERE l.negocio_id=?${usuario?' AND l.usuario_id=?':''} ORDER BY l.fecha DESC,l.creado_at DESC`).all(...params);
 const balances={};for(const x of eventos){const b=balances[x.usuario_id]??={usuario_id:x.usuario_id,nombre:x.nombre,generado:0,pagado:0};b.generado+=Number(x.importe_centavos);}for(const x of pagos){const b=balances[x.usuario_id]??={usuario_id:x.usuario_id,nombre:x.nombre,generado:0,pagado:0};b.pagado+=Number(x.importe_centavos);}
 const acuerdos=await db.prepare(`SELECT a.*,v.fecha,v.canal FROM comision_acuerdos a JOIN ventas v ON v.id=a.venta_id WHERE a.negocio_id=?${filter} ORDER BY v.fecha DESC`).all(...params);
 const generaciones=await db.prepare(`SELECT g.*,a.usuario_id FROM comision_generaciones g JOIN comision_acuerdos a ON a.id=g.acuerdo_id WHERE a.negocio_id=?${filter} ORDER BY g.fecha DESC`).all(...params);
 for(const x of generaciones){const b=balances[x.usuario_id]??={usuario_id:x.usuario_id,nombre:'Vendedor',generado:0,pagado:0};b.comision_generada=(b.comision_generada||0)+Number(x.importe_centavos);}
 const enRango=x=>x.fecha>=desde&&x.fecha<=hasta;
 const totales={generada:generaciones.filter(enRango).reduce((s,x)=>s+x.importe_centavos,0),liquidable:eventos.filter(enRango).reduce((s,x)=>s+x.importe_centavos,0),pagada:pagos.filter(x=>enRango({fecha:x.fecha_contable||x.fecha})).reduce((s,x)=>s+x.importe_centavos,0),operaciones:new Set(generaciones.filter(x=>enRango(x)&&x.id.startsWith('alta:')).map(x=>x.acuerdo_id)).size};
 const evolucion={};for(const x of generaciones){const mes=x.fecha.slice(0,7);(evolucion[mes]??={mes,generada:0,liquidable:0,pagada:0}).generada+=x.importe_centavos;}for(const x of eventos){const mes=x.fecha.slice(0,7);(evolucion[mes]??={mes,generada:0,liquidable:0,pagada:0}).liquidable+=x.importe_centavos;}for(const x of pagos){const mes=(x.fecha_contable||x.fecha).slice(0,7);(evolucion[mes]??={mes,generada:0,liquidable:0,pagada:0}).pagada+=x.importe_centavos;}
 return {totales,acuerdos:acuerdos.map(a=>({...a,liquidable:eventos.filter(e=>e.acuerdo_id===a.id).reduce((s,e)=>s+e.importe_centavos,0),generada:generaciones.filter(g=>g.acuerdo_id===a.id).reduce((s,g)=>s+g.importe_centavos,0)})),evolucion:Object.values(evolucion).sort((a,b)=>b.mes.localeCompare(a.mes)).slice(0,12),eventos:eventos.filter(x=>x.fecha>=desde&&x.fecha<=hasta),pagos:pagos.filter(x=>(x.fecha_contable||x.fecha)>=desde&&(x.fecha_contable||x.fecha)<=hasta),balances:Object.values(balances).map(b=>({...b,liquidable:b.generado,pendiente_cobro:(b.comision_generada||0)-b.generado,pendiente:b.generado-b.pagado})),desde,hasta};
}
export async function liquidarComision(n,b,actor) {
 integer(b.importe_centavos,'importe',{min:1});dateISO(b.fecha);if(b.fecha>todayAR())throw fail('No registrar pagos futuros');
 if(typeof b.solicitud_id!=='string'||! /^[a-f0-9-]{36}$/i.test(b.solicitud_id)||typeof b.usuario_id!=='string'||typeof b.nota!=='string'||b.nota.length>1000)throw fail('Datos inválidos');
 return db.transaction(async()=>{
 await lockComisiones(n);
 const old=await db.prepare('SELECT * FROM comision_liquidaciones WHERE id=?').get(b.solicitud_id);
 if(old){if(old.negocio_id!==n||old.usuario_id!==b.usuario_id||Number(old.importe_centavos)!==b.importe_centavos||old.fecha!==b.fecha||old.nota!==b.nota||old.autor!==actor||(old.cierre_id||null)!==(b.cierre_id||null))throw fail('Solicitud reutilizada',409);return old;}
 const r=await resumenComisiones(n,b.usuario_id,'0001-01-01','9999-12-31'),balance=r.balances[0];
 if(!balance||b.importe_centavos>balance.pendiente)throw fail('El importe supera la comisión pendiente',409);
 if(b.cierre_id){
 const c=await db.prepare('SELECT * FROM comision_cierres WHERE id=? AND negocio_id=? AND usuario_id=?').get(b.cierre_id,n,b.usuario_id);if(!c)throw fail('Liquidación no encontrada',404);
 const paid=await db.prepare('SELECT COALESCE(sum(importe_centavos),0) total FROM comision_liquidaciones WHERE cierre_id=?').get(c.id);
 if(b.importe_centavos>Math.max(0,c.resumen.saldo_pendiente)-Number(paid.total))throw fail('El pago supera el saldo de la liquidación',409);
 }
 await db.prepare('INSERT INTO comision_liquidaciones(id,negocio_id,usuario_id,importe_centavos,fecha,nota,autor,cierre_id,fecha_contable) VALUES(?,?,?,?,?,?,?,?,?)').run(b.solicitud_id,n,b.usuario_id,b.importe_centavos,b.fecha,b.nota,actor,b.cierre_id||null,await fechaContable(n,b.usuario_id,b.fecha));
 await auditar('comision_liquidacion',b.solicitud_id,'registrar',null,b,actor);return {id:b.solicitud_id};});
}
