import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const source=read('app.js'),page=read('index.html'),purifier=read('vendor/purify.min.js');
const errorSource=read('ventaError.js').replace('export async function','async function');
const historySource=read('ventasHistorial.js').replace(/^import .*;\n/gm,'').replace('export async function','async function');
const pendingSource=read('pendingMutation.js').replace('export function','function');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const preview=(overrides={})=>({
  venta:{id:'duplicada',fecha:'2026-10-19',monto_total_centavos:100000},credito:{id:'credito'},version:'version-1',
  productos:[{id:'producto',nombre:'Campera QA',cantidad_reponer:1,stock_actual:6,stock_despues:7}],
  pagos:[],total_pagos_centavos:0,capital_pendiente_centavos:100000,advertencias:[],permitido:true,motivo_bloqueo:null,...overrides,
});
const pagos=()=>[{id:'anticipo',tipo:'entrega_inicial',monto_centavos:10000,fecha_hora:'2026-10-19T12:00:00-03:00'},
  {id:'pago',tipo:'cuota',monto_centavos:5000,fecha_hora:'2026-10-19T12:05:00-03:00'}];
function browser(respond=(path,opts)=>opts.method?{venta_id:'duplicada'}:preview()) {
  const dom=new JSDOM(page,{url:'https://zilky.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[],success=[],toasts=[];
  w.fetch=async()=>({ok:true,status:200,json:async()=>[]});w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.localStorage.setItem('zilky_token','sesion-qa');w.qaState.usuario={id:'admin',rol:'administrador'};w.qaState.negocioActual='tienda';w.qaState.negocios=[{id:'tienda',nombre:'Tienda QA'}];
  w.eval('(()=>{'+errorSource+'\nwindow.saleError=eliminarVentaPorError;})();');
  w.eval('(()=>{'+pendingSource+'\nwindow.pendingFactory=pendingMutation;})();');
  w.eval('(()=>{const pendingMutation=window.pendingFactory,eliminarVentaPorError=window.saleError;'+historySource+'\nwindow.salesHistory=ventasHistorial;})();');
  const state={active:true},view=w.document.getElementById('view');
  const ctx={api:async(path,opts={})=>{calls.push({path,opts});return respond(path,opts);},setHTML:w.setHTML,negocio:'tienda',ventaId:'duplicada',usuarioId:'admin',admin:true,
    toast:(...args)=>toasts.push(args),isCurrent:()=>state.active&&w.qaState.negocioActual==='tienda'&&w.qaState.usuario?.id==='admin'&&w.qaState.usuario?.rol==='administrador',onSuccess:r=>success.push(r)};
  return {w,calls,ctx,state,view,success,toasts,el:selector=>view.querySelector(selector)};
}
const posts=b=>b.calls.filter(call=>call.opts.method==='POST');
const submit=b=>b.el('[data-sale-error-form]').dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));
const key='zilky-venta-error-pendiente:admin:tienda';

test('Venta por error: primero carga la vista previa y explica la reposición automática de stock 6 → 7',async()=>{
  let terminar;const b=browser(()=>new Promise(resolve=>terminar=resolve));
  try {
    const pending=b.w.saleError(b.view,b.ctx);assert.equal(b.el('[data-sale-error-form]'),null);
    assert.equal(b.calls[0].path,'/ventas/duplicada/eliminar-error?negocio_id=tienda');
    terminar(preview());await pending;
    assert.match(b.view.textContent,/Eliminar venta cargada por error/);assert.match(b.view.textContent,/1 unidad.*Stock: 6 → 7/s);
    assert.match(b.view.textContent,/venta y sus cuotas quedan anuladas.*productos vuelven al stock automáticamente.*historial se conserva/s);
    assert.equal(b.el('#ventaErrorMotivo').value,'Venta cargada dos veces');
    assert.equal(b.el('[data-sale-error-payments]'),null);assert.equal(b.el('input[name="reponer"]'),null);assert.equal(posts(b).length,0);
  }finally{b.w.close();}
});

