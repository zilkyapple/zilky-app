import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { stockSchema } from '../src/db/stockSchema.js';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubePrivacidadSchema } from '../src/db/tiendanubePrivacidadSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { tiendanubeReservasSchema } from '../src/db/tiendanubeReservasSchema.js';
import { crearServicioReservasTiendanube } from '../src/services/tiendanubeReservasService.js';
import { crearServicioTiendanubeSync } from '../src/services/tiendanubeSyncService.js';
import { hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';

// Only isolated PostgreSQL WASM and injected fake APIs. No DATABASE_URL,
// token, live order, customer, money, email or actual inventory is accessed.
const NOW='2026-11-09T14:00:00Z';
const REQUEST='12345678-abcd-1234-abcd-123456789abc';
const INTENT='76543210-abcd-1234-abcd-123456789abc';
const input=(extra={})=>({solicitud_id:REQUEST,items:[{producto_id:'p1',cantidad:1}],total_esperado_centavos:4250000,...extra});
const rawOrder=(body,extra={})=>({id:40,store_id:101,created_at:NOW,status:'open',payment_status:'pending',currency:'ARS',gateway:'offline',
  cancelled_at:null,paid_at:null,note:body.note,subtotal:body.total,total:body.total,
  discount:'0.00',shipping_cost_customer:'0.00',shipping_cost_owner:'0.00',coupon:[],
  products:body.products.map(line=>({...line,product_id:line.variant_id===111?11:22,issues:{unclaimed_stock:0}})),...extra});

async function fixture(){
  const pg=new PGlite();await pg.waitReady;const context=new AsyncLocalStorage();
  const query=(sql,params=[])=>(context.getStore()||pg).query(sql,params);
  const db={query,exec:sql=>(context.getStore()||pg).exec(sql),
    prepare(sql){let i=0;const q=sql.replace(/\?/g,()=>`$${++i}`);return {
      get:async(...p)=>(await query(q,p)).rows[0],all:async(...p)=>(await query(q,p)).rows,
      run:async(...p)=>({changes:(await query(q,p)).affectedRows}),
    };},transaction:fn=>context.getStore()?fn(context.getStore()):pg.transaction(tx=>context.run(tx,()=>fn(tx))),
  };
  await db.exec(`
    CREATE TABLE negocios(id TEXT PRIMARY KEY,organizacion_id TEXT NOT NULL);
    CREATE TABLE usuarios(id TEXT PRIMARY KEY,rol TEXT,activo INTEGER);
    CREATE TABLE usuario_organizacion(usuario_id TEXT,organizacion_id TEXT,rol TEXT,activo INTEGER);
    CREATE TABLE usuario_negocio(usuario_id TEXT,negocio_id TEXT,activo INTEGER,permisos JSONB);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT NOT NULL REFERENCES negocios(id),stock INTEGER,precio_financiado_centavos INTEGER);
    CREATE TABLE producto_combo_componentes(combo_id TEXT,producto_id TEXT);
    INSERT INTO negocios VALUES('n1','org1'),('n2','org2');
    INSERT INTO usuarios VALUES('admin','administrador',1),('employee','empleado',1),('foreign-admin','administrador',1),('inactive','empleado',0);
    INSERT INTO usuario_organizacion VALUES('admin','org1','administrador',1),('foreign-admin','org2','administrador',1);
    INSERT INTO usuario_negocio VALUES('employee','n1',1,'{"ventas.crear":true,"tienda.pedidos":true}'),('inactive','n1',1,'{"ventas.crear":true,"tienda.pedidos":true}');
    INSERT INTO productos VALUES('p1','n1',2,4250000),('p2','n1',3,6500000),('foreign','n2',3,4250000);
  `);
  for(const schema of [stockSchema,tiendanubeSchema,tiendanubePrivacidadSchema,tiendanubeSyncSchema,tiendanubeReservasSchema])await db.exec(schema);
  await db.exec(`CREATE TABLE tiendanube_entregas(store_id TEXT,order_hash TEXT,venta_id TEXT,PRIMARY KEY(store_id,order_hash));
    INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada,sync_activada_at,sync_baseline_at,sync_webhooks_at)
    VALUES('n1','101','51162','fixture-not-a-token','write_orders,write_products',FALSE,'2026-11-09T10:00:00Z','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id,sync_baseline_at,sync_stock_remoto)
    VALUES('p1','n1','101','11','111','2026-11-09T10:00:00Z',2),('p2','n1','101','22','222','2026-11-09T10:00:00Z',3);
  `);
  const calls=[];
  const fakeApi=async(method,path,body)=>{calls.push({method,path,body});return rawOrder(body);};
  const service=(options={})=>crearServicioReservasTiendanube({db,enabled:true,syncEnabled:true,canalesCentralizados:()=>true,
    now:()=>new Date(NOW),uuid:()=>INTENT,apiFactory:()=>fakeApi,...options});
  const read=sql=>db.prepare(sql).get();
  const count=async table=>(await read(`SELECT COUNT(*)::int n FROM ${table}`)).n;
  const addEvent=async()=>db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_proximo_intento)
    VALUES('101','order/created','40','fixture-event','{}','2026-11-09T12:00:00Z')`).run();
  return {pg,db,service,calls,read,count,addEvent};
}
const code=expected=>err=>err?.code===expected;

test('claim persistente usa una sola escritura, reserva stock y no crea una venta ni cobro',async()=>{
  const f=await fixture();try{
    const result=await f.service().reservarProductosTiendanube('n1',input(),'employee');
    assert.deepEqual(result,{reserva_id:INTENT,estado:'reservada',codigo:null,pedido_id:'40',total_publicado_centavos:4250000,
      stock_reservado:true,venta_creada:false,cobro_creado:false,repetida:false});
    assert.equal(f.calls.length,1);const {method,path,body}=f.calls[0];
    assert.equal(method,'POST');assert.equal(path,'/orders');assert.equal(body.inventory_behaviour,'claim');
    assert.equal(body.payment_status,'pending');assert.equal(body.gateway,'offline');
    assert.equal(body.send_confirmation_email,false);assert.equal(body.send_fulfillment_email,false);
    assert.deepEqual(body.customer,{});assert.deepEqual(body.billing_address,{});assert.deepEqual(body.shipping_address,{});
    assert.deepEqual(body.products,[{variant_id:111,quantity:1,price:'42500.00'}]);
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,1);
    assert.equal((await f.read("SELECT sync_stock_remoto FROM tiendanube_variantes WHERE producto_id='p1'")).sync_stock_remoto,1);
    assert.equal((await f.read('SELECT cantidad_aplicada FROM tiendanube_pedido_stock')).cantidad_aplicada,1);
    assert.equal(await f.count('producto_historial'),1);assert.equal(await f.count('tiendanube_pedidos'),1);
    const con=await f.read('SELECT pausada,sync_reserva_token,sync_reserva_iniciada_at FROM tiendanube_conexiones');
    assert.deepEqual(con,{pausada:false,sync_reserva_token:null,sync_reserva_iniciada_at:null});
    const intent=await f.read('SELECT * FROM tiendanube_reserva_intentos');
    assert.equal(intent.estado,'reservada');assert.equal(intent.order_hash,hashPedidoPrivacidad('101','40'));
    assert.equal(intent.order_id,undefined);assert.equal(intent.customer,undefined);
    assert.deepEqual(await f.db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ventas','pagos','cuotas','comisiones')").all(),[]);
  }finally{await f.pg.close();}
});

test('repetir misma solicitud devuelve resultado sin POST; cambiar contenido o actor queda bloqueado',async()=>{
  const f=await fixture();try{
    const service=f.service();await service.reservarProductosTiendanube('n1',input(),'employee');
    assert.equal((await service.reservarProductosTiendanube('n1',input({solicitud_id:REQUEST.toUpperCase()}),'employee')).repetida,true);
    await assert.rejects(service.reservarProductosTiendanube('n1',input({items:[{producto_id:'p1',cantidad:2}],total_esperado_centavos:8500000}),'employee'),code('SOLICITUD_RESERVA_REUTILIZADA'));
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('SOLICITUD_RESERVA_REUTILIZADA'));
    assert.equal(f.calls.length,1);assert.equal(await f.count('producto_historial'),1);
  }finally{await f.pg.close();}
});

test('filas duplicadas de producto se agregan antes del claim y del hash idempotente',async()=>{
  const f=await fixture();try{
    const service=f.service();
    await service.reservarProductosTiendanube('n1',input({items:[{producto_id:'p1',cantidad:1},{producto_id:'p1',cantidad:1}],total_esperado_centavos:8500000}),'admin');
    assert.deepEqual(f.calls[0].body.products,[{variant_id:111,quantity:2,price:'42500.00'}]);
    assert.equal((await service.reservarProductosTiendanube('n1',input({items:[{producto_id:'p1',cantidad:2}],total_esperado_centavos:8500000}),'admin')).repetida,true);
    assert.equal(f.calls.length,1);assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,0);
  }finally{await f.pg.close();}
});

test('flags y verificador default false impiden nuevos pedidos aun con credenciales configuradas',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.service({enabled:false}).reservarProductosTiendanube('n1',input(),'admin'),code('RESERVAS_TIENDANUBE_DESHABILITADAS'));
    await assert.rejects(f.service({syncEnabled:false}).reservarProductosTiendanube('n1',input(),'admin'),code('SINCRONIZACION_NO_LISTA_PARA_RESERVAR'));
    await assert.rejects(f.service({canalesCentralizados:undefined}).reservarProductosTiendanube('n1',input(),'admin'),code('CANALES_NO_CENTRALIZADOS'));
    assert.equal(f.calls.length,0);assert.equal(await f.count('tiendanube_reserva_intentos'),0);
  }finally{await f.pg.close();}
});

test('actor, negocio y permiso se comprueban dentro de la transacción y no admiten campo bypass',async()=>{
  const f=await fixture();try{
    const service=f.service();
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'foreign-admin'),code('ADMINISTRADOR_DE_OTRA_ORGANIZACION'));
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'inactive'),code('ACTOR_NO_AUTORIZADO'));
    await assert.rejects(service.reservarProductosTiendanube('n2',input(),'employee'),code('SIN_PERMISO_RESERVAR_EN_NEGOCIO'));
    await f.db.exec("UPDATE usuario_negocio SET permisos='{\"ventas.crear\":true}' WHERE usuario_id='employee';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'employee'),code('SIN_PERMISO_RESERVAR_EN_NEGOCIO'));
    await assert.rejects(service.reservarProductosTiendanube('n1',input({skip_stock:true}),'admin'),code('RESERVA_INPUT_INVALIDO'));
    await assert.rejects(service.reservarProductosTiendanube('n1',input({items:[{producto_id:'p1',cantidad:1,inventory_behaviour:'bypass'}]}),'admin'),code('RESERVA_ITEM_INVALIDO'));
    assert.equal(f.calls.length,0);assert.equal(await f.count('tiendanube_reserva_intentos'),0);
  }finally{await f.pg.close();}
});

test('readiness exige write_orders, stock finito igual al baseline y precio de $500 sin recálculo',async()=>{
  const f=await fixture();try{
    const service=f.service();
    await f.db.exec("UPDATE tiendanube_conexiones SET scopes='write_products,read_orders';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('FALTA_SCOPE_WRITE_ORDERS'));
    await f.db.exec("UPDATE tiendanube_conexiones SET scopes='write_orders,write_products';UPDATE tiendanube_variantes SET sync_stock_remoto=3 WHERE producto_id='p1';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('STOCK_NO_DISPONIBLE_PARA_RESERVAR'));
    await f.db.exec("UPDATE tiendanube_variantes SET sync_stock_remoto=2 WHERE producto_id='p1';UPDATE productos SET precio_financiado_centavos=4250100 WHERE id='p1';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('PRECIO_PUBLICADO_NO_REDONDEADO'));
    await f.db.exec("UPDATE productos SET precio_financiado_centavos=4300000 WHERE id='p1';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('PRECIO_CAMBIO_ANTES_DE_RESERVAR'));
    await assert.rejects(service.reservarProductosTiendanube('n1',input({items:[{producto_id:'foreign',cantidad:1}]}),'admin'),code('VARIANTE_NO_VINCULADA_PARA_RESERVAR'));
    assert.equal(f.calls.length,0);assert.equal(await f.count('tiendanube_reserva_intentos'),0);
  }finally{await f.pg.close();}
});

test('un evento sin conciliar bloquea la reserva antes de cualquier POST',async()=>{
  const f=await fixture();try{
    await f.addEvent();
    await assert.rejects(f.service().reservarProductosTiendanube('n1',input(),'admin'),code('EVENTOS_PENDIENTES_ANTES_DE_RESERVAR'));
    assert.equal(f.calls.length,0);assert.equal(await f.count('tiendanube_reserva_intentos'),0);
  }finally{await f.pg.close();}
});

test('422 de stock insuficiente libera el token sin venta ni rebaja local, y nunca reintenta ese UUID',async()=>{
  const f=await fixture();try{
    let posts=0;const service=f.service({apiFactory:()=>async()=>{posts++;throw Object.assign(new Error('Not enough stock'),{status:422});}});
    const result=await service.reservarProductosTiendanube('n1',input(),'employee');
    assert.equal(result.estado,'rechazada');assert.equal(result.stock_reservado,false);
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,2);
    assert.deepEqual(await f.read('SELECT pausada,sync_reserva_token FROM tiendanube_conexiones'),{pausada:false,sync_reserva_token:null});
    assert.equal((await service.reservarProductosTiendanube('n1',input(),'employee')).repetida,true);
    assert.equal(posts,1);assert.equal(await f.count('tiendanube_pedido_stock'),0);assert.equal(await f.count('producto_historial'),0);
  }finally{await f.pg.close();}
});

test('timeout tras claim remoto conserva intento, pausa y prohíbe re-POST o nuevo UUID',async()=>{
  const f=await fixture();try{
    let remoteStock=2,posts=0;const service=f.service({apiFactory:()=>async()=>{posts++;remoteStock--;throw new Error('lost response');}});
    const result=await service.reservarProductosTiendanube('n1',input(),'employee');
    assert.equal(result.estado,'revision_manual');assert.equal(result.codigo,'RESULTADO_POST_PEDIDO_AMBIGUO');
    assert.equal(remoteStock,1);assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,2);
    assert.deepEqual(await f.read('SELECT pausada,sync_reserva_token FROM tiendanube_conexiones'),{pausada:true,sync_reserva_token:INTENT});
    assert.equal((await service.reservarProductosTiendanube('n1',input(),'employee')).repetida,true);
    await assert.rejects(service.reservarProductosTiendanube('n1',input({solicitud_id:'22345678-abcd-1234-abcd-123456789abc'}),'employee'),code('SINCRONIZACION_NO_LISTA_PARA_RESERVAR'));
    assert.equal(posts,1);assert.equal(await f.count('tiendanube_pedido_stock'),0);
  }finally{await f.pg.close();}
});

test('un webhook que llega antes del 201 espera y luego adopta el mismo ledger sin duplicar',async()=>{
  const f=await fixture();try{
    let raw,gets=0;const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:()=>new Date(NOW),apiFactory:()=>async(method)=>{assert.equal(method,'GET');gets++;return raw;}});
    const service=f.service({apiFactory:()=>async(_method,_path,body)=>{
      raw=rawOrder(body);await f.addEvent();
      assert.deepEqual(await sync.procesarEntrada('n1'),{estado:'esperando_reserva_central'});
      assert.deepEqual(await sync.procesarSalida('n1'),{estado:'esperando_reserva_central'});
      const readiness=await sync.readiness('n1');
      assert.equal(readiness.listo,false);assert.ok(readiness.bloqueos.includes('RESERVA_CENTRAL_PENDIENTE'));
      assert.equal(JSON.stringify(readiness).includes(INTENT),false);
      assert.equal(gets,0);return raw;
    }});
    assert.equal((await service.reservarProductosTiendanube('n1',input(),'employee')).estado,'reservada');
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,0);
    assert.equal(gets,1);assert.equal(await f.count('producto_historial'),1);
    assert.equal((await f.read('SELECT cantidad_aplicada FROM tiendanube_pedido_stock')).cantidad_aplicada,1);
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,1);
    assert.equal((await f.read('SELECT reserva_intento_id FROM tiendanube_pedidos')).reserva_intento_id,INTENT);
  }finally{await f.pg.close();}
});

test('doble click mientras POST está en curso ve intento enviando sin otra escritura remota',async()=>{
  const f=await fixture();let release;try{
    let posts=0,started;const begin=new Promise(resolve=>{started=resolve;});const hold=new Promise(resolve=>{release=resolve;});
    const service=f.service({apiFactory:()=>async(_method,_path,body)=>{posts++;started();await hold;return rawOrder(body);}});
    const first=service.reservarProductosTiendanube('n1',input(),'employee');await begin;
    const duplicate=await service.reservarProductosTiendanube('n1',input(),'employee');
    assert.equal(duplicate.estado,'enviando');assert.equal(duplicate.repetida,true);assert.equal(duplicate.stock_reservado,false);
    release();assert.equal((await first).estado,'reservada');assert.equal(posts,1);
    assert.equal(await f.count('producto_historial'),1);
  }finally{release?.();await f.pg.close();}
});

test('respuesta con unclaimed_stock no es una reserva válida aunque el POST haya creado pedido',async()=>{
  const f=await fixture();try{
    const service=f.service({apiFactory:()=>async(_method,_path,body)=>rawOrder(body,{products:[{product_id:11,variant_id:111,quantity:1,price:'42500.00',issues:{unclaimed_stock:1}}]})});
    const result=await service.reservarProductosTiendanube('n1',input(),'admin');
    assert.equal(result.estado,'revision_manual');assert.equal(result.codigo,'STOCK_REMOTO_NO_RESERVADO');
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,2);
    assert.equal((await f.read('SELECT pausada FROM tiendanube_conexiones')).pausada,true);
    assert.equal(await f.count('tiendanube_pedidos'),0);assert.equal(await f.count('tiendanube_pedido_stock'),0);
  }finally{await f.pg.close();}
});

test('importe o estado inesperado en respuesta exige revisión sin inventar cobros',async()=>{
  const f=await fixture();try{
    const service=f.service({apiFactory:()=>async(_method,_path,body)=>rawOrder(body,{payment_status:'paid',paid_at:NOW,total_paid_by_customer:'42500.00'})});
    assert.equal((await service.reservarProductosTiendanube('n1',input(),'admin')).codigo,'RESPUESTA_POST_PEDIDO_NO_VERIFICADA');
    assert.equal(await f.count('tiendanube_pedidos'),0);assert.equal(await f.count('producto_historial'),0);
  }finally{await f.pg.close();}
});

test('cambio local durante la reserva obliga revisión: nunca descuenta dos veces ni deshace claim remoto',async()=>{
  const f=await fixture();try{
    let posts=0;const service=f.service({apiFactory:()=>async(_method,_path,body)=>{
      posts++;await f.db.exec("UPDATE productos SET stock=1 WHERE id='p1'");return rawOrder(body);
    }});
    const result=await service.reservarProductosTiendanube('n1',input(),'admin');
    assert.equal(result.codigo,'RESERVA_REMOTA_PENDIENTE_DE_CONCILIACION');
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,1);
    assert.equal((await f.read("SELECT sync_stock_remoto FROM tiendanube_variantes WHERE producto_id='p1'")).sync_stock_remoto,2);
    assert.equal(await f.count('tiendanube_pedido_stock'),0);assert.equal(await f.count('producto_historial'),0);
    assert.equal(posts,1);assert.equal((await f.read('SELECT sync_reserva_token FROM tiendanube_conexiones')).sync_reserva_token,INTENT);
  }finally{await f.pg.close();}
});

test('privacidad mantiene solo hash en intento; borrado del resumen no provoca reconstrucción ni re-POST',async()=>{
  const f=await fixture();try{
    const service=f.service();await service.reservarProductosTiendanube('n1',input(),'admin');
    await f.db.exec("DELETE FROM tiendanube_pedidos WHERE store_id='101' AND order_id='40'");
    const repeated=await service.reservarProductosTiendanube('n1',input(),'admin');
    assert.equal(repeated.pedido_id,null);assert.equal(repeated.repetida,true);assert.equal(f.calls.length,1);
    assert.equal((await f.read('SELECT order_hash FROM tiendanube_reserva_intentos')).order_hash,hashPedidoPrivacidad('101','40'));
    assert.equal(await f.count('tiendanube_pedidos'),0);
    await f.db.exec(tiendanubeReservasSchema); // Additive migration is repeatable.
    assert.equal(await f.count('tiendanube_reserva_intentos'),1);
  }finally{await f.pg.close();}
});

test('última unidad ganada por web rechaza claim local y su webhook lleva ambos stocks a cero',async()=>{
  const f=await fixture();try{
    await f.db.exec("UPDATE productos SET stock=1 WHERE id='p1';UPDATE tiendanube_variantes SET sync_stock_remoto=1 WHERE producto_id='p1';DELETE FROM tiendanube_stock_outbox;");
    let remoteStock=1,posts=0;
    const service=f.service({apiFactory:()=>async()=>{
      // Simulates the provider's documented 422 claim constraint. This is not
      // evidence of real API linearizability: live concurrent checkout remains
      // a separate activation prerequisite.
      remoteStock--;await f.addEvent();posts++;
      throw Object.assign(new Error('Not enough stock for variant 111'),{status:422});
    }});
    assert.equal((await service.reservarProductosTiendanube('n1',input(),'employee')).estado,'rechazada');
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,1);
    const webOrder={id:40,store_id:101,created_at:NOW,status:'open',payment_status:'pending',products:[{variant_id:111,quantity:1,issues:{unclaimed_stock:0}}]};
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:()=>new Date(NOW),apiFactory:()=>async(method)=>{assert.equal(method,'GET');return webOrder;}});
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,1);
    assert.equal(remoteStock,0);assert.equal(posts,1);assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,0);
    assert.equal((await f.read("SELECT sync_stock_remoto FROM tiendanube_variantes WHERE producto_id='p1'")).sync_stock_remoto,0);
  }finally{await f.pg.close();}
});

test('fallo de commit local luego de claim revierte todo el ledger y conserva revisión sin reenvío',async()=>{
  const f=await fixture();try{
    const prepare=f.db.prepare;let failed=false;
    f.db.prepare=sql=>{
      const stmt=prepare(sql);
      if(sql.startsWith("UPDATE tiendanube_reserva_intentos SET estado='reservada'"))return {...stmt,run:async()=>{failed=true;throw new Error('simulated database write failure');}};
      return stmt;
    };
    const result=await f.service().reservarProductosTiendanube('n1',input(),'employee');
    assert.equal(failed,true);assert.equal(result.codigo,'RESERVA_REMOTA_PENDIENTE_DE_CONCILIACION');
    assert.equal((await f.read("SELECT stock FROM productos WHERE id='p1'")).stock,2);
    assert.equal((await f.read("SELECT sync_stock_remoto FROM tiendanube_variantes WHERE producto_id='p1'")).sync_stock_remoto,2);
    for(const table of ['tiendanube_pedidos','tiendanube_pedido_stock','producto_historial','tiendanube_stock_outbox'])assert.equal(await f.count(table),0);
    assert.equal((await f.service().reservarProductosTiendanube('n1',input(),'employee')).repetida,true);
    assert.equal(f.calls.length,1);assert.equal((await f.read('SELECT sync_reserva_token FROM tiendanube_conexiones')).sync_reserva_token,INTENT);
  }finally{await f.pg.close();}
});

test('reinicio del proceso no reenvía un intento enviando aunque hayan pasado treinta días',async()=>{
  const f=await fixture();let release;try{
    let started;const begin=new Promise(resolve=>{started=resolve;});const hold=new Promise(resolve=>{release=resolve;});let posts=0;
    const firstService=f.service({apiFactory:()=>async(_method,_path,body)=>{posts++;started();await hold;return rawOrder(body);}});
    const first=firstService.reservarProductosTiendanube('n1',input(),'employee');await begin;
    await f.db.exec("UPDATE tiendanube_conexiones SET sync_reserva_iniciada_at='2026-10-01T00:00:00Z';");
    const restarted=f.service({now:()=>new Date('2026-12-09T14:00:00Z'),apiFactory:()=>async()=>{throw new Error('must never send from second instance');}});
    const repeated=await restarted.reservarProductosTiendanube('n1',input(),'employee');
    assert.equal(repeated.estado,'enviando');assert.equal(repeated.repetida,true);
    release();assert.equal((await first).estado,'reservada');assert.equal(posts,1);
  }finally{release?.();await f.pg.close();}
});

test('outbox pendiente, combo y lease impiden claim aunque el actor sea dueño',async()=>{
  const f=await fixture();try{
    const service=f.service();
    await f.db.exec("UPDATE productos SET stock=3 WHERE id='p1';UPDATE tiendanube_variantes SET sync_stock_remoto=3 WHERE producto_id='p1';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('SALIDA_STOCK_PENDIENTE_ANTES_DE_RESERVAR'));
    await f.db.exec("DELETE FROM tiendanube_stock_outbox;INSERT INTO producto_combo_componentes VALUES('p1','p2');");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('COMBO_NO_SOPORTADO_PARA_RESERVAR'));
    await f.db.exec("DELETE FROM producto_combo_componentes;UPDATE tiendanube_conexiones SET sync_lease_token='stale-worker',sync_lease_hasta='2026-10-01T00:00:00Z';");
    await assert.rejects(service.reservarProductosTiendanube('n1',input(),'admin'),code('SINCRONIZACION_NO_LISTA_PARA_RESERVAR'));
    assert.equal(f.calls.length,0);assert.equal(await f.count('tiendanube_reserva_intentos'),0);
  }finally{await f.pg.close();}
});
