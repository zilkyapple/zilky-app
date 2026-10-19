import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearUsuario} from '../src/repositories/usuarios.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {vistaFinanciacion,corregirFinanciacion} from '../src/services/financiacionService.js';
import {todayAR,addDays} from '../src/lib/dates.js';
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin=await crearUsuario({email:'admin@historica.invalid',password_hash:'unused'});
const negocio=await crearNegocio({nombre:'QA carga histórica',dias_gracia:0,mora_tipo:'fijo',mora_valor:1000,mora_periodo:'semana'});
const hoy=todayAR(),compra=addDays(hoy,-100),vence=addDays(hoy,-60);
test.after(()=>pool.end());
async function fixture(){
  const c=await crearCliente({nombre:'Histórico',apellido:'QA',negocio_id:negocio.id});
  return crearVenta({negocio_id:negocio.id,cliente_id:c.id,fecha:compra,modalidad:'cuotas',monto_total_centavos:46500000,
    plan:{cantidad_cuotas:3,valor_cuota_centavos:15500000,fecha_primera_cuota:vence}});
}
async function corregir(id,cambios={}){
  const v=await vistaFinanciacion(id);
  return corregirFinanciacion(id,{version:v.version,solicitud_id:randomUUID(),motivo:'Corregir carga histórica QA',confirmar_correccion_pagos:true,
    datos:{monto_total_centavos:v.credito.monto_total_centavos,entrega_inicial_centavos:v.credito.entrega_inicial_centavos,fecha_inicio:v.credito.fecha_inicio,
      producto_descripcion:'Descripción histórica correcta',condiciones:'',cuotas:v.cuotas.map(q=>({id:q.id,monto_centavos:q.monto_centavos,fecha_vencimiento:q.fecha_vencimiento})),...cambios}},admin.id);
}
test('Carga histórica: corregir descripción o entrega física antes de pagos no congela mora de hoy',async()=>{
  const v=await fixture();
  await corregir(v.credito.id,{fecha_entrega_producto:compra});
  assert.equal((await vistaFinanciacion(v.credito.id)).cuotas.every(q=>q.mora_generada_centavos===0),true);
  const r=await registrarPago({credito_id:v.credito.id,monto_centavos:15500000,fecha_hora:`${vence}T12:00:00-03:00`,usuario_id:admin.id});
  assert.equal(r.aplicaciones.reduce((s,a)=>s+a.mora,0),0);
  const q=(await vistaFinanciacion(v.credito.id)).cuotas;
  assert.equal(q[0].saldo_pendiente_centavos,0);
  assert.equal(q[0].fecha_saldada,vence);
  assert.equal(q[1].saldo_pendiente_centavos,15500000);
});
test('Carga histórica: editar documentación después de un pago no congela mora de otras cuotas',async()=>{
  const v=await fixture();
  await registrarPago({credito_id:v.credito.id,monto_centavos:15500000,fecha_hora:`${vence}T12:00:00-03:00`,usuario_id:admin.id});
  const before=await vistaFinanciacion(v.credito.id);
  await corregir(v.credito.id,{fecha_entrega_producto:compra});
  const after=await vistaFinanciacion(v.credito.id);
  assert.deepEqual(after.cuotas,before.cuotas);
  assert.deepEqual(after.pagos,before.pagos);
  assert.deepEqual(after.aplicaciones,before.aplicaciones);
});
test('Carga histórica: un plan sin pagos se corrige sin guardar interés estimado como cobrado',async()=>{
  const v=await fixture(),p=await vistaFinanciacion(v.credito.id);
  await corregir(v.credito.id,{cuotas:p.cuotas.map(q=>({id:q.id,monto_centavos:q.monto_centavos,fecha_vencimiento:addDays(q.fecha_vencimiento,-1)}))});
  const after=await vistaFinanciacion(v.credito.id);
  assert.equal(after.cuotas.every(q=>q.mora_generada_centavos===0&&q.mora_pagada_centavos===0),true);
});
