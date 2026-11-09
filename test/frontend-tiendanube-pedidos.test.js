import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<5;i++)await tick();};
const caps=()=>({actor_id:'emp',puede_cobrar:true,puede_elegir_cliente:true,elegir_vendedor:false});
const detail=()=>({order_id:'40',estado:'pendiente',fecha_entrega:'2026-11-09',capacidades:caps(),condiciones:[
  {condicion_precio:'30_dias',total_centavos:4250000,precio_publicado_centavos:4250000,descuento_centavos:0,lineas:[{producto_id:'p1',nombre:'Remera Street',variante:'Único · Azul',cantidad:1,precio_unitario_centavos:4250000}]},
  {condicion_precio:'contado',total_centavos:4000000,precio_publicado_centavos:4250000,descuento_centavos:250000,lineas:[{producto_id:'p1',nombre:'Remera Street',variante:'Único · Azul',cantidad:1,precio_unitario_centavos:4000000}]},
]});
function browser({admin=false,negocio='n1',permit,respond,stored}={}){
  const dom=new JSDOM('<!doctype html><main id="view"></main>',{url:'https://zilky.test/',runScripts:'outside-only'});
  const w=dom.window,view=w.document.getElementById('view'),calls=[];
  const NativeDate=w.Date;w.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-11-09T18:00:00Z']));}static now(){return new NativeDate('2026-11-09T18:00:00Z').valueOf();}};
  w.eval(read('vendor/purify.min.js'));
  w.eval('(()=>{'+read('tiendanubePedidos.js').replace(/export (?=(?:async )?function)/g,'')+'\nwindow.mountOrders=tiendanubePedidosView;})();');
  const fallback=(path,opts={})=>{
    if(path.startsWith('/tiendanube/pedidos/opciones?'))return {capacidades:{...caps(),elegir_vendedor:admin},clientes:[{id:'c1',nombre:'Ana',apellido:'Prueba'}],vendedores:admin?[{id:'emp',nombre:'Lucas'},{id:'admin',nombre:'Dueño'}]:[]};
    if(path.startsWith('/tiendanube/pedidos?'))return {capacidades:{...caps(),elegir_vendedor:admin},pedidos:[{order_id:'40',estado:'pendiente'}]};
    if(path.startsWith('/tiendanube/pedidos/40/entrega?'))return {...detail(),capacidades:{...caps(),elegir_vendedor:admin}};
    if(path==='/tiendanube/pedidos/40/entrega'&&opts.method==='POST'){
      const body=JSON.parse(opts.body);return {estado:'entregada',venta_id:'v1',credito_id:'cr1',condicion_precio:body.condicion_precio,
        total_centavos:body.total_esperado_centavos,entrega_inicial_centavos:body.entrega_inicial_centavos,saldo_inicial_centavos:body.total_esperado_centavos-body.entrega_inicial_centavos,
        fecha_entrega:body.fecha_entrega,fecha_limite:body.fecha_limite||null};
    }
    throw Error('Unexpected path '+path);
  };
  const active={value:true};
  const ctx={negocio,usuarioId:'emp',admin,puede:permit||(()=>true),valid:()=>active.value,
    setHTML:(el,html)=>el.innerHTML=w.DOMPurify.sanitize(html,{USE_PROFILES:{html:true}}),
    api:async(path,opts={})=>{calls.push({path,opts});return respond?respond(path,opts,fallback):fallback(path,opts);}};
  if(stored)w.sessionStorage.setItem('zilky-tn-entrega:emp:n1',JSON.stringify(stored));
  return {w,view,calls,ctx,active,el:s=>view.querySelector(s),mount:()=>w.mountOrders(view,ctx),writes:()=>calls.filter(c=>c.opts.method==='POST')};
}
function change(b,name,value,type='change'){
  const el=b.el(`[name="${name}"]`);assert.ok(el,'missing field '+name);
  if(el.type==='checkbox')el.checked=value;else el.value=value;
  el.dispatchEvent(new b.w.Event(type,{bubbles:true}));
}
async function open(b){await b.mount();b.el('[data-tn-order="40"]').click();await flush();}
const submit=b=>b.el('[data-tn-delivery-form]').dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));

