import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';
import { randomUUID } from 'node:crypto';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a=await crearNegocio({nombre:'QA correcciones A',mora_valor:0}),b=await crearNegocio({nombre:'QA correcciones B',mora_valor:0});
const admin=await crearUsuario({email:'admin@correcciones.invalid',password_hash:'unused'});
const editor=await crearUsuario({email:'editor@correcciones.invalid',password_hash:'unused',rol:'empleado'});
const lector=await crearUsuario({email:'lector@correcciones.invalid',password_hash:'unused',rol:'empleado'});
await asignarNegocio(editor.id,a.id,{'clientes.ver':true,'clientes.editar':true});
await asignarNegocio(lector.id,a.id,{'clientes.ver':true});
const cliente=await crearCliente({nombre:'Bruno',apellido:'QA',negocio_id:a.id,notas:'Nota original'});
const hoy=todayAR();
const s=await crearVenta({negocio_id:a.id,cliente_id:cliente.id,fecha:addDays(hoy,-40),modalidad:'cuotas',monto_total_centavos:63293900,
  plan:{cantidad_cuotas:6,valor_cuota_centavos:10548983,fecha_primera_cuota:addDays(hoy,-24)}});
await registrarPago({credito_id:s.credito.id,monto_centavos:500,fecha_hora:`${hoy}T12:00:00-03:00`});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
async function api(path,user=editor,method='GET',body) {
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{method,headers:{Authorization:'Bearer '+firmarToken(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json()};
}
const path=`/clientes/${cliente.id}/datos?negocio_id=${a.id}`;
async function finanzas() {
  return Promise.all(['ventas','creditos','cuotas','pagos','comprobantes','pago_aplicaciones'].map(async t=>(await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows));
}
test('Correcciones PG: editar datos con pagos conserva todas las tablas financieras y audita antes/después/actor/motivo',async()=>{
  const before=await finanzas(),f=await api(path);
  assert.equal(f.status,200);
  const body={version:f.body.version,datos:{nombre:'Bruno corregido',telefono:'QA-555',notas:'Nueva nota'},motivo:'Corregir error de carga QA'};
  assert.equal((await api(path,editor,'PATCH',body)).status,200);
  assert.deepEqual(await finanzas(),before);
  const events=(await pool.query("SELECT * FROM auditoria WHERE entidad='cliente' AND entidad_id=$1",[cliente.id])).rows;
  assert.equal(events.length,1);assert.equal(events[0].empleado,editor.id);assert.equal(events[0].motivo,body.motivo);
  assert.equal(JSON.parse(events[0].datos_anteriores).nombre,'Bruno');assert.equal(JSON.parse(events[0].datos_nuevos).nombre,'Bruno corregido');
  assert.equal((await api(path,editor,'PATCH',body)).status,200);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM auditoria WHERE entidad='cliente' AND entidad_id=$1",[cliente.id])).rows[0].n,1);
});
test('Correcciones PG: una versión vieja no pisa una corrección nueva',async()=>{
  const f=await api(path),body={version:f.body.version,datos:{notas:'Corrección uno'},motivo:'QA concurrencia'};
  assert.equal((await api(path,editor,'PATCH',body)).status,200);
  assert.equal((await api(path,editor,'PATCH',{...body,datos:{notas:'Corrección dos'}})).status,409);
});
test('Correcciones PG: lector, otros negocios y mass assignment denegados',async()=>{
  assert.equal((await api(path,lector)).status,403);
  assert.equal((await api(`/clientes/${cliente.id}/datos?negocio_id=${b.id}`)).status,403);
  const f=await api(path);
  assert.equal((await api(path,editor,'PATCH',{version:f.body.version,datos:{organizacion_id:'otra'},motivo:'QA'})).status,400);
});
test('Correcciones PG: ficha compartida requiere permiso sobre todos los negocios o administrador',async()=>{
  await vincularClienteNegocio(cliente.id,b.id);
  assert.equal((await api(path)).status,403);
  const f=await api(path,admin);assert.equal(f.status,200);
  assert.equal((await api(path,admin,'PATCH',{version:f.body.version,datos:{nombre:'Bruno'},motivo:'QA compartido'})).status,200);
});
test('Correcciones PG: ficha individual conserva deuda completa pero exigible y próxima fecha son independientes',async()=>{
  const r=await api(`/clientes/${cliente.id}?negocio_id=${a.id}`,lector);
  assert.equal(r.status,200);assert.equal(r.body.cuotasVencidas,1);assert.equal(r.body.diasAtrasoVencimiento,24);
  assert.equal(r.body.saldoExigibleCentavos,10548483);assert.equal(r.body.deudaTotalCentavos,63293400);
  assert.ok(r.body.proximoVencimiento>hoy);assert.equal(r.body.creditos[0].cuotas.length,6);
  assert.equal((await api('/dashboard/resumen',lector)).status,403);
});

test('Eliminar PG: vista previa, confirmación explícita y motivo; conserva auditoría y reintento',async()=>{
  const c=await crearCliente({nombre:'Error',apellido:'QA',notas:'Dato original',negocio_id:a.id});
  const path=`/clientes/${c.id}`,f=await api(path+'/datos',admin);
  await api(path+'/datos',admin,'PATCH',{version:f.body.version,datos:{nombre:'Error corregido'},motivo:'QA edición previa'});
  const preview=await api(path+'/eliminacion',admin);
  assert.equal(preview.status,200);assert.equal(preview.body.permitido,true);assert.equal(preview.body.actividad.correcciones,1);
  const body={version:preview.body.version,confirmacion:'ELIMINAR',motivo:'Cliente creado por error QA',solicitud_id:randomUUID()};
  assert.equal((await api(path,admin,'DELETE',{...body,confirmacion:''})).status,400);
  assert.equal((await api(path,admin,'DELETE',{...body,motivo:''})).status,400);
  assert.equal((await api(path,admin,'DELETE',body)).status,200);
  assert.equal((await pool.query('SELECT id FROM clientes WHERE id=$1',[c.id])).rowCount,0);
  assert.equal((await pool.query('SELECT cliente_id FROM cliente_negocio WHERE cliente_id=$1',[c.id])).rowCount,0);
  const logs=(await pool.query("SELECT * FROM auditoria WHERE entidad='cliente' AND entidad_id=$1 ORDER BY fecha_hora",[c.id])).rows;
  assert.equal(logs.length,2);
  const saved=JSON.parse(logs.find(x=>x.accion==='eliminar_sin_actividad').datos_anteriores);
  assert.equal(saved.cliente.notas,'Dato original');assert.equal(saved.cliente.nombre,'Error corregido');assert.equal(saved.negocios[0].negocio_id,a.id);
  assert.equal((await api(path,admin,'DELETE',body)).status,200);
  assert.equal((await api(path,admin,'DELETE',{...body,solicitud_id:randomUUID()})).status,409);
  assert.equal((await pool.query("SELECT id FROM auditoria WHERE entidad='cliente' AND entidad_id=$1",[c.id])).rowCount,2);
});
test('Eliminar PG: empleados, incluso editores, no pueden inspeccionar ni eliminar',async()=>{
  assert.equal((await api(`/clientes/${cliente.id}/eliminacion`)).status,403);
  assert.equal((await api(`/clientes/${cliente.id}`,editor,'DELETE',{})).status,403);
});
test('Eliminar PG: operaciones, cuotas, pagos y comprobantes bloquean sin modificar finanzas',async()=>{
  const before=await finanzas(),p=await api(`/clientes/${cliente.id}/eliminacion`,admin);
  assert.equal(p.body.permitido,false);assert.equal(p.body.actividad.operaciones,1);assert.equal(p.body.actividad.cuotas,6);assert.equal(p.body.actividad.pagos,1);assert.equal(p.body.actividad.comprobantes,1);
  const r=await api(`/clientes/${cliente.id}`,admin,'DELETE',{version:p.body.version,confirmacion:'ELIMINAR',motivo:'QA bloqueo',solicitud_id:randomUUID()});
  assert.equal(r.status,409);assert.deepEqual(await finanzas(),before);
  assert.equal((await pool.query('SELECT id FROM clientes WHERE id=$1',[cliente.id])).rowCount,1);
});
test('Eliminar PG: nueva actividad después de previsualizar invalida la eliminación',async()=>{
  const c=await crearCliente({nombre:'Carrera',apellido:'QA',negocio_id:a.id}),path=`/clientes/${c.id}`;
  const p=await api(path+'/eliminacion',admin);
  await crearVenta({negocio_id:a.id,cliente_id:c.id,fecha:hoy,modalidad:'unico',monto_total_centavos:100000,plan:{fecha_limite:addDays(hoy,30)}});
  assert.equal((await api(path,admin,'DELETE',{version:p.body.version,confirmacion:'ELIMINAR',motivo:'QA concurrencia',solicitud_id:randomUUID()})).status,409);
  assert.equal((await pool.query('SELECT id FROM clientes WHERE id=$1',[c.id])).rowCount,1);
});
test('Eliminar PG: cambios de datos o vínculos requieren nueva confirmación',async()=>{
  const c=await crearCliente({nombre:'Versión',apellido:'QA',negocio_id:a.id}),path=`/clientes/${c.id}`;
  const p=await api(path+'/eliminacion',admin);
  await vincularClienteNegocio(c.id,b.id);
  assert.equal((await api(path,admin,'DELETE',{version:p.body.version,confirmacion:'ELIMINAR',motivo:'QA versión',solicitud_id:randomUUID()})).status,409);
  const n=await api(path+'/eliminacion',admin);assert.equal(n.body.negocios,2);
});
test('Eliminar PG: seguimiento comercial preservado aunque no haya operaciones',async()=>{
  const c=await crearCliente({nombre:'Seguimiento',apellido:'QA',negocio_id:a.id}),path=`/clientes/${c.id}`;
  await pool.query('UPDATE clientes SET seguimiento_nota=$1 WHERE id=$2',['Contactado QA',c.id]);
  const p=await api(path+'/eliminacion',admin);assert.equal(p.body.seguimiento,true);assert.equal(p.body.permitido,false);
  assert.equal((await api(path,admin,'DELETE',{version:p.body.version,confirmacion:'ELIMINAR',motivo:'QA bloqueo',solicitud_id:randomUUID()})).status,409);
});

test('Mora PG: condonación auditada, reintento, empleado denegado y atraso conservado',async()=>{
  const n=await crearNegocio({nombre:'QA mora',dias_gracia:0,mora_tipo:'fijo',mora_valor:8500,mora_periodo:'semana'});
  const c=await crearCliente({nombre:'Mora',apellido:'QA',negocio_id:n.id});
  const v=await crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:addDays(hoy,-2),modalidad:'unico',monto_total_centavos:14000000,plan:{fecha_limite:addDays(hoy,-1)}});
  const q=v.cuotas[0],url=`/pagos/cuotas/${q.id}`;
  const p=await api(url+'/mora',admin);assert.equal(p.body.mora.pendiente,850000);
  const body={version:p.body.version,motivo:'Buen cliente QA',solicitud_id:randomUUID()};
  assert.equal((await api(url+'/perdonar-mora',editor,'POST',body)).status,403);
  const [r1,r2]=await Promise.all([api(url+'/perdonar-mora',admin,'POST',body),api(url+'/perdonar-mora',admin,'POST',body)]);
  assert.equal(r1.status,200);assert.equal(r2.status,200);
  assert.equal((await pool.query("SELECT id FROM auditoria WHERE entidad_id=$1 AND accion='perdonar_mora'",[q.id])).rowCount,1);
  const f=await api(`/clientes/${c.id}?negocio_id=${n.id}`,admin);
  assert.equal(f.body.creditos[0].cuotas[0].moraGenerada,850000);assert.equal(f.body.creditos[0].cuotas[0].moraPerdonada,850000);
  assert.equal(f.body.saldoExigibleCentavos,14000000);
  await registrarPago({credito_id:v.credito.id,monto_centavos:14000000,fecha_hora:`${hoy}T12:00:00-03:00`});
  const after=(await pool.query('SELECT * FROM cuotas WHERE id=$1',[q.id])).rows[0];
  assert.equal(after.dias_atraso_al_pagar,1);assert.equal(after.mora_perdonada_centavos,850000);assert.equal(after.mora_generada_centavos,850000);
});
test('Mora PG: capital primero mantiene mora pendiente, luego cobro y anulación la reabren',async()=>{
  const {anularComprobante}=await import('../src/services/comprobantesService.js');
  const n=await crearNegocio({nombre:'QA capital primero',dias_gracia:0,mora_tipo:'fijo',mora_valor:8500,mora_periodo:'semana',orden_aplicacion_pago:['capital','mora']});
  const c=await crearCliente({nombre:'Cobro',apellido:'QA',negocio_id:n.id});
  const v=await crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:addDays(hoy,-2),modalidad:'unico',monto_total_centavos:14000000,plan:{fecha_limite:addDays(hoy,-1)}});
  await registrarPago({credito_id:v.credito.id,monto_centavos:14000000,fecha_hora:`${hoy}T12:00:00-03:00`});
  let f=await api(`/clientes/${c.id}?negocio_id=${n.id}`,admin);assert.equal(f.body.saldoExigibleCentavos,850000);
  const pago=await registrarPago({credito_id:v.credito.id,cuota_id:v.cuotas[0].id,monto_centavos:850000,fecha_hora:`${hoy}T12:00:00-03:00`});
  assert.equal(pago.aplicaciones[0].mora,850000);assert.equal(pago.remanente,0);
  await anularComprobante(pago.comprobante.id,{motivo:'QA anulación',usuarioId:admin.id});
  f=await api(`/clientes/${c.id}?negocio_id=${n.id}`,admin);assert.equal(f.body.saldoExigibleCentavos,850000);
});

