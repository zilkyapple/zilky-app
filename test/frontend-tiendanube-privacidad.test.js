import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const write=c=>c.opts.method==='POST';
function browser({tipo='customer-data-request',admin=true,respond}={}){
  const dom=new JSDOM('<!doctype html><main id="view"></main>',{url:'https://zilky.test/',runScripts:'outside-only'});
  const w=dom.window,view=w.document.getElementById('view'),calls=[],downloads=[],toasts=[],active={value:true};
  w.eval(read('vendor/purify.min.js'));
  w.eval('(()=>{'+read('tiendanubePrivacidad.js').replace(/export (?=(?:async )?function)/g,'')+'\nwindow.qaPrivacy=tiendanubePrivacidadView;})();');
  let s={id:'r1',store_id:'101',negocio_id:'n',tipo,estado:tipo==='customer-data-request'?'pendiente_entrega':'pendiente_revision',creada_at:'2026-11-09T12:00:00Z'},receipt=null;
  const fallback=(path,opts)=>{
    if(path==='/tiendanube/privacidad-gestion?negocio_id=n')return {solicitudes:[s],hay_mas:false};
    if(path==='/tiendanube/privacidad-gestion/r1?negocio_id=n')return {solicitud:s,entrega:receipt,informe_disponible:tipo==='customer-data-request'};
    if(path.endsWith('/exportar'))return {exportacion_id:'e1',informe_hash:'b'.repeat(64),informe:{solicitud_id:'r1',store_id:'101',pedidos:[]},estado:s.estado,enviado_por_sistema:false};
    if(path.endsWith('/entrega')){
      s={...s,estado:'completada'};receipt={canal:'recepcion_administrador',declarada_at:'2026-11-09T12:00:00Z',enviado_por_sistema:false};return {estado:'completada',entrega:receipt};
    }
    if(path.endsWith('/borrado/preview'))return {solicitud:s,puede_confirmar:true,bloqueos:[],eliminar:{credenciales:1,vinculos:2},conservar:{entregas_comerciales:3},revocacion_verificada:true,
      datos_locales_zilky_modificados:false,obligaciones_externas_verificadas:false,frase_requerida:'BORRAR INTEGRACION 101',confirmacion_token:'a'.repeat(64),vence_at:new Date(Date.now()+600000).toISOString()};
    if(path.endsWith('/borrado/confirmar')){s={...s,estado:'completada'};return {estado:'completada',solicitud_id:'r1',accion:'datos_operativos_de_integracion_eliminados',datos_locales_zilky_modificados:false};}
    throw Error('Ruta inesperada '+path);
  };
  const ctx={admin,negocio:'n',valid:()=>active.value,setHTML:(el,html)=>{el.innerHTML=w.DOMPurify.sanitize(html,{USE_PROFILES:{html:true}});},
    api:async(path,opts={})=>{calls.push({path,opts});return respond?respond(path,opts,fallback):fallback(path,opts);},
    toast:(...a)=>toasts.push(a),descargar:async(content,filename)=>downloads.push({content,filename})};
  return {w,view,calls,downloads,toasts,ctx,active,el:q=>view.querySelector(q),mount:()=>w.qaPrivacy(view,ctx),open:async()=>{view.querySelector('[data-privacy-open]').click();await tick();}};
}
function change(b,name,value){const el=b.el(`[name="${name}"]`);assert.ok(el,name);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new b.w.Event('change',{bubbles:true}));}

test('privacidad UI solo admin/negocio vigente y no realiza escrituras por abrir una solicitud',async()=>{
  for(const options of [{admin:false},{admin:true}]){
    const b=browser(options);try{
      await b.mount();
      if(options.admin===false){assert.equal(b.calls.length,0);continue;}
      await b.open();assert.equal(b.calls.filter(write).length,0);assert.match(b.view.textContent,/Descargar no equivale a entregar/);
      b.ctx.negocio='otro';b.el('[data-privacy-export]').click();await tick();assert.equal(b.calls.filter(write).length,0);
    }finally{b.w.close();}
  }
});

test('descarga no completa ni declara entrega; requiere canal+casilla y evita doble envío',async()=>{
  const b=browser();try{
    await b.mount();await b.open();b.el('[data-privacy-export]').click();await tick();
    assert.equal(b.downloads.length,1);assert.equal(b.downloads[0].filename,'tiendanube-informe-r1.json');
    assert.equal(b.calls.filter(write).length,1);assert.match(b.view.textContent,/No se registró una entrega/);
    assert.equal(b.el('[data-privacy-deliver]').disabled,true);
    change(b,'canal','recepcion_administrador');assert.equal(b.el('[data-privacy-deliver]').disabled,true);
    change(b,'confirmar_entrega',true);assert.equal(b.el('[data-privacy-deliver]').disabled,false);
    b.el('[data-privacy-deliver]').click();b.el('[data-privacy-deliver]')?.click();await tick();
    const writes=b.calls.filter(write);assert.equal(writes.length,2);
    assert.deepEqual(JSON.parse(writes[1].opts.body),{negocio_id:'n',exportacion_id:'e1',informe_hash:'b'.repeat(64),canal:'recepcion_administrador',confirmar_entrega:true});
    assert.match(b.view.textContent,/No fue un envío automático/);
    assert.match(b.toasts.flat().join(' '),/No se envió un correo/);
  }finally{b.w.close();}
});

