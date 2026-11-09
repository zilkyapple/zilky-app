import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const report=()=>({negocio_id:'n1',store_id:'101',modo:'solo_lectura',baseline_confirmable:false,baseline_guardado:false,
  sincronizacion_activada:false,stock_modificado:false,huella:'a'.repeat(64),corte_consulta_at:'2026-11-09T18:00:00.000Z',
  bloqueos:['CORTE_REMOTO_NO_VERIFICABLE','PAGINACION_SIN_METADATOS'],paginacion_pedidos:{paginas_recorridas:1,fin_observado:true,completa_verificada:false},
  variantes:[{producto_id:'p1',product_id:'11',variant_id:'111',nombre:'Remera Street',sku_local:'STREET-AZ',sku_remoto:'STREET-AZ',
    talle_local:'Único',talle_remoto:'Único',color_local:'Azul',color_remoto:'Azul',stock_local:3,stock_remoto:3,
    precio_30_dias_local_centavos:4250000,precio_publicado_remoto_centavos:4250000,precio_contado_local_centavos:4000000,precio_contado_segun_regla_centavos:4000000,
    coincide:true,bloqueos:[],advertencias:[]}],
  pedidos:[{order_id:'40',estado:'open',pago_estado:'pending',envio_estado:'unfulfilled',entrega_local_registrada:false,requiere_revision:true,
    items:[{variant_id:'111',cantidad:1,producto_id:'p1'}]}]});

function browser({admin=true,negocio='n1',respond}={}){
  const dom=new JSDOM('<!doctype html><main id="view"></main>',{url:'https://fixture.test/',runScripts:'outside-only'}),w=dom.window;
  w.eval(read('vendor/purify.min.js'));
  w.eval('(()=>{'+read('tiendanubeBaseline.js').replace(/export (?=(?:async )?function)/g,'')+'\nwindow.mountBaseline=tiendanubeBaselineView;})();');
  const view=w.document.getElementById('view'),calls=[],active={value:true};
  const ctx={admin,negocio,valid:()=>active.value,setHTML:(el,html)=>el.innerHTML=w.DOMPurify.sanitize(html,{USE_PROFILES:{html:true}}),
    api:async(path,opts={})=>{calls.push({path,opts});return respond?respond(path,opts):report();}};
  return {w,view,calls,ctx,active,mount:()=>w.mountBaseline(view,ctx),el:s=>view.querySelector(s)};
}

test('baseline UI exige admin y negocio antes de consultar datos de inventario',async()=>{
  for(const options of [{admin:false},{negocio:null}]){
    const b=browser(options);try{await b.mount();assert.equal(b.calls.length,0);assert.equal(b.el('table'),null);}finally{b.w.close();}
  }
});
test('baseline UI informa pausa y límites, muestra pares exactos y no ofrece activar ni corregir',async()=>{
  const b=browser();try{
    await b.mount();assert.match(b.view.textContent,/Revisión inicial de inventarios/);assert.match(b.view.textContent,/solo lectura/);
    assert.match(b.view.textContent,/sincronización continúa pausada/);assert.match(b.view.textContent,/42\.500/);assert.match(b.view.textContent,/40\.000/);
    assert.match(b.view.textContent,/no confirma que el checkout aplique/);assert.match(b.view.textContent,/no demuestra que la captura sea completa/);
    const buttons=[...b.view.querySelectorAll('button')].map(el=>el.textContent);assert.deepEqual(buttons,['Actualizar revisión','Volver a comparar esta misma vista']);
    assert.equal(b.calls.length,1);assert.equal(b.calls[0].path,'/tiendanube/baseline/preview?negocio_id=n1');
    assert.equal(b.el('input'),null);assert.equal(b.el('form'),null);
  }finally{b.w.close();}
});
test('revalidación manda únicamente huella y corte exactos, repite lectura y no promete baseline guardado',async()=>{
  const b=browser();try{
    await b.mount();b.el('[data-tn-baseline-revalidate]').click();b.el('[data-tn-baseline-revalidate]').click();await flush();
    const posts=b.calls.filter(c=>c.opts.method==='POST');assert.equal(posts.length,1);
    assert.equal(posts[0].path,'/tiendanube/baseline/revalidar');
    assert.deepEqual(JSON.parse(posts[0].opts.body),{negocio_id:'n1',huella:'a'.repeat(64),corte_consulta_at:'2026-11-09T18:00:00.000Z'});
    assert.match(b.view.textContent,/base inicial no se guardó/);assert.match(b.view.textContent,/conexión sigue pausada/);
  }finally{b.w.close();}
});
test('huella cambiada descarta tabla vieja y no reintenta ni escribe stocks automáticamente',async()=>{
  const b=browser({respond:(path,opts)=>{if(opts.method==='POST')throw Object.assign(Error('SECRET_CANARY'),{code:'BASELINE_CAMBIO_DESDE_PREVIEW'});return report();}});
  try{await b.mount();b.el('[data-tn-baseline-revalidate]').click();await flush();assert.match(b.view.textContent,/datos cambiaron/);
    assert.equal(b.el('table'),null);assert.equal(b.calls.length,2);assert.doesNotMatch(b.view.textContent,/SECRET_CANARY/);
  }finally{b.w.close();}
});
test('respuesta demorada no se muestra tras cambiar de negocio, perder rol o desmontar la vista',async()=>{
  for(const kind of ['business','role','session','unmount']){
    let release;const promise=new Promise(resolve=>release=resolve),b=browser({respond:()=>promise});
    try{
      const mounting=b.mount();await flush();
      if(kind==='business')b.ctx.negocio='n2';if(kind==='role')b.ctx.admin=false;if(kind==='session')b.active.value=false;
      if(kind==='unmount')b.view.replaceChildren();release(report());await mounting;
      assert.doesNotMatch(b.view.textContent,/Remera Street|42\.500/);assert.equal(b.calls.length,1);
    }finally{b.w.close();}
  }
});
test('UI no filtra HTML, campos no solicitados, datos de otra tienda ni mensajes secretos del proveedor',async()=>{
  const b=browser({respond:()=>{
    const r=report();r.token_cifrado='SECRET_CANARY';r.costo_centavos=888888888;r.comision_centavos=250000;
    r.variantes[0].nombre='<img src=x onerror=alert(1)>Remera';r.pedidos[0].pago_estado='<script>alert(1)</script>';return r;
  }});
  try{await b.mount();assert.equal(b.el('img'),null);assert.equal(b.el('script'),null);assert.doesNotMatch(b.view.textContent,/SECRET_CANARY|888888888|comision_centavos/);}finally{b.w.close();}
  for(const respond of [()=>({...report(),negocio_id:'n2'}),()=>({...report(),baseline_guardado:true}),()=>{throw Error('PRIVATE_CANARY');}]){
    const denied=browser({respond});try{await denied.mount();assert.equal(denied.el('table'),null);assert.doesNotMatch(denied.view.textContent,/PRIVATE_CANARY|Remera Street/);}finally{denied.w.close();}
  }
});
