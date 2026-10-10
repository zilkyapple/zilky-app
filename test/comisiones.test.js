import './setup-env.js';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';import {crearCliente} from '../src/repositories/clientes.js';import {crearUsuario} from '../src/repositories/usuarios.js';import {crearProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';import {registrarPago} from '../src/services/pagosService.js';import {anularComprobante} from '../src/services/comprobantesService.js';
import {configurarComision,configurarProductoComision,resumenComisiones,liquidarComision} from '../src/services/comisionesService.js';
import {firmarToken} from '../src/lib/auth.js';import {app} from '../src/app.js';import {todayAR} from '../src/lib/dates.js';
await migrate();await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const n=await crearNegocio({nombre:'Comisiones QA'}),other=await crearNegocio({nombre:'Otro'}),client=await crearCliente({nombre:'=FORMULA',apellido:'QA',negocio_id:n.id});
const admin=await crearUsuario({email:'admin@commission.invalid',password_hash:'unused'}),employee=await crearUsuario({nombre:'Empleado QA',email:'employee@commission.invalid',password_hash:'unused',rol:'empleado'}),outsider=await crearUsuario({email:'outsider@commission.invalid',password_hash:'unused',rol:'empleado'});
await db.prepare('INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES(?,?,?,1)').run(employee.id,n.id,JSON.stringify({'ventas.crear':true,'clientes.ver':true}));
const product=await crearProducto({negocio_id:n.id,nombre:'Producto QA',precio_financiado_centavos:100000});
const input={negocio_id:n.id,cliente_id:client.id,modalidad:'unico',monto_total_centavos:100000,entrega_inicial_centavos:20000,items:[{producto_id:product.id,cantidad:1,precio_unitario_centavos:100000}],usuario_id:employee.id,fecha:todayAR(),plan:{plazo_dias:30}};
const summary=()=>resumenComisiones(n.id,null,'0001-01-01','9999-12-31');
const config=(momento='cobro',activa=true,visible_empleado=false)=>configurarComision(n.id,{momento,activa,visible_empleado},admin.id);
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
const request=(path,user=employee,options={})=>fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+firmarToken(user)}});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
let sale,payment;
test('Default off; activation is prospective and rules are frozen per sale',async()=>{
 await configurarProductoComision(n.id,product.id,{tipo:'porcentaje',valor:1000},admin.id);
 await crearVenta(input);assert.equal((await summary()).eventos.length,0);
 await config();sale=await crearVenta(input);assert.equal((await summary()).balances[0].generado,2000);
 await configurarProductoComision(n.id,product.id,{tipo:'fijo',valor:20000},admin.id);await config('venta',false);
 payment=await registrarPago({credito_id:sale.credito.id,monto_centavos:40000,usuario_id:admin.id});
 assert.equal((await summary()).balances[0].generado,6000);assert.equal((await summary()).eventos.length,2);
});
test('Void reverses proportional accrual while preserving payment and commission history',async()=>{
 await anularComprobante(payment.comprobante.id,{motivo:'Prueba QA',usuarioId:admin.id});const r=await summary();assert.equal(r.balances[0].generado,2000);assert.ok(r.eventos.some(x=>Number(x.importe_centavos)===-4000));assert.equal(r.eventos.length,3);
 const p=await registrarPago({credito_id:sale.credito.id,monto_centavos:90000,usuario_id:admin.id});assert.equal(p.remanente,10000);assert.equal((await summary()).balances[0].generado,10000);
});
test('Sale mode accrues full fixed commission and does not change with later receipts',async()=>{
 await config('venta');const s=await crearVenta({...input,entrega_inicial_centavos:0});assert.equal((await summary()).balances[0].generado,30000);
 await registrarPago({credito_id:s.credito.id,monto_centavos:1000,usuario_id:admin.id});assert.equal((await summary()).balances[0].generado,30000);
});
test('Settlements are idempotent; concurrent duplicate cannot overpay',async()=>{
 const body={usuario_id:employee.id,importe_centavos:30000,fecha:todayAR(),nota:'Pago QA',solicitud_id:randomUUID()};await Promise.all([liquidarComision(n.id,body,admin.id),liquidarComision(n.id,body,admin.id)]);const r=await summary();assert.equal(r.pagos.length,1);assert.equal(r.balances[0].pendiente,0);await assert.rejects(liquidarComision(n.id,{...body,solicitud_id:randomUUID(),importe_centavos:1},admin.id),/supera/);
});
test('Employees see only themselves when enabled; hidden settings and cross-business access remain blocked',async()=>{
 const url='/comisiones?negocio_id='+n.id+'&desde=2026-01-01&hasta=2099-12-31';assert.equal((await request(url)).status,403);await config('venta',true,true);
 const r=await request(url+'&usuario_id='+admin.id);assert.equal(r.status,200);const data=await r.json();assert.ok(data.eventos.every(x=>x.usuario_id===employee.id));assert.equal((await request(url,outsider)).status,403);
 assert.equal((await request(url.replace(n.id,other.id))).status,403);assert.equal((await request('/comisiones/productos?negocio_id='+n.id)).status,403);
 assert.equal((await request('/comisiones/configuracion',employee,{method:'PUT',body:JSON.stringify({negocio_id:n.id,activa:true,visible_empleado:true,momento:'venta'})})).status,403);
 await config('venta',true,false);assert.equal((await request(url)).status,403);
});
test('Exports are scoped, formula-safe and available only to administrators',async()=>{
 const base='/exportaciones?negocio_id='+n.id+'&desde=2026-01-01&hasta=2099-12-31&tipo=';
 assert.equal((await request(base+'clientes')).status,403);
 for(const type of ['clientes','ventas','pagos','cuotas','productos','comisiones']){const r=await request(base+type,admin);assert.equal(r.status,200);const d=await r.json();assert.ok(d.filas>0);if(type==='clientes')assert.match(d.csv,/'=FORMULA/);}
 const otherRows=await (await request(base.replace(n.id,other.id)+'clientes',admin)).json();assert.equal(otherRows.filas,0);
});