test('privacidad UI requiere preview vigente, frase exacta y confirmación antes de borrar',async()=>{
  const b=browser({tipo:'store-redact'});try{
    await b.mount();await b.open();assert.equal(b.el('[data-privacy-delete]'),null);
    b.el('[data-privacy-preview]').click();await tick();
    assert.equal(b.calls.filter(write).length,1);assert.match(b.view.textContent,/todavía no se eliminó nada/);assert.match(b.view.textContent,/no tiene deshacer/);
    assert.equal(b.el('[data-privacy-delete]').disabled,true);
    change(b,'frase','BORRAR TODO');change(b,'confirmar_borrado',true);assert.equal(b.el('[data-privacy-delete]').disabled,true);
    change(b,'frase','BORRAR INTEGRACION 101');assert.equal(b.el('[data-privacy-delete]').disabled,false);
    b.el('[data-privacy-delete]').click();b.el('[data-privacy-delete]')?.click();await tick();
    const writes=b.calls.filter(write);assert.equal(writes.length,2);assert.deepEqual(JSON.parse(writes[1].opts.body),{negocio_id:'n',confirmacion_token:'a'.repeat(64),confirmar_borrado:true,frase:'BORRAR INTEGRACION 101'});
    assert.match(b.toasts.flat().join(' '),/inventario, las ventas, los cobros y la web original se conservaron/);
    assert.equal(b.el('[data-privacy-delete]'),null);
  }finally{b.w.close();}
});

test('privacidad UI no habilita borrado cuando falta revocación, hay bloqueo, expiró o es otra instalación',async()=>{
  const patches=[{puede_confirmar:false,bloqueos:['PRIVACIDAD_OPERACION_EN_CURSO'],bloqueos_detalle:[{mensaje:'Hay una reserva pendiente.'}]},
    {revocacion_verificada:false},{bloqueos:['PENDIENTE']},{solicitud:{id:'r1',negocio_id:'ajeno'}},{vence_at:'2000-01-01T00:00:00Z'}];
  for(const patch of patches){
    const b=browser({tipo:'store-redact',respond:(path,opts,fallback)=>path.endsWith('/borrado/preview')?{...fallback(path,opts),...patch}:fallback(path,opts)});
    try{
      await b.mount();await b.open();b.el('[data-privacy-preview]').click();await tick();
      const button=b.el('[data-privacy-delete]');assert.ok(!button||button.disabled);button?.click();await tick();assert.equal(b.calls.filter(write).length,1);
    }finally{b.w.close();}
  }
});

test('error incierto invalida la confirmación hasta actualizar; no afirma borrado ni repite',async()=>{
  const b=browser({tipo:'store-redact',respond:(path,opts,fallback)=>{if(path.endsWith('/borrado/confirmar'))throw Error('DO-NOT-EXPOSE-secret-fixture');return fallback(path,opts);}});
  try{
    await b.mount();await b.open();b.el('[data-privacy-preview]').click();await tick();change(b,'frase','BORRAR INTEGRACION 101');change(b,'confirmar_borrado',true);
    b.el('[data-privacy-delete]').click();await tick();assert.match(b.view.textContent,/No se confirmó la operación/);
    assert.doesNotMatch(b.view.textContent,/DO-NOT-EXPOSE/);assert.equal(b.el('[data-privacy-delete]'),null);assert.equal(b.el('[data-privacy-preview]').disabled,true);
    assert.equal(b.calls.filter(write).length,2);assert.equal(b.toasts.some(t=>String(t[0]).startsWith('Se retiraron')),false);
    b.el('[data-privacy-refresh]').click();await tick();assert.equal(b.el('[data-privacy-preview]').disabled,false);
  }finally{b.w.close();}
});

test('respuestas tardías o de otro negocio no reviven la pantalla ni descargan archivos',async()=>{
  let finish;
  const b=browser({respond:(path,opts,fallback)=>path.endsWith('/exportar')?new Promise(resolve=>{finish=()=>resolve(fallback(path,opts));}):fallback(path,opts)});
  try{
    await b.mount();await b.open();b.el('[data-privacy-export]').click();b.active.value=false;finish();await tick();
    assert.equal(b.downloads.length,0);assert.equal(b.el('[data-privacy-delivery-form]'),null);
  }finally{b.w.close();}
  const foreign=browser({respond:(path,opts,fallback)=>path.includes('/r1?')?{solicitud:{id:'r1',negocio_id:'otro',tipo:'customer-data-request'}}:fallback(path,opts)});
  try{await foreign.mount();await foreign.open();assert.equal(foreign.el('[data-privacy-export]'),null);assert.equal(foreign.calls.filter(write).length,0);}finally{foreign.w.close();}
});

test('bloqueos y títulos se escapan; no renderiza campos desconocidos ni secretos',async()=>{
  const b=browser({tipo:'store-redact',respond:(path,opts,fallback)=>path.endsWith('/borrado/preview')?{...fallback(path,opts),puede_confirmar:false,bloqueos:['blocked'],bloqueos_detalle:[{mensaje:'<img src=x onerror="alert(1)">'}],token_cifrado:'DO-NOT-EXPOSE'}:fallback(path,opts)});
  try{
    await b.mount();await b.open();b.el('[data-privacy-preview]').click();await tick();assert.equal(b.el('[data-privacy-plan] img'),null);
    assert.doesNotMatch(b.view.textContent,/DO-NOT-EXPOSE/);assert.match(b.view.textContent,/<img/);
  }finally{b.w.close();}
});
