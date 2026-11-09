import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const purifier=read('vendor/purify.min.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const config=()=>({negocio_id:'n',habilitada:false,slug:'tienda-qa',nombre:'Tienda QA',descripcion:'Catálogo del negocio',tipo:'iphone',whatsapp:'5491111111111',secciones:['Fundas','Accesorios','Auriculares']});
const listing=()=>({id:'web1',producto_id:'core1',nombre:'Funda transparente',descripcion:'Protección para iPhone',categoria:'Fundas',modelos:['iPhone 15','iPhone 15 Pro'],talle:'',color:'Transparente',publicado:true,precio_centavos:123456,orden:0,stock:5,media:[],version:'v-producto'});
const core=()=>[{id:'core1',nombre:'Funda transparente',stock:5,precio_contado_centavos:123456,categoria:'Fundas'}];
const order=()=>({id:'pedido1',codigo:'PED-001',estado:'pendiente',total_centavos:246912,contacto:{nombre:'Ana Contacto Privado',apellido:'Prueba',telefono:'5491166667777',email:'ana.privada@qa.invalid'},created_at:'2026-11-02T12:00:00Z'});
const detail=()=>({pedido:order(),items:[{producto_id:'core1',nombre:'Funda transparente',cantidad:2,precio_unitario_centavos:123456,subtotal_centavos:246912}],stock:[{producto_id:'core1',nombre:'Funda transparente',cantidad:2,stock_actual:5,stock_despues:3}],version:'v-pedido'});
const confirmedDetail=()=>({...detail(),pedido:{...order(),estado:'confirmado'},cobros:[],resumen_cobros:{cobrado_centavos:0,saldo_centavos:246912,estado:'sin_cobrar'}});
const route=path=>path.split('?')[0];
const isWrite=call=>call.opts.method&&call.opts.method!=='GET';

function browser({admin=false,permisos=['tienda.editar'],respond}={}) {
  const dom=new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>',{url:'https://zilky.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[],toasts=[],downloads=[],state={active:true,negocio:'n'},allowed=new Set(permisos);
  w.localStorage.setItem('zilky_token','sesion-qa');w.eval(purifier);
  const source=read('tiendaAdmin.js').replace(/^import .*;\n/gm,'').replace(/export (?=(?:async )?function)/g,'');
  w.eval('(()=>{'+source+'\nwindow.qaTiendaAdmin=tiendaAdminView;window.qaOptimizarFoto=optimizarFoto;})();');
  const view=w.document.getElementById('view');
  const fallback=(path,opts)=>{
    if(isWrite({opts}))return route(path).includes('/productos')?listing():{...detail(),pedido:{...order(),estado:'confirmado'}};
    if(route(path)==='/tiendas')return {config:config(),estadisticas:{productos:1,publicados:1,pedidos_pendientes:1}};
    if(route(path)==='/tiendas/productos')return [listing()];
    if(route(path)==='/tiendas/catalogo')return core();
    if(route(path)==='/tiendas/productos/web1/media')return {media:[],version:'v-media',usados_bytes:0};
    if(route(path)==='/tiendas/pedidos')return [order()];
    if(route(path)==='/tiendas/pedidos/pedido1')return detail();
    throw Error('Ruta inesperada: '+path);
  };
  const ctx={negocio:'n',admin,usuario:{id:admin?'admin':'empleado',rol:admin?'administrador':'empleado'},
    api:async(path,opts={})=>{calls.push({path,opts});return respond?respond(path,opts,fallback):fallback(path,opts);},
    setHTML:(element,html)=>{if(element)element.innerHTML=w.DOMPurify.sanitize(html,{USE_PROFILES:{html:true,svg:true}});},
    toast:(...args)=>toasts.push(args),puede:(permission,negocio)=>negocio==='n'&&allowed.has(permission),
    valid:()=>state.active&&state.negocio==='n',refresh:()=>{},getToken:()=>w.localStorage.getItem('zilky_token'),
    download:async(path,name)=>downloads.push({path,name}),
  };
  return {w,view,ctx,calls,toasts,downloads,state,allowed,el:selector=>view.querySelector(selector),mount:()=>w.qaTiendaAdmin(view,ctx)};
}
const writes=b=>b.calls.filter(isWrite);
const submit=(b,selector)=>b.el(selector).dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));
const storageText=b=>Array.from({length:b.w.sessionStorage.length},(_,i)=>b.w.sessionStorage.getItem(b.w.sessionStorage.key(i))).join('\n');

