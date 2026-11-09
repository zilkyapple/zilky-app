import test from 'node:test';
import assert from 'node:assert/strict';
import { crearServicioTiendanubeSync, clasificarFalloSync, stockRemotoVerificado } from '../src/services/tiendanubeSyncService.js';

const DATE='2026-11-09T12:00:00.000Z';
const copy=x=>x===undefined?undefined:structuredClone(x);

function fixture({stock=5,remote=5,paused=false,enabled=true,api}={}){
  const state={
    con:{negocio_id:'ropa',store_id:'10',pausada:paused,sync_activada_at:'2026-11-09T10:00:00Z',sync_baseline_at:'2026-11-09T10:00:00Z',sync_webhooks_at:'2026-11-09T10:00:00Z'},
    link:{producto_id:'shirt',negocio_id:'ropa',store_id:'10',product_id:'20',variant_id:'30',sync_baseline_at:'2026-11-09T10:00:00Z',sync_stock_remoto:remote},
    stock,events:[],orders:{},ledger:{},outbox:null,redacted:new Set(),history:[],calls:[],
  };
  let mutex=Promise.resolve();
  const repo={
    async transaccion(n,fn){
      const prior=mutex;let release;mutex=new Promise(r=>{release=r;});await prior;
      const before=copy(state);
      try{return await fn(n===state.con?.negocio_id?copy(state.con):null);}catch(e){Object.assign(state,before);throw e;}finally{release();}
    },
    async resumen(){return {conexion:copy(state.con),variantes:1,sin_baseline:state.link.sync_baseline_at?0:1,revision:state.outbox?.estado==='revision_manual'?1:0};},
    async pausar(_n,code){state.con.pausada=true;state.con.sync_motivo_pausa=code;},
    async evento(store,now){return copy(state.events.find(e=>e.store_id===store&&!e.procesado_at&&['pendiente','reintento'].includes(e.sync_estado)&&(!e.retry||e.retry<=now)));},
    async marcarEvento(e,estado,error=null,retry=null){Object.assign(state.events.find(x=>x.id===e.id),{sync_estado:estado,error,retry,procesado_at:['procesado','ignorado'].includes(estado)?DATE:null});},
    async hayEntradas(store){return state.events.some(e=>e.store_id===store&&!e.procesado_at&&e.sync_estado!=='ignorado');},
    async estaRedactado(_s,o){return state.redacted.has(String(o));},
    async pedido(_s,o){return copy(state.orders[o]);},
    async entrega(){return null;},
    async aplicados(_s,o){return copy(Object.values(state.ledger[o]||{}));},
    async variante(n,s,v){return n===state.con.negocio_id&&s===state.con.store_id&&v===state.link.variant_id?copy({...state.link,stock:state.stock}):null;},
    async guardarPedido(_c,p,revision){state.orders[p.order_id]={...copy(p),pendiente_revision:revision};},
    async aplicarReserva(_c,p,link,qty,delta){
      state.stock-=delta;state.link.sync_stock_remoto-=delta;
      (state.ledger[p.order_id]??={})[link.variant_id]={variant_id:link.variant_id,producto_id:link.producto_id,cantidad_aplicada:qty};
      state.history.push({order:p.order_id,delta});mutateStock(state.stock);
    },
    async candidato(_n,now){return state.outbox?.estado==='pendiente'&&!state.outbox.envio_token&&(!state.outbox.proximo_intento||state.outbox.proximo_intento<=now)&&(!state.link.sync_verificar_despues||state.link.sync_verificar_despues<=now)?{producto_id:'shirt'}:null;},
    async salida(){return state.outbox?copy({...state.outbox,...state.link,stock:state.stock}):null;},
    async lease(_c,token,hasta){Object.assign(state.con,{sync_lease_token:token,sync_lease_hasta:hasta});},
    async liberar(_n,token){if(state.con.sync_lease_token===token){state.con.sync_lease_token=null;state.con.sync_lease_hasta=null;}},
    async reclamar(o,token,now){Object.assign(state.outbox,{estado:'enviando',envio_token:token,envio_version:o.version,envio_stock:o.stock,envio_delta:o.stock-o.sync_stock_remoto,envio_put_iniciado:false,envio_iniciado_at:now,intentos:(state.outbox.intentos||0)+1});},
    async iniciarEscritura(){state.outbox.envio_put_iniciado=true;},
    async terminar(o,token,r){
      if(state.outbox?.envio_token!==token)return;
      if(r.esperado!==undefined){state.link.sync_stock_remoto=r.esperado;state.link.sync_verificar_despues=r.verificarDespues||null;}
      Object.assign(state.outbox,{estado:r.estado==='sincronizado'&&state.outbox.version!==o.version?'pendiente':r.estado,ultimo_error:r.codigo||null,proximo_intento:r.retry||null});
      if(r.estado!=='revision_manual')Object.assign(state.outbox,{envio_token:null,envio_version:null,envio_stock:null,envio_delta:null,envio_put_iniciado:false,envio_iniciado_at:null});
    },
    async abandonados(){return state.outbox?.envio_token?[copy(state.outbox)]:[];},
    async marcarRevision(_o,code){state.outbox.estado='revision_manual';state.outbox.ultimo_error=code;},
  };
  const addEvent=(order='40',topic='order/created')=>{state.events.push({id:state.events.length+1,store_id:'10',recurso_id:order,topic,sync_estado:'pendiente',sync_intentos:0});};
  function mutateStock(next){
    state.stock=next;
    state.outbox={...state.outbox,producto_id:'shirt',negocio_id:'ropa',stock_deseado:next,version:(state.outbox?.version||0)+1,estado:'pendiente',intentos:0,proximo_intento:null};
  }
  let order={id:40,created_at:'2026-11-09T11:00:00Z',status:'open',payment_status:'pending',products:[{variant_id:30,quantity:1}]};
  const remoteVariant=stock=>({id:30,product_id:20,stock_management:true,stock});
  const service=crearServicioTiendanubeSync({repo,enabled,now:()=>new Date(DATE),uuid:()=>`claim-${state.calls.length}`,apiFactory:()=>async(method,path,data)=>{
    state.calls.push({method,path,data});
    if(api)return api({method,path,data,state,mutateStock,remoteVariant,order});
    if(path.startsWith('/orders/'))return copy(order);
    if(method==='GET')return remoteVariant(state.link.sync_stock_remoto);
    return [remoteVariant(state.link.sync_stock_remoto+data.value)];
  }});
  return {state,service,addEvent,mutateStock,setOrder:o=>{order={...order,...o};},remoteVariant};
}

