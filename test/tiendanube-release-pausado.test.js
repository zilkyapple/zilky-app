import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { stockSchema } from '../src/db/stockSchema.js';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubePrivacidadSchema } from '../src/db/tiendanubePrivacidadSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { tiendanubeEntregasSchema } from '../src/db/tiendanubeEntregasSchema.js';
import { tiendanubeReservasSchema } from '../src/db/tiendanubeReservasSchema.js';
import { iniciarTiendanubeWorker } from '../src/services/tiendanubeWorker.js';
import { crearServicioTiendanubeSync } from '../src/services/tiendanubeSyncService.js';
import { crearServicioEntregasTiendanube } from '../src/services/tiendanubeEntregasService.js';
import { crearServicioReservasTiendanube } from '../src/services/tiendanubeReservasService.js';

// Completely isolated upgrade/regression checks. No real .env, DB, Tiendanube
// API, inventory, receipt, commission, customer or email is accessed.
process.env.DOTENV_CONFIG_PATH='/__zilky_release_paused_test_no_config__';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/isolated';
process.env.TIENDANUBE_SYNC_ENABLED='false';
process.env.TIENDANUBE_ENTREGAS_ENABLED='false';
process.env.TIENDANUBE_RESERVAS_ENABLED='false';
const {db,pool}=await import('../src/db/connection.js');
pool.connect=async()=>{throw new Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
pool.query=async()=>{throw new Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
const {migrate}=await import('../src/db/migrate.js');
const {todayAR}=await import('../src/lib/dates.js');
const {crearVenta}=await import('../src/services/ventasService.js');
const {moverStock}=await import('../src/services/productosService.js');
const {guardarCombo}=await import('../src/services/comisionReglasService.js');
const {detalleVenta,devolverVenta}=await import('../src/services/ventasGestionService.js');
const {vistaVentaError,eliminarVentaError}=await import('../src/services/ventaErrorService.js');
const {crearPedidoPublico,detallePedidoTienda,confirmarPedidoTienda,cancelarPedidoTienda}=await import('../src/services/tiendaPedidosService.js');
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('NETWORK_HTTP_FORBIDDEN_IN_TEST');};
test.after(async()=>{globalThis.fetch=fetchOriginal;await pool.end();});

const schemas=[tiendanubeSchema,tiendanubePrivacidadSchema,tiendanubeSyncSchema,tiendanubeEntregasSchema,tiendanubeReservasSchema];
test('primera creación de tablas Tiendanube no cambia filas legacy, deuda, dinero o publicación',async()=>{
  const pg=new PGlite();await pg.waitReady;
  try{
    await pg.exec(`CREATE TABLE negocios(id TEXT PRIMARY KEY,nombre TEXT);
      CREATE TABLE usuarios(id TEXT PRIMARY KEY,rol TEXT);
      CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT REFERENCES negocios(id),stock INTEGER,costo_centavos INTEGER);
      CREATE TABLE ventas(id TEXT PRIMARY KEY,total_centavos INTEGER);
      CREATE TABLE creditos(id TEXT PRIMARY KEY,saldo_centavos INTEGER);
      CREATE TABLE pagos(id TEXT PRIMARY KEY,monto_centavos INTEGER);
      CREATE TABLE tiendas_config(negocio_id TEXT PRIMARY KEY,habilitada BOOLEAN);
      CREATE TABLE tienda_productos(id TEXT PRIMARY KEY,publicado BOOLEAN);
      INSERT INTO negocios VALUES('n','Negocio preexistente');INSERT INTO usuarios VALUES('u','administrador');
      INSERT INTO productos VALUES('p','n',3,2100000),('null','n',NULL,100),('negative','n',-1,100);
      INSERT INTO ventas VALUES('v',4250000);INSERT INTO creditos VALUES('c',3250000);INSERT INTO pagos VALUES('r',1000000);
      INSERT INTO tiendas_config VALUES('n',TRUE);INSERT INTO tienda_productos VALUES('w',TRUE);`);
    await pg.exec(stockSchema);
    const tables=['negocios','usuarios','productos','ventas','creditos','pagos','tiendas_config','tienda_productos','producto_historial'];
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await pg.query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows])));
    const before=await snapshot();
    await pg.transaction(async tx=>{for(const schema of schemas)await tx.exec(schema);});
    assert.deepEqual(await snapshot(),before);
    assert.equal((await pg.query('SELECT COUNT(*)::int n FROM tiendanube_conexiones')).rows[0].n,0);
    assert.equal((await pg.query('SELECT COUNT(*)::int n FROM tiendanube_stock_outbox')).rows[0].n,0);
  }finally{await pg.close();}
});

