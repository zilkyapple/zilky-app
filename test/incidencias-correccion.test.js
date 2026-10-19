import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../src/app.js';
import {pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearNegocio,actualizarNegocio} from '../src/repositories/negocios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearProducto} from '../src/repositories/productos.js';
import {crearUsuario,asignarNegocio} from '../src/repositories/usuarios.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {registrarIncidenciaEquipo,corregirFechaIncidenciaEquipo} from '../src/services/incidenciasService.js';
import {firmarToken} from '../src/lib/auth.js';
import {todayAR,addDays} from '../src/lib/dates.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a=await crearNegocio({nombre:'QA fechas equipos A',mora_valor:0});
const b=await crearNegocio({nombre:'QA fechas equipos B',mora_valor:0});
await actualizarNegocio(a.id,{seguimiento_equipos:1});
await actualizarNegocio(b.id,{seguimiento_equipos:1});
const admin=await crearUsuario({email:'admin@incidencias.invalid',password_hash:'unused'});
const otroAdmin=await crearUsuario({email:'otro-admin@incidencias.invalid',password_hash:'unused'});
const empleado=await crearUsuario({email:'empleado@incidencias.invalid',password_hash:'unused',rol:'empleado'});
await asignarNegocio(empleado.id,a.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true});
const hoy=todayAR();
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});

