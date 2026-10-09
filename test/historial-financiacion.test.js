import test from 'node:test';
import assert from 'node:assert/strict';
import {resumenCorreccion} from '../src/lib/historialFinanciacion.js';
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