test('Tienda admin: acceso desde stock abre el producto ya vinculado o prepara su vinculación sin duplicar inventario',async()=>{
  for(const id of ['core1','core2']){
    const b=browser({respond:(path,opts,fallback)=>route(path)==='/tiendas/catalogo'?[...core(),{id:'core2',nombre:'Remera de stock',stock:0,precio_contado_centavos:4050000,categoria:'Remeras'}]:fallback(path,opts)});
    try{
      b.w.sessionStorage.setItem('zilky-tienda-producto:n',id);
      await b.mount();
      assert.equal(b.w.sessionStorage.getItem('zilky-tienda-producto:n'),null);
      assert.equal(b.el('#ta-product-form [name="nombre"]').value,id==='core1'?'Funda transparente':'Remera de stock');
      if(id==='core2'){
        assert.equal(b.el('#ta-product-form [name="origen"]').value,'existente');
        assert.equal(b.el('#ta-product-form [name="producto_id"]').value,'core2');
        assert.equal(b.el('#ta-product-form [name="stock"]'),null,'el inventario conserva el stock original');
        assert.match(b.el('#ta-product-form').textContent,/Agotado/);
      }else assert.equal(b.el('#ta-product-form [name="origen"]'),null,'el producto web ya existe');
      assert.equal(writes(b).length,0,'abrir el enlace no publica ni crea productos sin guardar');
    }finally{b.w.close();}
  }
});

test('Tienda admin: las fotos grandes se reducen a 1600 px conservando MIME, nombre y transparencia PNG',async()=>{
  for(const type of ['image/jpeg','image/png']) {
    const b=browser(),encodings=[],draws=[];let closed=0;
    try {
      const bitmap={width:2000,height:1000,close:()=>closed++};
      b.w.createImageBitmap=async()=>bitmap;
      b.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:(...args)=>draws.push(args),fillRect:()=>{throw Error('No debe rellenar el fondo transparente');}});
      b.w.HTMLCanvasElement.prototype.toBlob=function(done,mime,quality){encodings.push({width:this.width,height:this.height,mime,quality});done(new b.w.Blob([new Uint8Array(4096)],{type:mime}));};
      const file=new b.w.File([new Uint8Array(600*1024)],type==='image/png'?'funda-transparente.png':'foto-grande.jpg',{type,lastModified:123456});
      const optimized=await b.w.qaOptimizarFoto(file);
      assert.notEqual(optimized,file);assert.equal(optimized.size,4096);assert.equal(optimized.type,type);
      assert.equal(optimized.name,file.name);assert.equal(optimized.lastModified,file.lastModified);
      assert.deepEqual(encodings,[{width:1600,height:800,mime:type,quality:type==='image/png'?undefined:0.82}]);
      assert.equal(draws[0][0],bitmap);assert.deepEqual(draws[0].slice(1),[0,0,1600,800]);assert.equal(closed,1);
    }finally{b.w.close();}
  }
});

test('Tienda admin: los videos y las fotos pequeñas se conservan sin recodificar',async()=>{
  const b=browser();let decoded=0,closed=0;
  try {
    b.w.createImageBitmap=async()=>{decoded++;return {width:640,height:480,close:()=>closed++};};
    b.w.HTMLCanvasElement.prototype.getContext=()=>{throw Error('No debe usar canvas para este archivo');};
    const video=new b.w.File([new Uint8Array(1024)],'video.mp4',{type:'video/mp4'});
    assert.equal(await b.w.qaOptimizarFoto(video),video);assert.equal(decoded,0);
    const photo=new b.w.File([new Uint8Array(1024)],'foto.jpg',{type:'image/jpeg'});
    assert.equal(await b.w.qaOptimizarFoto(photo),photo);assert.equal(decoded,1);assert.equal(closed,1);
  }finally{b.w.close();}
});

test('Tienda admin: una lectura de foto que termina después de navegar devuelve el original y libera bitmap',async()=>{
  const b=browser();let current=true,finish,closed=0,canvasUsed=false;
  try {
    b.w.createImageBitmap=()=>new Promise(resolve=>finish=resolve);
    b.w.HTMLCanvasElement.prototype.getContext=()=>{canvasUsed=true;return null;};
    const file=new b.w.File([new Uint8Array(600*1024)],'foto.jpg',{type:'image/jpeg'});
    const pending=b.w.qaOptimizarFoto(file,()=>current);current=false;
    finish({width:2000,height:1000,close:()=>closed++});
    assert.equal(await pending,file);assert.equal(canvasUsed,false);assert.equal(closed,1);
  }finally{b.w.close();}
});

