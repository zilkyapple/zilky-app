import './setup-env.js';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';import {crearCliente,buscarClientes} from '../src/repositories/clientes.js';import {crearUsuario} from '../src/repositories/usuarios.js';import {crearProducto,getProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';import {registrarPago} from '../src/services/pagosService.js';import {anularComprobante} from '../src/services/comprobantesService.js';
import {configurarComision,configurarProductoComision,resumenComisiones,liquidarComision} from '../src/services/comisionesService.js';
import {guardarCombo,guardarRegla,configurarVisibilidad} from '../src/services/comisionReglasService.js';
import {ajustarComision,vistaCierre,aprobarCierre,publicarCierre} from '../src/services/comisionCierresService.js';
import {detalleVenta,devolverVenta} from '../src/services/ventasGestionService.js';
import {firmarToken} from '../src/lib/auth.js';import {app} from '../src/app.js';import {todayAR} from '../src/lib/dates.js';
await migrate();await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const n=await crearNegocio({nombre:'Integración QA'}),other=await crearNegocio({nombre:'Otro QA'}),c=await crearCliente({nombre:'Cliente',apellido:'QA',negocio_id:n.id});
const admin=await crearUsuario({email:'admin@integration.invalid',password_hash:'unused',nombre:'Dueño'}),emp=await crearUsuario({email:'sales@integration.invalid',password_hash:'unused',rol:'empleado',nombre:'Vendedor'}),outsider=await crearUsuario({email:'other@integration.invalid',password_hash:'unused',rol:'empleado'});
await db.prepare('INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES(?,?,?,1)').run(emp.id,n.id,JSON.stringify({'ventas.crear':true,'clientes.ver':true,'productos.ver':true,'costos.ver':true}));
await db.prepare('INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES(?,?,?,1)').run(outsider.id,other.id,JSON.stringify({'ventas.crear':true,'clientes.ver':true}));
const p=await crearProducto({negocio_id:n.id,nombre:'Jean QA',stock:100,precio_contado_centavos:100000,costo_centavos:123456}),p2=await crearProducto({negocio_id:n.id,nombre:'Remera QA',stock:100,precio_contado_centavos:50000}),combo=await crearProducto({negocio_id:n.id,nombre:'Combo QA',precio_contado_centavos:150000}),ajeno=await crearProducto({negocio_id:other.id,nombre:'Ajeno QA',stock:10});
await configurarComision(n.id,{activa:true,visible_empleado:false,momento:'venta'},admin.id);
await configurarProductoComision(n.id,p.id,{tipo:'fijo',valor:2500},admin.id);await configurarProductoComision(n.id,p2.id,{tipo:'porcentaje',valor:1000},admin.id);
const line=(product,qty=1)=>({producto_id:product.id,cantidad:qty,precio_unitario_centavos:product.precio_contado_centavos});
const body=(items=[line(p)])=>({negocio_id:n.id,cliente_id:c.id,modalidad:'unico',items,monto_total_centavos:items.reduce((s,x)=>s+x.cantidad*x.precio_unitario_centavos,0),entrega_inicial_centavos:0,usuario_id:emp.id,comision_usuario_id:emp.id,solicitud_id:randomUUID(),plan:{plazo_dias:30}});
const summary=()=>resumenComisiones(n.id,emp.id,'0001-01-01','9999-12-31');
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
const request=(path,user=emp,method='GET',data)=>fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+firmarToken(user)},body:data?JSON.stringify(data):undefined});
const url='/comisiones?negocio_id='+n.id+'&desde=2020-01-01&hasta=2099-12-31';
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
let simple,multi,financiada,anon;
test('Single sale is atomic and retry safe; changed request conflicts without touching stock',async()=>{
 const b=body();const before=(await getProducto(p.id)).stock;const [a,r]=await Promise.all([crearVenta(b),crearVenta(b)]);simple=a;assert.equal(a.venta.id,r.venta.id);assert.equal((await getProducto(p.id)).stock,before-1);
 assert.equal((await db.prepare('SELECT count(*) total FROM creditos WHERE venta_id=?').get(a.venta.id)).total,1);assert.equal((await db.prepare('SELECT count(*) total FROM comision_acuerdos WHERE venta_id=?').get(a.venta.id)).total,1);
 await assert.rejects(crearVenta({...b,notas:'otro'}),e=>e.status===409);assert.equal((await getProducto(p.id)).stock,before-1);
});
test('Multi-product cash sale produces one payment, one credit, one commission agreement',async()=>{
 const b=body([line(p),line(p2,2)]);b.entrega_inicial_centavos=b.monto_total_centavos;multi=await crearVenta(b);
 assert.equal(multi.cuotas.length,0);assert.equal(multi.credito.estado,'finalizado');assert.equal(multi.entregaInicial.pago.monto_centavos,200000);
 const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(multi.venta.id);assert.equal(a.total_centavos,12500);assert.equal(a.detalle.length,2);assert.equal(multi.venta.vendedor_id,emp.id);
});
test('Anonymous cash sale is paid in full and never appears in customer search; fiado requires customer',async()=>{
 const b=body();b.cliente_id=null;b.entrega_inicial_centavos=b.monto_total_centavos;anon=await crearVenta(b);assert.equal(anon.cuotas.length,0);assert.equal(anon.credito.estado,'finalizado');assert.equal((await buscarClientes('Consumidor',n.id)).length,0);
 await assert.rejects(crearVenta({...b,solicitud_id:randomUUID(),entrega_inicial_centavos:0}),/Elegí un cliente/);
});
test('Fiado and financed sales retain principal separately from commissions',async()=>{
 assert.equal(simple.cuotas[0].saldo_pendiente_centavos,100000);
 await configurarComision(n.id,{activa:true,visible_empleado:false,momento:'cobro'},admin.id);
 financiada=await crearVenta({...body(),modalidad:'cuotas',entrega_inicial_centavos:10000,plan:{cantidad_cuotas:3,valor_cuota_centavos:30000,fecha_primera_cuota:'2090-01-10'}});
 assert.equal(financiada.cuotas.length,3);assert.equal(financiada.cuotas.reduce((s,x)=>s+x.saldo_pendiente_centavos,0),90000);
 const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(financiada.venta.id);let r=await summary();assert.equal(r.acuerdos.find(x=>x.id===a.id).liquidable,250);
 const pay=await registrarPago({credito_id:financiada.credito.id,monto_centavos:30000,usuario_id:admin.id});r=await summary();assert.equal(r.acuerdos.find(x=>x.id===a.id).liquidable,1000);
 await anularComprobante(pay.comprobante.id,{motivo:'QA',usuarioId:admin.id});assert.equal((await summary()).acuerdos.find(x=>x.id===a.id).liquidable,250);
});
test('Combo moves each component once and accrues only the package commission',async()=>{
 await guardarCombo(n.id,combo.id,{componentes:[{producto_id:p.id,cantidad:1},{producto_id:p2.id,cantidad:2}]},admin.id);
 await guardarRegla(n.id,combo.id,{canal:'combo',tipo:'fijo',valor:9000},admin.id);const before=(await getProducto(p2.id)).stock;
 const s=await crearVenta(body([line(combo)]));const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(s.venta.id);assert.equal(a.total_centavos,9000);assert.equal((await getProducto(p2.id)).stock,before-2);
 await assert.rejects(guardarCombo(n.id,combo.id,{componentes:[{producto_id:ajeno.id,cantidad:1}]},admin.id),e=>e.status===403);
 await assert.rejects(guardarCombo(n.id,p.id,{componentes:[{producto_id:combo.id,cantidad:1}]},admin.id),/combo/);
});
test('Wholesale and seller overrides are prospective; original terms stay frozen',async()=>{
 await guardarRegla(n.id,p.id,{canal:'mayorista',tipo:'fijo',valor:1000},admin.id);await guardarRegla(n.id,p.id,{canal:'mayorista',tipo:'fijo',valor:1500,usuario_id:emp.id},admin.id);
 const s=await crearVenta({...body(),canal:'mayorista'});assert.equal((await db.prepare('SELECT total_centavos FROM comision_acuerdos WHERE venta_id=?').get(s.venta.id)).total_centavos,1500);assert.equal((await db.prepare('SELECT total_centavos FROM comision_acuerdos WHERE venta_id=?').get(simple.venta.id)).total_centavos,2500);
});
test('Return restores stock once, preserves receipts, creates client credit and reverses only returned items',async()=>{
 const d=await detalleVenta(n.id,multi.venta.id),it=d.items.find(x=>x.producto_id===p2.id);const b={solicitud_id:randomUUID(),tipo:'devolucion',motivo:'QA devolución',version:d.version,reponer:true,items:[{id:it.id,cantidad:1}]};
 const before=(await getProducto(p2.id)).stock;const [x,y]=await Promise.all([devolverVenta(n.id,multi.venta.id,b,admin.id),devolverVenta(n.id,multi.venta.id,b,admin.id)]);assert.equal(x.id,y.id);assert.equal((await getProducto(p2.id)).stock,before+1);assert.equal(x.saldo_favor_centavos,50000);
 assert.equal((await db.prepare('SELECT anulado FROM pagos WHERE id=?').get(multi.entregaInicial.pago.id)).anulado,0);
 assert.equal((await summary()).acuerdos.find(a=>a.venta_id===multi.venta.id).liquidable,7500);
});
test('Sale void cancels outstanding debt and commissions without erasing its quotas',async()=>{
 const d=await detalleVenta(n.id,simple.venta.id);await devolverVenta(n.id,simple.venta.id,{solicitud_id:randomUUID(),tipo:'anulacion',motivo:'QA anulación',version:d.version,reponer:true},admin.id);
 const q=await db.prepare('SELECT * FROM cuotas WHERE credito_id=?').get(simple.credito.id);assert.equal(q.saldo_pendiente_centavos,0);assert.equal(q.estado_manual,'anulada');assert.equal((await summary()).acuerdos.find(a=>a.venta_id===simple.venta.id).liquidable,0);
 await assert.rejects(registrarPago({credito_id:simple.credito.id,monto_centavos:100}),/anulada/);
});
test('Commission adjustments are audited and not erased by subsequent payments',async()=>{
 const a=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(financiada.venta.id),b={acuerdo_id:a.id,solicitud_id:randomUUID(),importe_centavos:700,motivo:'QA incentivo'};
 await ajustarComision(n.id,b,admin.id);await ajustarComision(n.id,b,admin.id);await registrarPago({credito_id:financiada.credito.id,monto_centavos:30000,usuario_id:admin.id});assert.equal((await summary()).acuerdos.find(x=>x.id===a.id).liquidable,1700);
});
let cerrado;
test('Monthly close uses a review version, publishes immutable totals and supports partial payments',async()=>{
 await configurarComision(n.id,{activa:true,visible_empleado:false,momento:'venta'},admin.id);await crearVenta({...body(),fecha:'2026-08-15'});
 const v=await vistaCierre(n.id,emp.id,'2026-08');await assert.rejects(aprobarCierre(n.id,{usuario_id:emp.id,mes:'2026-08',version:'stale'},admin.id),e=>e.status===409);
 cerrado=await aprobarCierre(n.id,{usuario_id:emp.id,mes:'2026-08',version:v.version},admin.id);await publicarCierre(n.id,cerrado.id,admin.id);
 const b={usuario_id:emp.id,importe_centavos:1000,fecha:todayAR(),nota:'QA parcial',solicitud_id:randomUUID(),cierre_id:cerrado.id};await liquidarComision(n.id,b,admin.id);await liquidarComision(n.id,b,admin.id);
 assert.equal((await db.prepare('SELECT resumen FROM comision_cierres WHERE id=?').get(cerrado.id)).resumen.liquidable,2500);
 await crearVenta({...body(),fecha:'2026-08-16'});assert.equal((await vistaCierre(n.id,emp.id,'2026-08')).resumen.liquidable,2500);
});
const policy=(modo,extra={})=>configurarVisibilidad(n.id,emp.id,{modo,ver_total:true,ver_detalle:false,ver_historial:false,venta_manual:false,...extra},admin.id);
test('Never and monthly visibility are enforced in backend, including totals-only and history permissions',async()=>{
 await policy('nunca');assert.equal((await request(url)).status,403);
 await policy('cierre');let r=await (await request(url+'&usuario_id='+admin.id)).json();assert.equal(r.cierres.length,1);assert.equal(r.cierres[0].liquidable,2500);assert.equal(r.cierres[0].pagado_cierre,1000);for(const key of ['eventos','balances','acuerdos','totales'])assert.equal(r[key],undefined);assert.equal(r.cierres[0].eventos,undefined);assert.equal(JSON.stringify(r).includes(p.id),false);
 await policy('cierre',{ver_total:false});r=await (await request(url)).json();assert.equal(r.cierres[0].liquidable,undefined);
});
test('Real-time total-only hides item rules, other sellers and costs even with legacy cost permission',async()=>{
 await policy('tiempo_real');const r=await (await request(url+'&usuario_id='+admin.id)).json();assert.ok(r.totales);assert.equal(r.eventos,undefined);assert.equal(r.acuerdos,undefined);assert.equal(JSON.stringify(r).includes('tipo'),false);
 const cat=await (await request('/ventas/catalogo?negocio_id='+n.id)).json();assert.ok(cat.productos.length);assert.equal(cat.venta_manual,false);assert.equal(JSON.stringify(cat).includes('comision'),false);assert.equal(JSON.stringify(cat).includes('costo_centavos'),false);
 const products=await (await request('/productos?negocio_id='+n.id)).json();assert.equal(JSON.stringify(products).includes('costo_centavos'),false);
});
test('Business isolation and manual sales permissions reject crafted requests without side effects',async()=>{
 assert.equal((await request(url,outsider)).status,403);assert.equal((await request('/comisiones/administracion?negocio_id='+n.id)).status,403);assert.equal((await request('/comisiones/cierres/'+cerrado.id+'/publicar',emp,'POST',{negocio_id:n.id})).status,403);
 assert.equal((await request('/ventas',emp,'POST',{...body(),items:[]})).status,403);
 assert.equal((await request('/ventas/'+simple.venta.id+'?negocio_id='+other.id)).status,403);
 await assert.rejects(crearVenta({...body(),items:[{producto_id:ajeno.id,cantidad:1,precio_unitario_centavos:100000}]}),/Producto/);
 assert.equal((await getProducto(ajeno.id)).stock,10);
});

