import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearUsuario} from '../src/repositories/usuarios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearCuota,getCuota} from '../src/repositories/cuotas.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {guardarCaja,detalleCaja} from '../src/services/cajaService.js';
import {vistaFinanciacion,corregirFinanciacion} from '../src/services/financiacionService.js';
import {calcularMora} from '../src/lib/mora.js';
import {todayAR,addDays} from '../src/lib/dates.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin=await crearUsuario({email:'dueno@correcciones-fechas.invalid',password_hash:'unused'});
const hoy=todayAR();
test.after(()=>pool.end());

async function fixture({entrega=0,mora=0}={}){
  const negocio=await crearNegocio({nombre:'QA fechas '+randomUUID(),dias_gracia:0,mora_tipo:'fijo',mora_valor:mora,mora_periodo:'semana'});
  const cliente=await crearCliente({nombre:'Fechas',apellido:'QA',negocio_id:negocio.id});
  const venta=await crearVenta({negocio_id:negocio.id,cliente_id:cliente.id,fecha:addDays(hoy,-20),modalidad:'cuotas',
    monto_total_centavos:1000000+entrega,entrega_inicial_centavos:entrega,usuario_id:admin.id,
    plan:{cantidad_cuotas:1,valor_cuota_centavos:1000000,fecha_primera_cuota:addDays(hoy,-5)}});
  return {negocio,cliente,venta,id:venta.credito.id};
}
function datosDe(v,cambios={}){
  return {monto_total_centavos:v.credito.monto_total_centavos,entrega_inicial_centavos:v.credito.entrega_inicial_centavos,
    fecha_inicio:v.credito.fecha_inicio,producto_descripcion:v.credito.producto_descripcion||'',condiciones:v.credito.condiciones||'',
    cuotas:v.cuotas.map(q=>({id:q.id,monto_centavos:q.monto_centavos,fecha_vencimiento:q.fecha_vencimiento})),...cambios};
}
function solicitud(v,datos,extra={}){
  return {version:v.version,solicitud_id:randomUUID(),motivo:'Corrección de carga histórica QA',confirmar_correccion_pagos:true,datos,...extra};
}

test('Fechas PG: corrige vencimiento pagado y retiro posterior al anticipo, conservando pagos, aplicaciones y saldo',async()=>{
  const {id}=await fixture({entrega:200000});
  await registrarPago({credito_id:id,monto_centavos:1000000,fecha_hora:`${addDays(hoy,-3)}T12:00:00-03:00`});
  const antes=await vistaFinanciacion(id);
  const datos=datosDe(antes,{fecha_inicio:addDays(hoy,-10),cuotas:antes.cuotas.map(q=>({id:q.id,monto_centavos:q.monto_centavos,fecha_vencimiento:addDays(hoy,-1)}))});
  const body=solicitud(antes,datos);
  await corregirFinanciacion(id,body,admin.id);
  const despues=await vistaFinanciacion(id);
  assert.equal(despues.credito.fecha_inicio,addDays(hoy,-10));
  assert.equal(despues.fecha_entrega_inicial,addDays(hoy,-20));
  assert.equal(despues.cuotas[0].fecha_vencimiento,addDays(hoy,-1));
  assert.equal(despues.cuotas[0].fecha_saldada,addDays(hoy,-3));
  assert.equal(despues.cuotas[0].dias_atraso_al_pagar,0);
  assert.equal(despues.cuotas[0].saldo_pendiente_centavos,0);
  assert.deepEqual(despues.pagos,antes.pagos);
  assert.deepEqual(despues.aplicaciones,antes.aplicaciones);
  assert.equal((await corregirFinanciacion(id,body,admin.id)).reintentado,true);
  const logs=await db.prepare("SELECT * FROM auditoria WHERE entidad_id=? AND accion='corregir_financiacion'").all(id);
  assert.equal(logs.length,1);
  assert.equal(JSON.parse(logs[0].datos_anteriores).cuotas[0].dias_atraso_al_pagar,2);
});

