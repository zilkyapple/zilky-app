import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {datosContratoCelular,renderBorradorContratoCelular,advertenciasContratoCelular,CLAUSULAS_CELULAR} from '../src/lib/contratoCelular.js';
const fixture=()=>({
 cliente:{id:'client',nombre:'Cliente',apellido:'QA',dni:'00000000',direccion:'Domicilio QA',telefono:'000'},
 venta:{id:'sale',cliente_id:'client',negocio_id:'store',monto_total_centavos:110000,entrega_inicial_centavos:10000},
 credito:{id:'credit',venta_id:'sale',cliente_id:'client',negocio_id:'store',monto_total_centavos:110000,entrega_inicial_centavos:10000},
 cuotas:[{credito_id:'credit',numero:2,monto_centavos:33333,fecha_vencimiento:'2026-12-10',saldo_pendiente_centavos:0},{credito_id:'credit',numero:1,monto_centavos:33333,fecha_vencimiento:'2026-11-10',saldo_pendiente_centavos:0},{credito_id:'credit',numero:3,monto_centavos:33334,fecha_vencimiento:'2027-01-10',saldo_pendiente_centavos:1}],
 vendedor:{nombre:'Vendedor QA',dni:'00000001'},equipo:{marca:'Marca QA',imei:'000000000000001'},fecha_documento:'2026-10-10',lugar:'Lugar QA'
});
test('Contrato usa montos nominales originales, no deuda restante ni cuotas redondeadas',()=>{
 const f=fixture(),before=JSON.stringify(f),d=datosContratoCelular(f),doc=new JSDOM(renderBorradorContratoCelular(d)).window.document;
 assert.equal(JSON.stringify(f),before);assert.equal(d.total_centavos,110000);assert.equal(d.cuotas.reduce((s,q)=>s+q.monto_centavos,10000),110000);
 assert.deepEqual([...doc.querySelectorAll('table:nth-of-type(2) tbody tr')].map(r=>r.textContent),['110/11/2026$ 333,33','210/12/2026$ 333,33','310/01/2027$ 333,34']);
 assert.match(doc.body.textContent,/según detalle de cuotas/);assert.match(doc.body.textContent,/No emitido ni firmado/);
});
test('Contrato conserva todas las cláusulas suministradas y firmas sin completar',()=>{
 const doc=new JSDOM(renderBorradorContratoCelular(datosContratoCelular(fixture()))).window.document;
 for(const [title,paragraphs] of CLAUSULAS_CELULAR){assert.ok(doc.body.textContent.includes(title));for(const p of paragraphs)assert.ok(doc.body.textContent.includes(p));}
 assert.equal(doc.querySelectorAll('h2').length,13);assert.equal(doc.querySelectorAll('script').length,0);
 assert.match(doc.body.textContent,/No se exige pagaré como requisito general/);
});
test('Datos personales y equipo no ejecutan HTML; no se infieren datos faltantes',()=>{
 const f=fixture();f.cliente.nombre='<img src=x onerror=alert(1)>';f.equipo.observaciones='<script>alert(2)</script>';const d=datosContratoCelular(f);const doc=new JSDOM(renderBorradorContratoCelular(d)).window.document;
 assert.equal(doc.querySelectorAll('img,script').length,0);assert.ok(doc.body.textContent.includes(f.cliente.nombre));assert.equal(d.equipo.modelo,'');
 assert.ok(doc.body.textContent.includes('__________________'));
});
test('Rechaza mezcla de cliente, venta, negocio, cuotas e importes inconsistentes',()=>{
 for(const mutate of [f=>f.credito.negocio_id='other',f=>f.credito.cliente_id='other',f=>f.cuotas[0].credito_id='other',f=>f.cuotas[0].monto_centavos++,f=>f.cuotas[0].numero=1,f=>f.cuotas[0].monto_centavos=-1,f=>f.fecha_documento='2026-02-30']){const f=fixture();mutate(f);assert.throws(()=>datosContratoCelular(f));}
});
test('El autocompletado es una instantánea independiente de los objetos de origen',()=>{
 const f=fixture(),d=datosContratoCelular(f);f.cliente.nombre='Nuevo';f.cuotas[0].monto_centavos=1;assert.equal(d.comprador.nombre,'Cliente QA');assert.equal(d.cuotas[1].monto_centavos,33333);
});
test('Plan de más de doce cuotas no se trunca y no agrega cuotas vacías',()=>{
 const f=fixture();f.cuotas=Array.from({length:13},(_,i)=>({credito_id:'credit',numero:i+1,monto_centavos:10000,fecha_vencimiento:'2027-01-10'}));f.venta.monto_total_centavos=140000;f.credito.monto_total_centavos=140000;
 const doc=new JSDOM(renderBorradorContratoCelular(datosContratoCelular(f))).window.document;assert.equal(doc.querySelectorAll('table:nth-of-type(2) tbody tr').length,13);
});
test('Advertencias muestran discrepancia sin modificar reglas de mora',()=>{
 const negocio={mora_tipo:'porcentaje',mora_valor:2,mora_periodo:'semana',mora_base:'saldo_vencido',dias_gracia:7,mora_acumulativa:0};const before=JSON.stringify(negocio);assert.match(advertenciasContratoCelular(negocio).join(' '),/una sola vez/);assert.equal(JSON.stringify(negocio),before);
});
