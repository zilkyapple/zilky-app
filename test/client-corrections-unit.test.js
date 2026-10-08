import test from 'node:test';
import assert from 'node:assert/strict';
import { resumenVencimientos } from '../src/lib/vencimientos.js';
import { datosBasicos, validarDatosCliente, versionDatos } from '../src/lib/clientData.js';
import { redondearInteresCentavos } from '../src/lib/money.js';
import { calcularMora, distribuirPago } from '../src/lib/mora.js';

for (const [origen, esperado] of [[8402,8500],[8240,8000],[140237,140000],[140310,140500],[250,500],[249,0],[0,0]]) {
  test(`Interés calculado: $${origen} se redondea a $${esperado}`,()=>assert.equal(redondearInteresCentavos(origen*100),esperado*100));
}
test('Redondeo de mora: se aplica en el motor, no solo en el texto; conserva el pago parcial exacto',()=>{
  const c={id:'qa',fecha_vencimiento:'2026-10-01',monto_centavos:14000000,saldo_pendiente_centavos:14000000,mora_pagada_centavos:20000};
  const negocio={dias_gracia:0,mora_tipo:'fijo',mora_valor:8402,mora_periodo:'semana',orden_aplicacion_pago:'["mora","capital"]'};
  const m=calcularMora(c,negocio,'2026-10-02');
  assert.equal(m.acumulada,850000);assert.equal(m.pendiente,830000);
  const pago=distribuirPago({cuotas:[{...c}],monto:840000,negocio,today:'2026-10-02'});
  assert.equal(pago.aplicaciones[0].mora,830000);assert.equal(pago.aplicaciones[0].capital,10000);
  assert.equal(pago.remanente,0);assert.equal(c.saldo_pendiente_centavos,14000000);
});
test('Redondeo: rechaza importes inválidos sin generar saldos NaN/Infinity',()=>{
  for(const v of [-1,Infinity,NaN,1.5,'500']) assert.throws(()=>redondearInteresCentavos(v));
});

const cuota = (fecha, saldo, mora=0, extra={}) => ({fecha_vencimiento:fecha, saldo_pendiente_centavos:saldo, moraPendiente:mora, ...extra});
test('Exigible: nunca suma cuotas futuras al reclamo; distingue vencida, hoy y próxima',()=>{
  const r=resumenVencimientos([
    cuota('2026-09-13',14000000,850000), cuota('2026-10-13',14000000), cuota('2026-11-13',14000000),
    cuota('2026-12-13',21293900), cuota('2026-10-07',100000), cuota('2026-08-13',0),
    cuota('2026-07-13',99999999,0,{estado_manual:'anulada'}),
  ],'2026-10-07');
  assert.equal(r.saldoExigibleCentavos,14950000); assert.equal(r.saldoVencidoCentavos,14850000);
  assert.equal(r.saldoVenceHoyCentavos,100000); assert.equal(r.cuotasVencidas,1); assert.equal(r.cuotasVencenHoy,1);
  assert.equal(r.vencimientoVencido,'2026-09-13'); assert.equal(r.diasAtrasoVencimiento,24);
  assert.equal(r.proximoVencimiento,'2026-10-13'); assert.equal(r.diasHastaVencimiento,6);
});
test('Exigible: solo agrega mora pendiente; una mora perdonada/cobrada no vuelve al reclamo',()=>{
  const r=resumenVencimientos([cuota('2026-09-13',14000000,0,{moraGenerada:850000,moraPerdonada:850000}),cuota('2026-10-13',14000000)],'2026-10-07');
  assert.equal(r.saldoExigibleCentavos,14000000);
});
test('Exigible: agrega todos los atrasos actuales sin alterar los datos de entrada',()=>{
  const cuotas=[cuota('2026-09-13',1200,100),cuota('2026-08-13',4000,200)];
  const before=structuredClone(cuotas),r=resumenVencimientos(cuotas,'2026-10-07');
  assert.equal(r.saldoExigibleCentavos,5500);assert.equal(r.cuotasVencidas,2);assert.equal(r.proximoVencimiento,null);
  assert.deepEqual(cuotas,before);
});
test('Exigible: sin deuda o únicamente con futuras no reclama saldo',()=>{
  assert.equal(resumenVencimientos([], '2026-10-07').saldoExigibleCentavos,0);
  const r=resumenVencimientos([cuota('2026-10-13',63293900)],'2026-10-07');
  assert.equal(r.saldoExigibleCentavos,0);assert.equal(r.vencimientoVencido,null);
});
test('Cliente: edición preserva campos omitidos y permite vaciar opcionales',()=>{
  const r=validarDatosCliente({nombre:' Bruno ',apellido:'QA',telefono:'123',notas:'Anterior'},{nombre:'Bruno',telefono:' ',notas:'Nueva nota',instagram:'@@bruno'});
  assert.equal(r.telefono,null);assert.equal(r.apellido,'QA');assert.equal(r.instagram,'@bruno');assert.equal(r.notas,'Nueva nota');
});
test('Cliente: no permite cambiar identidad, scope, permisos ni finanzas por mass assignment',()=>{
  for(const key of ['id','organizacion_id','negocio_id','rol','saldo_financiado_centavos','seguimiento_estado','__proto__']) {
    assert.throws(()=>validarDatosCliente({nombre:'Bruno'},JSON.parse(`{"${key}":"intruso"}`)),/no editable/);
  }
});
test('Cliente: valida nombre, fechas reales, tamaños, tipos y URL segura',()=>{
  for(const cambios of [{nombre:''},{telefono:123},{notas:'x'.repeat(10001)},{fecha_nacimiento:'2026-02-30'},{foto_url:'javascript:alert(1)'},[]]) {
    assert.throws(()=>validarDatosCliente({nombre:'Bruno'},cambios));
  }
});
test('Cliente: versión no incluye finanzas ni cambia por orden de campos, pero detecta edición concurrente',()=>{
  assert.equal(versionDatos({nombre:'Bruno',apellido:'QA',deuda:123}),versionDatos({apellido:'QA',nombre:'Bruno'}));
  assert.notEqual(versionDatos({nombre:'Bruno'}),versionDatos({nombre:'Bruno',notas:'Cambio'}));
  assert.equal(datosBasicos({id:'no-exportar',nombre:'Bruno'}).id,undefined);
});