test('Tienda admin: requiere un negocio y alguno de sus permisos antes de cargar datos',async()=>{
  for(const modo of ['sin-permiso','sin-negocio','pantalla-vencida']) {
    const b=browser({permisos:[]});
    try {
      if(modo==='sin-negocio'){b.ctx.negocio=null;b.ctx.admin=true;}
      if(modo==='pantalla-vencida'){b.ctx.admin=true;b.state.active=false;}
      await b.mount();assert.equal(b.calls.length,0);assert.equal(b.el('#ta-config,#ta-product-form,[data-ta-confirm]'),null);
    }finally{b.w.close();}
  }
});

test('Tienda admin: editar catálogo no concede configuración ni acceso a pedidos y contactos',async()=>{
  const b=browser();
  try {
    await b.mount();assert.ok(b.el('[data-ta-new]'));assert.ok(b.el('[data-ta-edit="web1"]'));
    assert.equal(b.el('[data-ta-tab="tienda"],#ta-config'),null);assert.equal(b.el('[data-ta-tab="pedidos"]'),null);
    assert.equal(b.calls.some(c=>c.path.includes('/pedidos')),false);
    b.el('[data-ta-edit="web1"]').click();await tick();
    assert.ok(b.el('#ta-product-form'));assert.equal(b.el('#ta-product-form [name="stock"]'),null);
    assert.equal(b.el('#ta-product-form [name="nombre"]').value,'Funda transparente');
    assert.equal(b.el('#ta-product-form [name="precio"]').value,'1234.56');
    b.el('#ta-product-form [name="nombre"]').value='Funda reforzada';
    b.el('#ta-product-form [name="precio"]').value='2000.75';
    b.el('#ta-product-form [name="modelos"]').value='iPhone 15, iPhone 15 Pro\niPhone 16';
    submit(b,'#ta-product-form');await tick();
    const request=writes(b)[0],body=JSON.parse(request.opts.body);
    assert.equal(request.path,'/tiendas/productos/web1');assert.equal(request.opts.method,'PUT');
    assert.equal(body.negocio_id,'n');assert.equal(body.precio_centavos,200075);assert.equal(body.nombre,'Funda reforzada');
    assert.deepEqual(body.modelos,['iPhone 15','iPhone 15 Pro','iPhone 16']);
    assert.equal('stock' in body,false);assert.equal('habilitada' in body,false);assert.equal(body.version,'v-producto');
    assert.match(body.solicitud_id,/^[a-f0-9-]{36}$/i);
  }finally{b.w.close();}
});

test('Tienda admin: solo el administrador puede configurar publicación y secciones del negocio',async()=>{
  const b=browser({admin:true});
  try {
    await b.mount();b.el('[data-ta-tab="tienda"]').click();await tick();
    assert.ok(b.el('#ta-config'));b.el('#ta-config [name="habilitada"]').checked=true;
    b.el('#ta-config [name="slug"]').value='ropa-qa';b.el('#ta-config [name="nombre"]').value='Ropa QA';
    b.el('#ta-config [name="tipo"]').value='ropa';b.el('#ta-config [name="whatsapp"]').value='5491122223333';
    b.el('#ta-config [name="secciones"]').value='Jean\nJogging\nRemeras\nColección propia';
    submit(b,'#ta-config');await tick();
    const request=writes(b)[0],body=JSON.parse(request.opts.body);
    assert.equal(request.path,'/tiendas/config');assert.equal(request.opts.method,'PUT');assert.equal(body.negocio_id,'n');assert.equal(body.habilitada,true);assert.equal(body.slug,'ropa-qa');
    assert.equal(body.tipo,'ropa');assert.deepEqual(body.secciones,['Jean','Jogging','Remeras','Colección propia']);
    assert.match(body.solicitud_id,/^[a-f0-9-]{36}$/i);
  }finally{b.w.close();}
});