async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const context=new AsyncLocalStorage(),current=()=>context.getStore()||pg;
  db.query=async(sql,params=[])=>{const r=await current().query(sql,params);return {...r,rowCount:r.affectedRows};};
  db.exec=sql=>current().exec(sql);
  db.transaction=fn=>context.getStore()?fn(context.getStore()):pg.transaction(tx=>context.run(tx,()=>fn(tx)));
  db.lockClienteNegocio=(c,n)=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([c,n])]);
  await migrate();
  await db.exec(`INSERT INTO organizaciones(id,nombre) VALUES('org','Organización aislada');
    INSERT INTO negocios(id,nombre,organizacion_id) VALUES('n','Negocio aislado','org');
    INSERT INTO usuarios(id,email,rol,activo) VALUES('u','admin@fixture.invalid','administrador',1);
    INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES('u','org','administrador',1);
    INSERT INTO clientes(id,nombre,apellido,organizacion_id) VALUES('c','Persona','Fixture','org');
    INSERT INTO cliente_negocio(cliente_id,negocio_id) VALUES('c','n');
    INSERT INTO productos(id,negocio_id,organizacion_id,nombre,categoria,stock,costo_centavos,precio_contado_centavos,precio_financiado_centavos)
      VALUES('linked','n','org','Prenda vinculada','Remeras',2,2100000,4000000,4250000),
      ('local','n','org','Solo local','Remeras',0,2100000,4000000,4250000),
      ('uncontrolled','n','org','Sin control','Remeras',NULL,2100000,4000000,4250000),
      ('combo','n','org','Combo','Combo',999,0,8000000,8500000);
    INSERT INTO comision_config(negocio_id,activa,visible_empleado,momento) VALUES('n',TRUE,FALSE,'venta');
    INSERT INTO comision_producto(producto_id,tipo,valor) VALUES('linked','fijo',250000);
    INSERT INTO tiendas_config(negocio_id,slug,habilitada,nombre) VALUES('n','fixture-release',TRUE,'Catálogo original');
    INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,precio_centavos,publicado) VALUES('web','n','linked','Prenda publicada',4250000,TRUE);
    INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes)
      VALUES('n','101','51162','fixture-not-a-token','write_products,read_orders');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id) VALUES('linked','n','101','11','111');
  `);
  const stock=async id=>(await db.prepare('SELECT stock FROM productos WHERE id=?').get(id)).stock;
  const count=async table=>(await db.prepare(`SELECT COUNT(*)::int n FROM ${table}`).get()).n;
  const sale=(product='linked',quantity=1)=>crearVenta({negocio_id:'n',cliente_id:'c',usuario_id:'u',comision_usuario_id:'u',
    solicitud_id:randomUUID(),fecha:todayAR(),modalidad:'unico',entrega_inicial_centavos:0,
    monto_total_centavos:4250000*quantity,items:[{producto_id:product,cantidad:quantity,precio_unitario_centavos:4250000}],plan:{plazo_dias:30}});
  const noCommerce=async()=>{
    for(const table of ['tiendanube_pedidos','tiendanube_pedido_stock','tiendanube_entregas','tiendanube_reserva_intentos'])assert.equal(await count(table),0,table);
    assert.equal((await db.prepare('SELECT pausada FROM tiendanube_conexiones').get()).pausada,true);
    const worker=iniciarTiendanubeWorker({db});assert.equal(worker.activo,false);assert.deepEqual(await worker.tick(),{estado:'deshabilitado'});
  };
  return {pg,stock,count,sale,noCommerce};
}

