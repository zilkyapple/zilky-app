import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {todayAR} from '../lib/dates.js';
import {integer,text} from '../lib/validation.js';
import {fail,solicitudId,huella} from '../lib/solicitud.js';
import {calcularMora} from '../lib/mora.js';
import {auditar} from '../lib/audit.js';
import {sumarSaldoFavor} from '../repositories/pagos.js';
import {sincronizarComision} from './comisionesService.js';
import {generarComision,lockComisiones} from './comisionCierresService.js';
import {recalcularEstadoCredito} from './pagosService.js';
const ratio=(a,b,c)=>Number((BigInt(a)*BigInt(b)*2n+BigInt(c))/(2n*BigInt(c)));
export async function detalleVenta(n,v){
 const venta=await db.prepare('SELECT * FROM ventas WHERE id=? AND negocio_id=?').get(v,n);if(!venta)throw fail('Venta no encontrada',404);
 const items=await db.prepare('SELECT * FROM venta_detalle WHERE venta_id=? ORDER BY id').all(v);
 const devoluciones=await db.prepare('SELECT * FROM venta_devoluciones WHERE venta_id=? ORDER BY creado_at').all(v);
 for(const it of items)it.devuelto=devoluciones.reduce((sum,d)=>sum+(d.detalle.items||[]).filter(x=>x.id===it.id).reduce((s,x)=>s+x.cantidad,0),0);
 const credito=await db.prepare('SELECT * FROM creditos WHERE venta_id=?').get(v);
 return {venta,items,devoluciones,credito,version:huella({venta,items,devoluciones})};
}
export async function devolverVenta(n,v,b,actor){
 solicitudId(b.solicitud_id);const motivo=text(b.motivo,'motivo',1000);
 if(!['devolucion','anulacion'].includes(b.tipo)||typeof b.reponer!=='boolean')throw fail('Devolución inválida');
 return db.transaction(async()=>{
 const initial=await detalleVenta(n,v);await db.lockClienteNegocio(initial.venta.cliente_id,n);
 await db.prepare('SELECT id FROM ventas WHERE id=? FOR UPDATE').get(v);
 await db.prepare('SELECT id FROM creditos WHERE id=? FOR UPDATE').get(initial.credito.id);
 await lockComisiones(n);
 const old=await db.prepare('SELECT * FROM venta_devoluciones WHERE id=?').get(b.solicitud_id);
 if(old){if(old.venta_id!==v||old.usuario_id!==actor||old.huella!==huella(b))throw fail('Solicitud reutilizada',409);return old;}
 const d=await detalleVenta(n,v);if(d.version!==b.version)throw fail('La venta cambió. Volvé a revisarla',409);if(d.venta.estado==='anulada')throw fail('La venta ya está anulada',409);
 const selected=b.tipo==='anulacion'?d.items.filter(x=>x.cantidad>x.devuelto).map(x=>({id:x.id,cantidad:x.cantidad-x.devuelto})):b.items;
 if(!Array.isArray(selected)||(!selected.length&&b.tipo!=='anulacion'))throw fail('Elegí los productos a devolver');
 const items=[],seen=new Set();for(const x of selected){const it=d.items.find(r=>r.id===x.id);if(!it||seen.has(x.id))throw fail('Producto repetido o ajeno a la venta');integer(x.cantidad,'cantidad',{min:1,max:it.cantidad-it.devuelto});seen.add(x.id);items.push({...it,cantidad:x.cantidad,cantidad_original:it.cantidad});}
 const restante=d.venta.monto_total_centavos-Number(d.venta.devolucion_centavos);
 const importe=b.tipo==='anulacion'?restante:items.reduce((s,x)=>s+x.cantidad*x.precio_unitario_centavos,0);integer(importe,'importe a devolver',{min:1,max:restante});
 const cuotas=await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY fecha_vencimiento DESC,numero DESC').all(d.credito.id);
 const negocio=await db.prepare('SELECT * FROM negocios WHERE id=?').get(n);
 const base=cuotas.reduce((s,x)=>s+x.monto_centavos,0)+d.credito.entrega_inicial_centavos;
 const basePrevia=d.devoluciones.reduce((s,x)=>s+Number(x.detalle.base_reducida_centavos||0),0);
 const baseReducida=b.tipo==='anulacion'?base-basePrevia:ratio(base,Number(d.venta.devolucion_centavos)+importe,d.venta.monto_total_centavos)-basePrevia;
 let reducir=baseReducida;const cuotaCambios=[];
 for(const q of cuotas){
   const mora=calcularMora(q,negocio,todayAR()),cap=Math.min(q.saldo_pendiente_centavos,reducir);reducir-=cap;
   const cancela=b.tipo==='anulacion';
   if(cap||cancela){
    const saldo=q.saldo_pendiente_centavos-cap;
    await db.prepare('UPDATE cuotas SET saldo_pendiente_centavos=?,mora_generada_centavos=?,mora_perdonada_centavos=?,estado_manual=? WHERE id=?').run(saldo,mora.acumulada,cancela?mora.perdonada+mora.pendiente:mora.perdonada,cancela?'anulada':q.estado_manual,q.id);
    cuotaCambios.push({id:q.id,capital_reducido_centavos:cap,mora_perdonada_centavos:cancela?mora.pendiente:0});
   }
 }
 const anon=await db.prepare('SELECT consumidor_final_negocio FROM clientes WHERE id=?').get(d.venta.cliente_id);
 // An unidentified customer's refund belongs to THIS receipt, never to a shared customer wallet.
 if(reducir>0&&!anon.consumidor_final_negocio)await sumarSaldoFavor(d.venta.cliente_id,n,reducir);
 if(b.reponer){
  const stock=new Map();for(const it of items)for(const c of (it.componentes.length?it.componentes:it.producto_id?[{producto_id:it.producto_id,cantidad:1}]:[]))stock.set(c.producto_id,(stock.get(c.producto_id)||0)+c.cantidad*it.cantidad);
  for(const [p,cantidad] of [...stock].sort((a,b)=>a[0].localeCompare(b[0]))){
   const product=await db.prepare('SELECT * FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(p,n);if(!product)throw fail('Componente de otro negocio',403);if(product.stock===null)continue;
   await db.prepare('UPDATE productos SET stock=stock+? WHERE id=?').run(cantidad,p);
   await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,usuario_id,venta_id,solicitud_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(),p,n,b.tipo,product.stock,product.stock+cantidad,motivo,actor,v,b.solicitud_id);
  }
 }
 const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(v);let comision=0;
 if(a){
  const previa=d.devoluciones.reduce((s,x)=>s+Number(x.detalle.comision_revertida_centavos||0),0);
  if(b.tipo==='anulacion')comision=a.total_centavos-previa;
  else if(a.detalle.every(x=>x.id)){
   for(const x of items){const line=a.detalle.find(i=>i.id===x.id);if(line)comision+=ratio(line.comision_centavos,x.devuelto+x.cantidad,x.cantidad_original)-ratio(line.comision_centavos,x.devuelto,x.cantidad_original);}
  } else comision=ratio(a.total_centavos,Number(d.venta.devolucion_centavos)+importe,d.venta.monto_total_centavos)-previa;
 }
 const detalle={items,cuotas:cuotaCambios,base_reducida_centavos:baseReducida,comision_revertida_centavos:comision,reponer:b.reponer,destino_reintegro:anon.consumidor_final_negocio?'pendiente_en_esta_venta':'saldo_a_favor_del_cliente'};
 await db.prepare(`INSERT INTO venta_devoluciones(id,venta_id,negocio_id,tipo,motivo,importe_centavos,capital_reducido_centavos,saldo_favor_centavos,detalle,antes,huella,usuario_id) VALUES(?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?)`).run(b.solicitud_id,v,n,b.tipo,motivo,importe,baseReducida-reducir,reducir,JSON.stringify(detalle),JSON.stringify({venta:d.venta,credito:d.credito,cuotas}),huella(b),actor);
 await db.prepare('UPDATE ventas SET devolucion_centavos=devolucion_centavos+?,estado=? WHERE id=?').run(importe,b.tipo==='anulacion'?'anulada':importe===restante?'devuelta':'devolucion_parcial',v);
 if(a){await generarComision(a,-comision,todayAR(),motivo,'devolucion:'+b.solicitud_id);await sincronizarComision(d.credito.id,todayAR(),b.tipo==='anulacion'?'Anulación de venta':'Devolución');}
 await recalcularEstadoCredito(d.credito.id,negocio,todayAR(),actor);
 await auditar('venta',v,b.tipo,d,{solicitud_id:b.solicitud_id,importe_centavos:importe,detalle},actor,motivo);
 return {id:b.solicitud_id,importe_centavos:importe,capital_reducido_centavos:baseReducida-reducir,saldo_favor_centavos:reducir,detalle};
 });
}