test('Tienda admin: un producto nuevo empieza como borrador y sus archivos esperan a que exista',async()=>{
  const b=browser();
  try {
    await b.mount();b.el('[data-ta-new]').click();await tick();
    assert.equal(b.el('#ta-product-form [name="publicado"]').checked,false);
    assert.ok(b.el('#ta-product-form [name="stock"]'));
    b.el('#ta-product-form [name="stock"]').value='';
    assert.equal(b.el('#ta-media-files'),null);
    assert.match(b.el('#ta-product-form').textContent,/Después de guardar el producto podés agregar varias fotos y videos/);
    b.el('#ta-product-form [name="nombre"]').value='Auricular QA';
    b.el('#ta-product-form [name="precio"]').value='8900';submit(b,'#ta-product-form');await tick();
    const request=writes(b)[0],body=JSON.parse(request.opts.body);
    assert.equal(request.path,'/tiendas/productos');assert.equal(request.opts.method,'POST');assert.equal(body.publicado,false);assert.equal(body.stock,0);
    assert.equal(body.precio_centavos,890000);
  }finally{b.w.close();}
});

test('Tienda admin: un empleado puede fijar stock inicial al crear un producto nuevo',async()=>{
  const b=browser();
  try {
    await b.mount();b.el('[data-ta-new]').click();await tick();
    b.el('#ta-product-form [name="nombre"]').value='Funda azul';b.el('#ta-product-form [name="precio"]').value='2500';
    b.el('#ta-product-form [name="stock"]').value='7';submit(b,'#ta-product-form');await tick();
    const body=JSON.parse(writes(b)[0].opts.body);
    assert.equal(body.stock,7);assert.equal('producto_id' in body,false);
  }finally{b.w.close();}
});

test('Tienda admin: vincular inventario existente conserva su stock sin enviar un ajuste',async()=>{
  const b=browser();
  try {
    await b.mount();b.el('[data-ta-new]').click();await tick();
    b.el('#ta-product-form [name="origen"]').value='existente';
    b.el('#ta-product-form [name="origen"]').dispatchEvent(new b.w.Event('change',{bubbles:true}));await tick();
    assert.equal(b.el('#ta-product-form [name="stock"]'),null);
    b.el('#ta-product-form [name="producto_id"]').value='core1';
    b.el('#ta-product-form [name="producto_id"]').dispatchEvent(new b.w.Event('change',{bubbles:true}));await tick();
    assert.equal(b.el('#ta-product-form [name="nombre"]').value,'Funda transparente');
    submit(b,'#ta-product-form');await tick();
    const body=JSON.parse(writes(b)[0].opts.body);
    assert.equal(body.producto_id,'core1');assert.equal('stock' in body,false);
  }finally{b.w.close();}
});

test('Tienda admin: datos del catálogo y contacto se presentan como texto seguro',async()=>{
  const attack='<img src=x data-injected onerror=alert(1)>';
  const b=browser({admin:true,respond:(path,opts,fallback)=>route(path)==='/tiendas/productos'&&!isWrite({opts})?[{...listing(),nombre:attack,descripcion:attack}]:fallback(path,opts)});
  try {
    await b.mount();assert.equal(b.el('[data-injected],[onerror]'),null);assert.ok(b.view.textContent.includes(attack));
    b.el('[data-ta-edit="web1"]').click();await tick();
    assert.equal(b.el('#ta-product-form [name="nombre"]').value,attack);assert.equal(b.el('[data-injected],[onerror]'),null);
  }finally{b.w.close();}
});

test('Tienda admin: una respuesta incierta conserva la solicitud exacta y bloquea duplicados hasta reintentar',async()=>{
  let fail=true;const b=browser({respond:(path,opts,fallback)=>{if(isWrite({opts})&&fail)throw Error('Respuesta perdida');return fallback(path,opts);}});
  try {
    await b.mount();b.el('[data-ta-edit="web1"]').click();await tick();
    b.el('#ta-product-form [name="precio"]').value='1600.50';submit(b,'#ta-product-form');submit(b,'#ta-product-form');await tick();
    assert.equal(writes(b).length,1);const original=writes(b)[0];
    assert.match(storageText(b),/160050/);assert.ok(b.el('#ta-pending [data-ta-retry]'));
    await b.mount();assert.ok(b.el('#ta-pending [data-ta-retry]'));
    fail=false;b.el('#ta-pending [data-ta-retry]').click();await tick();await tick();
    assert.equal(writes(b).length,2);assert.equal(writes(b)[1].path,original.path);assert.equal(writes(b)[1].opts.method,original.opts.method);assert.equal(writes(b)[1].opts.body,original.opts.body);
    assert.equal(storageText(b).includes(JSON.parse(original.opts.body).solicitud_id),false);
  }finally{b.w.close();}
});