test('Fechas PG: fecha independiente de entrega reemplaza comprobante sin duplicar efectivo ni modificar cuotas',async()=>{
  const {id,negocio}=await fixture({entrega:200000});
  const caja=await guardarCaja(null,{nombre:'QA documentación',activa:true,arqueo:false,modalidad:'negocio',negocios:[negocio.id]},admin.id);
  await db.prepare("UPDATE pagos SET nota='Seña histórica',empleado='Responsable original',comprobante_url='https://example.invalid/comprobante' WHERE credito_id=? AND tipo='entrega_inicial' AND anulado=0").run(id);
  const antes=await vistaFinanciacion(id),old=antes.pagos.find(p=>p.tipo==='entrega_inicial'&&!p.anulado);
  const efectivoAntes=await detalleCaja(caja.id);
  const datos=datosDe(antes,{fecha_entrega_inicial:addDays(hoy,-25)}),body=solicitud(antes,datos);
  await Promise.all([corregirFinanciacion(id,body,admin.id),corregirFinanciacion(id,body,admin.id)]);
  const despues=await vistaFinanciacion(id),active=despues.pagos.filter(p=>p.tipo==='entrega_inicial'&&!p.anulado);
  assert.equal(active.length,1);assert.notEqual(active[0].id,old.id);
  assert.equal(active[0].monto_centavos,old.monto_centavos);assert.equal(active[0].fecha_hora.slice(0,10),addDays(hoy,-25));
  for(const key of ['caja','empleado','comprobante_url','nota'])assert.equal(active[0][key],old[key]);
  assert.equal(despues.pagos.find(p=>p.id===old.id).anulado,1);
  assert.equal(despues.pagos.find(p=>p.id===old.id).fecha_hora,old.fecha_hora);
  assert.deepEqual(despues.cuotas,antes.cuotas);assert.deepEqual(despues.aplicaciones,antes.aplicaciones);
  const recibos=await db.prepare('SELECT * FROM comprobantes WHERE credito_id=?').all(id);
  assert.equal(recibos.length,2);assert.equal(recibos.find(c=>c.pago_id===old.id).estado,'anulado');
  assert.equal(recibos.find(c=>c.pago_id===active[0].id).estado,'emitido');
  assert.equal(recibos.find(c=>c.pago_id===active[0].id).comprobante_original_id,recibos.find(c=>c.pago_id===old.id).id);
  assert.deepEqual((await detalleCaja(caja.id)).movimientos,efectivoAntes.movimientos);
});

test('Fechas PG: aumentar cuota saldada reabre únicamente diferencia; no permite importe inferior a lo cobrado',async()=>{
  const {id}=await fixture();
  await registrarPago({credito_id:id,monto_centavos:1000000,fecha_hora:`${hoy}T12:00:00-03:00`});
  const antes=await vistaFinanciacion(id);
  const datos=datosDe(antes,{monto_total_centavos:1200000,cuotas:antes.cuotas.map(q=>({id:q.id,monto_centavos:1200000,fecha_vencimiento:q.fecha_vencimiento}))});
  await corregirFinanciacion(id,solicitud(antes,datos),admin.id);
  const despues=await vistaFinanciacion(id);
  assert.equal(despues.cuotas[0].saldo_pendiente_centavos,200000);
  assert.equal(despues.cuotas[0].fecha_saldada,null);assert.equal(despues.cuotas[0].dias_atraso_al_pagar,null);
  assert.deepEqual(despues.pagos,antes.pagos);assert.deepEqual(despues.aplicaciones,antes.aplicaciones);
  const invalid=datosDe(despues,{cuotas:despues.cuotas.map(q=>({id:q.id,monto_centavos:999999,fecha_vencimiento:q.fecha_vencimiento}))});
  await assert.rejects(corregirFinanciacion(id,solicitud(despues,invalid),admin.id),/menor al capital cobrado/);
  assert.deepEqual(await vistaFinanciacion(id),despues);
});

test('Interés PG: sin interés exige confirmar pendiente, preserva lo cobrado y no cambia reglas de otros préstamos',async()=>{
  const {id,negocio}=await fixture({mora:1000});
  await registrarPago({credito_id:id,monto_centavos:40000,fecha_hora:`${addDays(hoy,-2)}T12:00:00-03:00`});
  const antes=await vistaFinanciacion(id);
  assert.equal(antes.mora_pendiente_centavos,60000);assert.equal(antes.interes.pagada_centavos,40000);
  const body=solicitud(antes,datosDe(antes,{mora_modo:'sin_interes'}));
  await assert.rejects(corregirFinanciacion(id,body,admin.id),/Confirmá el interés pendiente/);
  assert.deepEqual(await vistaFinanciacion(id),antes);
  body.confirmar_sin_interes=true;
  await corregirFinanciacion(id,body,admin.id);
  const despues=await vistaFinanciacion(id);
  assert.equal(despues.credito.mora_modo,'sin_interes');assert.equal(despues.cuotas[0].mora_modo,'sin_interes');
  assert.equal(despues.interes.pagada_centavos,40000);assert.equal(despues.interes.perdonada_centavos,60000);assert.equal(despues.mora_pendiente_centavos,0);
  assert.equal(calcularMora(despues.cuotas[0],negocio,addDays(hoy,90)).pendiente,0);
  assert.deepEqual(despues.pagos,antes.pagos);assert.deepEqual(despues.aplicaciones,antes.aplicaciones);
  const otra=await fixture({mora:1000});
  assert.equal((await vistaFinanciacion(otra.id)).mora_pendiente_centavos,100000);
  assert.equal((await db.prepare('SELECT mora_valor FROM negocios WHERE id=?').get(negocio.id)).mora_valor,1000);
  await migrate();assert.equal((await vistaFinanciacion(id)).credito.mora_modo,'sin_interes');
  const nueva=await crearCuota({credito_id:id,numero:2,monto_centavos:100000,fecha_vencimiento:addDays(hoy,10)});
  assert.equal(nueva.mora_modo,'sin_interes');
  await db.prepare("UPDATE cuotas SET mora_modo='negocio' WHERE id=?").run(nueva.id);
  assert.equal((await getCuota(nueva.id)).mora_modo,'sin_interes');
});

