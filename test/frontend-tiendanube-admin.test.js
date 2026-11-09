import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const estado=()=>({conexion:{store_id:'123',pausada:true},configuracion_servidor:true,links:[]});
const diagnostico=()=>({conexion:{store_id:'123',pausada:true},listo:false,bloqueos:['FEATURE_FLAG_APAGADA','CONEXION_PAUSADA','SIN_FECHA_DE_CORTE','BASELINE_PENDIENTE','WEBHOOKS_NO_VERIFICADOS','SIN_VARIANTES_VINCULADAS'],variantes:0,sin_baseline:0,revision:0});
const catalogo=()=>({locales:[{id:'local-a',nombre:'Remera Street',variante:'Único · Azul',sku:'ST-AZ',stock:1},{id:'local-b',nombre:'Remera Street',variante:'Único · Rosa oscuro',sku:'ST-RO',stock:1}],remotos:[{product_id:'10',variant_id:'101',nombre:'Remera Street',valores:[{es:'Azul'},{es:'Único'}],sku:'ST-AZ',stock:1},{product_id:'10',variant_id:'102',nombre:'Remera Street',valores:[{es:'Rosa oscuro'},{es:'Único'}],sku:'ST-RO',stock:1}]});
const goodUrl='https://www.tiendanube.com/apps/51162/authorize?state='+'a'.repeat(64);
const write=call=>call.opts.method&&call.opts.method!=='GET';

function browser({admin=true,negocio='n',respond}={}){
  const dom=new JSDOM('<!doctype html><main id="view"></main>',{url:'https://zilky.test/',runScripts:'outside-only'});
  const w=dom.window,view=w.document.getElementById('view'),calls=[],toasts=[],navigations=[];
  w.eval(read('vendor/purify.min.js'));
  const source=read('tiendanubeAdmin.js').replace(/export (?=(?:async )?function)/g,'');
  w.eval('(()=>{'+source+'\nwindow.qaAdmin=tiendanubeAdminView;window.qaUrl=validarAutorizacionTiendanube;})();');
  const fallback=(path,opts)=>{
    if(path.startsWith('/tiendanube/estado?'))return estado();
    if(path.startsWith('/tiendanube/diagnostico?'))return diagnostico();
    if(path.startsWith('/tiendanube/catalogo?'))return catalogo();
    if(path==='/tiendanube/iniciar')return {url:goodUrl};
    if(path==='/tiendanube/vinculos')return {sincronizacion:'pausada'};
    if(path==='/tiendanube/pausar')return {pausada:true};
    throw Error('Ruta inesperada: '+path);
  };
  const active={value:true};
  const ctx={admin,negocio,valid:()=>active.value,
    api:async(path,opts={})=>{calls.push({path,opts});return respond?respond(path,opts,fallback):fallback(path,opts);},
    setHTML:(element,html)=>{element.innerHTML=w.DOMPurify.sanitize(html,{USE_PROFILES:{html:true}});},
    toast:(...args)=>toasts.push(args),navigate:url=>navigations.push(url),
  };
  return {w,view,ctx,calls,toasts,navigations,active,el:selector=>view.querySelector(selector),mount:()=>w.qaAdmin(view,ctx)};
}
function change(b,name,value){const el=b.el(`[name="${name}"]`);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new b.w.Event('change',{bubbles:true}));}
const submit=b=>b.el('[data-tn-form]').dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));

test('Tiendanube admin exige administrador, negocio y pantalla vigente antes de consultar datos',async()=>{
  for(const options of [{admin:false},{negocio:null},{admin:true}]){
    const b=browser(options);
    try{
      if(options.admin===true)b.active.value=false;
      await b.mount();assert.equal(b.calls.length,0);assert.equal(b.el('[data-tn-link]'),null);
    }finally{b.w.close();}
  }
});

test('Tiendanube admin muestra estado pausado y no habilita/publica ni toca stock automáticamente',async()=>{
  const b=browser();
  try{
    await b.mount();assert.match(b.view.textContent,/sincronización pausada/);
    assert.equal(b.calls.filter(write).length,0);
    assert.equal(b.el('[data-tn-link]').disabled,true);
    assert.equal(b.el('[name="producto_id"]').value,'');
    assert.equal(b.el('[name="variante_remota"]').value,'');
    assert.match(b.view.textContent,/La web original de Zilky se conserva/);
    assert.equal(b.el('[data-tn-activate],[data-tn-publish]'),null);
  }finally{b.w.close();}
});

