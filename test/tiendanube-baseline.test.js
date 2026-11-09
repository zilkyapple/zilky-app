import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { crearServicioBaselineTiendanube } from '../src/services/tiendanubeBaselineService.js';
import { hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';

const now=()=>new Date('2026-11-09T18:00:00Z');
const rawProduct=()=>({id:11,attributes:[{es:'Talle'},{es:'Color'}],description:'PRIVATE_CANARY',
  variants:[{id:111,product_id:11,stock_management:true,stock:3,price:'42500.00',promotional_price:null,sku:'STREET-AZ',values:[{es:'Único'},{es:'Azul'}]}]});
const rawOrder=(id=40)=>({id,store_id:101,created_at:'2026-11-09T12:00:00Z',updated_at:'2026-11-09T12:00:00Z',status:'open',
  payment_status:'pending',shipping_status:'unfulfilled',products:[{product_id:11,variant_id:111,quantity:1,price:'42500.00'}],
  contact_name:'PRIVATE_CANARY',contact_email:'PRIVATE_CANARY',token:'PRIVATE_CANARY',total:'42500.00'});

async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const als=new AsyncLocalStorage(),sqlCalls=[],apiCalls=[],current=()=>als.getStore()||pg;
  let revoked=false,remoteHook=null,sync=false,deliveries=false,product=rawProduct(),pages=[[]];
  const db={query:async(sql,params=[])=>{
    sqlCalls.push({sql,params});
    if(revoked&&/JOIN usuario_organizacion/.test(sql))return {rows:[]};
    return current().query(sql,params);
  },transaction:fn=>als.getStore()?fn():pg.transaction(tx=>als.run(tx,fn)),prepare(sql){
    let i=0;const converted=sql.replace(/\?/g,()=>'$'+(++i));
    return {get:async(...params)=>(await db.query(converted,params)).rows[0],all:async(...params)=>(await db.query(converted,params)).rows};
  }};
  await pg.exec(`
    CREATE TABLE negocios(id TEXT PRIMARY KEY,organizacion_id TEXT);
    CREATE TABLE usuarios(id TEXT PRIMARY KEY,rol TEXT,activo INT);
    CREATE TABLE usuario_organizacion(usuario_id TEXT,organizacion_id TEXT,rol TEXT,activo INT);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT,nombre TEXT,variante TEXT,sku TEXT,stock INT,
      precio_contado_centavos INT,precio_financiado_centavos INT,costo_centavos INT);
    CREATE TABLE tienda_productos(producto_id TEXT,negocio_id TEXT,talle TEXT,color TEXT);
    CREATE TABLE tiendanube_conexiones(negocio_id TEXT PRIMARY KEY,store_id TEXT,app_id TEXT,token_cifrado TEXT,scopes TEXT,
      pausada BOOLEAN,sync_baseline_at TIMESTAMPTZ,sync_activada_at TIMESTAMPTZ,sync_lease_token TEXT,sync_lease_hasta TIMESTAMPTZ,
      sync_reserva_token TEXT,creada_at TIMESTAMPTZ);
    CREATE TABLE tiendanube_variantes(producto_id TEXT,negocio_id TEXT,store_id TEXT,product_id TEXT,variant_id TEXT,
      vinculada_at TIMESTAMPTZ,sync_baseline_at TIMESTAMPTZ,sync_stock_remoto INT,sync_verificar_despues TIMESTAMPTZ);
    CREATE TABLE tiendanube_stock_outbox(producto_id TEXT,negocio_id TEXT,stock_deseado INT,version BIGINT,estado TEXT,
      envio_token TEXT,envio_version BIGINT,envio_stock INT,envio_delta INT,envio_put_iniciado BOOLEAN,envio_iniciado_at TIMESTAMPTZ);
    CREATE TABLE tiendanube_eventos(id INT,store_id TEXT,topic TEXT,recurso_id TEXT,body_hash TEXT,sync_version BIGINT,sync_estado TEXT,procesado_at TIMESTAMPTZ);
    CREATE TABLE tiendanube_reserva_intentos(id TEXT,negocio_id TEXT,estado TEXT,order_hash TEXT);
    CREATE TABLE tiendanube_pedido_stock(store_id TEXT,order_hash TEXT,variant_id TEXT,producto_id TEXT,cantidad_aplicada INT);
    CREATE TABLE tiendanube_pedidos(negocio_id TEXT,store_id TEXT,order_id TEXT,estado TEXT,cantidades JSONB,pagado BOOLEAN,cancelado BOOLEAN,pendiente_revision BOOLEAN);
    CREATE TABLE tiendanube_privacidad_borrados(store_id TEXT,order_hash TEXT);
    CREATE TABLE tiendanube_entregas(negocio_id TEXT,store_id TEXT,order_hash TEXT);
    INSERT INTO negocios VALUES('n1','org1'),('n2','org2');
    INSERT INTO usuarios VALUES('admin','administrador',1),('admin2','administrador',1),('emp','empleado',1);
    INSERT INTO usuario_organizacion VALUES('admin','org1','administrador',1),('admin2','org2','administrador',1),('emp','org1','administrador',1);
    INSERT INTO productos VALUES('p1','n1','Remera Street','Único · Azul','STREET-AZ',3,4000000,4250000,2000000);
    INSERT INTO tienda_productos VALUES('p1','n1','Único','Azul');
    INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada,creada_at)
      VALUES('n1','101','51162','SECRET_CANARY','write_products,read_orders',TRUE,'2026-11-08T15:00:00Z');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id,vinculada_at)
      VALUES('p1','n1','101','11','111','2026-11-09T10:00:00Z');
  `);
  const service=crearServicioBaselineTiendanube({database:db,syncEnabled:()=>sync,deliveriesEnabled:()=>deliveries,now,
    apiFactory:()=>async(method,path)=>{
      apiCalls.push({method,path});assert.equal(method,'GET');
      // Match the production client's resource allowlist, including encoded
      // ISO milliseconds; the fixture must not accept an unusable API path.
      assert.match(path,/^\/(?:[a-z0-9/_?=&%-]+)$/i);
      if(remoteHook)await remoteHook({path,current:current()});
      const url=new URL(path,'https://fixture.test');
      if(url.pathname==='/products/11')return structuredClone(product);
      if(url.pathname==='/orders')return structuredClone(pages[Number(url.searchParams.get('page'))-1]??[]);
      throw Error('Unexpected remote route');
    }});
  sqlCalls.length=0;
  return {pg,db,service,sqlCalls,apiCalls,set product(v){product=v;},set pages(v){pages=v;},set hook(v){remoteHook=v;},
    set revoked(v){revoked=v;},set sync(v){sync=v;},set deliveries(v){deliveries=v;},
    noWrites(){assert.equal(sqlCalls.some(c=>/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(c.sql)),false);assert.equal(apiCalls.some(c=>c.method!=='GET'),false);}};
}
const reference=view=>({negocio_id:'n1',huella:view.huella,corte_consulta_at:view.corte_consulta_at});