test('Interés PG: cambiar reglas del negocio invalida confirmación previa y no crea correcciones parciales',async()=>{
  const {id,negocio}=await fixture({mora:1000});
  const antes=await vistaFinanciacion(id),body=solicitud(antes,datosDe(antes,{mora_modo:'sin_interes'}),{confirmar_sin_interes:true});
  await db.prepare('UPDATE negocios SET mora_valor=2000 WHERE id=?').run(negocio.id);
  await assert.rejects(corregirFinanciacion(id,body,admin.id),e=>e.status===409&&/cambió/.test(e.message));
  const despues=await vistaFinanciacion(id);
  assert.equal(despues.credito.mora_modo,'negocio');assert.deepEqual(despues.cuotas,antes.cuotas);
  assert.equal((await db.prepare("SELECT id FROM auditoria WHERE entidad_id=? AND accion='corregir_financiacion'").all(id)).length,0);
});

test('Interés PG: volver a política del negocio conserva perdones y sincroniza cuotas existentes',async()=>{
  const {id}=await fixture();
  let actual=await vistaFinanciacion(id);
  await corregirFinanciacion(id,solicitud(actual,datosDe(actual,{mora_modo:'sin_interes'})),admin.id);
  actual=await vistaFinanciacion(id);
  await corregirFinanciacion(id,solicitud(actual,datosDe(actual,{mora_modo:'negocio'})),admin.id);
  const despues=await vistaFinanciacion(id);
  assert.equal(despues.credito.mora_modo,'negocio');assert.equal(despues.cuotas[0].mora_modo,'negocio');
  assert.equal(despues.cuotas[0].mora_perdonada_centavos,actual.cuotas[0].mora_perdonada_centavos);
});

test('Corrección PG: validaciones de fecha futura y campos de cuota no modifican historial',async()=>{
  const {id}=await fixture({entrega:200000}),antes=await vistaFinanciacion(id);
  for(const cambios of [
    {fecha_entrega_inicial:addDays(hoy,1)},
    {fecha_entrega_inicial:'2026-02-30'},
    {mora_modo:'otra'},
    {cuotas:[{...datosDe(antes).cuotas[0],saldo_pendiente_centavos:0}]},
  ])await assert.rejects(corregirFinanciacion(id,solicitud(antes,datosDe(antes,cambios)),admin.id),e=>e.status===400);
  assert.deepEqual(await vistaFinanciacion(id),antes);
});

test('Corrección PG: cobro de otro cliente y corrección en el mismo negocio conservan caja sin bloqueos cruzados',async()=>{
  const {id,negocio}=await fixture({entrega:200000});
  const caja=await guardarCaja(null,{nombre:'QA concurrencia documental',activa:true,arqueo:false,modalidad:'negocio',negocios:[negocio.id]},admin.id);
  const cliente=await crearCliente({nombre:'Otro cliente',apellido:'QA',negocio_id:negocio.id});
  const otra=await crearVenta({negocio_id:negocio.id,cliente_id:cliente.id,fecha:hoy,modalidad:'cuotas',monto_total_centavos:1000000,
    plan:{cantidad_cuotas:1,valor_cuota_centavos:1000000,fecha_primera_cuota:addDays(hoy,30)}});
  const vista=await vistaFinanciacion(id);
  const correccion=solicitud(vista,datosDe(vista,{monto_total_centavos:1300000,entrega_inicial_centavos:300000}));
  const acotada=fn=>db.transaction(async()=>{await db.query("SET LOCAL lock_timeout = '3s'");return fn();});
  await Promise.all([
    acotada(()=>corregirFinanciacion(id,correccion,admin.id)),
    acotada(()=>registrarPago({credito_id:otra.credito.id,monto_centavos:100000,fecha_hora:`${hoy}T12:00:00-03:00`,usuario_id:admin.id})),
  ]);
  const movimientos=(await detalleCaja(caja.id)).movimientos;
  assert.equal(movimientos.filter(m=>m.tipo==='cobro').length,1);
  assert.equal(movimientos.find(m=>m.tipo==='cobro').monto,100000);
  assert.equal(movimientos.filter(m=>m.tipo==='correccion').length,1);
  assert.equal((await vistaFinanciacion(id)).credito.entrega_inicial_centavos,300000);
  assert.equal((await vistaFinanciacion(otra.credito.id)).cuotas[0].saldo_pendiente_centavos,900000);
});