test('Tienda admin: no envía una mutación si no puede conservar su solicitud recuperable',async()=>{
  const b=browser();
  try {
    await b.mount();b.el('[data-ta-edit="web1"]').click();await tick();
    b.w.Storage.prototype.setItem=()=>{throw Error('Storage bloqueado');};
    submit(b,'#ta-product-form');await tick();assert.equal(writes(b).length,0);
  }finally{b.w.close();}
});

test('Tienda admin: sesión, negocio, permisos o navegación cambiados invalidan un formulario abierto',async()=>{
  for(const change of ['sesion','negocio','permiso','pantalla']) {
    const b=browser();
    try {
      await b.mount();b.el('[data-ta-edit="web1"]').click();await tick();const form=b.el('#ta-product-form');
      if(change==='sesion')b.w.localStorage.setItem('zilky_token','otra-sesion');
      if(change==='negocio')b.state.negocio='otro';
      if(change==='permiso')b.allowed.clear();
      if(change==='pantalla')b.view.replaceChildren();
      form.dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(writes(b).length,0);
    }finally{b.w.close();}
  }
});

test('Tienda admin: pedidos muestran contacto y precios reales, sin persistir contactos durante un reintento',async()=>{
  const b=browser({permisos:['tienda.pedidos'],respond:(path,opts,fallback)=>{if(isWrite({opts}))throw Error('Sin respuesta');return fallback(path,opts);}});
  try {
    await b.mount();if(b.el('[data-ta-tab="pedidos"]'))b.el('[data-ta-tab="pedidos"]').click();await tick();
    assert.equal(b.el('[data-ta-new],#ta-config'),null);assert.ok(b.el('[data-ta-order="pedido1"]'));
    b.el('[data-ta-order="pedido1"]').click();await tick();
    assert.match(b.view.textContent,/Ana Contacto Privado/);assert.match(b.view.textContent,/5491166667777/);assert.match(b.view.textContent,/1\.234,56/);assert.match(b.view.textContent,/2\.469,12/);
    assert.doesNotMatch(b.view.textContent,/pago recibido|pago confirmado|pagado correctamente/i);
    b.el('[data-ta-confirm="pedido1"]').click();await tick();
    const request=writes(b)[0],body=JSON.parse(request.opts.body);
    assert.equal(request.path,'/tiendas/pedidos/pedido1/confirmar');assert.equal(body.negocio_id,'n');assert.equal(body.version,'v-pedido');
    assert.match(body.solicitud_id,/^[a-f0-9-]{36}$/i);assert.equal('contacto' in body,false);
    for(const value of ['Ana Contacto Privado','5491166667777','ana.privada@qa.invalid'])assert.equal(storageText(b).includes(value),false);
  }finally{b.w.close();}
});

test('Tienda admin: cancelar un pedido requiere un motivo y conserva la versión revisada',async()=>{
  const b=browser({permisos:['tienda.pedidos']});
  try {
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    b.el('[data-ta-cancel="pedido1"]').click();await tick();assert.equal(writes(b).length,0);
    b.el('#ta-cancel-reason').value='El cliente canceló la compra';b.el('[data-ta-cancel="pedido1"]').click();await tick();
    const request=writes(b)[0],body=JSON.parse(request.opts.body);
    assert.equal(request.path,'/tiendas/pedidos/pedido1/cancelar');assert.equal(body.version,'v-pedido');assert.equal(body.motivo,'El cliente canceló la compra');assert.equal(body.negocio_id,'n');
    assert.equal('contacto' in body,false);
  }finally{b.w.close();}
});

test('Tienda admin: el enlace compartido es real y la descarga de contactos utiliza el helper autorizado',async()=>{
  const b=browser({permisos:['tienda.pedidos'],respond:(path,opts,fallback)=>route(path)==='/tiendas'?{config:{...config(),habilitada:true},estadisticas:{}}:fallback(path,opts)});
  const copied=[];
  try {
    Object.defineProperty(b.w.navigator,'clipboard',{value:{writeText:async value=>copied.push(value)}});
    await b.mount();assert.equal(b.el('.ta-share a').href,'https://zilky.test/tienda/tienda-qa');
    b.el('[data-ta-copy]').click();await tick();assert.deepEqual(copied,['https://zilky.test/tienda/tienda-qa']);
    b.el('[data-ta-csv]').click();await tick();
    assert.deepEqual(b.downloads,[{path:'/tiendas/contactos.csv?negocio_id=n',name:'contactos-tienda.csv'}]);
  }finally{b.w.close();}
});

