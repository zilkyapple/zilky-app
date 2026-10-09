import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
function browser(){const dom=new JSDOM(page,{url:'https://zilky.test/#/caja',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.requestAnimationFrame=fn=>{fn();return 1;};w.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>url==='/api/negocios'?[{id:'a',nombre:'Ropa'},{id:'b',nombre:'<img src=x onerror=alert(1)>'}]:url==='/api/usuarios'?[{id:'u',nombre:'Admin',activo:1}]:[]};};
 w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');w.qaState.usuario={rol:'administrador',id:'u'};return {w,calls,view:w.document.getElementById('view')};}
test('Caja UI: configura activación y arqueo independientes, varios negocios y sin endpoints financieros',async()=>{
 const {w,calls,view}=browser();await w.viewCaja(view);view.querySelector('#cajaNueva').click();const form=view.querySelector('#cajaConfig');
 assert.equal(form.elements.activa.checked,false);assert.equal(form.elements.arqueo.checked,false);
 assert.equal(form.querySelector('img'),null);form.elements.nombre.value='Local';form.elements.activa.checked=true;
 form.querySelectorAll('[name=negocio]').forEach(x=>x.checked=true);
 await form.onsubmit({preventDefault(){}});
 const write=calls.find(c=>c.opts.method==='POST');const body=JSON.parse(write.opts.body);assert.equal(body.activa,true);assert.equal(body.arqueo,false);assert.deepEqual(body.negocios,['a','b']);
 assert.ok(calls.every(c=>!c.url.includes('dashboard')&&!c.url.includes('pagos')));w.close();
});
test('Caja UI: rol empleado no solicita totales de caja',async()=>{const {w,calls,view}=browser();w.qaState.usuario={rol:'empleado',negocios:[]};await w.render();assert.ok(view.textContent.includes('Requiere administrador'));assert.equal(calls.length,0);w.close();});
test('Caja UI: movimientos escapan conceptos y conservan centavos',()=>{const {w}=browser();const html=w.movHtml({fecha:'2026-10-09T12:00:00Z',negocio:'QA',concepto:'<script>x</script>',medio:'efectivo',monto:123456});assert.ok(!html.includes('<script>'));assert.ok(html.includes('1.234,56'));w.close();});
