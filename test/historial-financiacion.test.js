import test from 'node:test';
import assert from 'node:assert/strict';
import {resumenCorreccion,resumenCorreccionPago} from '../src/lib/historialFinanciacion.js';
const evento = () => ({fecha_hora:'2026-10-09',autor:'QA',motivo:'Corregir carga',
  datos_anteriores:JSON.stringify({credito:{monto_total_centavos:100000,entrega_inicial_centavos:0,fecha_inicio:'2026-10-01'},cuotas:[{id:'q',numero:1,monto_centavos:100000,fecha_vencimiento:'2026-11-01'}],pagos:[{nota:'PRIVADO'}]}),
  datos_nuevos:JSON.stringify({requestHash:'INTERNO',despues:{credito:{monto_total_centavos:120000,entrega_inicial_centavos:20000,fecha_inicio:'2026-10-02'},cuotas:[{id:'q',numero:1,monto_centavos:100000,fecha_vencimiento:'2026-11-02'}],pagos:[{nota:'PRIVADO'}]}})});
test('Historial: valores anteriores/nuevos y datos del autor sin snapshots internos',()=>{
 const e=evento(),r=resumenCorreccion(e);
 assert.equal(r.autor,'QA');assert.equal(r.cambios.length,4);
 assert.deepEqual(r.cambios.find(c=>c.campo==='monto_total_centavos'),{campo:'monto_total_centavos',etiqueta:'Importe de la operación',tipo:'dinero',anterior:100000,nuevo:120000});
 assert.doesNotMatch(JSON.stringify(r),/PRIVADO|INTERNO|datos_anteriores|pagos/);
 assert.deepEqual(e,evento());
});
test('Historial: cuotas se comparan por identidad, conserva agregadas y retiradas',()=>{
 const e=evento(),d=JSON.parse(e.datos_nuevos);d.despues.cuotas=[{id:'nueva',numero:1,monto_centavos:50000,fecha_vencimiento:'2026-12-01'}];e.datos_nuevos=JSON.stringify(d);
 const r=resumenCorreccion(e);assert.ok(r.cambios.some(c=>c.nuevo==='Agregada'));assert.ok(r.cambios.some(c=>c.nuevo==='Retirada del plan'));
 assert.ok(r.cambios.some(c=>c.anterior===100000&&c.nuevo===null));
});
test('Historial: registros incompletos no bloquean la ficha ni inventan cambios',()=>{
 for(const e of [{}, {datos_anteriores:'{',datos_nuevos:'null'}, {datos_anteriores:'null',datos_nuevos:'{}'}])assert.deepEqual(resumenCorreccion(e).cambios,[]);
});

test('Historial: distingue fecha de retiro, anticipo e interés sin exponer otros pagos',()=>{
 const e={datos_anteriores:{credito:{fecha_inicio:'2026-01-01'},pagos:[{tipo:'entrega_inicial',fecha_hora:'2026-01-01T12:00:00-03:00',nota:'privada'}]},datos_nuevos:{despues:{credito:{fecha_inicio:'2026-02-01',mora_modo:'sin_interes'},pagos:[{tipo:'entrega_inicial',fecha_hora:'2026-01-01T12:00:00-03:00',anulado:1},{tipo:'entrega_inicial',fecha_hora:'2026-01-20T12:00:00-03:00'}]}}};
 const r=resumenCorreccion(e);
 assert.equal(r.cambios.find(c=>c.campo==='fecha_entrega_inicial').nuevo,'2026-01-20');
 assert.equal(r.cambios.find(c=>c.campo==='mora_modo').nuevo,'Sin interés por atraso');
 assert.doesNotMatch(JSON.stringify(r),/privada|requestHash/);
});

test('Historial de pago: muestra la corrección y el vínculo sin filtrar la ficha completa',()=>{
 const r=resumenCorreccionPago({entidad_id:'original',autor:'Dueño',motivo:'Error al copiar el cuaderno',fecha_hora:'2026-10-18',datos_anteriores:JSON.stringify({pago:{monto_centavos:20000000,fecha_hora:'2026-03-01T12:00:00-03:00',medio_pago:'efectivo',nota:null},credito:{privado:'no publicar'},cuotas:[{id:'secreto'}]}),datos_nuevos:JSON.stringify({reemplazo_id:'correcto',requestHash:'interno',datos:{monto_centavos:25000000,fecha_hora:'2026-03-10T12:00:00-03:00',medio_pago:'efectivo',nota:null}})});
 assert.equal(r.pago_id,'original');assert.equal(r.reemplazo_id,'correcto');assert.equal(r.cambios.length,2);
 assert.equal(r.cambios[0].anterior,20000000);assert.equal(r.cambios[0].nuevo,25000000);
 assert.doesNotMatch(JSON.stringify(r),/privado|secreto|interno|credito|cuotas/);
});
