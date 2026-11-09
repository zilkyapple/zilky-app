import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { stockSchema } from '../src/db/stockSchema.js';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubePrivacidadSchema } from '../src/db/tiendanubePrivacidadSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';
import { crearRepositorioTiendanubeSync,crearServicioTiendanubeSync } from '../src/services/tiendanubeSyncService.js';

// Isolated PostgreSQL WASM, not DATABASE_URL. This minimal delivery table tests
// the stock engine's guard only, not the financial delivery implementation.
async function setup(){
  const pg=new PGlite();await pg.waitReady;const ctx=new AsyncLocalStorage();
  const query=(sql,p=[]) => (ctx.getStore()||pg).query(sql,p);
  const db={query,exec:sql=>(ctx.getStore()||pg).exec(sql),
    prepare(sql){let i=0;const q=sql.replace(/\?/g,()=>`$${++i}`);return {
      get:async(...p)=>(await query(q,p)).rows[0],all:async(...p)=>(await query(q,p)).rows,
      run:async(...p)=>({changes:(await query(q,p)).affectedRows}),
    };},
    transaction:fn=>ctx.getStore()?fn(ctx.getStore()):pg.transaction(tx=>ctx.run(tx,()=>fn(tx))),
  };
  await db.exec(`CREATE TABLE negocios(id TEXT PRIMARY KEY);CREATE TABLE usuarios(id TEXT PRIMARY KEY);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT NOT NULL REFERENCES negocios(id),stock INTEGER);
    INSERT INTO negocios VALUES('n1');INSERT INTO usuarios VALUES('u1');INSERT INTO productos VALUES('p1','n1',5);`);
  for(const s of [stockSchema,tiendanubeSchema,tiendanubePrivacidadSchema,tiendanubeSyncSchema])await db.exec(s);
  await db.exec(`CREATE TABLE tiendanube_entregas(store_id TEXT,order_hash TEXT,venta_id TEXT,PRIMARY KEY(store_id,order_hash));
    INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada,sync_activada_at,sync_baseline_at,sync_webhooks_at)
      VALUES('n1','101','51162','fixture','write_products,read_orders',FALSE,'2026-11-09T10:00:00Z','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id,sync_baseline_at,sync_stock_remoto)
      VALUES('p1','n1','101','11','111','2026-11-09T10:00:00Z',5);`);
  let clock=new Date('2026-11-09T14:00:00Z');
  const add=async(topic='order/created',resource='40',when='2026-11-09T13:59:30Z')=>db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_proximo_intento,sync_ultimo_evento_at)
    VALUES('101',?,?,?,'{}','2026-11-09T12:00:00Z',?) RETURNING id`).get(topic,resource,`${topic}-${resource}-${clock.toISOString()}`,when);
  return {db,pg,add,now:()=>clock,setClock:value=>{clock=new Date(value);}};
}
const pedido=(qty=1)=>({id:40,store_id:101,created_at:'2026-11-09T11:00:00Z',status:'open',payment_status:'pending',products:[{variant_id:111,quantity:qty}]});
const variante=stock=>({id:111,product_id:11,stock_management:true,stock});

test('trigger conserva revisión ambigua aunque una nueva venta cambie stock',async()=>{
  const f=await setup();try{
    await f.db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE tiendanube_stock_outbox SET estado='revision_manual',ultimo_error='RESULTADO_POST_STOCK_AMBIGUO',intentos=5 WHERE producto_id='p1';UPDATE productos SET stock=3 WHERE id='p1';");
    const o=await f.db.prepare('SELECT * FROM tiendanube_stock_outbox WHERE producto_id=?').get('p1');
    assert.equal(o.estado,'revision_manual');assert.equal(o.ultimo_error,'RESULTADO_POST_STOCK_AMBIGUO');
    assert.equal(Number(o.version),2);assert.equal(o.stock_deseado,3);assert.equal(o.intentos,5);
  }finally{await f.pg.close();}
});

test('marcar una generación vieja no consume una notificación reencolada',async()=>{
  const f=await setup();try{
    await f.add();const repo=crearRepositorioTiendanubeSync(f.db);
    const first=await repo.evento('101',f.now().toISOString());
    await f.db.exec("UPDATE tiendanube_eventos SET sync_version=sync_version+1,sync_estado='pendiente',procesado_at=NULL;");
    await repo.marcarEvento(first,'procesado');
    let row=await f.db.prepare('SELECT * FROM tiendanube_eventos WHERE id=?').get(first.id);
    assert.equal(Number(row.sync_version),2);assert.equal(row.procesado_at,null);assert.equal(row.sync_estado,'pendiente');
    await repo.marcarEvento(row,'procesado');row=await f.db.prepare('SELECT * FROM tiendanube_eventos WHERE id=?').get(first.id);
    assert.equal(row.sync_estado,'procesado');assert.ok(row.procesado_at);
  }finally{await f.pg.close();}
});

test('product/updated espera al pedido tardío, prioriza order y se verifica sin escritura',async()=>{
  const f=await setup();try{
    await f.add('product/updated','11');const calls=[];
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path)=>{calls.push(method);return path.startsWith('/orders/')?pedido():variante(4);}});
    assert.equal((await sync.procesarEntrada('n1')).estado,'esperando_pedidos');
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,false);
    await f.add();
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,1);
    f.setClock('2026-11-09T14:01:00Z');
    assert.equal((await sync.procesarEntrada('n1')).stock_verificado,true);
    assert.deepEqual(calls,['GET','GET','GET']);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,4);
  }finally{await f.pg.close();}
});

test('cambio remoto sin pedido explicativo pausa después de gracia y jamás escribe',async()=>{
  const f=await setup();try{
    await f.add('product/updated','11','2026-11-09T13:58:00Z');let writes=0;
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method)=>{if(method!=='GET')writes++;return variante(2);}});
    assert.equal((await sync.procesarEntrada('n1')).codigo,'STOCK_REMOTO_CAMBIO_FUERA_DE_COLA');
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,true);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,5);assert.equal(writes,0);
  }finally{await f.pg.close();}
});

test('entrega adoptada permite evento de pago idéntico, pero no nuevas reservas/cancelaciones automáticas',async()=>{
  const f=await setup();try{
    let qty=1,paid=false;await f.add();
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async()=>({...pedido(qty),payment_status:paid?'paid':'pending'})});
    await sync.procesarEntrada('n1');
    await f.db.prepare('INSERT INTO tiendanube_entregas VALUES(?,?,?)').run('101',hashPedidoPrivacidad('101','40'),'venta-fixture');
    paid=true;await f.add('order/paid');
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,0);
    qty=2;await f.add('order/edited');
    assert.equal((await sync.procesarEntrada('n1')).codigo,'PEDIDO_ENTREGADO_REQUIERE_REVISION');
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,4);
    assert.equal((await f.db.prepare('SELECT COUNT(*)::int n FROM producto_historial').get()).n,1);
  }finally{await f.pg.close();}
});

test('POST relativo conserva checkout intercalado y webhook tardío no resta dos veces',async()=>{
  const f=await setup();try{
    let remote=5,posts=0;
    await f.db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path,data)=>{
      if(path.startsWith('/orders/'))return pedido();
      if(method==='POST'){
        assert.equal(path,'/products/11/variants/stock');assert.deepEqual(data,{action:'variation',value:-1,id:111});
        // A checkout completes after GET but before the relative adjustment.
        // Both decrements survive. The response contains that unimported order.
        remote--;remote=Math.max(0,remote+data.value);posts++;return [variante(remote)];
      }
      assert.equal(method,'GET');
      return variante(remote);
    }});
    assert.equal((await sync.procesarSalida('n1')).codigo,'VARIACION_APLICADA_ESPERANDO_PEDIDOS');assert.equal(remote,3);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,4);
    assert.equal((await sync.procesarSalida('n1')).estado,'vacio');assert.equal(posts,1);
    await f.add();await sync.procesarEntrada('n1');
    await f.db.exec("UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    // Even the stock trigger resetting outbox.proximo_intento cannot erase the
    // separate verification hold. No POST is repeated while awaiting the order.
    assert.equal((await sync.procesarSalida('n1')).estado,'vacio');
    f.setClock('2026-11-09T14:01:00Z');
    assert.equal((await sync.procesarSalida('n1')).sin_escritura,true);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,3);assert.equal(remote,3);
    const link=await f.db.prepare('SELECT sync_stock_remoto,sync_verificar_despues FROM tiendanube_variantes').get();
    assert.equal(link.sync_stock_remoto,3);assert.equal(link.sync_verificar_despues,null);
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,false);assert.equal(posts,1);
  }finally{await f.pg.close();}
});

test('variación aplicada sin pedido explicativo pausa al verificar y no la repite',async()=>{
  const f=await setup();try{
    let remote=5,posts=0;
    await f.db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,_path,data)=>{
      if(method==='POST'){remote=3;remote+=data.value;posts++;return [variante(remote)];}
      return variante(remote);
    }});
    assert.equal((await sync.procesarSalida('n1')).estado,'pendiente');
    f.setClock('2026-11-09T14:01:00Z');
    assert.equal((await sync.procesarSalida('n1')).codigo,'STOCK_REMOTO_CAMBIO_FUERA_DE_COLA');
    assert.equal(posts,1);assert.equal(remote,2);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,4);
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,true);
  }finally{await f.pg.close();}
});

test('venta local durante gracia queda pendiente y solo emite su delta propio después de conciliar',async()=>{
  const f=await setup();try{
    let remote=5,posts=0;const deltas=[];
    await f.db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path,data)=>{
      if(path.startsWith('/orders/'))return pedido();
      if(method==='POST'){if(posts===0)remote--;remote+=data.value;posts++;deltas.push(data.value);return [variante(remote)];}
      return variante(remote);
    }});
    await sync.procesarSalida('n1');
    await f.db.exec("UPDATE productos SET stock=3 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    assert.equal((await sync.procesarSalida('n1')).estado,'vacio');assert.equal(posts,1);
    await f.add();await sync.procesarEntrada('n1');
    await f.db.exec("UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    f.setClock('2026-11-09T14:01:00Z');
    assert.equal((await sync.procesarSalida('n1')).estado,'sincronizado');
    assert.deepEqual(deltas,[-1,-1]);assert.equal(remote,2);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,2);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,2);
  }finally{await f.pg.close();}
});

test('reposición positiva preserva checkout concurrente sin incorporarlo dos veces al baseline',async()=>{
  const f=await setup();try{
    let remote=5,posts=0;
    await f.db.exec("UPDATE productos SET stock=6 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path,data)=>{
      if(path.startsWith('/orders/'))return pedido();
      if(method==='POST'){assert.equal(data.value,1);remote--;remote+=data.value;posts++;return [variante(remote)];}
      return variante(remote);
    }});
    assert.equal((await sync.procesarSalida('n1')).estado,'pendiente');assert.equal(remote,5);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,6);
    await f.add();await sync.procesarEntrada('n1');f.setClock('2026-11-09T14:01:00Z');
    await f.db.exec("UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    assert.equal((await sync.procesarSalida('n1')).sin_escritura,true);assert.equal(posts,1);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,5);
  }finally{await f.pg.close();}
});

test('límite de última unidad: POST satura a cero, pedido posterior alerta sobreventa sin stock negativo',async()=>{
  const f=await setup();try{
    let remote=1,posts=0;
    await f.db.exec("UPDATE tiendanube_variantes SET sync_stock_remoto=1;UPDATE productos SET stock=0 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path,data)=>{
      if(path.startsWith('/orders/'))return pedido();
      if(method==='POST'){
        // Both channels sold the same last unit. Relative stock updates avoid
        // overwriting a remote sale, but do not provide a shared reservation.
        remote--;remote=Math.max(0,remote+data.value);posts++;return [variante(remote)];
      }
      return variante(remote);
    }});
    assert.equal((await sync.procesarSalida('n1')).estado,'sincronizado');assert.equal(remote,0);
    await f.add();assert.equal((await sync.procesarEntrada('n1')).codigo,'STOCK_LOCAL_INSUFICIENTE');
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,0);assert.equal(posts,1);
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,true);
    assert.equal((await f.db.prepare('SELECT COUNT(*)::int n FROM tiendanube_pedido_stock').get()).n,0);
  }finally{await f.pg.close();}
});

test('respuesta POST de más de una variante se considera insegura y nunca se repite',async()=>{
  const f=await setup();try{
    let posts=0;
    await f.db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,_path,data)=>{
      if(method==='POST'){posts++;assert.equal(data.id,111);return [variante(4),{...variante(4),id:112}];}
      return variante(5);
    }});
    assert.equal((await sync.procesarSalida('n1')).codigo,'RESPUESTA_VARIACION_INVALIDA');
    assert.equal((await sync.procesarSalida('n1')).estado,'pausado');assert.equal(posts,1);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,5);
  }finally{await f.pg.close();}
});

test('pedido pagado con una línea sin reserva pausa antes de tocar stock, baseline o ledger',async()=>{
  const f=await setup();try{
    const event=await f.add('order/paid'),calls=[];
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async(method,path)=>{
      calls.push({method,path});return {...pedido(),payment_status:'paid',products:[
        {variant_id:111,quantity:1},
        {variant_id:111,quantity:2,issues:{unclaimed_stock:'1'}},
      ]};
    }});
    assert.deepEqual(await sync.procesarEntrada('n1'),{estado:'revision_manual',codigo:'STOCK_REMOTO_NO_RESERVADO'});
    assert.deepEqual(calls,[{method:'GET',path:'/orders/40'}]);
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,5);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,5);
    for(const table of ['tiendanube_pedidos','tiendanube_pedido_stock','tiendanube_stock_outbox','producto_historial']){
      assert.equal((await f.db.prepare(`SELECT COUNT(*)::int n FROM ${table}`).get()).n,0);
    }
    const con=await f.db.prepare('SELECT pausada,sync_motivo_pausa FROM tiendanube_conexiones').get();
    assert.equal(con.pausada,true);assert.equal(con.sync_motivo_pausa,'STOCK_REMOTO_NO_RESERVADO');
    const e=await f.db.prepare('SELECT sync_estado,error,procesado_at FROM tiendanube_eventos WHERE id=?').get(event.id);
    assert.equal(e.sync_estado,'revision_manual');assert.equal(e.error,'STOCK_REMOTO_NO_RESERVADO');assert.equal(e.procesado_at,null);
    assert.equal((await sync.procesarSalida('n1')).estado,'pausado');assert.equal(calls.length,1);
  }finally{await f.pg.close();}
});

test('revisión de unclaimed_stock posterior preserva la reserva previa sin descontar ni reponer',async()=>{
  const f=await setup();try{
    let raw=pedido();await f.add();
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async()=>raw});
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,1);
    raw={...pedido(2),payment_status:'paid',products:[{variant_id:111,quantity:2,issues:{unclaimed_stock:1}}]};
    await f.add('order/updated');
    assert.equal((await sync.procesarEntrada('n1')).codigo,'STOCK_REMOTO_NO_RESERVADO');
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,4);
    assert.equal((await f.db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes').get()).sync_stock_remoto,4);
    assert.equal((await f.db.prepare('SELECT cantidad_aplicada FROM tiendanube_pedido_stock').get()).cantidad_aplicada,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*)::int n FROM producto_historial').get()).n,1);
  }finally{await f.pg.close();}
});

test('unclaimed_stock de tipo ambiguo falla cerrado con evento revisable y cero movimientos',async()=>{
  const f=await setup();try{
    await f.add();
    const sync=crearServicioTiendanubeSync({db:f.db,enabled:true,now:f.now,apiFactory:()=>async()=>({
      ...pedido(),products:[{variant_id:111,quantity:1,issues:{unclaimed_stock:false}}],
    })});
    assert.equal((await sync.procesarEntrada('n1')).codigo,'PEDIDO_REMOTO_MALFORMADO');
    assert.equal((await f.db.prepare('SELECT stock FROM productos').get()).stock,5);
    assert.equal((await f.db.prepare('SELECT COUNT(*)::int n FROM tiendanube_pedido_stock').get()).n,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*)::int n FROM producto_historial').get()).n,0);
    assert.equal((await f.db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,true);
  }finally{await f.pg.close();}
});