test('feature flag y conexión pausada impiden cualquier llamada a la API',async()=>{
  const off=fixture({enabled:false});off.addEvent();off.mutateStock(4);
  assert.equal((await off.service.procesarEntrada('ropa')).estado,'deshabilitado');
  assert.equal((await off.service.procesarSalida('ropa')).estado,'deshabilitado');
  assert.deepEqual(off.state.calls,[]);
  const paused=fixture({paused:true});paused.addEvent();paused.mutateStock(4);
  assert.equal((await paused.service.procesarEntrada('ropa')).estado,'pausado');
  assert.equal((await paused.service.procesarSalida('ropa')).estado,'pausado');
  assert.deepEqual(paused.state.calls,[]);
});

test('pedido sin pagar reserva una vez; webhook paid duplicado no toca stock ni crea cobros/comisiones',async()=>{
  const f=fixture();f.addEvent();
  const first=await f.service.procesarEntrada('ropa');
  assert.equal(first.unidades_reservadas,1);assert.equal(first.cobros_creados,0);assert.equal(first.comisiones_creadas,0);
  assert.equal(f.state.stock,4);assert.equal(f.state.link.sync_stock_remoto,4);
  f.setOrder({payment_status:'paid'});f.addEvent('40','order/paid');f.addEvent('40','order/paid');
  assert.equal((await f.service.procesarEntrada('ropa')).unidades_reservadas,0);
  assert.equal((await f.service.procesarEntrada('ropa')).unidades_reservadas,0);
  assert.equal(f.state.stock,4);assert.equal(f.state.history.length,1);assert.equal(f.state.orders['40'].pagado,true);
});

test('pedidos históricos y redactados no se reimportan ni reservan',async()=>{
  const f=fixture();f.addEvent();f.setOrder({created_at:'2026-11-08T10:00:00Z'});
  assert.equal((await f.service.procesarEntrada('ropa')).estado,'historico_ignorado');assert.equal(f.state.stock,5);
  f.addEvent('41');f.state.redacted.add('41');
  assert.equal((await f.service.procesarEntrada('ropa')).estado,'redactado_ignorado');assert.equal(f.state.calls.length,1);
});

test('variante no vinculada y stock insuficiente pausan sin aplicar parcialmente un pedido',async()=>{
  const f=fixture();f.addEvent();f.setOrder({products:[{variant_id:30,quantity:1},{variant_id:31,quantity:1}]});
  assert.equal((await f.service.procesarEntrada('ropa')).codigo,'VARIANTE_SIN_BASELINE');assert.equal(f.state.stock,5);assert.equal(f.state.con.pausada,true);
  const g=fixture({stock:0});g.addEvent();
  assert.equal((await g.service.procesarEntrada('ropa')).codigo,'STOCK_LOCAL_INSUFICIENTE');assert.equal(g.state.stock,0);
});