test('baseline preview exacto es solo lectura: stocks, dos precios, SKU/talle/color, sin falsa activación',async()=>{
  const f=await fixture();try{
    const view=await f.service.preview('n1','admin');
    assert.equal(view.modo,'solo_lectura');assert.equal(view.baseline_confirmable,false);assert.equal(view.baseline_guardado,false);
    assert.equal(view.sincronizacion_activada,false);assert.equal(view.stock_modificado,false);assert.equal(view.corte_exclusivo_verificado,false);
    assert.match(view.huella,/^[a-f0-9]{64}$/);assert.deepEqual(view.bloqueos,['CORTE_REMOTO_NO_VERIFICABLE','PAGINACION_SIN_METADATOS']);
    const v=view.variantes[0];assert.equal(v.coincide,true);assert.equal(v.producto_id,'p1');assert.equal(v.variant_id,'111');
    assert.deepEqual([v.stock_local,v.stock_remoto,v.precio_30_dias_local_centavos,v.precio_publicado_remoto_centavos,v.precio_contado_local_centavos,v.precio_contado_segun_regla_centavos],[3,3,4250000,4250000,4000000,4000000]);
    assert.deepEqual([v.sku_local,v.sku_remoto,v.talle_local,v.talle_remoto,v.color_local,v.color_remoto],['STREET-AZ','STREET-AZ','Único','Único','Azul','Azul']);
    assert.equal(v.descuento_checkout_verificado,false);assert.equal(view.paginacion_pedidos.fin_observado,true);assert.equal(view.paginacion_pedidos.completa_verificada,false);
    assert.doesNotMatch(JSON.stringify(view),/CANARY|token_cifrado|costo_centavos|comision|contact_email/);f.noWrites();
    const con=(await f.pg.query('SELECT pausada,sync_baseline_at,sync_activada_at FROM tiendanube_conexiones')).rows[0];
    assert.deepEqual(con,{pausada:true,sync_baseline_at:null,sync_activada_at:null});
  }finally{await f.pg.close();}
});
test('baseline exige administrador activo de la organización real, no rol global ni permisos operativos',async()=>{
  const f=await fixture();try{
    for(const actor of ['admin2','emp','missing'])await assert.rejects(f.service.preview('n1',actor),{status:403,code:'BASELINE_SIN_PERMISO'});
    await f.pg.exec("UPDATE usuario_organizacion SET activo=0 WHERE usuario_id='admin'");
    await assert.rejects(f.service.preview('n1','admin'),{status:403});assert.equal(f.apiCalls.length,0);f.noWrites();
  }finally{await f.pg.close();}
});
test('flags prendidas, conexión activa y cualquier lease/reserva detienen lectura sin cambios',async()=>{
  const f=await fixture();try{
    f.sync=true;await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_REQUIERE_MOTORES_APAGADOS'});f.sync=false;
    f.deliveries=true;await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_REQUIERE_MOTORES_APAGADOS'});f.deliveries=false;
    await f.pg.exec('UPDATE tiendanube_conexiones SET pausada=FALSE');
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_REQUIERE_PAUSA'});
    await f.pg.exec("UPDATE tiendanube_conexiones SET pausada=TRUE,sync_lease_token='old',sync_lease_hasta='2000-01-01'");
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_OPERACION_PENDIENTE'});
    await f.pg.exec("UPDATE tiendanube_conexiones SET sync_lease_token=NULL,sync_reserva_token='old'");
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_OPERACION_PENDIENTE'});
    await f.pg.exec("UPDATE tiendanube_conexiones SET sync_reserva_token=NULL,sync_baseline_at='2026-11-08'");
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_EXISTENTE_REQUIERE_REVISION'});
    assert.equal(f.apiCalls.length,0);f.noWrites();
  }finally{await f.pg.close();}
});
test('discrepancias precisas bloquean, nunca eligen otra variante por nombre ni corrigen stock/precio',async()=>{
  const f=await fixture();try{
    const cases=[
      [v=>v.stock=2,'DIFERENCIA_STOCK'],[v=>v.price='43000.00','DIFERENCIA_PRECIO_PUBLICADO'],
      [v=>v.sku='STREET-ROSA','DIFERENCIA_SKU'],[v=>v.values[0]={es:'M'},'DIFERENCIA_TALLE'],
      [v=>v.values[1]={es:'Rosa oscuro'},'DIFERENCIA_COLOR'],[v=>v.id=112,'VARIANTE_REMOTA_NO_COINCIDE'],
      [v=>v.stock_management=false,'STOCK_REMOTO_SIN_CONTROL'],[v=>v.inventory_levels=[],'MULTIPLES_UBICACIONES_NO_CONFIGURADAS'],
      [v=>v.promotional_price='41000.00','PROMOCION_REMOTA_NO_CONCILIADA'],
    ];
    for(const [modify,code] of cases){const p=rawProduct();modify(p.variants[0]);f.product=p;const view=await f.service.preview('n1','admin');assert.ok(view.bloqueos.includes(code),code);assert.equal(view.variantes[0].coincide,false);}
    f.product=rawProduct();await f.pg.exec("UPDATE tienda_productos SET talle='',color=''");
    assert.ok((await f.service.preview('n1','admin')).bloqueos.includes('TALLE_COLOR_NO_VERIFICABLES'));
    assert.equal((await f.pg.query('SELECT stock FROM productos')).rows[0].stock,3);f.noWrites();
  }finally{await f.pg.close();}
});
test('revalidar huella relee remoto bajo locks y nunca convierte igualdad en baseline listo',async()=>{
  const f=await fixture();try{
    const first=await f.service.preview('n1','admin');const before=f.apiCalls.length;
    const second=await f.service.revalidar('n1',reference(first),'admin');
    assert.ok(f.apiCalls.length>before);assert.equal(second.huella,first.huella);assert.equal(second.coincide_con_preview,true);
    assert.equal(second.baseline_confirmable,false);assert.equal(second.baseline_guardado,false);assert.equal(second.sincronizacion_activada,false);
    assert.ok(f.sqlCalls.some(c=>c.sql.includes('FOR UPDATE')&&c.sql.includes('tiendanube_conexiones')));
    assert.ok(f.sqlCalls.some(c=>c.sql.includes('FOR SHARE OF v,p')));f.noWrites();
    const changed=rawProduct();changed.variants[0].stock=2;f.product=changed;
    await assert.rejects(f.service.revalidar('n1',reference(first),'admin'),{code:'BASELINE_CAMBIO_DESDE_PREVIEW'});
    f.product=rawProduct();await f.pg.exec('UPDATE productos SET stock=2');
    await assert.rejects(f.service.revalidar('n1',reference(first),'admin'),{code:'BASELINE_CAMBIO_DESDE_PREVIEW'});
    assert.equal((await f.pg.query('SELECT stock FROM productos')).rows[0].stock,2);f.noWrites();
  }finally{await f.pg.close();}
});
test('revalidar rechaza snapshots inventados, futuros, vencidos, negocio contradictorio y flags del navegador',async()=>{
  const f=await fixture();try{
    const first=await f.service.preview('n1','admin'),ref=reference(first),before=f.apiCalls.length;
    for(const data of [null,{}, {...ref,huella:'x'}, {...ref,negocio_id:'n2'}, {...ref,activar:true}, {...ref,stock:9}, {...ref,corte_consulta_at:'invalid'}]){
      await assert.rejects(f.service.revalidar('n1',data,'admin'),{code:'BASELINE_HUELLA_INVALIDA',status:400});
    }
    for(const time of ['2026-11-09T18:00:01.000Z','2026-11-09T17:44:59.000Z'])await assert.rejects(f.service.revalidar('n1',{...ref,corte_consulta_at:time},'admin'),{code:'BASELINE_VISTA_VENCIDA'});
    assert.equal(f.apiCalls.length,before);f.noWrites();
  }finally{await f.pg.close();}
});
test('pendientes, envíos inciertos y reservas quedan visibles sin borrar ni consumir evidencia',async()=>{
  const f=await fixture();try{
    await f.pg.exec(`INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado,version,estado,envio_token,envio_put_iniciado)
        VALUES('p1','n1',8,2,'revision_manual','uncertain',TRUE);
      INSERT INTO tiendanube_eventos VALUES(1,'101','order/created','40','hash',2,'pendiente',NULL);
      INSERT INTO tiendanube_reserva_intentos VALUES('r1','n1','revision_manual','h');
      INSERT INTO tiendanube_pedido_stock VALUES('101','h','111','p1',1);
      INSERT INTO tiendanube_pedidos VALUES('n1','101','40','open','{"111":1}',FALSE,FALSE,TRUE);`);
    f.pages=[[rawOrder()]];
    const v=await f.service.preview('n1','admin');
    for(const code of ['SALIDAS_PENDIENTES_O_INCIERTAS','EVENTOS_PENDIENTES_O_EN_REVISION','RESERVAS_PREVIAS_REQUIEREN_CONCILIACION','PEDIDOS_LOCALES_EN_REVISION'])assert.ok(v.bloqueos.includes(code));
    assert.deepEqual(v.pendientes,{salidas:1,eventos:1,intentos_reserva:1,reservas:1});
    assert.equal((await f.pg.query('SELECT estado,envio_token,stock_deseado FROM tiendanube_stock_outbox')).rows[0].envio_token,'uncertain');f.noWrites();
  }finally{await f.pg.close();}
});
test('recorre pedidos paginados al corte sin PII, conserva desconocimiento de completitud y privacidad',async()=>{
  const f=await fixture();try{
    f.pages=[Array.from({length:100},(_,i)=>rawOrder(i+1)),[rawOrder(101)]];
    const key=hashPedidoPrivacidad('101','3');await f.pg.query('INSERT INTO tiendanube_privacidad_borrados VALUES($1,$2)',['101',key]);
    const v=await f.service.preview('n1','admin');assert.equal(v.pedidos.length,100);assert.equal(v.pedidos.some(o=>o.order_id==='3'),false);
    assert.equal(v.pedidos_omitidos_por_privacidad,1);assert.equal(v.paginacion_pedidos.paginas_recorridas,2);assert.equal(v.paginacion_pedidos.fin_observado,true);
    assert.equal(v.paginacion_pedidos.completa_verificada,false);assert.ok(v.bloqueos.includes('PEDIDOS_EN_TRANSITO_O_SIN_CONCILIAR'));
    assert.equal(v.pedidos[0].items[0].producto_id,'p1');assert.doesNotMatch(JSON.stringify(v),/PRIVATE_CANARY|contact_name|contact_email|"total"/);
    for(const req of f.apiCalls.filter(c=>c.path.startsWith('/orders?'))){
      const q=new URL(req.path,'https://fixture.test').searchParams;assert.equal(q.get('created_at_max'),v.corte_consulta_at);assert.equal(q.get('status'),'any');
      assert.doesNotMatch(q.get('fields'),/contact|customer|total|note/);
    }
    f.noWrites();
  }finally{await f.pg.close();}
});
test('paginación repetida falla cerrada y alcanzar límite nunca se presenta como lectura completa',async()=>{
  const f=await fixture();try{
    f.pages=[Array.from({length:100},(_,i)=>rawOrder(i+1)),[rawOrder(1)]];
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_PAGINACION_INESTABLE'});
    f.pages=Array.from({length:10},(_,p)=>Array.from({length:100},(_,i)=>rawOrder(p*100+i+1)));
    const v=await f.service.preview('n1','admin');assert.equal(v.paginacion_pedidos.fin_observado,false);assert.equal(v.paginacion_pedidos.completa_verificada,false);
    assert.ok(v.bloqueos.includes('LECTURA_PEDIDOS_LIMITADA'));assert.equal(v.baseline_confirmable,false);f.noWrites();
  }finally{await f.pg.close();}
});
test('paid/fulfilled no prueban entrega ni conciliación; variantes ajenas requieren revisión exacta',async()=>{
  const f=await fixture();try{
    const order=rawOrder();order.payment_status='paid';order.shipping_status='fulfilled';order.products[0].variant_id=222;f.pages=[[order]];
    let view=await f.service.preview('n1','admin');assert.equal(view.pedidos[0].requiere_revision,true);assert.equal(view.pedidos[0].items[0].producto_id,null);
    assert.ok(view.bloqueos.includes('PEDIDO_CON_VARIANTE_SIN_VINCULO_EXACTO'));
    order.products[0].variant_id=111;f.pages=[[order]];
    await f.pg.query('INSERT INTO tiendanube_entregas VALUES($1,$2,$3)',['n1','101',hashPedidoPrivacidad('101','40')]);
    view=await f.service.preview('n1','admin');assert.equal(view.pedidos[0].entrega_local_registrada,true);assert.equal(view.pedidos[0].requiere_revision,false);
    assert.equal(view.baseline_confirmable,false);f.noWrites();
  }finally{await f.pg.close();}
});
test('revocación o cambio de flags durante la API impiden devolver vista con autoridad vieja',async()=>{
  const f=await fixture();try{
    f.hook=()=>{f.revoked=true;};await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_SIN_PERMISO',status:403});
    f.revoked=false;f.hook=()=>{f.deliveries=true;};await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_REQUIERE_MOTORES_APAGADOS'});f.noWrites();
  }finally{await f.pg.close();}
});
test('evento llegado durante consulta invalida lectura en vez de certificar snapshot local viejo',async()=>{
  const f=await fixture();try{
    let done=false;f.hook=async({current})=>{if(!done){done=true;await current.query("INSERT INTO tiendanube_eventos VALUES(1,'101','order/created','40','hash',1,'pendiente',NULL)");}};
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_CAMBIO_DURANTE_LECTURA'});f.noWrites();
  }finally{await f.pg.close();}
});
test('proveedor inválido, otro store y pedido posterior al filtro no producen baseline ni PII de error',async()=>{
  const f=await fixture();try{
    f.hook=()=>{throw Object.assign(Error('TOKEN_PRIVATE_CANARY'),{status:401});};
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_ACCESO_REMOTO_REVOCADO'});f.hook=null;
    const wrong=rawOrder();wrong.store_id=102;f.pages=[[wrong]];
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_PEDIDO_DE_OTRA_TIENDA'});
    wrong.store_id=101;wrong.created_at='2026-11-09T18:00:01Z';f.pages=[[wrong]];
    await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_RESPUESTA_REMOTA_INVALIDA'});
    f.pages=[{}];await assert.rejects(f.service.preview('n1','admin'),{code:'BASELINE_RESPUESTA_REMOTA_INVALIDA'});f.noWrites();
  }finally{await f.pg.close();}
});
