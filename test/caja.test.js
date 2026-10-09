import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearUsuario,asignarNegocio} from '../src/repositories/usuarios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {guardarCaja,abrirCaja,movimientoCaja,cerrarCaja,detalleCaja,capturarPagoCaja,resolverPendiente} from '../src/services/cajaService.js';
import {vistaFinanciacion,corregirFinanciacion} from '../src/services/financiacionService.js';
import {todayAR,addDays} from '../src/lib/dates.js';
import {app} from '../src/app.js';
import {firmarToken} from '../src/lib/auth.js';
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a=await crearNegocio({nombre:'Caja A',mora_valor:0}),b=await crearNegocio({nombre:'Caja B',mora_valor:0});
const admin=await crearUsuario({email:'admin@caja.invalid',password_hash:'unused'}),employee=await crearUsuario({email:'employee@caja.invalid',password_hash:'unused',rol:'empleado'});
const input={nombre:'Compartida',activa:false,arqueo:false,modalidad:'negocio',negocios:[a.id,b.id]};
let c=await guardarCaja(null,input,admin.id);
const cliente=await crearCliente({nombre:'Caja',apellido:'QA',negocio_id:a.id});
const sale=await crearVenta({negocio_id:a.id,cliente_id:cliente.id,fecha:todayAR(),modalidad:'cuotas',monto_total_centavos:100000,plan:{cantidad_cuotas:2,valor_cuota_centavos:50000,fecha_primera_cuota:addDays(todayAR(),10)}});
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
const payment=()=>registrarPago({credito_id:sale.credito.id,monto_centavos:1000,medio_pago:'efectivo',usuario_id:admin.id});
const tables=async()=>JSON.stringify(await Promise.all(['ventas','creditos','cuotas','pagos','comprobantes'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())));
test('Caja desactivada no bloquea pagos y no agrega movimientos; configuración no altera finanzas',async()=>{
 await payment();assert.equal((await detalleCaja(c.id)).movimientos.length,0);
 const before=await tables();c=await guardarCaja(c.id,{...input,activa:true,arqueo:true,version:c.version},admin.id);assert.equal(await tables(),before);
});
let s;
test('Apertura idempotente y sin duplicación concurrente',async()=>{
 const data={inicial:20000,solicitud_id:randomUUID()};const [x,y]=await Promise.all([abrirCaja(c.id,data,admin.id),abrirCaja(c.id,data,admin.id)]);assert.equal(x.id,y.id);s=x;
 await assert.rejects(abrirCaja(c.id,{...data,solicitud_id:randomUUID()},admin.id),/abierto/);
});
test('Cobros automáticos conservan negocio; ingreso manual no modifica deuda; medios separados',async()=>{
 await payment();const before=await tables();
 const i={solicitud_id:randomUUID(),negocio_id:b.id,tipo:'ingreso',monto:8000,medio:'transferencia',concepto:'QA banco'};
 await Promise.all([movimientoCaja(s.id,i,admin.id),movimientoCaja(s.id,i,admin.id)]);
 assert.equal(await tables(),before);
 const d=await detalleCaja(c.id);assert.equal(d.movimientos.length,2);assert.equal(d.sesiones[0].efectivo_esperado,21000);assert.equal(d.sesiones[0].medios.transferencia,8000);
 assert.equal(d.movimientos.find(x=>x.tipo==='cobro').negocio_id,a.id);
});
test('Arqueo requiere observación por diferencia; cierre conserva valores y no acepta escrituras',async()=>{
 await assert.rejects(cerrarCaja(s.id,{contado:20000},admin.id),/observación/);
 const closed=await cerrarCaja(s.id,{contado:20000,notas:'QA diferencia'},admin.id);assert.equal(closed.diferencia,-1000);
 await assert.rejects(movimientoCaja(s.id,{solicitud_id:randomUUID(),negocio_id:a.id,tipo:'egreso',monto:100,medio:'efectivo',concepto:'QA'},admin.id),/cerrado/);
 await payment();const d=await detalleCaja(c.id);assert.equal(d.sesiones[0].efectivo_esperado,21000);assert.equal(d.movimientos.filter(m=>!m.sesion_id).length,1);
});
test('Sin arqueo no exige conteo; pendientes se concilian explícitamente y una sola vez',async()=>{
 c=await guardarCaja(c.id,{...input,activa:true,version:c.version},admin.id);
 s=await abrirCaja(c.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
 const pending=(await detalleCaja(c.id)).movimientos.find(m=>!m.sesion_id);
 const r={aplicar:true,sesion_id:s.id,motivo:'QA cobro de este período'};
 await resolverPendiente(pending.id,r,admin.id);await resolverPendiente(pending.id,r,admin.id);
 assert.equal((await detalleCaja(c.id)).sesiones.find(x=>x.id===s.id).efectivo_esperado,1000);
 const close=await cerrarCaja(s.id,{},admin.id);assert.equal(close.contado,null);assert.equal(close.diferencia,null);
});
test('Caja no comparte negocios entre configuraciones; no admite IDs inexistentes ni configuración obsoleta',async()=>{
 await assert.rejects(guardarCaja(null,{...input,activa:true},admin.id),/otra caja/);
 await assert.rejects(guardarCaja(c.id,{...input,version:0},admin.id),/cambió/);
 await assert.rejects(guardarCaja(null,{...input,negocios:['missing']},admin.id),/existir/);
});
test('Empleado no obtiene finanzas globales por endpoints alternativos de Caja',async()=>{
 for(const path of ['/cajas','/cajas/'+c.id]){const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{headers:{Authorization:'Bearer '+firmarToken(employee)}});assert.equal(r.status,403);}
});
test('Anulaciones no presuponen devolución física ni alteran cierres anteriores',async()=>{
 const pago=await db.prepare('SELECT * FROM pagos ORDER BY created_at LIMIT 1').get();
 // The selected disabled-module payment has no cash entry and must not create a reversal.
 await db.transaction(()=>capturarPagoCaja(pago,admin.id,'anulacion'));
 const original=(await detalleCaja(c.id)).movimientos.find(m=>m.tipo==='cobro');const p=await db.prepare('SELECT * FROM pagos WHERE id=?').get(original.pago_id);
 await db.transaction(()=>capturarPagoCaja(p,admin.id,'anulacion'));
 const d=await detalleCaja(c.id),reverse=d.movimientos.find(m=>m.tipo==='anulacion');assert.equal(reverse.sesion_id,null);assert.equal(reverse.monto,-p.monto_centavos);
});
test('Corrección documental de entrega no duplica efectivo',async()=>{
 s=await abrirCaja(c.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
 const v=await crearVenta({negocio_id:a.id,cliente_id:cliente.id,fecha:todayAR(),modalidad:'cuotas',monto_total_centavos:10000,entrega_inicial_centavos:1000,usuario_id:admin.id,plan:{cantidad_cuotas:1,valor_cuota_centavos:9000,fecha_primera_cuota:addDays(todayAR(),10)}});
 const old=await vistaFinanciacion(v.credito.id);const before=(await detalleCaja(c.id)).movimientos.length;
 await corregirFinanciacion(v.credito.id,{version:old.version,motivo:'QA corrección documental',solicitud_id:randomUUID(),confirmar_correccion_pagos:true,datos:{monto_total_centavos:10000,entrega_inicial_centavos:2000,fecha_inicio:todayAR(),producto_descripcion:'QA',condiciones:'QA',cuotas:old.cuotas.map(q=>({id:q.id,monto_centavos:8000,fecha_vencimiento:q.fecha_vencimiento}))}},admin.id);
 const after=await detalleCaja(c.id);assert.equal(after.movimientos.filter(m=>m.tipo!=='correccion').length,before);assert.equal(after.movimientos.find(m=>m.tipo==='correccion').sesion_id,null);
 await cerrarCaja(s.id,{},admin.id);
});

test('Períodos por empleado: cada cobro se asigna a su responsable sin compartir saldo',async()=>{
 await asignarNegocio(employee.id,a.id,{'pagos.registrar':true});await asignarNegocio(employee.id,b.id,{'pagos.registrar':true});
 c=await guardarCaja(c.id,{...input,activa:true,modalidad:'empleado',version:c.version},admin.id);
 const sa=await abrirCaja(c.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
 const se=await abrirCaja(c.id,{inicial:0,responsable_id:employee.id,solicitud_id:randomUUID()},admin.id);
 await payment();await registrarPago({credito_id:sale.credito.id,monto_centavos:700,medio_pago:'efectivo',usuario_id:employee.id});
 const d=await detalleCaja(c.id);assert.equal(d.sesiones.find(s=>s.id===sa.id).efectivo_esperado,1000);assert.equal(d.sesiones.find(s=>s.id===se.id).efectivo_esperado,700);
 await assert.rejects(guardarCaja(c.id,{...input,version:c.version},admin.id),/abiertos/);
 await cerrarCaja(sa.id,{},admin.id);await cerrarCaja(se.id,{},admin.id);
});
test('Fallo de auditoría revierte el movimiento de caja',async()=>{
 const se=await abrirCaja(c.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
 await db.exec("CREATE OR REPLACE FUNCTION caja_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entidad='caja' AND NEW.accion='movimiento' THEN RAISE EXCEPTION 'CAJA_AUDIT_FAIL'; END IF; RETURN NEW; END $$; CREATE TRIGGER caja_fail BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION caja_audit_fail()");
 const before=(await detalleCaja(c.id)).movimientos.length;
 try{await assert.rejects(movimientoCaja(se.id,{solicitud_id:randomUUID(),negocio_id:a.id,tipo:'egreso',monto:100,medio:'efectivo',concepto:'QA rollback'},admin.id),/CAJA_AUDIT_FAIL/);assert.equal((await detalleCaja(c.id)).movimientos.length,before);}finally{await db.exec('DROP TRIGGER caja_fail ON auditoria; DROP FUNCTION caja_audit_fail()');}
 await cerrarCaja(se.id,{},admin.id);
});