test('Venta por error: pagos y anticipo requieren reconocer el error de carga y se envía una sola confirmación explícita',async()=>{
  const b=browser((path,opts)=>opts.method?{ok:true}:preview({pagos:pagos(),total_pagos_centavos:15000,capital_pendiente_centavos:85000}));
  try {
    b.w.confirm=()=>{throw Error('No debe abrir una segunda confirmación');};
    await b.w.saleError(b.view,b.ctx);assert.match(b.view.textContent,/Entrega inicial.*100.*Pago de cuota.*50/s);
    assert.match(b.view.textContent,/No se devuelve dinero ni se crea saldo a favor/);
    submit(b);await tick();assert.equal(posts(b).length,0);assert.match(b.el('[data-sale-error-status]').textContent,/Confirmá que los pagos también se cargaron por error/);
    b.el('[data-sale-error-payments]').checked=true;submit(b);await tick();
    const body=JSON.parse(posts(b)[0].opts.body);
    assert.equal(body.confirmar,true);assert.equal(body.confirmar_pagos_erroneos,true);assert.equal(body.negocio_id,'tienda');assert.equal(body.version,'version-1');
    assert.equal(body.motivo,'Venta cargada dos veces');assert.match(body.solicitud_id,/^[a-f0-9-]{36}$/i);
    assert.equal('reponer' in body,false);assert.equal(b.success.length,1);assert.equal(b.w.sessionStorage.getItem(key),null);
  }finally{b.w.close();}
});

test('Venta por error: nombres, advertencias y motivos de bloqueo se presentan como texto seguro',async()=>{
  const attack='<img src=x onerror="alert(1)"><button data-fake>Enviar</button>';
  const p=preview({permitido:false,motivo_bloqueo:attack,advertencias:[attack]});p.productos[0].nombre=attack;
  const b=browser(()=>p);
  try {await b.w.saleError(b.view,b.ctx);assert.equal(b.view.querySelector('img,[onerror],[data-fake]'),null);assert.ok(b.view.textContent.includes(attack));assert.equal(b.el('[data-sale-error-form]'),null);assert.equal(posts(b).length,0);}
  finally{b.w.close();}
});

test('Venta por error: la vista previa conserva los centavos de pagos, capital y total de la venta',async()=>{
  const v=preview({pagos:[{...pagos()[0],monto_centavos:100051}],total_pagos_centavos:100051,capital_pendiente_centavos:23456});
  v.venta.monto_total_centavos=123507;
  const b=browser(()=>v);
  try {await b.w.saleError(b.view,b.ctx);assert.match(b.view.textContent,/1\.235,07/);assert.match(b.view.textContent,/1\.000,51/);assert.match(b.view.textContent,/234,56/);assert.equal(b.el('#ventaErrorMotivo').maxLength,1000);}
  finally{b.w.close();}
});

test('Venta por error: permisos denegados y contexto vencido impiden consultar la vista previa',async()=>{
  for(const reason of ['empleado','pantalla']){
    const b=browser();try{if(reason==='empleado')b.ctx.admin=false;else b.state.active=false;
      await b.w.saleError(b.view,b.ctx);assert.equal(b.calls.length,0);assert.equal(b.el('[data-sale-error-confirm]'),null);
    }finally{b.w.close();}
  }
});

for(const change of ['negocio','usuario','rol','sesion','panel','separado'])test(`Venta por error: cambiar ${change} invalida la confirmación abierta`,async()=>{
  const b=browser();try{
    await b.w.saleError(b.view,b.ctx);const form=b.el('[data-sale-error-form]');
    if(change==='negocio')b.w.qaState.negocioActual='otra';if(change==='usuario')b.w.qaState.usuario.id='otro';if(change==='rol')b.w.qaState.usuario.rol='empleado';
    if(change==='sesion')b.w.localStorage.setItem('zilky_token','otra');if(change==='panel')b.view.replaceChildren();if(change==='separado')b.view.remove();
    form.dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(posts(b).length,0);assert.equal(b.success.length,0);
  }finally{b.w.close();}
});

test('Venta por error: doble toque envía un solo POST y una respuesta incierta conserva exactamente el cuerpo',async()=>{
  let rechazar;const b=browser((path,opts)=>opts.method?new Promise((resolve,reject)=>rechazar=reject):preview());
  try {
    await b.w.saleError(b.view,b.ctx);submit(b);submit(b);assert.equal(posts(b).length,1);
    const original=posts(b)[0].opts.body;assert.equal(b.el('#ventaErrorMotivo').disabled,true);
    rechazar(Object.assign(new Error('Sin conexión'),{status:500}));await tick();
    assert.equal(b.el('[data-sale-error-confirm]').disabled,false);assert.match(b.el('[data-sale-error-confirm]').textContent,/Comprobar operación pendiente/);
    b.el('#ventaErrorMotivo').value='Otro motivo programático';submit(b);assert.equal(posts(b).length,2);assert.equal(posts(b)[1].opts.body,original);
    rechazar(new Error('Sin respuesta'));await tick();assert.equal(JSON.parse(b.w.sessionStorage.getItem(key)).body.motivo,'Venta cargada dos veces');
  }finally{b.w.close();}
});

