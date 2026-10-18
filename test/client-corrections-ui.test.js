import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/clientCorrections.js',import.meta.url),'utf8').replace("import {pendingMutation} from './pendingMutation.js';",'').replaceAll('export async function','async function');
const pending=fs.readFileSync(new URL('../public/pendingMutation.js',import.meta.url),'utf8').replace('export function','function');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const financing=()=>({version:'a'.repeat(64),fecha_entrega_inicial:'2026-03-01',mora_pendiente_centavos:15000,credito:{id:'cr',monto_total_centavos:400000,entrega_inicial_centavos:100000,fecha_inicio:'2026-03-02',mora_modo:'negocio'},cuotas:[{id:'q1',numero:1,monto_centavos:150000,saldo_pendiente_centavos:0,fecha_vencimiento:'2026-04-02',fecha_saldada:'2026-04-01'},{id:'q2',numero:2,monto_centavos:150000,saldo_pendiente_centavos:150000,fecha_vencimiento:'2026-05-02'}],pagos:[{id:'p'}],aplicaciones:[{cuota_id:'q1',capital_centavos:150000}]});
const payment=()=>({version:'b'.repeat(64),pago:{id:'p',fecha_hora:'2026-04-01T13:45:27.123-03:00',monto_centavos:200000,medio_pago:'efectivo',nota:'Nota original',tipo:'cuota'},credito:{id:'cr'}});
const summary={version:'b'.repeat(64),resumen:{saldo_anterior_centavos:100000,saldo_posterior_centavos:150000,saldo_favor_anterior_centavos:0,saldo_favor_posterior_centavos:0,aplicaciones:[{cuota_id:'q1',numero:1,capital_anterior_centavos:200000,capital_nuevo_centavos:150000,mora_anterior_centavos:0,mora_nueva_centavos:0}],aviso:'La caja conserva sus movimientos reales.'}};
function browser(respond){
 const d=new JSDOM('<div id="sheetBackdrop"></div><div id="sheetRoot"></div>',{url:'https://zilky.test/',runScripts:'outside-only'}),w=d.window,calls=[],messages=[];let current=true,refreshes=0;
 w.eval(purifier);w.eval(`(()=>{${pending}\n${source}\nwindow.qaCorrections={financiacionCorreccion,pagoCorreccion};})()`);
 const ctx={admin:true,usuarioId:'owner',valid:()=>current,setHTML:(el,html)=>{if(el)el.innerHTML=w.DOMPurify.sanitize(html);},openSheet:html=>{w.document.getElementById('sheetRoot').innerHTML='<div id="activeSheet">'+w.DOMPurify.sanitize(html)+'</div>';w.document.getElementById('sheetBackdrop').classList.add('open');},closeSheet:()=>{w.document.getElementById('sheetBackdrop').classList.remove('open');},toast:m=>messages.push(m),refresh:async()=>{refreshes++;},api:async(path,opts={})=>{const call={path,...opts,body:opts.body?JSON.parse(opts.body):null};calls.push(call);return await respond(call);}};
 return {w,ctx,calls,messages,refreshes:()=>refreshes,stale:()=>{current=false;},el:id=>w.document.getElementById(id),close:()=>w.close()};
}
async function financeReview(b){await b.w.qaCorrections.financiacionCorreccion(b.ctx,'cr','n');b.el('corFecha').value='2026-03-05';b.el('corEntregaFecha').value='2026-02-28';b.el('corMotivo').value='Corregir carga del cuaderno';b.el('corRevisar').click();await tick();}
async function paymentReview(b){await b.w.qaCorrections.pagoCorreccion(b.ctx,'p','n');b.el('corPagoMonto').value='1500';b.el('corPagoFecha').value='2026-02-28T10:30';b.el('corPagoMotivo').value='Corregir fecha e importe del cuaderno';b.el('corPagoRevisar').click();await tick();}

test('Correcciones UI: fechas históricas, cuota pagada y perdón de mora se revisan antes de guardar',async()=>{
 const b=browser(call=>call.method==='PATCH'?{id:'cr'}:financing());try{
  await b.w.qaCorrections.financiacionCorreccion(b.ctx,'cr','n');
  assert.equal(b.el('corCuotas').children[0].querySelector('.corQuitar').disabled,true);
  assert.equal(b.el('corCuotas').children[0].querySelector('.corVence').disabled,false);
  b.el('corCuotas').children[0].querySelector('.corVence').value='2026-04-05';
  b.el('corFecha').value='2026-03-05';b.el('corEntregaFecha').value='2026-02-28';b.el('corMora').value='sin_interes';b.el('corMotivo').value='Corregir registro histórico';b.el('corRevisar').click();await tick();
  assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);assert.match(b.el('corReview').textContent,/Cuota 1 · vencimiento/);assert.match(b.el('corReview').textContent,/150,00/);
  b.el('corGuardar').click();await tick();assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);
  b.el('corConfirmar').checked=true;b.el('corGuardar').click();await tick();assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);
  b.el('corConfirmarInteres').checked=true;b.el('corGuardar').click();await tick();
  const call=b.calls.find(x=>x.method==='PATCH');assert.equal(call.body.datos.fecha_entrega_inicial,'2026-02-28');assert.equal(call.body.datos.fecha_inicio,'2026-03-05');assert.equal(call.body.datos.cuotas[0].fecha_vencimiento,'2026-04-05');assert.equal(call.body.datos.mora_modo,'sin_interes');assert.equal(call.body.confirmar_sin_interes,true);assert.equal(b.refreshes(),1);
 }finally{b.close();}
});

