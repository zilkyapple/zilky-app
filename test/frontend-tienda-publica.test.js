import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html=fs.readFileSync(new URL('../public/tienda.html',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../public/tienda.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sample=(overrides={})=>({tienda:{slug:'mi-tienda',nombre:'Tienda QA',descripcion:'Un catálogo ficticio',tipo:'general',secciones:['iPhones','Ropa']},productos:[
  {id:'iphone-13',nombre:'iPhone 13',descripcion:'Modelo clásico',categoria:'iPhones',modelos:['iPhone 13'],precio_centavos:10000000,disponible:true,stock_disponible:3,media:[]},
  {id:'iphone-13-pro',nombre:'iPhone 13 Pro',descripcion:'Modelo Pro',categoria:'iPhones',modelos:['iPhone 13 Pro'],precio_centavos:15000000,disponible:true,stock_disponible:null,media:[]},
  {id:'remera-m',nombre:'Remera',categoria:'Ropa',modelos:[],talle:'M',color:'Rosa',precio_centavos:2000000,disponible:true,stock_disponible:4,media:[]},
  {id:'remera-l',nombre:'Remera',categoria:'Ropa',modelos:[],talle:'L',color:'Negro',precio_centavos:2000000,disponible:false,stock_disponible:0,media:[]},
],...overrides});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const receipt=(body,total=body.total_esperado_centavos)=>({id:'pedido-qa',codigo:'QA-123',estado:'pendiente',total_centavos:total,items:body.items.map(item=>({producto_id:item.producto_id,nombre:'Producto confirmado',cantidad:item.cantidad,precio_unitario_centavos:total/item.cantidad,subtotal_centavos:total}))});
async function browser({catalog=sample(),respond,local={},session={}}={}){
  const dom=new JSDOM(html,{url:'https://zilky.test/tienda/mi-tienda',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];let uuid=0;
  w.crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`;
  w.HTMLMediaElement.prototype.pause=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  for(const [key,value]of Object.entries(local))w.localStorage.setItem(key,value);
  for(const [key,value]of Object.entries(session))w.sessionStorage.setItem(key,value);
  w.fetch=async(url,options={})=>{
    const call={url,options,body:options.body?JSON.parse(options.body):null};calls.push(call);
    if(respond){const result=await respond(call,calls);if(result)return result;}
    return response(options.method==='POST'?receipt(call.body):catalog);
  };
  w.eval(source+'\nwindow.qaShop=shop;');await tick();await tick();
  const b={w,calls,el:selector=>w.document.querySelector(selector),all:selector=>[...w.document.querySelectorAll(selector)],close:()=>w.close()};
  b.change=(selector,value)=>{b.el(selector).value=value;b.el(selector).dispatchEvent(new w.Event('change',{bubbles:true}));};
  b.submit=async()=>{b.el('#checkoutForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();};
  b.fill=()=>{for(const [id,value]of Object.entries({orderName:'Lucía',orderSurname:'Pérez',orderPhone:'11 2345 6789',orderEmail:'lucia@example.invalid',orderNote:'Nota ficticia'}))b.el('#'+id).value=value;b.el('#orderConsent').checked=true;};
  return b;
}

test('Tienda pública: carga sólo recursos públicos y consulta anónima sin credenciales ni token',async()=>{
  const b=await browser();try{
    assert.equal(b.el('#shopTitle').textContent,'Tienda QA');assert.equal(b.el('#shopContent').hidden,false);
    assert.deepEqual([...b.w.document.scripts].map(script=>new URL(script.src).pathname),['/tienda.js']);
    assert.doesNotMatch(html,/app\.js|styles\.css|authScreen|fonts\.google/i);
    assert.equal(b.calls.length,1);assert.equal(b.calls[0].url,'/api/tienda-publica/mi-tienda');
    assert.equal(b.calls[0].options.credentials,'omit');assert.equal(b.calls[0].options.headers.Authorization,undefined);
  }finally{b.close();}
});

test('Tienda pública: modelo exacto distingue iPhone 13 de 13 Pro y filtros de ropa combinan categoría, talle y color',async()=>{
  const b=await browser();try{
    b.change('#modelFilter','iPhone 13');assert.deepEqual(b.all('[data-product]').map(node=>node.dataset.product),['iphone-13']);
    b.change('#modelFilter','iPhone 13 Pro');assert.deepEqual(b.all('[data-product]').map(node=>node.dataset.product),['iphone-13-pro']);
    b.el('#clearFilters').click();b.el('[data-category="Ropa"]').click();b.change('#sizeFilter','M');b.change('#colorFilter','Rosa');
    assert.deepEqual(b.all('[data-product]').map(node=>node.dataset.product),['remera-m']);
    b.change('#colorFilter','Negro');assert.equal(b.all('[data-product]').length,0);assert.equal(b.el('#catalogEmpty').hidden,false);
    b.el('#clearFilters').click();assert.equal(b.all('[data-product]').length,4);
  }finally{b.close();}
});

test('Tienda pública: textos y opciones no ejecutan HTML; URLs peligrosas no entran en la galería y videos no se reproducen solos',async()=>{
  const unsafe='<img src=x onerror="window.hacked=1">';const data=sample();data.tienda.nombre=unsafe;data.productos[0].nombre=unsafe;
  data.productos[0].media=[{tipo:'imagen',url:'javascript:alert(1)',orden:0},{tipo:'imagen',url:'/api/tienda-media/a',orden:1},{tipo:'video',url:'/api/tienda-media/b',orden:2},{tipo:'imagen',url:'/api/tienda-media/c',orden:3},{tipo:'video',url:'https://evil.invalid/video',orden:4}];
  const b=await browser({catalog:data});try{
    assert.equal(b.el('#shopTitle').textContent,unsafe);assert.equal(b.w.hacked,undefined);assert.equal(b.el('[onerror]'),null);
    const opener=b.el('[data-product="iphone-13"] .product-open');opener.focus();opener.click();assert.equal(b.el('#productTitle').textContent,unsafe);
    assert.equal(b.all('.gallery-thumb').length,3);b.el('[aria-label="Ver video 2"]').click();
    const video=b.el('#galleryStage video');assert.equal(video.preload,'none');assert.equal(video.controls,true);assert.equal(video.autoplay,false);assert.equal(video.playsInline,true);
    assert.equal(new URL(video.src).origin,'https://zilky.test');assert.equal(b.all('img').every(img=>img.loading==='lazy'),true);
    video.tabIndex=0;video.focus();const tab=new b.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});video.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented,false,'El video debe formar parte del recorrido de teclado del diálogo');
    b.el('#closeProduct').click();assert.equal(b.el('#productDialog').open,false);assert.equal(b.w.document.activeElement,opener);
  }finally{b.close();}
});

test('Tienda pública: carrito respeta stock, permite quitar y persiste únicamente IDs y cantidades por tienda',async()=>{
  const b=await browser();try{
    b.el('[data-add="iphone-13"]').click();b.el('[data-add="iphone-13"]').click();b.el('#openCart').click();
    b.el('[data-cart-item="iphone-13"] [data-quantity="1"]').click();
    assert.equal(b.el('[data-cart-item="iphone-13"] .quantity-value').textContent,'3');
    assert.equal(b.el('[data-cart-item="iphone-13"] [data-quantity="1"]').disabled,true);
    b.el('[data-cart-item="iphone-13"] [data-quantity="-1"]').click();assert.match(b.el('#cartTotal').textContent,/200\.000/);
    assert.deepEqual(JSON.parse(b.w.localStorage.getItem('zilky-tienda-carrito:mi-tienda')),[{id:'iphone-13',cantidad:2}]);
    b.fill();assert.doesNotMatch(JSON.stringify(b.w.localStorage),/Lucía|Pérez|lucia|2345|Nota/);
    b.el('[data-cart-item="iphone-13"] .remove-item').click();assert.equal(b.el('#cartEmpty').hidden,false);assert.equal(b.el('#mobileCart').hidden,true);
    assert.equal(b.el('[data-add="remera-l"]').disabled,true);
  }finally{b.close();}
});

test('Tienda pública: un carrito recuperado con menos stock permite bajar cantidades hasta quedar disponible',async()=>{
  const data=sample();data.productos[0].stock_disponible=2;
  const b=await browser({catalog:data,local:{'zilky-tienda-carrito:mi-tienda':JSON.stringify([{id:'iphone-13',cantidad:5}])}});try{
    b.el('#openCart').click();assert.equal(b.el('#submitOrder').disabled,true);
    for(const count of [4,3,2]){
      b.el('[data-cart-item="iphone-13"] [data-quantity="-1"]').click();
      assert.equal(b.el('[data-cart-item="iphone-13"] .quantity-value').textContent,String(count));
    }
    assert.equal(b.el('#submitOrder').disabled,false);
  }finally{b.close();}
});

test('Tienda pública: exige consentimiento y celular argentino; servidor confirma importe y se limpian carrito y datos personales',async()=>{
  const b=await browser();try{
    b.el('[data-add="iphone-13"]').click();b.el('#openCart').click();b.fill();b.el('#orderConsent').checked=false;await b.submit();
    assert.equal(b.calls.filter(call=>call.body).length,0);
    b.el('#orderConsent').checked=true;b.el('#orderPhone').value='123';await b.submit();assert.equal(b.calls.filter(call=>call.body).length,0);assert.equal(b.el('#checkoutError').hidden,false);
    b.el('#orderPhone').value='+54 (11) 2345-6789';await b.submit();const posts=b.calls.filter(call=>call.body);assert.equal(posts.length,1);
    assert.equal(posts[0].body.contacto.telefono,'+5491123456789');assert.equal(posts[0].body.total_esperado_centavos,10000000);
    assert.deepEqual(posts[0].body.items,[{producto_id:'iphone-13',cantidad:1}]);assert.equal(posts[0].body.acepta_contacto,true);
    assert.equal(b.el('#orderSuccess').hidden,false);assert.match(b.el('#orderSuccess').textContent,/El negocio confirma disponibilidad y coordina el pago/);
    assert.equal(b.el('#orderName').value,'');assert.equal(b.el('#orderPhone').value,'');assert.equal(b.el('#orderNote').value,'');
    assert.equal(b.w.sessionStorage.getItem('zilky-tienda-pedido-pendiente:mi-tienda'),null);assert.deepEqual(JSON.parse(b.w.localStorage.getItem('zilky-tienda-carrito:mi-tienda')),[]);
  }finally{b.close();}
});

test('Tienda pública: respuesta perdida se recupera tras recargar con el mismo UUID, datos e importe original aunque cambie el catálogo',async()=>{
  const first=await browser({respond:call=>{if(call.body)throw new TypeError('Fallo de red');}});let local,session,original;
  try{
    first.el('[data-add="iphone-13"]').click();first.el('#openCart').click();first.fill();await first.submit();
    original=first.calls.find(call=>call.body).body;assert.equal(first.el('#pendingNotice').hidden,false);assert.equal(first.el('#orderName').disabled,true);
    local=Object.fromEntries(Object.entries(first.w.localStorage));session=Object.fromEntries(Object.entries(first.w.sessionStorage));
    assert.match(session['zilky-tienda-pedido-pendiente:mi-tienda'],/Lucía/);assert.doesNotMatch(JSON.stringify(local),/Lucía|Pérez|lucia/);
  }finally{first.close();}
  const changed=sample();changed.productos[0].precio_centavos=20000000;
  const b=await browser({catalog:changed,local,session});try{
    assert.equal(b.calls.filter(call=>call.body).length,0,'Nunca se reenvía un pedido al abrir la tienda');
    b.el('#openCart').click();assert.equal(b.el('#orderName').value,'Lucía');assert.equal(b.el('#orderName').disabled,true);assert.match(b.el('#cartTotal').textContent,/100\.000/);
    await b.submit();const resent=b.calls.find(call=>call.body).body;assert.deepEqual(resent,original);
    assert.equal(b.el('#orderSuccess').hidden,false);assert.equal(b.w.sessionStorage.length,0);
  }finally{b.close();}
});

test('Tienda pública: cambio de precio 409 actualiza carrito y exige revisión y una nueva confirmación manual',async()=>{
  const changed=sample();changed.productos[0].precio_centavos=12000000;let posted=0;
  const b=await browser({respond:(call,calls)=>{
    if(call.body&&++posted===1)return response({error:'Los precios cambiaron; revisá tu carrito.'},409);
    if(!call.body&&calls.length>1)return response(changed);
  }});try{
    b.el('[data-add="iphone-13"]').click();b.el('#openCart').click();b.fill();await b.submit();
    assert.equal(posted,1);assert.match(b.el('#cartTotal').textContent,/120\.000/);assert.match(b.el('#checkoutError').textContent,/Revisá los productos y el total/);
    assert.equal(b.el('#orderName').value,'Lucía');assert.equal(b.el('#submitOrder').disabled,false);assert.equal(b.w.sessionStorage.length,0);
    const first=b.calls.find(call=>call.body).body;await b.submit();const posts=b.calls.filter(call=>call.body);
    assert.equal(posts.length,2);assert.notEqual(posts[1].body.solicitud_id,first.solicitud_id);assert.equal(posts[1].body.total_esperado_centavos,12000000);
  }finally{b.close();}
});

test('Tienda pública: dos envíos simultáneos usan una sola solicitud y almacenamiento bloqueado detiene el envío antes de crear pedidos',async()=>{
  let finish;const b=await browser({respond:call=>call.body?new Promise(resolve=>{finish=()=>resolve(response(receipt(call.body)));}):undefined});
  try{
    b.el('[data-add="iphone-13"]').click();b.el('#openCart').click();b.fill();const first=b.submit(),second=b.submit();await tick();
    assert.equal(b.calls.filter(call=>call.body).length,1);assert.equal(b.el('#submitOrder').disabled,true);finish();await Promise.all([first,second]);
  }finally{b.close();}
  const blocked=await browser();try{
    blocked.el('[data-add="iphone-13"]').click();blocked.el('#openCart').click();blocked.fill();
    const set=blocked.w.Storage.prototype.setItem;blocked.w.Storage.prototype.setItem=function(key,value){if(key.startsWith('zilky-tienda-pedido-'))throw new Error('Storage bloqueado');return set.call(this,key,value);};
    await blocked.submit();assert.equal(blocked.calls.filter(call=>call.body).length,0);assert.match(blocked.el('#checkoutError').textContent,/Todavía no se envió/);
  }finally{blocked.close();}
});

test('Tienda pública: catálogo vacío, tienda no disponible y recuperación de conexión muestran estados útiles',async()=>{
  const empty=await browser({catalog:sample({productos:[]})});try{assert.equal(empty.el('#catalogEmpty').hidden,false);assert.match(empty.el('#emptyTitle').textContent,/Pronto/);}finally{empty.close();}
  const missing=await browser({respond:()=>response({error:'No encontrada'},404)});try{assert.equal(missing.el('#shopContent').hidden,true);assert.match(missing.el('#shopState').textContent,/no está disponible/);assert.equal(missing.el('#openCart').disabled,true);}finally{missing.close();}
  let attempts=0;const offline=await browser({respond:()=>{if(++attempts===1)throw new TypeError('Offline');}});try{
    assert.match(offline.el('#shopState').textContent,/No pudimos abrir/);offline.el('#shopState button').click();await tick();await tick();assert.equal(offline.el('#shopContent').hidden,false);
  }finally{offline.close();}
});