test('pedidos Tiendanube exige negocio y ambos permisos antes de consultar',async()=>{
  for(const opts of [{negocio:null},{permit:()=>false},{permit:p=>p==='tienda.pedidos'}]){
    const b=browser(opts);try{await b.mount();assert.equal(b.calls.length,0);assert.equal(b.el('[data-tn-order]'),null);}finally{b.w.close();}
  }
});
test('flag apagado se muestra sin fingir conexión, ventas ni cobros',async()=>{
  const b=browser({respond:()=>{throw Object.assign(Error('secret provider text'),{status:409,code:'ENTREGAS_TIENDANUBE_DESHABILITADAS'});}});
  try{await b.mount();assert.match(b.view.textContent,/todavía no está habilitada/);assert.equal(b.writes().length,0);assert.doesNotMatch(b.view.textContent,/secret provider/);}finally{b.w.close();}
});
test('entrega sin dinero mantiene total único, cliente obligatorio y vencimiento +30 editable',async()=>{
  const b=browser();try{
    await open(b);assert.equal(b.el('[name="monto"]').value,'0');assert.equal(b.el('[name="limite"]').value,'2026-12-09');
    change(b,'entregado',true);assert.equal(b.el('[data-tn-confirm-delivery]').disabled,true);
    change(b,'cliente','c1');assert.equal(b.el('[data-tn-confirm-delivery]').disabled,false);
    assert.match(b.view.textContent,/Un único saldo/);submit(b);submit(b);await flush();
    assert.equal(b.writes().length,1);const body=JSON.parse(b.writes()[0].opts.body);
    assert.equal(body.entrega_inicial_centavos,0);assert.equal(body.total_esperado_centavos,4250000);assert.equal(body.fecha_limite,'2026-12-09');
    assert.equal(Object.hasOwn(body,'fecha_hora_cobro'),false);assert.equal(Object.hasOwn(body,'medio_pago_entrega'),false);
    assert.equal(Object.hasOwn(body,'comision_usuario_id'),false);assert.match(b.view.textContent,/Entrega registrada/);
  }finally{b.w.close();}
});
test('entrega parcial permite monto real no mitad, fecha real y vencimiento acordado',async()=>{
  const b=browser();try{
    await open(b);change(b,'monto','10000','input');change(b,'medio','transferencia');change(b,'hora','2026-11-09T14:30:00');
    change(b,'limite','2026-12-15');change(b,'cliente','c1');change(b,'entregado',true);
    assert.equal(b.el('[data-tn-confirm-delivery]').disabled,true);change(b,'cobrado',true);
    submit(b);await flush();const body=JSON.parse(b.writes()[0].opts.body);
    assert.equal(body.entrega_inicial_centavos,1000000);assert.equal(body.fecha_hora_cobro,'2026-11-09T14:30:00-03:00');
    assert.equal(body.fecha_limite,'2026-12-15');assert.equal(body.medio_pago_entrega,'transferencia');assert.equal(body.cobro_ya_registrado,false);
  }finally{b.w.close();}
});
test('contado descuenta 2500 sin autocompletar dinero ni permitir saldo',async()=>{
  const b=browser();try{
    await open(b);change(b,'condicion','contado');assert.equal(b.el('[name="monto"]').value,'0');
    change(b,'monto','10000','input');change(b,'entregado',true);change(b,'cobrado',true);
    assert.equal(b.el('[data-tn-confirm-delivery]').disabled,true);
    change(b,'monto','40000','input');assert.equal(b.el('[data-tn-confirm-delivery]').disabled,false);
    submit(b);await flush();const body=JSON.parse(b.writes()[0].opts.body);
    assert.equal(body.total_esperado_centavos,4000000);assert.equal(body.entrega_inicial_centavos,4000000);assert.equal(body.cliente_id,null);
    assert.equal(Object.hasOwn(body,'fecha_limite'),false);
  }finally{b.w.close();}
});
test('empleado sin pagos.registrar no puede cargar dinero, ni atribuir venta a otro vendedor',async()=>{
  const b=browser({permit:p=>p!=='pagos.registrar'});try{
    await open(b);assert.equal(b.el('[name="monto"]').disabled,true);assert.equal(b.el('[name="vendedor"]'),null);
    change(b,'monto','10000','input');change(b,'cliente','c1');change(b,'entregado',true);change(b,'cobrado',true);
    submit(b);await flush();assert.equal(b.writes().length,0);
  }finally{b.w.close();}
});
test('admin puede elegir vendedor sin mostrar datos de comisión ni costo',async()=>{
  const b=browser({admin:true,respond:(path,opts,fallback)=>{
    const r=fallback(path,opts);r.token_cifrado='SECRET_CANARY';r.costo_centavos=9999999;r.comision_centavos=250000;
    return r;
  }});try{
    await open(b);change(b,'vendedor','admin');change(b,'cliente','c1');change(b,'entregado',true);submit(b);await flush();
    assert.equal(JSON.parse(b.writes()[0].opts.body).comision_usuario_id,'admin');
    assert.doesNotMatch(b.view.textContent,/SECRET_CANARY|9999999|comisi[oó]n|costo/i);
  }finally{b.w.close();}
});
test('error de red conserva UUID y payload; reintentar no reconstruye monto ni fecha',async()=>{
  let posts=0;
  const b=browser({respond:(path,opts,fallback)=>{
    if(opts.method==='POST'&&++posts===1)throw Object.assign(Error('lost response'),{status:503});
    return fallback(path,opts);
  }});try{
    await open(b);change(b,'cliente','c1');change(b,'entregado',true);submit(b);await flush();
    assert.ok(b.el('[data-tn-retry]'));assert.ok(b.w.sessionStorage.getItem('zilky-tn-entrega:emp:n1'));
    b.el('[data-tn-retry]').click();await flush();assert.equal(b.writes().length,2);
    assert.equal(b.writes()[0].opts.body,b.writes()[1].opts.body);assert.equal(b.w.sessionStorage.getItem('zilky-tn-entrega:emp:n1'),null);
  }finally{b.w.close();}
});
test('respuesta perdida se reconcilia con entrega existente sin reenviar POST',async()=>{
  let saved=null;
  const b=browser({respond:(path,opts,fallback)=>{
    if(opts.method==='POST'){saved=fallback(path,opts);throw Error('lost response');}
    if(saved&&path.startsWith('/tiendanube/pedidos/40/entrega?'))return {order_id:'40',estado:'entregada',entrega:saved};
    return fallback(path,opts);
  }});try{
    await open(b);change(b,'cliente','c1');change(b,'entregado',true);submit(b);await flush();
    assert.equal(b.writes().length,1);assert.equal(b.el('[data-tn-retry]'),null);assert.match(b.view.textContent,/ya tiene una entrega registrada/);
  }finally{b.w.close();}
});
test('rechazo definitivo sin entrega permite corregir sin duplicar solicitud incierta',async()=>{
  const b=browser({respond:(path,opts,fallback)=>opts.method==='POST'?Promise.reject(Object.assign(Error('invalid'),{status:400,code:'FECHA_COBRO_INVALIDA'})):fallback(path,opts)});
  try{
    await open(b);change(b,'cliente','c1');change(b,'entregado',true);submit(b);await flush();
    assert.equal(b.writes().length,1);assert.equal(b.el('[data-tn-retry]'),null);assert.equal(b.el('[name="cliente"]').disabled,false);
  }finally{b.w.close();}
});
test('pantalla vieja no usa datos ni envía POST tras cambio de negocio o revocación',async()=>{
  let resolve;
  const b=browser({respond:(path,opts,fallback)=>path.startsWith('/tiendanube/pedidos/40/entrega?')?new Promise(r=>resolve=r):fallback(path,opts)});
  try{
    await b.mount();b.el('[data-tn-order]').click();b.ctx.negocio='n2';resolve(detail());await flush();
    assert.equal(b.el('[data-tn-delivery-form]'),null);assert.equal(b.writes().length,0);
  }finally{b.w.close();}
  const revoked=browser();try{
    await open(revoked);change(revoked,'cliente','c1');change(revoked,'entregado',true);revoked.active.value=false;submit(revoked);await flush();assert.equal(revoked.writes().length,0);
  }finally{revoked.w.close();}
});
test('nombres remotos/locales se escapan y no crean markup ejecutable',async()=>{
  const b=browser({respond:(path,opts,fallback)=>{
    const r=fallback(path,opts);if(r.condiciones)r.condiciones[0].lineas[0].nombre='<img src=x onerror=alert(1)>';
    return r;
  }});try{await open(b);assert.equal(b.el('img,[onerror],script'),null);assert.match(b.view.textContent,/<img src=x/);}finally{b.w.close();}
});
test('entrypoint operativo tiene guards y no convierte integración admin en pantalla de empleado',()=>{
  const app=read('app.js'),server=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(app,/root === 'tiendanube' && parts\[1\] === 'pedidos'/);
  assert.match(app,/puede\('tienda\.pedidos',negocio\)&&puede\('ventas\.crear',negocio\)/);
  assert.ok(server.indexOf("app.use('/api/tiendanube', tiendanubePedidosRouter)")<server.indexOf("app.use('/api/tiendanube', tiendanubeAdminRouter)"));
  assert.match(server,/'\/tiendanubePedidos\.js'/);
});