test('Correcciones UI: respuesta incierta se recupera con la misma solicitud al reabrir',async()=>{
 let attempts=0;const b=browser(call=>{if(call.method==='PATCH'){if(++attempts===1)throw Error('Sin conexión');return {id:'cr'};}return financing();});try{
  await financeReview(b);b.el('corConfirmar').checked=true;b.el('corGuardar').click();await tick();
  assert.equal(b.w.sessionStorage.length,1);const first=b.calls.find(x=>x.method==='PATCH');
  await b.w.qaCorrections.financiacionCorreccion(b.ctx,'cr','n');assert.equal(b.el('corForm'),null);assert.ok(b.el('corPending').querySelector('button'));
  b.el('corPending').querySelector('button').click();await tick();
  const requests=b.calls.filter(x=>x.method==='PATCH');assert.equal(requests.length,2);assert.deepEqual(requests[1].body,first.body);assert.equal(b.w.sessionStorage.length,0);assert.equal(b.refreshes(),1);
 }finally{b.close();}
});

test('Correcciones UI: pago usa vista del servidor, confirma saldo y conserva versión',async()=>{
 const b=browser(call=>call.path.endsWith('/vista')?summary:call.method==='PATCH'?{id:'p',reemplazo_id:'new'}:payment());try{
  await paymentReview(b);assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);
  const vista=b.calls.find(x=>x.path.endsWith('/vista'));assert.equal(vista.body.datos.fecha_hora,'2026-02-28T10:30:00-03:00');assert.equal(vista.body.datos.monto_centavos,150000);assert.equal(vista.body.version,'b'.repeat(64));
  assert.match(b.el('corPagoReview').textContent,/Capital pendiente después/);assert.match(b.el('corPagoReview').textContent,/1\.500,00/);
  b.el('corPagoGuardar').click();await tick();assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);
  b.el('corPagoConfirmar').checked=true;b.el('corPagoGuardar').click();await tick();
  const patch=b.calls.find(x=>x.method==='PATCH');assert.deepEqual(patch.body.datos,vista.body.datos);assert.equal(patch.body.version,summary.version);assert.equal(b.refreshes(),1);
 }finally{b.close();}
});

test('Correcciones UI: cambiar solamente nota conserva la hora y milisegundos originales',async()=>{
 const b=browser(call=>call.path.endsWith('/vista')?summary:payment());try{
  await b.w.qaCorrections.pagoCorreccion(b.ctx,'p','n');assert.match(b.el('corPagoFecha').value,/^2026-04-01T13:45:27/);
  b.el('corPagoNota').value='Nota corregida';b.el('corPagoMotivo').value='Error de nota';b.el('corPagoRevisar').click();await tick();assert.equal(b.calls.find(x=>x.path.endsWith('/vista')).body.datos.fecha_hora,payment().pago.fecha_hora);
 }finally{b.close();}
});

test('Correcciones UI: entrega inicial informa dónde corregir importe',async()=>{
 const value=payment();value.pago.tipo='entrega_inicial';const b=browser(()=>value);try{
  await b.w.qaCorrections.pagoCorreccion(b.ctx,'p','n');assert.equal(b.el('corPagoMonto').readOnly,true);assert.equal(b.el('corPagoFecha').readOnly,false);assert.match(b.el('corContent').textContent,/Corregir fechas y cuotas/);
 }finally{b.close();}
});

test('Correcciones UI: un cambio de sesión o negocio impide guardar una revisión anterior',async()=>{
 const b=browser(call=>call.path.endsWith('/vista')?summary:payment());try{
  await paymentReview(b);b.el('corPagoConfirmar').checked=true;b.stale();b.el('corPagoGuardar').click();await tick();assert.equal(b.calls.filter(x=>x.method==='PATCH').length,0);
 }finally{b.close();}
});

test('Correcciones UI: vista tardía no reemplaza otra hoja y empleados no acceden',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r),b=browser(()=>waiting);try{
  const work=b.w.qaCorrections.financiacionCorreccion(b.ctx,'cr','n');b.ctx.openSheet('<h2>Otro formulario</h2>');resolve(financing());await work;assert.equal(b.el('corForm'),null);assert.match(b.el('activeSheet').textContent,/Otro formulario/);
  b.ctx.admin=false;await b.w.qaCorrections.pagoCorreccion(b.ctx,'p','n');assert.equal(b.calls.length,1);
 }finally{b.close();}
});

test('Correcciones UI: datos de notas se muestran como texto en la revisión',async()=>{
 const value=payment();value.pago.nota='<img src=x onerror=alert(1)>';const b=browser(call=>call.path.endsWith('/vista')?summary:value);try{
  await b.w.qaCorrections.pagoCorreccion(b.ctx,'p','n');b.el('corPagoNota').value='<script>alert(1)</script>';b.el('corPagoMotivo').value='<img src=x onerror=alert(1)>';b.el('corPagoRevisar').click();await tick();assert.equal(b.el('activeSheet').querySelector('img,script,[onerror]'),null);assert.match(b.el('corPagoReview').textContent,/<script>alert\(1\)<\/script>/);
 }finally{b.close();}
});