test('Tiendanube admin no pide catálogo ni permite autorizar si falta configuración del servidor',async()=>{
  const b=browser({respond:(path,opts,fallback)=>path.startsWith('/tiendanube/estado?')?{conexion:null,links:[],configuracion_servidor:false}:fallback(path,opts)});
  try{
    await b.mount();assert.equal(b.calls.length,2);assert.equal(b.el('[data-tn-connect]').disabled,true);
    b.el('[data-tn-connect]').click();await tick();assert.equal(b.calls.filter(write).length,0);
    assert.match(b.view.textContent,/No ingreses claves o contraseñas/);
  }finally{b.w.close();}
});

test('Tiendanube admin solo redirige al authorize HTTPS exacto de Tiendanube',async()=>{
  const b=browser();
  try{
    assert.equal(b.w.qaUrl(goodUrl),goodUrl);
    for(const bad of ['https://www.tiendanube.com.evil.test/apps/51162/authorize?state='+'a'.repeat(64),goodUrl.replace('https:','http:'),'javascript:alert(1)',goodUrl+'&redirect_uri=https://evil.test',goodUrl+'&state=other',goodUrl+'#evil',goodUrl.replace('www.tiendanube.com','www.tiendanube.com@evil.test')])assert.throws(()=>b.w.qaUrl(bad));
    await b.mount();b.el('[data-tn-connect]').click();await tick();
    assert.deepEqual(b.navigations,[goodUrl]);
    const request=b.calls.filter(write)[0];assert.equal(request.path,'/tiendanube/iniciar');
    assert.deepEqual(JSON.parse(request.opts.body),{negocio_id:'n'});
  }finally{b.w.close();}
});

test('Tiendanube admin rechaza respuesta de autorización maliciosa sin navegar',async()=>{
  const b=browser({respond:(path,opts,fallback)=>path==='/tiendanube/iniciar'?{url:'https://evil.test/'}:fallback(path,opts)});
  try{await b.mount();b.el('[data-tn-connect]').click();await tick();assert.equal(b.navigations.length,0);assert.match(b.view.textContent,/autorización segura/);}finally{b.w.close();}
});

test('Tiendanube admin requiere elección manual y confirmación de talle/color para vincular IDs exactos',async()=>{
  const b=browser();
  try{
    await b.mount();change(b,'producto_id','local-b');change(b,'variante_remota','10:102');
    assert.match(b.el('[data-tn-preview]').textContent,/Rosa oscuro/);
    assert.equal(b.el('[data-tn-link]').disabled,true);submit(b);await tick();assert.equal(b.calls.filter(write).length,0);
    change(b,'confirmar_variante',true);assert.equal(b.el('[data-tn-link]').disabled,false);
    submit(b);submit(b);await tick();
    const writes=b.calls.filter(write);assert.equal(writes.length,1);assert.equal(writes[0].path,'/tiendanube/vinculos');
    assert.deepEqual(JSON.parse(writes[0].opts.body),{negocio_id:'n',producto_id:'local-b',product_id:'10',variant_id:'102'});
  }finally{b.w.close();}
});

test('Tiendanube admin reinicia la confirmación si cambia el talle o color elegido',async()=>{
  const b=browser();
  try{
    await b.mount();change(b,'producto_id','local-a');change(b,'variante_remota','10:101');change(b,'confirmar_variante',true);
    change(b,'variante_remota','10:102');assert.equal(b.el('[name="confirmar_variante"]').checked,false);
    assert.equal(b.el('[data-tn-link]').disabled,true);submit(b);await tick();assert.equal(b.calls.filter(write).length,0);
  }finally{b.w.close();}
});