test('Financiación PG: corrige plan y entrega con originales auditados, conserva cuotas pagadas y reintentos',async()=>{
  const n=await crearNegocio({nombre:'QA plan',mora_valor:0});
  const c=await crearCliente({nombre:'Plan',apellido:'QA',negocio_id:n.id});
  const v=await crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:hoy,modalidad:'cuotas',monto_total_centavos:400000,entrega_inicial_centavos:100000,plan:{cantidad_cuotas:3,valor_cuota_centavos:100000,fecha_primera_cuota:addDays(hoy,30)}});
  await registrarPago({credito_id:v.credito.id,monto_centavos:50000,fecha_hora:`${hoy}T12:00:00-03:00`});
  const path=`/ventas/creditos/${v.credito.id}/correccion`,preview=await api(path,admin);
  assert.equal(preview.status,200);assert.equal((await api(path,editor)).status,403);
  const p=preview.body;
  const datos={monto_total_centavos:450000,entrega_inicial_centavos:150000,fecha_inicio:hoy,producto_descripcion:'iPhone corregido QA',condiciones:'Entrega y dos pagos',cuotas:p.cuotas.slice(0,2).map(q=>({id:q.id,monto_centavos:150000,fecha_vencimiento:q.fecha_vencimiento}))};
  const body={version:p.version,datos,motivo:'Error de carga QA',solicitud_id:randomUUID(),confirmar_correccion_pagos:true};
  assert.equal((await api(path,admin,'PATCH',{...body,confirmar_correccion_pagos:false})).status,400);
  assert.equal((await api(path,editor,'PATCH',body)).status,403);
  const first=await api(path,admin,'PATCH',body);assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal((await api(path,admin,'PATCH',body)).status,200);
  const after=(await api(path,admin)).body;
  assert.equal(after.cuotas.length,2);assert.equal(after.cuotas[0].saldo_pendiente_centavos,100000);
  assert.deepEqual(after.aplicaciones,p.aplicaciones);
  assert.equal(after.pagos.filter(x=>x.tipo==='entrega_inicial').length,2);
  assert.equal(after.pagos.find(x=>x.id===v.entregaInicial.pago.id).monto_centavos,100000);
  assert.equal(after.pagos.find(x=>x.id===v.entregaInicial.pago.id).anulado,1);
  assert.equal(after.pagos.find(x=>x.tipo==='entrega_inicial'&&!x.anulado).monto_centavos,150000);
  const old=(await pool.query('SELECT * FROM comprobantes WHERE id=$1',[v.entregaInicial.comprobante.id])).rows[0];
  assert.equal(old.monto_centavos,100000);assert.equal(old.estado,'anulado');
  const audit=(await pool.query("SELECT * FROM auditoria WHERE entidad_id=$1 AND accion='corregir_financiacion'",[v.credito.id])).rows;
  assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].datos_anteriores).cuotas.length,3);
  // Segunda migración debe tolerar entregas anteriores anuladas sin reconstruir ni borrar pagos.
  await migrate();
  const migrated=(await api(path,admin)).body.pagos;
  // La migración histórica completa organización en fixtures creados sin organización.
  assert.deepEqual(migrated,after.pagos.map(p=>({...p,organizacion_id:p.organizacion_id||'default'})));
  await migrate();assert.deepEqual((await api(path,admin)).body.pagos,migrated);
});
test('Financiación PG: no borra cuotas con aplicaciones, ni baja importe por debajo de capital cobrado',async()=>{
  const path=`/ventas/creditos/${s.credito.id}/correccion`,v=(await api(path,admin)).body;
  const datos={monto_total_centavos:v.credito.monto_total_centavos,entrega_inicial_centavos:0,fecha_inicio:v.credito.fecha_inicio,producto_descripcion:'',condiciones:'',cuotas:v.cuotas.map(q=>({id:q.id,monto_centavos:q.monto_centavos,fecha_vencimiento:q.fecha_vencimiento}))};
  const body={version:v.version,datos,motivo:'QA protección',solicitud_id:randomUUID(),confirmar_correccion_pagos:true};
  const before=await finanzas();
  assert.equal((await api(path,admin,'PATCH',{...body,datos:{...datos,cuotas:datos.cuotas.slice(1)}})).status,409);
  assert.equal((await api(path,admin,'PATCH',{...body,datos:{...datos,cuotas:datos.cuotas.map((q,i)=>i? q:{...q,monto_centavos:1})}})).status,409);
  assert.deepEqual(await finanzas(),before);
});

