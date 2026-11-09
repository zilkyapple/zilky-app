import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { stockSchema } from '../src/db/stockSchema.js';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubePrivacidadSchema } from '../src/db/tiendanubePrivacidadSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { tiendanubeEntregasSchema } from '../src/db/tiendanubeEntregasSchema.js';
import { crearServicioPrivacidadTiendanube,hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';
import { crearServicioTiendanubeSync } from '../src/services/tiendanubeSyncService.js';

// PostgreSQL real compilado a WASM, exclusivamente en memoria. No lee .env,
// DATABASE_URL ni conecta con Neon o con el negocio del usuario.
async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const storage=new AsyncLocalStorage();
  const current=()=>storage.getStore()||pg;
  const db={
    query:async(sql,params=[])=>{const r=await current().query(sql,params);return {...r,rowCount:r.affectedRows};},
    exec:sql=>current().exec(sql),
    prepare(sql){let i=0;const q=sql.replace(/\?/g,()=>`$${++i}`);return {
      get:async(...p)=>(await db.query(q,p)).rows[0],all:async(...p)=>(await db.query(q,p)).rows,
      run:async(...p)=>({changes:(await db.query(q,p)).rowCount}),
    };},
    transaction:fn=>storage.getStore()?fn(storage.getStore()):pg.transaction(tx=>storage.run(tx,()=>fn(tx))),
  };
  await db.exec(`CREATE TABLE negocios(id TEXT PRIMARY KEY);CREATE TABLE usuarios(id TEXT PRIMARY KEY);
    CREATE TABLE ventas(id TEXT PRIMARY KEY);CREATE TABLE creditos(id TEXT PRIMARY KEY);CREATE TABLE pagos(id TEXT PRIMARY KEY);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT NOT NULL REFERENCES negocios(id),nombre TEXT,stock INTEGER);
    INSERT INTO negocios VALUES('n1'),('n2');INSERT INTO usuarios VALUES('u1');
    INSERT INTO productos VALUES('p1','n1','Prenda de prueba',5),('p2','n2','Otra tienda',7);`);
  const migrate=async()=>{for(const schema of [stockSchema,tiendanubeSchema,tiendanubePrivacidadSchema,tiendanubeSyncSchema,tiendanubeEntregasSchema])await db.exec(schema);};
  await migrate();
  await db.exec(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes)
    VALUES('n1','101','51162','fixture-no-es-secreto','write_products,read_orders'),('n2','202','51162','fixture','write_products,read_orders');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id)
    VALUES('p1','n1','101','11','111'),('p2','n2','202','22','222');`);
  return {db,pg,migrate};
}
async function activarFixture(db){
  await db.exec(`UPDATE tiendanube_conexiones SET pausada=FALSE,sync_activada_at='2026-11-09T10:00:00Z',
    sync_baseline_at='2026-11-09T10:00:00Z',sync_webhooks_at='2026-11-09T10:00:00Z' WHERE negocio_id='n1';
    UPDATE tiendanube_variantes SET sync_baseline_at='2026-11-09T10:00:00Z',sync_stock_remoto=5 WHERE producto_id='p1';`);
}
async function evento(db,{order='40',topic='order/created',hash='one'}={}){
  await db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_proximo_intento)
    VALUES('101',?,?,?,'{}','2026-11-09T12:00:00Z')`).run(topic,order,hash);
}
const now=()=>new Date('2026-11-09T14:00:00Z');

test('migraciones repetibles y trigger real: no alteran inventario y encolan por variante',async()=>{
  const {db,pg,migrate}=await fixture();
  try{
    await migrate();
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
    assert.equal((await db.prepare('SELECT pausada FROM tiendanube_conexiones WHERE negocio_id=?').get('n1')).pausada,true);
    await db.exec("UPDATE productos SET stock=4 WHERE id='p1';UPDATE productos SET stock=3 WHERE id='p1';");
    const out=await db.prepare('SELECT * FROM tiendanube_stock_outbox WHERE producto_id=?').get('p1');
    assert.equal(out.stock_deseado,3);assert.equal(Number(out.version),2);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM tiendanube_stock_outbox').get()).n,1);
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p2')).stock,7);
  }finally{await pg.close();}
});