test('cancelación y edición que reduce unidades requieren revisión sin reponer stock',async()=>{
  const f=fixture();f.addEvent();await f.service.procesarEntrada('ropa');
  f.setOrder({status:'cancelled'});f.addEvent('40','order/cancelled');
  assert.equal((await f.service.procesarEntrada('ropa')).codigo,'CANCELACION_RESTOCK_POR_VERIFICAR');assert.equal(f.state.stock,4);
  const g=fixture();g.addEvent();g.setOrder({products:[{variant_id:30,quantity:2}]});await g.service.procesarEntrada('ropa');
  g.setOrder({products:[{variant_id:30,quantity:1}]});g.addEvent('40','order/edited');
  assert.equal((await g.service.procesarEntrada('ropa')).codigo,'EDICION_CON_REPOSICION_POR_VERIFICAR');assert.equal(g.state.stock,3);
});

test('pedido nuevo cancelado sin reserva no inventa reposición',async()=>{
  const f=fixture();f.addEvent();f.setOrder({status:'cancelled'});
  assert.equal((await f.service.procesarEntrada('ropa')).estado,'cancelado_sin_reserva');assert.equal(f.state.stock,5);assert.equal(f.state.history.length,0);
});

test('salida publica solo variación de una variante explícita, conserva versión y no cambia precios',async()=>{
  const f=fixture();f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).estado,'sincronizado');
  assert.deepEqual(f.state.calls.map(c=>c.method),['GET','POST']);assert.equal(f.state.calls[1].path,'/products/20/variants/stock');
  assert.deepEqual(f.state.calls[1].data,{action:'variation',value:-1,id:30});
  assert.equal(f.state.outbox.estado,'sincronizado');assert.equal(f.state.link.sync_stock_remoto,4);assert.equal(f.state.con.sync_lease_token,null);
});

test('reserva ya descontada en Tiendanube se confirma sin POST innecesario',async()=>{
  const f=fixture();f.addEvent();await f.service.procesarEntrada('ropa');
  const result=await f.service.procesarSalida('ropa');
  assert.equal(result.estado,'sincronizado');assert.equal(result.sin_escritura,true);
  assert.equal(f.state.calls.filter(c=>c.method==='POST').length,0);
  assert.equal(f.state.outbox.estado,'sincronizado');assert.equal(f.state.link.sync_stock_remoto,4);
});

test('versión nueva durante POST exitoso queda pendiente, no se pierde cambio local',async()=>{
  const f=fixture({api:({method,state,mutateStock,remoteVariant,data})=>{
    if(method==='GET')return remoteVariant(state.link.sync_stock_remoto);
    mutateStock(3);return [remoteVariant(state.link.sync_stock_remoto+data.value)];
  }});f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).estado,'sincronizado');
  assert.equal(f.state.outbox.estado,'pendiente');assert.equal(f.state.stock,3);assert.equal(f.state.link.sync_stock_remoto,4);
});

test('cambio local entre lectura y escritura cancela snapshot viejo sin POST',async()=>{
  const f=fixture({api:({method,state,mutateStock,remoteVariant})=>{
    if(method==='GET'){mutateStock(3);return remoteVariant(state.link.sync_stock_remoto);}throw new Error('No debe escribir');
  }});f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).codigo,'CAMBIO_DURANTE_PREPARACION');
  assert.equal(f.state.calls.length,1);assert.equal(f.state.stock,3);assert.equal(f.state.outbox.estado,'pendiente');assert.equal(f.state.outbox.version,2);
});

test('drift remoto previo impide enviar una variación sin conciliar',async()=>{
  const f=fixture({api:({remoteVariant})=>remoteVariant(2)});f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).codigo,'STOCK_REMOTO_CAMBIO_FUERA_DE_COLA');
  assert.equal(f.state.calls.length,1);assert.equal(f.state.con.pausada,true);assert.equal(f.state.outbox.estado,'revision_manual');
});

test('429 reintenta después de Retry-After; 401 pausa la conexión sin revelar error crudo',async()=>{
  const f=fixture({api:()=>{throw Object.assign(new Error('token confidencial que no debe guardarse'),{status:429,retryAfter:'60'});}});f.mutateStock(4);
  const retry=await f.service.procesarSalida('ropa');assert.equal(retry.codigo,'LIMITE_API');
  assert.equal(f.state.outbox.proximo_intento,'2026-11-09T12:01:00.000Z');assert.equal(f.state.con.pausada,false);assert.equal(f.state.outbox.ultimo_error,'LIMITE_API');
  const g=fixture({api:()=>{throw Object.assign(new Error('secreto'),{status:401});}});g.mutateStock(4);
  assert.equal((await g.service.procesarSalida('ropa')).codigo,'ACCESO_REVOCADO');assert.equal(g.state.con.pausada,true);
});