async function api(path,user=admin,method='GET',body) {
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{
    method,headers:{...(user?{Authorization:'Bearer '+firmarToken(user)}:{}),'Content-Type':'application/json'},
    ...(body&&method!=='GET'?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
async function fixture(tipo='equipo_entregado',negocio=a) {
  const cliente=await crearCliente({nombre:'Fecha equipo',apellido:'QA',negocio_id:negocio.id});
  const producto=await crearProducto({negocio_id:negocio.id,nombre:'Equipo fecha QA',stock:3});
  const venta=await crearVenta({negocio_id:negocio.id,cliente_id:cliente.id,fecha:addDays(hoy,-10),modalidad:'unico',monto_total_centavos:100000,
    entrega_inicial_centavos:20000,plan:{fecha_limite:addDays(hoy,20)},items:[{producto_id:producto.id,descripcion:'Equipo QA',cantidad:1,precio_unitario_centavos:100000}]});
  await registrarPago({credito_id:venta.credito.id,monto_centavos:10000});
  const evento=await registrarIncidenciaEquipo({creditoId:venta.credito.id,clienteId:cliente.id,negocioId:negocio.id,tipo,
    fecha:addDays(hoy,-2),motivo:'Motivo original del hecho QA',solicitudId:randomUUID(),usuarioId:admin.id});
  const scope={creditoId:venta.credito.id,clienteId:cliente.id,negocioId:negocio.id,incidenciaId:evento.id};
  const base=`/clientes/${cliente.id}/creditos/${venta.credito.id}/incidencias/${evento.id}`;
  return {cliente,venta,evento,scope,base,path:base+`?negocio_id=${negocio.id}`};
}
const correccion=version=>({version,fecha:addDays(hoy,-1),motivo:'Corregir fecha mal cargada QA',solicitud_id:randomUUID()});
async function finanzas() {
  return Promise.all(['ventas','venta_detalle','creditos','cuotas','pagos','pago_aplicaciones','comprobantes','saldo_favor','productos']
    .map(async table=>(await pool.query(`SELECT * FROM ${table} ORDER BY ${table==='saldo_favor'?'cliente_id,negocio_id':'id'}`)).rows));
}
async function auditoria(evento) {
  return (await pool.query("SELECT * FROM auditoria WHERE entidad='credito_incidencia' AND entidad_id=$1 AND accion='corregir_fecha_incidencia' ORDER BY fecha_hora",[evento.id])).rows;
}

test('Incidencias PG: consulta y corrección requieren administrador y cliente, crédito y negocio exactos',async()=>{
  const f=await fixture(),otra=await fixture('equipo_retirado',b),preview=await api(f.path);
  assert.equal(preview.status,200);assert.deepEqual(preview.body.evento,f.evento);assert.match(preview.body.version,/^[a-f0-9]{64}$/);
  const body=correccion(preview.body.version),before=await finanzas();
  for(const method of ['GET','PATCH']) {
    assert.equal((await api(f.path,null,method,body)).status,401);
    assert.equal((await api(f.path,empleado,method,body)).status,403);
    assert.equal((await api(f.base,admin,method,method==='PATCH'?body:undefined)).status,400);
    assert.equal((await api(f.base+`?negocio_id=${b.id}`,admin,method,body)).status,404);
    assert.equal((await api(f.path.replace(f.cliente.id,otra.cliente.id),admin,method,body)).status,404);
    assert.equal((await api(f.path.replace(f.venta.credito.id,otra.venta.credito.id),admin,method,body)).status,404);
    assert.equal((await api(f.path.replace(f.evento.id,otra.evento.id),admin,method,body)).status,404);
    assert.equal((await api(f.path.replace(f.evento.id,'inexistente'),admin,method,body)).status,404);
  }
  assert.equal((await api(f.path,admin,'PATCH',{...body,negocio_id:b.id})).status,400);
  assert.deepEqual(await finanzas(),before);assert.equal((await auditoria(f.evento)).length,0);
});

for(const tipo of ['equipo_entregado','equipo_retirado'])test(`Incidencias PG: corrige ${tipo} con auditoría sin alterar motivo original, pagos ni stock`,async()=>{
  const f=await fixture(tipo),preview=await api(f.path),body=correccion(preview.body.version),before=await finanzas();
  const response=await api(f.path,otroAdmin,'PATCH',body);
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.evento,{...f.evento,fecha:body.fecha});assert.notEqual(response.body.version,preview.body.version);
  assert.deepEqual((await api(f.path)).body,response.body);assert.deepEqual(await finanzas(),before);
  const logs=await auditoria(f.evento);assert.equal(logs.length,1);assert.equal(logs[0].empleado,otroAdmin.id);assert.equal(logs[0].motivo,body.motivo);
  assert.deepEqual(JSON.parse(logs[0].datos_anteriores),f.evento);
  assert.deepEqual(JSON.parse(logs[0].datos_nuevos).evento,response.body.evento);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM credito_incidencias WHERE credito_id=$1 AND tipo=$2',[f.venta.credito.id,tipo])).rows[0].n,1);
});

test('Incidencias PG: doble envío y reintento conservan resultado, actor y una sola auditoría',async()=>{
  const f=await fixture(),preview=await api(f.path),body=correccion(preview.body.version);
  const [first,retry]=await Promise.all([api(f.path,admin,'PATCH',body),api(f.path,admin,'PATCH',body)]);
  assert.equal(first.status,200);assert.equal(retry.status,200);assert.deepEqual(first.body.evento,retry.body.evento);
  assert.equal((await auditoria(f.evento)).length,1);
  for(const extra of [{fecha:hoy},{motivo:'Otro motivo de corrección'}])assert.equal((await api(f.path,admin,'PATCH',{...body,...extra})).status,409);
  assert.equal((await api(f.path,otroAdmin,'PATCH',body)).status,409);
  const next=await api(f.path,admin,'PATCH',{...correccion(first.body.version),fecha:hoy});assert.equal(next.status,200);
  const lateRetry=await api(f.path,admin,'PATCH',body);assert.equal(lateRetry.status,200);assert.equal(lateRetry.body.reintentado,true);
  assert.equal((await api(f.path)).body.evento.fecha,hoy);assert.equal((await auditoria(f.evento)).length,2);
});

test('Incidencias PG: versiones viejas no pisan una corrección concurrente',async()=>{
  const f=await fixture(),preview=await api(f.path),body=correccion(preview.body.version);
  const responses=await Promise.all([api(f.path,admin,'PATCH',body),api(f.path,admin,'PATCH',{...body,fecha:hoy,solicitud_id:randomUUID()})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await auditoria(f.evento)).length,1);
});

test('Incidencias PG: valida fecha, versión, motivo y solicitud; los hechos financieros son inmutables',async()=>{
  const f=await fixture(),preview=await api(f.path),body=correccion(preview.body.version),before=await finanzas();
  for(const extra of [{fecha:'2026-02-30'},{fecha:addDays(hoy,1)},{fecha:addDays(hoy,-11)},{fecha:''},
    {motivo:' '},{motivo:'x'.repeat(2001)},{solicitud_id:'corta'},{version:''},{version:undefined}]) {
    const response=await api(f.path,admin,'PATCH',{...body,...extra});assert.equal(response.status,400,JSON.stringify({extra,response}));
  }
  const automatico=(await pool.query("SELECT * FROM credito_incidencias WHERE credito_id=$1 AND tipo NOT IN ('equipo_entregado','equipo_retirado') LIMIT 1",[f.venta.credito.id])).rows[0];
  const automaticoPath=f.path.replace(f.evento.id,automatico.id);
  assert.equal((await api(automaticoPath)).status,409);assert.equal((await api(automaticoPath,admin,'PATCH',body)).status,409);
  assert.deepEqual((await api(f.path)).body.evento,f.evento);assert.deepEqual(await finanzas(),before);assert.equal((await auditoria(f.evento)).length,0);
});

test('Incidencias PG: desactivar seguimiento conserva la posibilidad de corregir fechas ya registradas',async()=>{
  const f=await fixture();
  await actualizarNegocio(a.id,{seguimiento_equipos:0});
  try {
    const preview=await api(f.path);assert.equal(preview.status,200);
    assert.equal((await api(f.path,admin,'PATCH',correccion(preview.body.version))).status,200);
  }finally{await actualizarNegocio(a.id,{seguimiento_equipos:1});}
});

test('Incidencias PG: un fallo de auditoría revierte la fecha y todas las tablas financieras',async()=>{
  const f=await fixture(),preview=await api(f.path),body=correccion(preview.body.version),before=await finanzas();
  await pool.query("CREATE FUNCTION incidencia_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INCIDENCIA_AUDIT_FORCED_FAILURE'; END $$");
  await pool.query('CREATE TRIGGER incidencia_audit_fail_trigger BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION incidencia_audit_fail()');
  try {
    await assert.rejects(()=>corregirFechaIncidenciaEquipo({...f.scope,version:body.version,fecha:body.fecha,motivo:body.motivo,solicitudId:body.solicitud_id,usuarioId:admin.id}),/INCIDENCIA_AUDIT_FORCED_FAILURE/);
  }finally{await pool.query('DROP TRIGGER incidencia_audit_fail_trigger ON auditoria; DROP FUNCTION incidencia_audit_fail()');}
  assert.deepEqual((await api(f.path)).body.evento,f.evento);assert.deepEqual(await finanzas(),before);assert.equal((await auditoria(f.evento)).length,0);
});