test('Tiendanube admin deshabilita variantes ya vinculadas y escapa nombres sin mostrar costos o tokens',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{
    if(path.startsWith('/tiendanube/estado?'))return {...estado(),token_cifrado:'TOKEN-QUE-NO-DEBE-VERSE',links:[{producto_id:'local-a',product_id:'10',variant_id:'101',nombre:'<img src=x onerror=alert(1)>',stock:0,sincronizacion:'pendiente'}]};
    if(path.startsWith('/tiendanube/catalogo?')){const c=catalogo();c.locales[0].nombre='<script>danger()</script>';c.locales[0].costo_centavos=99999999;return c;}
    return fallback(path,opts);
  }});
  try{
    await b.mount();assert.equal(b.el('[name="producto_id"] option[value="local-a"]').disabled,true);
    assert.equal(b.el('[name="variante_remota"] option[value="10:101"]').disabled,true);
    assert.equal(b.el('script,img,[onerror]'),null);assert.match(b.view.textContent,/<img src=x/);
    assert.doesNotMatch(b.view.textContent,/99999999|TOKEN-QUE-NO-DEBE-VERSE/);
  }finally{b.w.close();}
});

test('Tiendanube admin no usa respuestas ni realiza writes después de cambiar de negocio',async()=>{
  let finish;
  const b=browser({respond:(path,opts,fallback)=>path.startsWith('/tiendanube/estado?')?new Promise(resolve=>finish=resolve):fallback(path,opts)});
  try{
    const mounting=b.mount();b.ctx.negocio='otro';finish(estado());await mounting;
    assert.equal(b.calls.length,1);assert.equal(b.el('[data-tn-form]'),null);
  }finally{b.w.close();}
});

test('Tiendanube admin no redirige si la autorización termina después de salir de la pantalla',async()=>{
  let finish;
  const b=browser({respond:(path,opts,fallback)=>path==='/tiendanube/iniciar'?new Promise(resolve=>finish=resolve):fallback(path,opts)});
  try{
    await b.mount();b.el('[data-tn-connect]').click();b.active.value=false;finish({url:goodUrl});await tick();
    assert.equal(b.navigations.length,0);
  }finally{b.w.close();}
});

test('Tiendanube admin un write incierto bloquea reintentos hasta actualizar estado',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{if(path==='/tiendanube/vinculos')throw Error('Error con datos privados que no se deben imprimir');return fallback(path,opts);}});
  try{
    await b.mount();change(b,'producto_id','local-a');change(b,'variante_remota','10:101');change(b,'confirmar_variante',true);submit(b);await tick();
    assert.equal(b.el('[data-tn-link]').disabled,true);assert.equal(b.el('[name="producto_id"]').disabled,true);
    assert.match(b.view.textContent,/Actualizá el estado antes/);assert.doesNotMatch(b.view.textContent,/datos privados/);
    submit(b);await tick();assert.equal(b.calls.filter(write).length,1);
    b.el('[data-tn-refresh]').click();await tick();assert.equal(b.el('[name="producto_id"]').disabled,false);
  }finally{b.w.close();}
});

test('Tiendanube admin consulta diagnóstico y diferencia configuración, feature, baseline y webhooks',async()=>{
  const b=browser();
  try{
    await b.mount();assert.equal(b.calls.some(c=>c.path==='/tiendanube/diagnostico?negocio_id=n'),true);
    const text=b.el('[data-tn-diagnostic]').textContent;
    assert.match(text,/Configuración privada del servidor/);assert.match(text,/Apagado en el servidor/);
    assert.match(text,/Pendiente de conciliación/);assert.match(text,/Sin verificar/);assert.match(text,/Sin definir/);
    assert.match(text,/La sincronización está pausada/);assert.equal(b.el('[data-tn-pause]').disabled,true);
  }finally{b.w.close();}
});

test('Tiendanube admin pausada=false no se presenta como sincronización activa',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{
    if(path.startsWith('/tiendanube/estado?'))return {...estado(),conexion:{store_id:'123',pausada:false}};
    if(path.startsWith('/tiendanube/diagnostico?'))return {...diagnostico(),conexion:{store_id:'123',pausada:false},bloqueos:['FEATURE_FLAG_APAGADA','BASELINE_PENDIENTE','WEBHOOKS_NO_VERIFICADOS']};
    return fallback(path,opts);
  }});
  try{
    await b.mount();assert.match(b.view.textContent,/motor deshabilitado/);
    assert.doesNotMatch(b.view.textContent,/Sincronización activa|Conexión habilitada en el servidor/);
    assert.equal(b.el('[data-tn-link]').disabled,true);assert.equal(b.el('[data-tn-pause]').disabled,false);
  }finally{b.w.close();}
});

