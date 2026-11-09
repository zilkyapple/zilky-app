import test from 'node:test';
import assert from 'node:assert/strict';
import { crearServicioPrivacidadTiendanube, hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';

const copy=value=>value===undefined?undefined:structuredClone(value);
const fixed='2026-11-09T12:00:00.000Z';
function base(){
  return {conexiones:[{store_id:'10',negocio_id:'negocio-a',app_id:'51162',creada_at:fixed,actualizada_at:fixed,token_cifrado:'fixture-a'},
    {store_id:'20',negocio_id:'negocio-b',app_id:'51162',creada_at:fixed,actualizada_at:fixed,token_cifrado:'fixture-b'}],
    pedidos:[{store_id:'10',order_id:'100',estado:'open',cantidades:{'500':1},pagado:false,cancelado:false,actualizado_at:fixed},
      {store_id:'10',order_id:'101',estado:'closed',cantidades:{'501':2},pagado:true,cancelado:false,actualizado_at:fixed},
      {store_id:'20',order_id:'100',estado:'open',cantidades:{'600':3},pagado:false,cancelado:false,actualizado_at:fixed}],
    eventos:[{store_id:'10',topic:'order/created',recurso_id:'100'},
      {store_id:'10',topic:'product/updated',recurso_id:'100'},
      {store_id:'20',topic:'order/created',recurso_id:'100'}],solicitudes:[],borrados:[]};
}
function fakeDb(initial=base()){
  let state=copy(initial);
  const calls=[];
  function query(sql,params,kind){
    const compact=sql.replace(/\s+/g,' ').trim();
    calls.push({sql:compact,params:copy(params)});
    if(compact==='SELECT pg_advisory_xact_lock(hashtextextended(?,0))')return {};
    if(compact.startsWith('SELECT negocio_id,store_id,app_id,creada_at,actualizada_at,token_cifrado FROM tiendanube_conexiones')){
      const row=state.conexiones.find(r=>r.store_id===params[0]);
      return copy(row);
    }
    if(compact.startsWith('INSERT INTO tiendanube_privacidad_solicitudes')){
      if(state.solicitudes.some(r=>r.clave===params[1]))return undefined;
      const keys=['id','clave','contenido_hash','store_id','negocio_id','tipo','solicitud_ref','instalacion_actualizada_at','evento_fecha','estado'];
      const row=Object.fromEntries(keys.map((k,i)=>[k,params[i]]));
      Object.assign(row,{reporte:JSON.parse(params[10]),instalacion_huella:params[11],instalacion_creada_at:params[12],creada_at:fixed,actualizada_at:fixed});
      state.solicitudes.push(row);return copy(row);
    }
    if(compact.startsWith('INSERT INTO tiendanube_privacidad_borrados')){
      let changes=0;
      for(const orderHash of params[2]){
        if(state.borrados.some(r=>r.store_id===params[0]&&r.order_hash===orderHash))continue;
        state.borrados.push({store_id:params[0],order_hash:orderHash,solicitud_id:params[1],borrado_at:fixed});changes++;
      }
      return {changes};
    }
    if(compact==='SELECT * FROM tiendanube_privacidad_solicitudes WHERE clave=?')return copy(state.solicitudes.find(r=>r.clave===params[0]));
    if(compact==='SELECT * FROM tiendanube_privacidad_solicitudes WHERE id=? AND negocio_id=?')return copy(state.solicitudes.find(r=>r.id===params[0]&&r.negocio_id===params[1]));
    if(compact.startsWith('SELECT id,store_id,negocio_id,tipo,estado,solicitud_ref,'))return state.solicitudes.filter(r=>r.negocio_id===params[0]).map(r=>{
      const {reporte,clave,contenido_hash,...rest}=copy(r);return rest;
    });
    if(compact.startsWith('SELECT order_id,estado,cantidades,pagado,cancelado,actualizado_at FROM tiendanube_pedidos'))return copy(state.pedidos.filter(r=>r.store_id===params[0]&&params[1].includes(r.order_id)));
    if(compact.startsWith("SELECT id,reporte FROM tiendanube_privacidad_solicitudes"))return copy(state.solicitudes.filter(r=>r.store_id===params[0]&&r.tipo==='customer-data-request').map(r=>({id:r.id,reporte:r.reporte})));
    if(compact.startsWith('UPDATE tiendanube_privacidad_solicitudes SET reporte=')){
      const row=state.solicitudes.find(r=>r.id===params[1]);assert.ok(row);
      row.reporte=JSON.parse(params[0]);row.actualizada_at=fixed;
      return kind==='get'?copy(row):{changes:1};
    }
    if(compact.startsWith('DELETE FROM tiendanube_pedidos WHERE store_id=')){
      const before=state.pedidos.length;
      state.pedidos=state.pedidos.filter(r=>!(r.store_id===params[0]&&params[1].includes(r.order_id)));
      return {changes:before-state.pedidos.length};
    }
    if(compact.startsWith('DELETE FROM tiendanube_eventos WHERE store_id=')){
      const before=state.eventos.length;
      state.eventos=state.eventos.filter(r=>!(r.store_id===params[0]&&r.topic.startsWith('order/')&&params[1].includes(r.recurso_id)));
      return {changes:before-state.eventos.length};
    }
    throw new Error('Consulta no esperada en prueba: '+compact);
  }
  return {get state(){return copy(state);},calls,
    async transaction(fn){const before=copy(state);try{return await fn();}catch(e){state=before;throw e;}},
    prepare(sql){return {get:async(...p)=>query(sql,p,'get'),all:async(...p)=>query(sql,p,'all'),run:async(...p)=>query(sql,p,'run')};}};
}

test('data-request prepara informe mínimo pendiente de entrega y no copia campos arbitrarios',async()=>{
  const initial=base();initial.pedidos[0].campo_no_permitido='IGNORAR_CAMPO_ORIGEN';
  const database=fakeDb(initial),service=crearServicioPrivacidadTiendanube({database});
  const result=await service.procesar('customer-data-request',{store_id:10,data_request:{id:7},orders_requested:[100,999],
    customer:{campo_privado:'IGNORAR_CAMPO_CLIENTE'},campo_no_permitido:'IGNORAR_CAMPO_EXTRA'});
  assert.equal(result.estado,'pendiente_entrega');assert.equal(result.reporte.estado_entrega,'pendiente');
  assert.deepEqual(result.reporte.pedidos.map(r=>r.order_id),['100']);
  assert.equal(result.reporte.pedidos_no_almacenados,1);
  const persisted=JSON.stringify({stored:database.state.solicitudes,result,calls:database.calls});
  assert.doesNotMatch(persisted,/IGNORAR_CAMPO|campo_no_permitido|campo_privado/);
  assert.deepEqual(database.state.pedidos,initial.pedidos);
});

test('reintento de privacidad es idempotente aun si cambia orden o contador de reintentos',async()=>{
  const database=fakeDb(),service=crearServicioPrivacidadTiendanube({database});
  const first=await service.procesar('customer-data-request',{store_id:'10',data_request:{id:'7'},orders_requested:[100,101],retry:0});
  const again=await service.procesar('customer-data-request',{store_id:'10',data_request:{id:'7'},orders_requested:[101,100,100],retry:9});
  assert.equal(again.id,first.id);assert.equal(again.duplicada,true);assert.equal(database.state.solicitudes.length,1);
  await assert.rejects(()=>service.procesar('customer-data-request',{store_id:10,data_request:{id:7},orders_requested:[101]}),{status:409});
  assert.equal(database.state.solicitudes.length,1);
});

test('customer-redact borra resúmenes e inbox solo de la tienda/pedidos indicados y limpia informes previos',async()=>{
  const database=fakeDb(),service=crearServicioPrivacidadTiendanube({database});
  const report=await service.procesar('customer-data-request',{store_id:10,data_request:{id:7},orders_requested:[100,101]});
  const first=await service.procesar('customer-redact',{store_id:10,orders_to_redact:[100],customer:{ignorado:'IGNORAR'}});
  assert.equal(first.estado,'completada');assert.equal(first.reporte.pedidos_eliminados,1);
  assert.equal(first.reporte.eventos_eliminados,1);assert.equal(first.reporte.informes_redactados,1);
  assert.equal(first.reporte.datos_locales_zilky_modificados,false);
  assert.deepEqual(database.state.pedidos.map(r=>[r.store_id,r.order_id]),[['10','101'],['20','100']]);
  assert.deepEqual(database.state.eventos.map(r=>[r.store_id,r.topic]),[['10','product/updated'],['20','order/created']]);
  const cleaned=await service.obtener(report.id,'negocio-a');
  assert.deepEqual(cleaned.reporte.pedidos.map(r=>r.order_id),['101']);
  assert.equal(cleaned.reporte.pedidos_redactados,1);
  const again=await service.procesar('customer-redact',{store_id:10,orders_to_redact:[100],retry:4});
  assert.equal(again.duplicada,true);assert.equal(again.id,first.id);
  assert.equal(database.state.borrados.length,1);
  assert.equal(database.state.borrados[0].order_hash,hashPedidoPrivacidad('10','100'));
  assert.equal(Object.hasOwn(database.state.borrados[0],'order_id'),false);
  assert.equal(database.calls.some(c=>/DELETE FROM (productos|clientes|ventas|pagos|tiendanube_conexiones)/.test(c.sql)),false);
});

test('evento viejo de tienda/desinstalación queda pendiente de revisión y no revoca la instalación nueva',async()=>{
  for(const accion of ['store-redact','uninstalled']){
    const initial=base(),database=fakeDb(initial),service=crearServicioPrivacidadTiendanube({database});
    const result=await service.procesar(accion,{store_id:10,event_launch_ts:Math.floor(new Date('2026-11-08T12:00:00Z').valueOf()/1000)});
    assert.equal(result.estado,'pendiente_revision');
    assert.equal(result.reporte.evento_anterior_a_instalacion,true);
    assert.equal(result.reporte.credenciales_modificadas,false);
    assert.deepEqual(database.state.conexiones,initial.conexiones);
    assert.deepEqual(database.state.pedidos,initial.pedidos);
    assert.equal(database.calls.some(c=>c.sql.startsWith('DELETE ')),false);
  }
});

test('reportes administrativos se filtran por negocio y no exponen claves internas ni contenido de otra tienda',async()=>{
  const database=fakeDb(),service=crearServicioPrivacidadTiendanube({database});
  const own=await service.procesar('customer-data-request',{store_id:10,data_request:{id:7},orders_requested:[100]});
  const foreign=await service.procesar('customer-data-request',{store_id:20,data_request:{id:7},orders_requested:[100]});
  const listed=await service.listar('negocio-a');
  assert.deepEqual(listed.map(r=>r.id),[own.id]);
  assert.equal(await service.obtener(foreign.id,'negocio-a'),null);
  assert.equal(Object.hasOwn(listed[0],'clave'),false);assert.equal(Object.hasOwn(listed[0],'contenido_hash'),false);
  assert.equal((await service.obtener(own.id,'negocio-a')).reporte.pedidos[0].cantidades['500'],1);
});

test('valida pedidos e identificadores antes de usar la base y nunca incorpora el payload en errores',async()=>{
  const database=fakeDb(),service=crearServicioPrivacidadTiendanube({database});
  await assert.rejects(()=>service.procesar('customer-redact',{store_id:10,orders_to_redact:['IGNORAR_DATO_PRIVADO']}),e=>e.status===400&&!e.message.includes('IGNORAR'));
  await assert.rejects(()=>service.procesar('customer-data-request',{store_id:10,orders_requested:[100]}),{status:400});
  await assert.rejects(()=>service.procesar('customer-redact',{store_id:10,orders_to_redact:Array(1001).fill(100)}),{status:400});
  assert.equal(database.calls.length,0);
});

test('tombstone hashea IDs normalizados, separa tiendas y no abre la base',()=>{
  assert.equal(hashPedidoPrivacidad(10,100),hashPedidoPrivacidad('10','100'));
  assert.notEqual(hashPedidoPrivacidad(10,100),hashPedidoPrivacidad(20,100));
  assert.match(hashPedidoPrivacidad(10,100),/^[0-9a-f]{64}$/);
});