test('Venta por error: reabrir una solicitud incierta conserva la vista revisada y el mismo id, aun al partir de otra venta',async()=>{
  let fallar=true;
  const b=browser((path,opts)=>{if(opts.method){if(fallar)throw new Error('Respuesta perdida');return {ok:true};}return preview();});
  try {
    await b.w.saleError(b.view,b.ctx);submit(b);await tick();const original=posts(b)[0].opts.body,count=b.calls.length;
    await b.w.saleError(b.view,{...b.ctx,ventaId:'venta-real'});
    assert.match(b.view.textContent,/Hay otra venta pendiente de confirmar/);assert.equal(b.el('[data-sale-error-confirm]'),null);assert.equal(b.calls.length,count);
    b.el('[data-sale-error-pending-open]').click();await tick();assert.equal(b.el('[data-sale-error]').dataset.saleError,'duplicada');
    assert.equal(b.el('#ventaErrorMotivo').disabled,true);assert.equal(b.calls.length,count);
    fallar=false;submit(b);await tick();assert.equal(posts(b)[1].path,'/ventas/duplicada/eliminar-error?negocio_id=tienda');assert.equal(posts(b)[1].opts.body,original);
    assert.equal(b.success.length,1);assert.equal(b.w.sessionStorage.getItem(key),null);
  }finally{b.w.close();}
});

test('Venta por error: un conflicto invalida la vista previa y obliga a cargar los datos actuales',async()=>{
  const b=browser((path,opts)=>{if(opts.method)throw Object.assign(new Error('Stock modificado'),{status:409});return preview();});
  try {
    await b.w.saleError(b.view,b.ctx);submit(b);await tick();assert.equal(b.el('[data-sale-error-confirm]'),null);assert.match(b.view.textContent,/La venta cambió/);
    assert.equal(b.w.sessionStorage.getItem(key),null);b.el('[data-sale-error-reload]').click();await tick();assert.equal(b.calls.filter(call=>!call.opts.method).length,2);assert.ok(b.el('[data-sale-error-confirm]'));
  }finally{b.w.close();}
});

test('Venta por error: una validación rechazada libera campos y permite corregir el motivo',async()=>{
  const b=browser((path,opts)=>{if(opts.method)throw Object.assign(new Error('Motivo inválido'),{status:400});return preview();});
  try {
    await b.w.saleError(b.view,b.ctx);submit(b);await tick();assert.equal(b.el('#ventaErrorMotivo').disabled,false);assert.match(b.el('[data-sale-error-status]').textContent,/Motivo inválido/);
    b.el('#ventaErrorMotivo').value='Error de carga confirmado';submit(b);await tick();assert.equal(JSON.parse(posts(b)[1].opts.body).motivo,'Error de carga confirmado');
    assert.notEqual(JSON.parse(posts(b)[0].opts.body).solicitud_id,JSON.parse(posts(b)[1].opts.body).solicitud_id);
  }finally{b.w.close();}
});

test('Venta por error: no envía dinero ni stock si no puede guardar la solicitud recuperable',async()=>{
  const b=browser();try{
    await b.w.saleError(b.view,b.ctx);b.w.Storage.prototype.setItem=()=>{throw Error('Storage bloqueado');};submit(b);await tick();
    assert.equal(posts(b).length,0);assert.match(b.el('[data-sale-error-status]').textContent,/No se envió la eliminación/);
  }finally{b.w.close();}
});

test('Venta por error: una carga tardía no reemplaza el panel usado para otra venta',async()=>{
  let terminar;const b=browser(()=>new Promise(resolve=>terminar=resolve));
  try {const request=b.w.saleError(b.view,b.ctx);b.view.textContent='Otra venta';terminar(preview());await request;assert.equal(b.view.textContent,'Otra venta');assert.equal(b.el('[data-sale-error-confirm]'),null);}
  finally{b.w.close();}
});

