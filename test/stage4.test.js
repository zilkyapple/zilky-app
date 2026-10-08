import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { db,pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente,vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearUsuario,asignarNegocio } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR,addDays } from '../src/lib/dates.js';
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const hoy=todayAR(),a=await crearNegocio({nombre:'A QA',mora_valor:0}),b=await crearNegocio({nombre:'B QA',mora_valor:0});
const c=await crearCliente({nombre:'Contacto',apellido:'QA',negocio_id:a.id});await vincularClienteNegocio(c.id,b.id);
const admin=await crearUsuario({email:'admin@stage4.invalid',password_hash:'unused'});
const emp=await crearUsuario({email:'emp@stage4.invalid',password_hash:'unused',rol:'empleado'});
await asignarNegocio(emp.id,a.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true});
await asignarNegocio(emp.id,b.id,{'clientes.ver':true});
const venta=async n=>crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:hoy,modalidad:'unico',monto_total_centavos:100000,entrega_inicial_centavos:0,plan:{fecha_limite:addDays(hoy,3)}});
const va=await venta(a),vb=await venta(b);
const qa=(await db.prepare('SELECT * FROM cuotas WHERE credito_id=?').all(va.credito.id))[0];
const qb=(await db.prepare('SELECT * FROM cuotas WHERE credito_id=?').all(vb.credito.id))[0];
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
async function req(path,body,user=emp,method='POST') {const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{Authorization:'Bearer '+firmarToken(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const path=`/clientes/${c.id}/contactos?negocio_id=${a.id}`;
const body={cuota_id:qa.id,fecha:addDays(hoy,5),nota:'Comprometió contacto posterior',solicitud_id:'qa-contacto-stage4-00001'};
let contacto;
test('Etapa4: empleado programa contacto sin cambiar vencimiento ni deuda',async()=>{
  const r=await req(path,body);assert.equal(r.status,200);contacto=r.body;
  assert.equal(contacto.fecha_vencimiento_real,qa.fecha_vencimiento);
  assert.equal(contacto.fecha_contacto,body.fecha);
  assert.deepEqual(await db.prepare('SELECT * FROM cuotas WHERE id=?').get(qa.id),qa);
});
test('Etapa4: reintento/concurrencia no duplica contactos y rechaza reutilización distinta',async()=>{
  const rs=await Promise.all([req(path,body),req(path,body)]);assert.ok(rs.every(r=>r.status===200));
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM recordatorios WHERE cuota_id=?').get(qa.id)).n,1);
  assert.equal((await req(path,{...body,nota:'Otra nota'})).status,409);
  assert.equal((await req(path,{...body,solicitud_id:'qa-contacto-stage4-00002'})).status,409);
});
test('Etapa4: no cruza negocios ni permisos y exige negocio explícito',async()=>{
  assert.equal((await req(path,{...body,cuota_id:qb.id,solicitud_id:'qa-contacto-stage4-00003'})).status,404);
  assert.equal((await req(`/clientes/${c.id}/contactos?negocio_id=${b.id}`,{...body,cuota_id:qb.id})).status,403);
  assert.equal((await req(`/clientes/${c.id}/contactos`,body)).status,400);
  assert.equal((await req(path,{...body,negocio_id:b.id})).status,400);
});
test('Etapa4: reprogramar conserva original, registra autor, rechaza edición obsoleta',async()=>{
  const version=JSON.stringify([contacto.fecha_contacto,contacto.reprogramado_fecha,contacto.nota]);
  const data={accion:'reprogramar',fecha:addDays(hoy,8),nota:'Cliente pidió nueva fecha',version};
  const url=`/clientes/${c.id}/contactos/${contacto.id}?negocio_id=${a.id}`;
  const r=await req(url,data,emp,'PATCH');assert.equal(r.status,200);contacto=r.body;
  assert.equal(contacto.fecha_vencimiento_real,qa.fecha_vencimiento);
  assert.equal((await req(url,data,emp,'PATCH')).status,409);
  const audit=await db.prepare("SELECT * FROM auditoria WHERE entidad_id=? AND accion='reprogramar'").get(contacto.id);
  assert.equal(audit.empleado,emp.id);assert.equal(JSON.parse(audit.datos_anteriores).fecha_contacto,body.fecha);
});
test('Etapa4: modos son del cliente-negocio, solo admin cambia y sin clasificar especial',async()=>{
  const url=`/clientes/${c.id}/cobranza-modo?negocio_id=${a.id}`;
  const data={modo:'pausada',anterior:'revisar',nota:'Acuerdo manual QA'};
  assert.equal((await req(url,data)).status,403);
  assert.equal((await req(url,data,admin)).status,200);
  let conf=await db.prepare('SELECT * FROM cliente_negocio_cobranza WHERE cliente_id=? AND negocio_id=?').get(c.id,a.id);
  assert.equal(conf.gestion_especial,0);
  assert.equal((await req(url,{...data,modo:'automatico'},admin)).status,409);
  assert.equal((await req(url,{modo:'automatico',anterior:'pausada',nota:'Reanudar QA'},admin)).status,200);
});
test('Etapa4: ficha y lista operativa exponen solo contactos autorizados sin totales',async()=>{
  const rb=await req(`/clientes/${c.id}/contactos?negocio_id=${b.id}`,{...body,cuota_id:qb.id,solicitud_id:'qa-contacto-stage4-00004'},admin);assert.equal(rb.status,200);
  const f=await req(`/clientes/${c.id}?negocio_id=${a.id}`,null,emp,'GET');assert.equal(f.status,200);
  assert.equal(f.body.contactosCobranza.length,1);assert.equal(f.body.contactosCobranza[0].historial.length,2);
  const list=await req('/dashboard/cobranza',null,emp,'GET');assert.equal(list.status,200);
  assert.equal(list.body.contactos.length,1);assert.equal(list.body.contactos[0].negocio_id,a.id);
  assert.equal(list.body.todas.length,1);
  const reminders=await req(`/dashboard/recordatorios?negocio_id=${a.id}`,null,emp,'GET');assert.deepEqual(reminders.body,[]);
});
test('Etapa4: pago parcial mantiene contacto; pago final lo cancela y conserva historial',async()=>{
  await registrarPago({credito_id:va.credito.id,monto_centavos:1000,usuario_id:emp.id});
  assert.equal((await db.prepare('SELECT estado FROM recordatorios WHERE id=?').get(contacto.id)).estado,'pendiente');
  await registrarPago({credito_id:va.credito.id,monto_centavos:99000,usuario_id:emp.id});
  assert.equal((await db.prepare('SELECT estado FROM recordatorios WHERE id=?').get(contacto.id)).estado,'cancelado_pago');
  const audit=await db.prepare("SELECT * FROM auditoria WHERE entidad_id=? AND accion='cancelado_pago'").get(contacto.id);assert.equal(audit.empleado,emp.id);
  const list=await req('/dashboard/cobranza',null,emp,'GET');assert.equal(list.body.contactos.length,0);
  assert.equal((await req(path,{...body,solicitud_id:'qa-contacto-stage4-00005'})).status,400);
  assert.equal((await db.prepare('SELECT estado FROM recordatorios WHERE cuota_id=?').get(qb.id)).estado,'pendiente');
});
test('Etapa4: cancelar/realizar contacto no simula envío ni cambia saldo',async()=>{
  const r=await db.prepare('SELECT * FROM recordatorios WHERE cuota_id=?').get(qb.id);
  const url=`/clientes/${c.id}/contactos/${r.id}?negocio_id=${b.id}`;
  const response=await req(url,{accion:'realizado',nota:'Conversación declarada por QA',version:JSON.stringify([r.fecha_contacto,r.reprogramado_fecha,r.nota])},admin,'PATCH');
  assert.equal(response.status,200);assert.equal(response.body.estado,'realizado');assert.equal(response.body.enviado_fecha,null);
  assert.equal((await db.prepare('SELECT saldo_pendiente_centavos FROM cuotas WHERE id=?').get(qb.id)).saldo_pendiente_centavos,100000);
});