test('Tiendanube admin diagnóstico sin bloqueos no reemplaza la prueba de venta real',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{
    if(path.startsWith('/tiendanube/estado?'))return {...estado(),conexion:{store_id:'123',pausada:false}};
    if(path.startsWith('/tiendanube/diagnostico?'))return {conexion:{store_id:'123',pausada:false},listo:true,bloqueos:[],variantes:2,sin_baseline:0,revision:0};
    return fallback(path,opts);
  }});
  try{
    await b.mount();assert.match(b.view.textContent,/requisitos del motor completos/);
    assert.match(b.view.textContent,/no reemplaza la prueba de una venta/);
    assert.doesNotMatch(b.view.textContent,/Sincronización activa/);assert.equal(b.el('[data-tn-activate]'),null);
  }finally{b.w.close();}
});

test('Tiendanube admin un diagnóstico fallido se muestra desconocido y bloquea vínculos',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{if(path.startsWith('/tiendanube/diagnostico?'))throw Error('Error interno con secreto');return fallback(path,opts);}});
  try{
    await b.mount();assert.match(b.view.textContent,/estado del motor sin comprobar/);
    assert.match(b.el('[data-tn-diagnostic]').textContent,/desconocido/);
    assert.equal(b.el('[name="producto_id"]').disabled,true);assert.doesNotMatch(b.view.textContent,/con secreto/);
  }finally{b.w.close();}
});

test('Tiendanube admin pausa requiere confirmación y envía solo el negocio vigente',async()=>{
  let pausada=false;
  const b=browser({respond:(path,opts,fallback)=>{
    if(path.startsWith('/tiendanube/estado?'))return {...estado(),conexion:{store_id:'123',pausada}};
    if(path.startsWith('/tiendanube/diagnostico?'))return {...diagnostico(),conexion:{store_id:'123',pausada},bloqueos:pausada?diagnostico().bloqueos:diagnostico().bloqueos.filter(c=>c!=='CONEXION_PAUSADA')};
    if(path==='/tiendanube/pausar'){pausada=true;return {pausada:true};}
    return fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-tn-pause]').click();assert.ok(b.el('[data-tn-pause-confirm]'));assert.equal(b.calls.filter(write).length,0);
    b.el('[data-tn-pause-cancel]').click();assert.equal(b.el('[data-tn-pause-confirm]'),null);assert.equal(b.calls.filter(write).length,0);
    b.el('[data-tn-pause]').click();b.el('[data-tn-pause-confirm-action]').click();await tick();
    const writes=b.calls.filter(write);assert.equal(writes.length,1);assert.equal(writes[0].path,'/tiendanube/pausar');assert.equal(writes[0].opts.method,'POST');
    assert.deepEqual(JSON.parse(writes[0].opts.body),{negocio_id:'n'});
    assert.equal(b.el('[data-tn-pause]').disabled,true);assert.match(b.view.textContent,/sincronización pausada/);
  }finally{b.w.close();}
});

test('Tiendanube admin no confirma una pausa después de perder permiso o cambiar de negocio',async()=>{
  for(const mode of ['permiso','negocio']){
    const b=browser({respond:(path,opts,fallback)=>path.startsWith('/tiendanube/estado?')?{...estado(),conexion:{store_id:'123',pausada:false}}:fallback(path,opts)});
    try{
      await b.mount();b.el('[data-tn-pause]').click();
      if(mode==='permiso')b.ctx.admin=false;else b.ctx.negocio='otro';
      b.el('[data-tn-pause-confirm-action]').click();await tick();assert.equal(b.calls.filter(write).length,0);
    }finally{b.w.close();}
  }
});

test('Tiendanube admin no interpreta una respuesta de pausa no confirmada como éxito',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{
    if(path.startsWith('/tiendanube/estado?'))return {...estado(),conexion:{store_id:'123',pausada:false}};
    if(path==='/tiendanube/pausar')return {pausada:false};
    return fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-tn-pause]').click();b.el('[data-tn-pause-confirm-action]').click();await tick();
    assert.match(b.view.textContent,/No se pudo confirmar la pausa/);
    assert.equal(b.toasts.some(([text])=>text.includes('Pausa guardada')),false);
  }finally{b.w.close();}
});