test('upgrade nuevo es aditivo: conserva todas las filas legacy y la web original al repetirse',async()=>{
  const f=await fixture();try{
    await f.sale();
    const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'tiendanube_%' ORDER BY table_name")).rows.map(r=>r.table_name);
    const snapshot=async()=>{
      const result={};for(const table of tables){assert.match(table,/^[a-z_]+$/);result[table]=(await db.query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.r);}return result;
    };
    const before=await snapshot();
    for(let repetition=0;repetition<2;repetition++)await db.transaction(async()=>{for(const schema of schemas)await db.exec(schema);});
    assert.deepEqual(await snapshot(),before);
    assert.equal((await db.prepare('SELECT habilitada FROM tiendas_config').get()).habilitada,true);
    assert.equal((await db.prepare('SELECT publicado FROM tienda_productos').get()).publicado,true);
    await f.noCommerce();
  }finally{await f.pg.close();}
});

test('tres flags false bloquean worker, motor, entregas y reservas antes de DB o red',async()=>{
  const forbidden=()=>{assert.fail('No DB/API operation is allowed while disabled');};
  const fake={prepare:forbidden,transaction:forbidden,query:forbidden};
  const worker=iniciarTiendanubeWorker({db:fake});assert.equal(worker.activo,false);
  assert.deepEqual(await worker.tick(),{estado:'deshabilitado'});
  const sync=crearServicioTiendanubeSync({db:fake,apiFactory:forbidden});
  assert.deepEqual(await sync.procesarEntrada('n'),{estado:'deshabilitado'});
  assert.deepEqual(await sync.procesarSalida('n'),{estado:'deshabilitado'});
  const delivery=crearServicioEntregasTiendanube({database:fake,apiFactory:forbidden});
  await assert.rejects(delivery.confirmarEntregaTiendanube('n','40',{},'u'),{code:'ENTREGAS_TIENDANUBE_DESHABILITADAS'});
  const reserve=crearServicioReservasTiendanube({db:fake,apiFactory:forbidden});
  await assert.rejects(reserve.reservarProductosTiendanube('n',{},'u'),{code:'RESERVAS_TIENDANUBE_DESHABILITADAS'});
});

test('venta legacy mantiene negativos y null: vínculo pausado solo encola metadata, sin ventas remotas',async()=>{
  const f=await fixture();try{
    const linked=await f.sale('linked',3),local=await f.sale('local'),uncontrolled=await f.sale('uncontrolled');
    assert.equal(await f.stock('linked'),-1);assert.equal(await f.stock('local'),-1);assert.equal(await f.stock('uncontrolled'),null);
    assert.equal(linked.advertencias.length,1);assert.equal(local.advertencias.length,1);assert.equal(uncontrolled.advertencias.length,0);
    assert.equal(await f.count('ventas'),3);assert.equal(await f.count('cuotas'),3);assert.equal(await f.count('pagos'),0);
    const out=await db.prepare('SELECT producto_id,stock_deseado,estado FROM tiendanube_stock_outbox').all();
    assert.deepEqual(out,[{producto_id:'linked',stock_deseado:-1,estado:'pendiente'}]);
    await f.noCommerce();
  }finally{await f.pg.close();}
});