test('Venta por error: una confirmación tardía no ejecuta callbacks ni repinta después de navegar',async()=>{
  let terminar;const b=browser((path,opts)=>opts.method?new Promise(resolve=>terminar=resolve):preview());
  try {await b.w.saleError(b.view,b.ctx);submit(b);b.view.textContent='Otra pantalla';terminar({ok:true});await tick();assert.equal(b.view.textContent,'Otra pantalla');assert.equal(b.success.length,0);assert.equal(b.toasts.length,0);}
  finally{b.w.close();}
});

const sale=(id='duplicada',estado='activa')=>({id,estado,nombre:'Cliente QA',apellido:'',vendedor:'Admin',fecha:'2026-10-19',monto_total_centavos:100000,entrega_inicial_centavos:0,devolucion_centavos:0,modalidad:'cuotas'});
const detail=id=>({venta:sale(id),version:'version-detail',items:[{id:'item',descripcion:'Campera QA',cantidad:1,devuelto:0,precio_unitario_centavos:100000}],devoluciones:[]});
test('Historial: el administrador accede desde la lista y el detalle; la devolución anterior queda como opción avanzada',async()=>{
  const b=browser((path,opts)=>path.includes('/eliminar-error')?preview():path.startsWith('/ventas?')?[sale(),sale('anulada','anulada')]:detail('duplicada'));
  try {
    await b.w.salesHistory(b.view,b.ctx);assert.equal(b.view.querySelectorAll('#saleList button[data-sale-error]').length,1);
    b.el('[data-sale="duplicada"]').click();await tick();assert.ok(b.el('#saleDetail button[data-sale-error]'));
    const advanced=b.el('#saleReturn').closest('details');assert.equal(advanced.open,false);assert.match(advanced.querySelector('summary').textContent,/Devolución o anulación avanzada/);
    b.el('#saleDetail button[data-sale-error]').click();await tick();assert.ok(b.el('[data-sale-error-form]'));
    assert.equal(b.calls.at(-1).path,'/ventas/duplicada/eliminar-error?negocio_id=tienda');
  }finally{b.w.close();}
});

test('Historial: un empleado no ve botones de eliminación ni devolución aunque pueda ver sus ventas',async()=>{
  const b=browser(path=>path.startsWith('/ventas?')?[sale()]:detail('duplicada'));
  try {await b.w.salesHistory(b.view,{...b.ctx,admin:false});assert.equal(b.el('button[data-sale-error]'),null);b.el('[data-sale]').click();await tick();assert.equal(b.el('button[data-sale-error]'),null);assert.equal(b.el('#saleReturn'),null);}
  finally{b.w.close();}
});

test('Historial: una respuesta vieja de la venta A no reemplaza el detalle de la venta B',async()=>{
  let terminarA;const b=browser(path=>path.startsWith('/ventas?')?[sale('A'),sale('B')]:path.startsWith('/ventas/A?')?new Promise(resolve=>terminarA=resolve):detail('B'));
  try {await b.w.salesHistory(b.view,b.ctx);b.el('[data-sale="A"]').click();b.el('[data-sale="B"]').click();await tick();terminarA(detail('A'));await tick();assert.equal(b.el('#saleDetail button[data-sale-error]').dataset.saleError,'B');}
  finally{b.w.close();}
});

test('Historial: recuperar otra venta pendiente vuelve al detalle de la venta realmente anulada',async()=>{
  let history=false,failed=true;
  const b=browser((path,opts)=>{
    if(opts.method){if(failed)throw new Error('Respuesta perdida');return {venta:{id:'duplicada'}};}
    if(!history||path.includes('/eliminar-error'))return preview();
    if(path.startsWith('/ventas?'))return [sale('real'),sale('duplicada','anulada')];
    return {...detail('duplicada'),venta:sale('duplicada','anulada')};
  });
  try {
    await b.w.saleError(b.view,b.ctx);submit(b);await tick();history=true;
    await b.w.salesHistory(b.view,b.ctx);b.el('#saleList button[data-sale-error="real"]').click();await tick();
    b.el('[data-sale-error-pending-open]').click();await tick();failed=false;submit(b);await tick();await tick();
    assert.equal(b.calls.at(-1).path,'/ventas/duplicada?negocio_id=tienda');
    assert.equal(b.el('#saleDetail button[data-sale-error]'),null);
  }finally{b.w.close();}
});