test('Tienda admin: una consulta tardía no reemplaza otra pantalla',async()=>{
  let resolveConfig;const b=browser({respond:(path,opts,fallback)=>route(path)==='/tiendas'?new Promise(resolve=>resolveConfig=resolve):fallback(path,opts)});
  try {
    const pending=b.mount();b.view.textContent='Otra pantalla';resolveConfig({config:config(),estadisticas:{}});await pending;
    assert.equal(b.view.textContent,'Otra pantalla');assert.equal(b.el('#ta-config,[data-ta-new]'),null);
  }finally{b.w.close();}
});

test('Tienda admin: confirmar una venta conserva el cobro en cero hasta registrar dinero recibido',async()=>{
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>isWrite({opts})?confirmedDetail():fallback(path,opts)});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    assert.equal(b.el('#ta-payment-form'),null);assert.equal(b.el('[data-ta-payment-summary]'),null);
    assert.equal(b.el('[data-ta-confirm]').textContent,'Confirmar venta y descontar stock');
    b.el('[data-ta-confirm]').click();await tick();
    assert.match(writes(b)[0].path,/\/confirmar$/);
    const body=JSON.parse(writes(b)[0].opts.body);
    assert.deepEqual(Object.keys(body).sort(),['negocio_id','solicitud_id','version']);
    assert.equal(b.el('[data-ta-payment-summary]').dataset.estado,'sin_cobrar');
    assert.equal(b.el('#ta-payment-form [name="monto"]').value,'2469.12');
    assert.match(b.el('.ta-payment-summary').textContent,/Cobrado.*0,00/);
  }finally{b.w.close();}
});

test('Tienda admin: leer pedidos permite consultar cobros, registrarlos requiere permiso de pagos del mismo negocio',async()=>{
  for(const permisos of [['tienda.pedidos'],['tienda.pedidos','pagos.registrar'],['pagos.registrar']]){
    const b=browser({permisos,respond:(path,opts,fallback)=>route(path)==='/tiendas/pedidos/pedido1'?confirmedDetail():fallback(path,opts)});
    try{
      await b.mount();
      if(!permisos.includes('tienda.pedidos')){assert.equal(b.calls.length,0);continue;}
      b.el('[data-ta-order="pedido1"]').click();await tick();
      assert.ok(b.el('[data-ta-payment-summary]'));
      assert.equal(Boolean(b.el('#ta-payment-form')),permisos.includes('pagos.registrar'));
      if(!permisos.includes('pagos.registrar'))assert.match(b.el('#ta-order-detail').textContent,/Necesitás el permiso Registrar pagos/);
    }finally{b.w.close();}
  }
});

test('Tienda admin: un cobro parcial usa centavos, fecha argentina explícita y sólo efectivo o transferencia',async()=>{
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>{
    if(route(path)==='/tiendas/pedidos/pedido1/cobros')return {...confirmedDetail(),resumen_cobros:{cobrado_centavos:100000,saldo_centavos:146912,estado:'parcial'}};
    return route(path)==='/tiendas/pedidos/pedido1'?confirmedDetail():fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    b.el('#ta-payment-form [name="monto"]').value='1000';b.el('#ta-payment-form [name="medio_pago"]').value='transferencia';
    b.el('#ta-payment-form [name="fecha_hora"]').value='2026-11-02T13:45:20';b.el('#ta-payment-form [name="nota"]').value='Transferencia recibida';
    submit(b,'#ta-payment-form');submit(b,'#ta-payment-form');await tick();
    assert.equal(writes(b).length,1);const body=JSON.parse(writes(b)[0].opts.body);
    assert.equal(body.monto_centavos,100000);assert.equal(body.medio_pago,'transferencia');assert.equal(new Date(body.fecha_hora).toISOString(),'2026-11-02T16:45:20.000Z');assert.match(body.fecha_hora,/-03:00$/);
    assert.equal(body.nota,'Transferencia recibida');assert.equal(body.version,'v-pedido');assert.equal(body.negocio_id,'n');
    assert.equal(b.el('[data-ta-payment-summary]').dataset.estado,'parcial');assert.equal(b.el('#ta-payment-form [name="monto"]').value,'1469.12');
  }finally{b.w.close();}
});