test('pedido pendiente, pago posterior y venta local: una reserva y salida controlada',async()=>{
  const {db,pg}=await fixture();
  try{
    await activarFixture(db);await evento(db);
    let paid=false,remote=4,posts=0;
    const sync=crearServicioTiendanubeSync({db,enabled:true,now,apiFactory:()=>async(method,path,body)=>{
      if(path==='/orders/40')return {id:40,store_id:101,created_at:'2026-11-09T11:00:00Z',status:'open',payment_status:paid?'paid':'pending',products:[{variant_id:111,quantity:1}]};
      if(method==='POST'){
        posts++;assert.equal(body.action,'variation');assert.equal(String(body.id),'111');
        assert.equal(path,'/products/11/variants/stock');remote=Math.max(0,remote+body.value);
        return [{id:111,product_id:11,stock_management:true,stock:remote}];
      }
      return {id:111,product_id:11,stock_management:true,stock:remote};
    }});
    const result=await sync.procesarEntrada('n1');
    assert.equal(result.unidades_reservadas,1);assert.equal(result.cobros_creados,0);assert.equal(result.comisiones_creadas,0);
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,4);
    assert.equal((await db.prepare('SELECT sync_stock_remoto FROM tiendanube_variantes WHERE producto_id=?').get('p1')).sync_stock_remoto,4);
    paid=true;await evento(db,{topic:'order/paid',hash:'two'});
    assert.equal((await sync.procesarEntrada('n1')).unidades_reservadas,0);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM producto_historial').get()).n,1);
    // Cambio legítimo del local después de la reserva web.
    await db.exec("UPDATE productos SET stock=3 WHERE id='p1';UPDATE tiendanube_stock_outbox SET proximo_intento='2026-11-09T12:00:00Z';");
    assert.equal((await sync.procesarSalida('n1')).estado,'sincronizado');
    assert.equal(remote,3);assert.equal(posts,1);
    assert.equal((await db.prepare('SELECT estado FROM tiendanube_stock_outbox WHERE producto_id=?').get('p1')).estado,'sincronizado');
  }finally{await pg.close();}
});

test('privacidad borra resumen pero preserva stock y supresión de reimportación',async()=>{
  const {db,pg}=await fixture();
  try{
    await activarFixture(db);await evento(db);
    const sync=crearServicioTiendanubeSync({db,enabled:true,now,apiFactory:()=>async()=>({id:40,created_at:'2026-11-09T11:00:00Z',status:'open',payment_status:'pending',products:[{variant_id:111,quantity:1}]})});
    await sync.procesarEntrada('n1');
    const privacy=crearServicioPrivacidadTiendanube({database:db});
    const report=await privacy.procesar('customer-data-request',{store_id:101,data_request:{id:99},orders_requested:[40],customer:{email:'no-guardar@invalid.example'}});
    assert.equal(report.estado,'pendiente_entrega');assert.equal(report.reporte.pedidos.length,1);
    const erased=await privacy.procesar('customer-redact',{store_id:101,orders_to_redact:[40]});
    assert.equal(erased.estado,'completada');
    assert.equal((await db.prepare('SELECT count(*)::int n FROM tiendanube_pedidos WHERE store_id=?').get('101')).n,0);
    assert.equal((await db.prepare('SELECT count(*)::int n FROM tiendanube_pedido_stock WHERE store_id=? AND order_hash=?').get('101',hashPedidoPrivacidad('101','40'))).n,1);
    assert.equal((await privacy.obtener(report.id,'n1')).reporte.pedidos.length,0);
    assert.equal(await privacy.obtener(report.id,'n2'),null);
    await evento(db,{topic:'order/paid',hash:'late'});
    assert.equal((await sync.procesarEntrada('n1')).estado,'redactado_ignorado');
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,4);
    const uninstall=await privacy.procesar('uninstalled',{store_id:101,id:51162,event_launch_ts:1});
    assert.equal(uninstall.estado,'pendiente_revision');
    assert.ok(await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=?').get('101'));
  }finally{await pg.close();}
});