test('timeout después de iniciar POST se marca ambiguo y no se reintenta ciegamente',async()=>{
  const f=fixture({api:({method,state,remoteVariant})=>{if(method==='GET')return remoteVariant(state.link.sync_stock_remoto);throw new Error('network timeout');}});f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).codigo,'RESULTADO_POST_STOCK_AMBIGUO');
  assert.equal(f.state.outbox.estado,'revision_manual');assert.equal((await f.service.procesarSalida('ropa')).estado,'pausado');
  assert.equal(f.state.outbox.envio_delta,-1);assert.equal(f.state.outbox.envio_stock,4);assert.equal(f.state.outbox.envio_put_iniciado,true);
  assert.equal(f.state.con.sync_lease_token,null);
  assert.equal(f.state.calls.filter(c=>c.method==='POST').length,1);
});

test('lease durable serializa dos workers y envíos interrumpidos no se repiten',async()=>{
  let release,started;const didStart=new Promise(r=>{started=r;});const gate=new Promise(r=>{release=r;});
  const f=fixture({api:async({method,state,remoteVariant,data})=>{if(method==='GET'){started();await gate;return remoteVariant(state.link.sync_stock_remoto);}return [remoteVariant(state.link.sync_stock_remoto+data.value)];}});f.mutateStock(4);
  const one=f.service.procesarSalida('ropa');await didStart;
  assert.equal((await f.service.procesarSalida('ropa')).estado,'ocupado');release();await one;
  assert.equal(f.state.calls.filter(c=>c.method==='POST').length,1);
  const g=fixture();g.mutateStock(4);Object.assign(g.state.con,{sync_lease_token:'old',sync_lease_hasta:'2026-11-09T11:00:00Z'});
  Object.assign(g.state.outbox,{envio_token:'old',envio_put_iniciado:true});
  assert.equal((await g.service.procesarSalida('ropa')).codigo,'ENVIO_INTERRUMPIDO_REVISAR');assert.equal(g.state.calls.length,0);
});

test('inbox pendiente impide salida y stock sin control no se publica como finito',async()=>{
  const f=fixture();f.addEvent();f.mutateStock(4);
  assert.equal((await f.service.procesarSalida('ropa')).estado,'esperando_entradas');assert.equal(f.state.calls.length,0);
  const g=fixture();g.mutateStock(null);
  assert.equal((await g.service.procesarSalida('ropa')).codigo,'STOCK_O_BASELINE_INVALIDO');assert.equal(g.state.calls.length,0);
});

test('vínculo de otra tienda pausa salida antes de hacer solicitudes',async()=>{
  const f=fixture();f.mutateStock(4);f.state.link.store_id='999';
  assert.equal((await f.service.procesarSalida('ropa')).codigo,'VINCULO_INVALIDO');
  assert.equal(f.state.con.pausada,true);assert.equal(f.state.outbox.estado,'revision_manual');assert.equal(f.state.calls.length,0);
});

test('multi-location y variante equivocada se rechazan; readiness enumera bloqueos',async()=>{
  assert.throws(()=>stockRemotoVerificado({id:30,product_id:20,stock:1,stock_management:true,inventory_levels:[]},{variant_id:'30',product_id:'20'}),/MULTIPLES/);
  assert.throws(()=>stockRemotoVerificado({id:31,product_id:20,stock:1,stock_management:true},{variant_id:'30',product_id:'20'}),/DISTINTA/);
  const f=fixture({enabled:false,paused:true});f.state.con.sync_webhooks_at=null;
  const ready=await f.service.readiness('ropa');assert.equal(ready.listo,false);assert.ok(ready.bloqueos.includes('FEATURE_FLAG_APAGADA'));assert.ok(ready.bloqueos.includes('WEBHOOKS_NO_VERIFICADOS'));
});

test('clasificación de 500 de escritura es ambigua pero 500 de lectura admite retry',()=>{
  assert.equal(clasificarFalloSync({status:500},{escritura:true}).codigo,'RESULTADO_POST_STOCK_AMBIGUO');
  assert.equal(clasificarFalloSync({status:500}).estado,'reintento');
  assert.equal(clasificarFalloSync({status:429,retryAfter:'2'},{escritura:true}).delay,2000);
  assert.equal(clasificarFalloSync({status:429,retryAfter:null},{intentos:2}).delay,120000);
  assert.equal(clasificarFalloSync({status:429,retryAfter:''},{intentos:2}).delay,120000);
});