test('Financiación PG: reducción al capital cobrado conserva fecha real y atraso, sin crear otro pago',async()=>{
  const n=await crearNegocio({nombre:'QA corrección capital',mora_valor:0});
  const c=await crearCliente({nombre:'Capital',apellido:'QA',negocio_id:n.id});
  const v=await crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:addDays(hoy,-20),modalidad:'unico',monto_total_centavos:100000,plan:{fecha_limite:addDays(hoy,-10)}});
  await registrarPago({credito_id:v.credito.id,monto_centavos:50000,fecha_hora:`${addDays(hoy,-5)}T12:00:00-03:00`});
  const path=`/ventas/creditos/${v.credito.id}/correccion`,p=(await api(path,admin)).body;
  const datos={monto_total_centavos:50000,entrega_inicial_centavos:0,fecha_inicio:p.credito.fecha_inicio,producto_descripcion:'',condiciones:'',cuotas:p.cuotas.map(q=>({id:q.id,monto_centavos:50000,fecha_vencimiento:q.fecha_vencimiento}))};
  const body={version:p.version,datos,motivo:'QA importe corregido',solicitud_id:randomUUID(),confirmar_correccion_pagos:true};
  const r=await api(path,admin,'PATCH',body);assert.equal(r.status,200,JSON.stringify(r.body));
  const after=(await api(path,admin)).body;
  assert.equal(after.cuotas[0].saldo_pendiente_centavos,0);assert.equal(after.cuotas[0].fecha_saldada,addDays(hoy,-5));assert.equal(after.cuotas[0].dias_atraso_al_pagar,5);
  assert.deepEqual(after.pagos,p.pagos);assert.deepEqual(after.aplicaciones,p.aplicaciones);
  assert.equal((await api(path,admin,'PATCH',{...body,solicitud_id:randomUUID()})).status,409);
  const ficha=(await api(`/clientes/${c.id}?negocio_id=${n.id}`,admin)).body;
  assert.equal(ficha.creditos[0].correcciones.length,1);assert.equal(ficha.creditos[0].correcciones[0].motivo,body.motivo);
  const cambios=ficha.creditos[0].correcciones[0].cambios;
  assert.ok(cambios.some(c=>c.campo==='monto_total_centavos'&&c.anterior===100000&&c.nuevo===50000));
  assert.equal(ficha.creditos[0].correcciones[0].datos_anteriores,undefined);
});