test('Tienda admin: la fecha sin editar queda a cargo del servidor y un cobro no supera el saldo',async()=>{
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>route(path)==='/tiendas/pedidos/pedido1'?confirmedDetail():fallback(path,opts)});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    b.el('#ta-payment-form [name="monto"]').value='2500';submit(b,'#ta-payment-form');await tick();assert.equal(writes(b).length,0);
    b.el('#ta-payment-form [name="monto"]').value='100';submit(b,'#ta-payment-form');await tick();
    const body=JSON.parse(writes(b)[0].opts.body);assert.equal(body.monto_centavos,10000);assert.equal('fecha_hora' in body,false);assert.equal('nota' in body,false);
  }finally{b.w.close();}
});

test('Tienda admin: respuesta incierta de un cobro conserva cuerpo y UUID al cambiar campos y recargar',async()=>{
  let uncertain=true;
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>{
    if(route(path)==='/tiendas/pedidos/pedido1/cobros'){if(uncertain)throw Error('Respuesta de red perdida');return {...confirmedDetail(),resumen_cobros:{cobrado_centavos:10000,saldo_centavos:236912,estado:'parcial'}};}
    return route(path)==='/tiendas/pedidos/pedido1'?confirmedDetail():fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    b.el('#ta-payment-form [name="monto"]').value='100';submit(b,'#ta-payment-form');await tick();
    const first=writes(b)[0];assert.ok(b.el('[data-ta-retry]'));assert.ok(storageText(b).includes('monto_centavos'));
    assert.equal(storageText(b).includes(order().contacto.email),false);
    b.el('#ta-payment-form [name="monto"]').value='500';await b.mount();uncertain=false;
    b.el('[data-ta-retry]').click();await tick();
    assert.equal(writes(b).length,2);assert.equal(writes(b)[1].opts.body,first.opts.body);assert.equal(writes(b)[1].path,first.path);
    assert.equal(b.el('[data-ta-retry]'),null);assert.equal(b.el('[data-ta-payment-summary]').dataset.estado,'parcial');
  }finally{b.w.close();}
});

test('Tienda admin: revocar pagos mientras el formulario está abierto bloquea el envío y el reintento',async()=>{
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>{
    if(route(path)==='/tiendas/pedidos/pedido1/cobros')throw Error('Red interrumpida');
    return route(path)==='/tiendas/pedidos/pedido1'?confirmedDetail():fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    b.allowed.delete('pagos.registrar');submit(b,'#ta-payment-form');await tick();assert.equal(writes(b).length,0);
    b.allowed.add('pagos.registrar');submit(b,'#ta-payment-form');await tick();assert.equal(writes(b).length,1);
    b.allowed.delete('pagos.registrar');b.el('[data-ta-retry]').click();await tick();assert.equal(writes(b).length,1);
  }finally{b.w.close();}
});

test('Tienda admin: anular un cobro exige permiso y motivo, y conserva la versión revisada',async()=>{
  const paid={...confirmedDetail(),cobros:[{id:'cobro1',pago_id:'pago1',monto_centavos:10000,medio_pago:'efectivo',fecha_hora:'2026-11-02T13:00:00-03:00',comprobante:{numero:'QA-0001'},anulado:false}],resumen_cobros:{cobrado_centavos:10000,saldo_centavos:236912,estado:'parcial'}};
  for(const permisos of [['tienda.pedidos'],['tienda.pedidos','comprobantes.anular']]){
    const b=browser({permisos,respond:(path,opts,fallback)=>{
      if(route(path).endsWith('/cobros/cobro1/anular'))return {...confirmedDetail(),cobros:[{...paid.cobros[0],anulado:true}]};
      return route(path)==='/tiendas/pedidos/pedido1'?paid:fallback(path,opts);
    }});
    try{
      await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
      assert.match(b.el('[data-ta-payment-id="cobro1"]').textContent,/QA-0001/);
      assert.equal(Boolean(b.el('[data-ta-payment-void]')),permisos.includes('comprobantes.anular'));
      if(!permisos.includes('comprobantes.anular'))continue;
      b.el('[data-ta-payment-void]').click();submit(b,'#ta-payment-void-form');await tick();assert.equal(writes(b).length,0);
      b.el('#ta-payment-void-form [name="motivo"]').value='Importe cargado por error';submit(b,'#ta-payment-void-form');await tick();
      const body=JSON.parse(writes(b)[0].opts.body);assert.equal(body.version,'v-pedido');assert.equal(body.motivo,'Importe cargado por error');
      assert.match(writes(b)[0].path,/\/cobros\/cobro1\/anular$/);assert.equal(b.el('[data-ta-payment-summary]').dataset.estado,'sin_cobrar');assert.match(b.el('[data-ta-payment-id="cobro1"]').textContent,/Anulado/);
    }finally{b.w.close();}
  }
});

