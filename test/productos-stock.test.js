import './setup-env.js';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';import {crearCliente} from '../src/repositories/clientes.js';import {crearUsuario} from '../src/repositories/usuarios.js';import {getProducto} from '../src/repositories/productos.js';
import {nuevoProducto,editarProducto,moverStock,historialProducto} from '../src/services/productosService.js';
import {crearVenta} from '../src/services/ventasService.js';import {firmarToken} from '../src/lib/auth.js';import {app} from '../src/app.js';import {todayAR} from '../src/lib/dates.js';
await migrate();await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const n=await crearNegocio({nombre:'Stock QA'}),other=await crearNegocio({nombre:'Otro'}),client=await crearCliente({nombre:'Cliente QA',negocio_id:n.id});
const admin=await crearUsuario({email:'admin@stock.invalid',password_hash:'unused'}),employee=await crearUsuario({email:'employee@stock.invalid',password_hash:'unused',rol:'empleado'});
await db.prepare('INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES(?,?,?,1)').run(employee.id,n.id,JSON.stringify({'productos.ver':true}));
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
const request=(path,user=admin,method='GET',body)=>fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+firmarToken(user)},body:body?JSON.stringify(body):undefined});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
const create=extra=>nuevoProducto({negocio_id:n.id,nombre:'Producto QA',...extra},admin.id);
const move=(p,extra)=>moverStock(p.id,n.id,{tipo:'reposicion',cantidad:2,motivo:'Entrega de proveedor',solicitud_id:randomUUID(),...extra},admin.id);
const sale=p=>crearVenta({negocio_id:n.id,cliente_id:client.id,modalidad:'unico',monto_total_centavos:100000,entrega_inicial_centavos:0,items:[{producto_id:p.id,cantidad:1,precio_unitario_centavos:100000}],usuario_id:admin.id,fecha:todayAR(),plan:{plazo_dias:30}});
test('Only name is required; optional fields and photo persist, edits retain product identity',async()=>{
 const p=await create();assert.equal(p.stock,null);assert.equal(p.precio_contado_centavos,0);
 const next=await editarProducto(p.id,n.id,{revision:p.revision,nombre:'Nuevo nombre',foto_url:'https://example.com/photo.jpg',sku:'SKU-1',costo_centavos:5000},admin.id);
 assert.equal(next.id,p.id);assert.equal(next.nombre,'Nuevo nombre');assert.equal(next.revision,2);const rows=await historialProducto(p.id,n.id);assert.equal(rows.length,2);const edit=rows.find(x=>x.tipo==='edicion');assert.equal(edit.detalles.anterior.nombre,p.nombre);assert.equal(edit.detalles.foto_modificada,true);assert.equal(edit.detalles.nuevo.foto_url,undefined);
 await assert.rejects(editarProducto(p.id,n.id,{revision:1,nombre:'Stale'},admin.id),e=>e.status===409);assert.equal((await getProducto(p.id)).nombre,'Nuevo nombre');
});
test('Reject invalid input and direct stock edits without modifying product',async()=>{
 const p=await create({stock:5});for(const extra of [{nombre:''},{nombre:'x'.repeat(181)},{precio_contado_centavos:-1},{foto_url:'javascript:alert(1)'},{foto_url:'data:image/svg+xml;base64,PHN2Zz4='},{foto_url:'data:image/png;base64,YWJj'},{stock:99}])await assert.rejects(editarProducto(p.id,n.id,{revision:1,...extra},admin.id),e=>e.status===400);
 await assert.rejects(create({stock:1.5}));await assert.rejects(create({stock:-1}));assert.equal((await getProducto(p.id)).stock,5);assert.equal((await historialProducto(p.id,n.id)).length,1);
});
test('Concurrent replenishments add independently; duplicate requests add once',async()=>{
 const p=await create({stock:10});await Promise.all([move(p,{cantidad:3}),move(p,{cantidad:4})]);assert.equal((await getProducto(p.id)).stock,17);
 const body={solicitud_id:randomUUID(),cantidad:5};await Promise.all([move(p,body),move(p,body)]);assert.equal((await getProducto(p.id)).stock,22);assert.equal((await historialProducto(p.id,n.id)).filter(x=>x.tipo==='reposicion').length,3);await assert.rejects(move(p,{...body,cantidad:6}),e=>e.status===409);
});
test('Count starts control, stale count cannot overwrite a sale, disabling preserves history',async()=>{
 const p=await create();await assert.rejects(move(p),/conteo inicial/);
 await move(p,{tipo:'conteo',cantidad:3,stock_esperado:null,motivo:'Conteo inicial'});const s=await sale(p);assert.equal((await getProducto(p.id)).stock,2);
 await assert.rejects(move(p,{tipo:'conteo',cantidad:10,stock_esperado:3}),e=>e.status===409);assert.equal((await getProducto(p.id)).stock,2);
 await move(p,{tipo:'conteo',cantidad:8,stock_esperado:2,motivo:'Inventario contado'});
 const rows=await historialProducto(p.id,n.id);const v=rows.find(x=>x.tipo==='venta');assert.ok(v.venta_id);assert.equal(v.stock_anterior,3);assert.equal(v.stock_nuevo,2);assert.equal(v.usuario_id,admin.id);
 const before=await db.prepare('SELECT * FROM creditos WHERE id=?').get(s.credito.id);
 await editarProducto(p.id,n.id,{revision:1,nombre:'Renombrado',precio_financiado_centavos:999999},admin.id);
 assert.deepEqual(await db.prepare('SELECT * FROM creditos WHERE id=?').get(s.credito.id),before);
 await move(p,{tipo:'sin_control',cantidad:null,stock_esperado:8,motivo:'Se suspende inventario'});await sale(p);assert.equal((await getProducto(p.id)).stock,null);assert.equal((await historialProducto(p.id,n.id)).filter(x=>x.tipo==='sin_control').length,1);
});
test('Movement and audit are atomic; failed sale rolls back both stock and history',async()=>{
 const p=await create({stock:5});const initial=await historialProducto(p.id,n.id);
 await assert.rejects(db.transaction(async()=>{await move(p);throw Error('Rollback QA');}),/Rollback QA/);assert.equal((await getProducto(p.id)).stock,5);assert.deepEqual(await historialProducto(p.id,n.id),initial);
 await assert.rejects(crearVenta({negocio_id:n.id,cliente_id:client.id,modalidad:'cuotas',monto_total_centavos:100000,items:[{producto_id:p.id,cantidad:2,precio_unitario_centavos:50000}],usuario_id:admin.id,plan:{}}));assert.equal((await getProducto(p.id)).stock,5);assert.deepEqual(await historialProducto(p.id,n.id),initial);
});
test('API permissions: employees may read but never mutate or access cost history; scope enforced',async()=>{
 const p=await create({stock:2,costo_centavos:123});const base='/productos/'+p.id;
 assert.equal((await request(base,employee)).status,200);assert.equal((await (await request(base,employee)).json()).costo_centavos,undefined);
 for(const [path,method,body] of [['/productos','POST',{negocio_id:n.id,nombre:'X'}],[base,'PUT',{negocio_id:n.id,revision:1,nombre:'X'}],[base+'/stock','POST',{negocio_id:n.id,tipo:'reposicion',cantidad:1,motivo:'X',solicitud_id:randomUUID()}],[base+'/historial?negocio_id='+n.id,'GET']])assert.equal((await request(path,employee,method,body)).status,403);
 assert.equal((await request(base,admin,'PUT',{negocio_id:other.id,revision:1,nombre:'X'})).status,404);
 assert.equal((await request(base+'/historial?negocio_id='+other.id)).status,404);
 const r=await request(base+'/stock',admin,'POST',{negocio_id:n.id,tipo:'conteo',cantidad:0,stock_esperado:2,motivo:'Inventario vacío',solicitud_id:randomUUID()});assert.equal(r.status,200);assert.equal((await getProducto(p.id)).stock,0);
});
