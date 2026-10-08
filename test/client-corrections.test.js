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