test('stock manual pausado conserva reposición, conteo y sin_control sin llamadas remotas',async()=>{
  const f=await fixture();try{
    const move=body=>moverStock('linked','n',{solicitud_id:randomUUID(),motivo:'Fixture de inventario',...body},'u');
    await move({tipo:'reposicion',cantidad:3});assert.equal(await f.stock('linked'),5);
    await move({tipo:'conteo',cantidad:1,stock_esperado:5});assert.equal(await f.stock('linked'),1);
    await move({tipo:'sin_control',stock_esperado:1});assert.equal(await f.stock('linked'),null);
    assert.equal((await db.prepare('SELECT stock_deseado FROM tiendanube_stock_outbox').get()).stock_deseado,null);
    await f.noCommerce();
  }finally{await f.pg.close();}
});

test('combo legacy descuenta componentes y devolución repone snapshot sin alterar producto combo',async()=>{
  const f=await fixture();try{
    await guardarCombo('n','combo',{componentes:[{producto_id:'linked',cantidad:2},{producto_id:'local',cantidad:1}]},'u');
    const sale=await f.sale('combo',2);
    assert.equal(await f.stock('linked'),-2);assert.equal(await f.stock('local'),-2);assert.equal(await f.stock('combo'),999);
    const d=await detalleVenta('n',sale.venta.id);
    await devolverVenta('n',sale.venta.id,{solicitud_id:randomUUID(),version:d.version,tipo:'devolucion',motivo:'Retorno fixture',reponer:true,items:[{id:d.items[0].id,cantidad:1}]},'u');
    assert.equal(await f.stock('linked'),0);assert.equal(await f.stock('local'),-1);assert.equal(await f.stock('combo'),999);
    assert.equal((await db.prepare('SELECT stock_deseado FROM tiendanube_stock_outbox').get()).stock_deseado,0);
    await f.noCommerce();
  }finally{await f.pg.close();}
});

test('web original recibe, confirma y cancela pedido normalmente con vínculo pausado',async()=>{
  const f=await fixture();try{
    const order=await crearPedidoPublico('fixture-release',{solicitud_id:randomUUID(),contacto:{nombre:'Cliente',apellido:'Fixture',telefono:'+5491112345678'},
      items:[{producto_id:'web',cantidad:1}],total_esperado_centavos:4250000,acepta_contacto:true});
    assert.equal(await f.stock('linked'),2);
    let d=await detallePedidoTienda('n',order.id);
    await confirmarPedidoTienda('n',order.id,{version:d.version,solicitud_id:randomUUID()},'u');
    assert.equal(await f.stock('linked'),1);
    d=await detallePedidoTienda('n',order.id);
    await cancelarPedidoTienda('n',order.id,{version:d.version,solicitud_id:randomUUID(),motivo:'Cancelación fixture'},'u');
    assert.equal(await f.stock('linked'),2);assert.equal(await f.count('ventas'),0);assert.equal(await f.count('pagos'),0);
    assert.equal((await db.prepare('SELECT habilitada FROM tiendas_config').get()).habilitada,true);
    await f.noCommerce();
  }finally{await f.pg.close();}
});

test('anulación por error legacy conserva historia y repone solo unidades originales en pausa',async()=>{
  const f=await fixture();try{
    const sale=await f.sale();assert.equal(await f.stock('linked'),1);
    const preview=await vistaVentaError('n',sale.venta.id);assert.equal(preview.permitido,true,preview.motivo_bloqueo);
    await eliminarVentaError('n',sale.venta.id,{solicitud_id:randomUUID(),version:preview.version,motivo:'Carga fixture errónea',confirmar:true},'u');
    assert.equal(await f.stock('linked'),2);
    assert.equal((await db.prepare('SELECT estado FROM ventas WHERE id=?').get(sale.venta.id)).estado,'anulada');
    assert.equal(await f.count('ventas'),1);assert.equal(await f.count('creditos'),1);
    assert.equal((await db.prepare('SELECT stock_deseado FROM tiendanube_stock_outbox').get()).stock_deseado,2);
    await f.noCommerce();
  }finally{await f.pg.close();}
});