test('Anonymous full return never credits the shared customer and is not duplicated on retry',async()=>{
 const d=await detalleVenta(n.id,anon.venta.id),b={solicitud_id:randomUUID(),tipo:'devolucion',motivo:'QA devolución anónima',version:d.version,reponer:true,items:d.items.map(x=>({id:x.id,cantidad:x.cantidad}))};
 const x=await devolverVenta(n.id,anon.venta.id,b,admin.id);const again=await devolverVenta(n.id,anon.venta.id,b,admin.id);assert.equal(x.id,again.id);assert.equal(x.detalle.destino_reintegro,'pendiente_en_esta_venta');assert.equal(x.saldo_favor_centavos,100000);
 assert.equal((await detalleVenta(n.id,anon.venta.id)).venta.estado,'devuelta');
 await assert.rejects(registrarPago({credito_id:anon.credito.id,monto_centavos:100}),/devuelta|anulada/);
});
test('A payment made after a return preview invalidates that preview and preserves the payment',async()=>{
 const s=await crearVenta(body()),d=await detalleVenta(n.id,s.venta.id);const pay=await registrarPago({credito_id:s.credito.id,monto_centavos:10000,usuario_id:admin.id});
 await assert.rejects(devolverVenta(n.id,s.venta.id,{solicitud_id:randomUUID(),tipo:'anulacion',motivo:'QA vista vencida',version:d.version,reponer:false},admin.id),e=>e.status===409);
 assert.equal((await db.prepare('SELECT anulado FROM pagos WHERE id=?').get(pay.pago.id)).anulado,0);
});
test('Full return cancels both principal and outstanding late fees without erasing quotas',async()=>{
 const s=await crearVenta({...body(),fecha:'2026-01-01',plan:{plazo_dias:1}});
 const d=await detalleVenta(n.id,s.venta.id);await devolverVenta(n.id,s.venta.id,{solicitud_id:randomUUID(),tipo:'devolucion',motivo:'QA devolución total',version:d.version,reponer:true,items:d.items.map(x=>({id:x.id,cantidad:x.cantidad}))},admin.id);
 const q=await db.prepare('SELECT * FROM cuotas WHERE credito_id=?').get(s.credito.id);assert.equal(q.saldo_pendiente_centavos,0);assert.equal(q.estado_manual,'anulada');assert.equal(q.mora_generada_centavos,q.mora_perdonada_centavos+q.mora_pagada_centavos);
});
test('Closed detail permission exposes only frozen own product breakdown; full payment cannot overpay',async()=>{
 await policy('cierre',{ver_detalle:true,ver_historial:true});const r=await (await request(url)).json();assert.ok(r.cierres[0].productos.length);assert.equal(r.cierres[0].productos[0].comision_centavos,2500);assert.equal(JSON.stringify(r).includes('costo'),false);
 const b={usuario_id:emp.id,importe_centavos:1500,fecha:todayAR(),nota:'QA saldo cierre',solicitud_id:randomUUID(),cierre_id:cerrado.id};await liquidarComision(n.id,b,admin.id);await assert.rejects(liquidarComision(n.id,{...b,solicitud_id:randomUUID(),importe_centavos:1},admin.id),e=>e.status===409||e.status===400);
 assert.equal(Number((await db.prepare('SELECT sum(importe_centavos) amount FROM comision_liquidaciones WHERE cierre_id=?').get(cerrado.id)).amount),2500);
});
test('Sale endpoint requires an idempotency key; staff cannot impersonate a seller',async()=>{
 const b=body();delete b.solicitud_id;assert.equal((await request('/ventas',emp,'POST',b)).status,400);
 const r=await request('/ventas',emp,'POST',{...body(),comision_usuario_id:admin.id});assert.equal(r.status,201);const s=await r.json();assert.equal(s.venta.vendedor_id,emp.id);
});