test('Tienda admin: cancelar una venta cobrada comunica la conservación de cobros y no crea un reintegro',async()=>{
  const paid={...confirmedDetail(),cobros:[{id:'cobro1',monto_centavos:246912,medio_pago:'transferencia',fecha_hora:'2026-11-02T13:00:00-03:00'}],resumen_cobros:{cobrado_centavos:246912,saldo_centavos:0,estado:'cobrado'}};
  const b=browser({permisos:['tienda.pedidos','pagos.registrar'],respond:(path,opts,fallback)=>route(path)==='/tiendas/pedidos/pedido1'?paid:route(path).endsWith('/cancelar')?{...paid,pedido:{...paid.pedido,estado:'cancelado'}}:fallback(path,opts)});
  try{
    await b.mount();b.el('[data-ta-order="pedido1"]').click();await tick();
    assert.equal(b.el('#ta-payment-form'),null);assert.match(b.el('.ta-cancel').textContent,/cancelar repone el stock y conserva los cobros/);
    b.el('#ta-cancel-reason').value='Cliente no retira';b.el('[data-ta-cancel]').click();await tick();
    assert.equal(writes(b).length,1);assert.match(writes(b)[0].path,/\/cancelar$/);
    assert.equal('monto_centavos' in JSON.parse(writes(b)[0].opts.body),false);assert.equal(b.el('[data-ta-payment-summary]').dataset.estado,'cobrado');
    assert.ok(b.el('[data-ta-payment-id="cobro1"]'));assert.equal(b.el('#ta-payment-form'),null);
  }finally{b.w.close();}
});

test('Tienda admin: Encargos filtra pedidos y muestra variantes guardadas, importe estimado y falta de stock',async()=>{
  let available=false;
  const requested={...detail(),pedido:{...order(),has_encargos:true},has_encargos:true,items:[{...detail().items[0],es_encargo:true,opciones:{modelos:['iPhone 15 Pro'],talle:'M',color:'Azul'}}],stock:[{...detail().stock[0],stock_actual:0,insuficiente:true}]};
  const b=browser({permisos:['tienda.pedidos'],respond:(path,opts,fallback)=>{
    if(route(path)==='/tiendas/pedidos')return [{...order(),has_encargos:true}];
    if(route(path)==='/tiendas/pedidos/pedido1')return available?{...requested,version:'v-stock-nuevo',stock:[{...requested.stock[0],stock_actual:5,insuficiente:false}]}:requested;
    return fallback(path,opts);
  }});
  try{
    await b.mount();b.el('[data-ta-tab="encargos"]').click();await tick();
    assert.ok(b.calls.some(c=>c.path==='/tiendas/pedidos?negocio_id=n&encargos=true'));
    b.el('[data-ta-order="pedido1"]').click();await tick();
    assert.match(b.el('#ta-order-detail').textContent,/Para encargar.*iPhone 15 Pro · Talle M · Azul/s);assert.match(b.el('.ta-order-total').textContent,/Total estimado/);
    assert.match(b.el('.ta-stock-notice').textContent,/Falta stock/);assert.equal(b.el('[data-ta-confirm]').disabled,true);b.el('[data-ta-confirm]').click();await tick();assert.equal(writes(b).length,0);
    available=true;b.el('#ta-order-detail [data-ta-order="pedido1"]').click();await tick();assert.equal(b.el('[data-ta-confirm]').disabled,false);
    b.el('[data-ta-confirm]').click();await tick();assert.equal(JSON.parse(writes(b)[0].opts.body).version,'v-stock-nuevo');
    assert.equal('monto_centavos' in JSON.parse(writes(b)[0].opts.body),false);
  }finally{b.w.close();}
});
