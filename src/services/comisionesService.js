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
export function calcularComision(items) {
 let total=0;for(const x of items){const importe=x.tipo==='porcentaje'?Math.round(x.precio_unitario_centavos*x.cantidad*x.valor/10000):x.cantidad*x.valor;integer(importe,'importe de comisión');total+=importe;}
 integer(total,'total comisión');return total;
}
// Called inside sale transaction. Rules and beneficiary are frozen, never inferred from a free-text employee name.
export async function acordarComision(ventaId,actor) {
 const v=await db.prepare('SELECT * FROM ventas WHERE id=?').get(ventaId),cfg=await configuracionComision(v.negocio_id);
 if(!cfg.activa||!actor)return;
 const items=await db.prepare(`SELECT d.producto_id,d.descripcion,d.cantidad,d.precio_unitario_centavos,p.tipo,p.valor FROM venta_detalle d JOIN comision_producto p ON p.producto_id=d.producto_id WHERE d.venta_id=? ORDER BY d.id`).all(ventaId);
 const total=calcularComision(items);if(!total)return;
 const cr=await db.prepare('SELECT * FROM creditos WHERE venta_id=?').get(ventaId);
 const qs=await db.prepare('SELECT COALESCE(sum(monto_centavos),0) AS monto FROM cuotas WHERE credito_id=?').get(cr.id);
 const base=Number(qs.monto)+cr.entrega_inicial_centavos;
 if(!Number.isSafeInteger(base)||base<=0)throw fail('Base de comisión inválida');
 await db.prepare('INSERT INTO comision_acuerdos(id,venta_id,negocio_id,usuario_id,momento,base_centavos,total_centavos,detalle) VALUES(?,?,?,?,?,?,?,?::jsonb)').run(id(),ventaId,v.negocio_id,actor,cfg.momento,base,total,JSON.stringify(items));
 await sincronizarComision(cr.id,v.fecha,'Venta registrada');
}
// Appends deltas; a voided payment reverses its earned commission without erasing history or settlements.
export async function sincronizarComision(creditoId,fecha=todayAR(),motivo='Actualización de cobro') {
 const a=await db.prepare('SELECT a.* FROM comision_acuerdos a JOIN creditos c ON c.venta_id=a.venta_id WHERE c.id=? FOR UPDATE OF a').get(creditoId);if(!a)return;
 let objetivo=Number(a.total_centavos);
 if(a.momento==='cobro'){
  const row=await db.prepare(`SELECT COALESCE(sum(CASE WHEN p.tipo='entrega_inicial' THEN p.monto_centavos ELSE COALESCE((SELECT sum(pa.capital_centavos) FROM pago_aplicaciones pa WHERE pa.pago_id=p.id),0) END),0) AS capital FROM pagos p WHERE p.credito_id=? AND p.anulado=0`).get(creditoId);
  objetivo=Math.round(Number(a.total_centavos)*Math.min(Number(row.capital),Number(a.base_centavos))/Number(a.base_centavos));
 }
 const old=await db.prepare('SELECT COALESCE(sum(importe_centavos),0) AS total FROM comision_eventos WHERE acuerdo_id=?').get(a.id);
 const delta=objetivo-Number(old.total);if(delta)await db.prepare('INSERT INTO comision_eventos(id,acuerdo_id,fecha,importe_centavos,motivo) VALUES(?,?,?,?,?)').run(id(),a.id,fecha,delta,motivo);
}
export async function resumenComisiones(n,usuario,desde,hasta) {
 dateISO(desde);dateISO(hasta);if(desde>hasta)throw fail('Rango inválido');
 const params=[n],filter=usuario?' AND a.usuario_id=?':'';if(usuario)params.push(usuario);
 const eventos=await db.prepare(`SELECT e.*,a.usuario_id,u.nombre,a.venta_id,a.momento FROM comision_eventos e JOIN comision_acuerdos a ON a.id=e.acuerdo_id JOIN usuarios u ON u.id=a.usuario_id WHERE a.negocio_id=?${filter} ORDER BY e.fecha DESC,e.creado_at DESC`).all(...params);
 const pagos=await db.prepare(`SELECT l.*,u.nombre FROM comision_liquidaciones l JOIN usuarios u ON u.id=l.usuario_id WHERE l.negocio_id=?${usuario?' AND l.usuario_id=?':''} ORDER BY l.fecha DESC,l.creado_at DESC`).all(...params);
 const balances={};for(const x of eventos){const b=balances[x.usuario_id]??={usuario_id:x.usuario_id,nombre:x.nombre,generado:0,pagado:0};b.generado+=Number(x.importe_centavos);}for(const x of pagos){const b=balances[x.usuario_id]??={usuario_id:x.usuario_id,nombre:x.nombre,generado:0,pagado:0};b.pagado+=Number(x.importe_centavos);}
 return {eventos:eventos.filter(x=>x.fecha>=desde&&x.fecha<=hasta),pagos:pagos.filter(x=>x.fecha>=desde&&x.fecha<=hasta),balances:Object.values(balances).map(b=>({...b,pendiente:b.generado-b.pagado})),desde,hasta};
}
export async function liquidarComision(n,b,actor) {
 integer(b.importe_centavos,'importe',{min:1});dateISO(b.fecha);if(b.fecha>todayAR())throw fail('No registrar pagos futuros');
 if(typeof b.solicitud_id!=='string'||! /^[a-f0-9-]{36}$/i.test(b.solicitud_id)||typeof b.usuario_id!=='string'||typeof b.nota!=='string'||b.nota.length>1000)throw fail('Datos inválidos');
 return db.transaction(async()=>{
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['comision-liquidacion:'+n+':'+b.usuario_id]);
 const old=await db.prepare('SELECT * FROM comision_liquidaciones WHERE id=?').get(b.solicitud_id);
 if(old){if(old.negocio_id!==n||old.usuario_id!==b.usuario_id||Number(old.importe_centavos)!==b.importe_centavos||old.fecha!==b.fecha||old.nota!==b.nota||old.autor!==actor)throw fail('Solicitud reutilizada',409);return old;}
 const r=await resumenComisiones(n,b.usuario_id,'0001-01-01','9999-12-31'),balance=r.balances[0];
 if(!balance||b.importe_centavos>balance.pendiente)throw fail('El importe supera la comisión pendiente',409);
 await db.prepare('INSERT INTO comision_liquidaciones(id,negocio_id,usuario_id,importe_centavos,fecha,nota,autor) VALUES(?,?,?,?,?,?,?)').run(b.solicitud_id,n,b.usuario_id,b.importe_centavos,b.fecha,b.nota,actor);
 await auditar('comision_liquidacion',b.solicitud_id,'registrar',null,b,actor);return {id:b.solicitud_id};});
}
