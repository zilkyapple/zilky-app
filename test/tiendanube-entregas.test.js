import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { tiendanubeEntregasSchema } from '../src/db/tiendanubeEntregasSchema.js';
import { crearServicioEntregasTiendanube, pesosTiendanubeACentavos, validarPedidoEntregaTiendanube } from '../src/services/tiendanubeEntregasService.js';
import { hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';

// Only in-memory PostgreSQL. Never load real .env or use a real server.
process.env.DOTENV_CONFIG_PATH='/__zilky_entregas_test_config_does_not_exist__';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/isolated';
const {db,pool}=await import('../src/db/connection.js');
pool.connect=async()=>{throw new Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
pool.query=async()=>{throw new Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
const {migrate}=await import('../src/db/migrate.js');
const {crearVenta,crearVentaConReservaTiendanube}=await import('../src/services/ventasService.js');
const fixed=()=>new Date('2026-11-09T18:00:00Z');
const total=4250000;
const defaultBody=extra=>({solicitud_id:randomUUID(),cliente_id:'c1',fecha_entrega:'2026-11-09',
  condicion_precio:'30_dias',entrega_inicial_centavos:0,total_esperado_centavos:total,confirmar_entrega:true,...extra});
function remote(extra={}){
  return {id:40,store_id:101,created_at:'2026-11-09T12:00:00Z',currency:'ARS',status:'open',payment_status:'pending',gateway:'offline',
    products:[{product_id:11,variant_id:111,quantity:1,price:'42500.00'}],subtotal:'42500.00',total:'42500.00',
    discount:'0.00',discount_coupon:'0.00',discount_gateway:'0.00',coupon:[],...extra};
}
async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const als=new AsyncLocalStorage(),current=()=>als.getStore()||pg,calls=[];
  db.query=async(sql,params=[])=>{calls.push({sql,params:structuredClone(params)});const r=await current().query(sql,params);return {...r,rowCount:r.affectedRows};};
  db.exec=sql=>current().exec(sql);
  db.transaction=fn=>als.getStore()?fn(als.getStore()):pg.transaction(tx=>als.run(tx,()=>fn(tx)));
  db.lockClienteNegocio=(c,n)=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([c,n])]);
  await migrate();await db.exec(tiendanubeEntregasSchema);await db.exec(tiendanubeEntregasSchema);
  await db.exec(`INSERT INTO organizaciones(id,nombre) VALUES('org-a','Organización de prueba'),('org-b','Organización ajena');
    INSERT INTO negocios(id,nombre,organizacion_id) VALUES('n1','Prueba A','org-a'),('n2','Prueba B','org-b');
    INSERT INTO usuarios(id,email,rol,activo) VALUES('admin','admin@fixture.invalid','administrador',1),('emp','emp@fixture.invalid','empleado',1),
      ('other','other@fixture.invalid','empleado',1),('admin-b','admin-b@fixture.invalid','administrador',1);
    INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES('admin','org-a','administrador',1),('admin-b','org-b','administrador',1);
    INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES('emp','n1','{"ventas.crear":true,"tienda.pedidos":true,"clientes.ver":true,"pagos.registrar":true}',1),
      ('other','n2','{"ventas.crear":true,"tienda.pedidos":true,"clientes.ver":true,"pagos.registrar":true}',1);
    INSERT INTO clientes(id,nombre,apellido) VALUES('c1','Cliente','Prueba'),('c2','Cliente','Otro negocio');
    INSERT INTO cliente_negocio(cliente_id,negocio_id) VALUES('c1','n1'),('c2','n2');
    INSERT INTO productos(id,negocio_id,nombre,categoria,stock,precio_contado_centavos,precio_financiado_centavos,costo_centavos)
      VALUES('p1','n1','Prenda de prueba','Remeras',5,4000000,4250000,2000000),('p2','n2','Prenda ajena','Remeras',8,4000000,4250000,2000000);
    INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada,sync_activada_at,sync_baseline_at,sync_webhooks_at)
      VALUES('n1','101','51162','fixture-no-access','read_orders,write_products',FALSE,'2026-11-09T10:00:00Z','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id,sync_baseline_at,sync_stock_remoto)
      VALUES('p1','n1','101','11','111','2026-11-09T10:00:00Z',5);
    INSERT INTO tiendanube_pedidos(negocio_id,store_id,order_id,estado,cantidades,pagado,cancelado,pendiente_revision)
      VALUES('n1','101','40','open','{"111":1}',FALSE,FALSE,FALSE);
    INSERT INTO comision_config(negocio_id,activa,visible_empleado,momento) VALUES('n1',TRUE,FALSE,'venta');
    INSERT INTO comision_producto(producto_id,tipo,valor) VALUES('p1','fijo',250000);`);
  await db.prepare('INSERT INTO tiendanube_pedido_stock(store_id,order_hash,variant_id,producto_id,cantidad_aplicada) VALUES(?,?,?,?,?)')
    .run('101',hashPedidoPrivacidad('101','40'),'111','p1',1);
  let raw=remote(),requests=0;
  const service=crearServicioEntregasTiendanube({database:db,crearVentaReservada:crearVentaConReservaTiendanube,enabled:true,now:fixed,
    apiFactory:()=>async(method,path)=>{requests++;assert.equal(method,'GET');assert.equal(path,'/orders/40');return structuredClone(raw);}});
  const count=async(table)=>(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
  return {pg,db,service,calls,count,get requests(){return requests;},set remote(v){raw=v;}};
}

test('decimal remoto exacto: no redondea centavos ni acepta exponentes/formatos ambiguos',()=>{
  for(const [v,n] of [['42500.00',4250000],['40.5',4050],[40.5,4050],['0',0]])assert.equal(pesosTiendanubeACentavos(v),n);
  for(const v of [true,null,undefined,' 40','40,50','1e3','4.001',0.1+0.2,'21474836.48'])assert.throws(()=>pesosTiendanubeACentavos(v));
});
test('precios pactados conservados y descuento no se aplica dos veces',()=>{
  const options={storeId:'101',orderId:'40',condicionPrecio:'contado',fechaEntrega:'2026-11-09'};
  const local=validarPedidoEntregaTiendanube(remote(),options);
  assert.equal(local.total_centavos,4000000);assert.equal(local.descuento_origen,'local');
  const applied=validarPedidoEntregaTiendanube(remote({discount:'2500.00',discount_gateway:'2500.00',total:'40000.00'}),options);
  assert.equal(applied.total_centavos,4000000);assert.equal(applied.descuento_origen,'remoto');
  assert.equal(applied.lineas[0].precio_publicado_centavos,4250000);
  assert.equal(applied.lineas[0].precio_unitario_centavos,4000000);
  assert.throws(()=>validarPedidoEntregaTiendanube(remote({discount:'2500.00',discount_gateway:'0.00',total:'40000.00'}),options),{code:'DESCUENTO_O_TOTAL_REMOTO_REQUIERE_CONCILIACION'});
  for(const patch of [{currency:'USD'},{total:'45000.00'},{shipping_cost_customer:'500.00'},{payment_status:'refunded'},
    {gateway:'mercadopago',payment_status:'paid'},{coupon:[{}]},
    {promotional_discount:{total_discount_amount:'500.00'}}])assert.throws(()=>validarPedidoEntregaTiendanube(remote(patch),options));
});
test('servicio deshabilitado por defecto sin abrir DB ni pedir orden',async()=>{
  const service=crearServicioEntregasTiendanube({enabled:false,database:{transaction(){assert.fail('no DB');}},apiFactory(){assert.fail('no API');}});
  await assert.rejects(service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'ENTREGAS_TIENDANUBE_DESHABILITADAS'});
});

test('PostgreSQL real: entrega sin dinero adopta reserva una vez, crea una deuda y comisión inmediata',async()=>{
  const f=await fixture();
  try{
    f.remote=remote({payment_status:'paid',paid_at:'2026-11-09T13:00:00Z',contact_name:'EXTERNAL_CANARY',contact_email:'EXTERNAL_CANARY',extra:{secret:'EXTERNAL_CANARY'}});
    const b=defaultBody(),r=await f.service.confirmarEntregaTiendanube('n1','40',b,'emp');
    assert.equal(r.saldo_inicial_centavos,total);assert.equal(r.stock_descontado_ahora,0);assert.equal(r.fecha_limite,'2026-12-09');
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
    assert.equal(await f.count('pagos'),0);assert.equal(await f.count('ventas'),1);assert.equal(await f.count('creditos'),1);
    const qs=await db.prepare('SELECT * FROM cuotas WHERE credito_id=?').all(r.credito_id);
    assert.equal(qs.length,1);assert.equal(qs[0].saldo_pendiente_centavos,total);
    const agreement=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(r.venta_id);
    assert.equal(agreement.usuario_id,'emp');assert.equal(Number(agreement.total_centavos),250000);assert.equal(agreement.momento,'venta');
    const events=await db.prepare("SELECT * FROM comision_eventos WHERE acuerdo_id=? AND tipo='devengo'").all(agreement.id);
    assert.equal(events.length,1);assert.equal(Number(events[0].importe_centavos),250000);assert.equal(events[0].fecha,'2026-11-09');
    const again=await f.service.confirmarEntregaTiendanube('n1','40',{...b,solicitud_id:randomUUID()},'emp');
    assert.equal(again.venta_id,r.venta_id);assert.equal(again.repetida,true);assert.equal(f.requests,1);
    assert.equal(await f.count('tiendanube_pedido_stock'),1);assert.equal(await f.count('tiendanube_stock_outbox'),0);
    assert.equal(await f.count('producto_historial'),1);
    assert.doesNotMatch(JSON.stringify({r,queries:f.calls,link:await db.prepare('SELECT * FROM tiendanube_entregas').all()}),/EXTERNAL_CANARY/);
    assert.doesNotMatch(JSON.stringify(r),/costo|comision|contact|token/);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: entrega parcial usa dinero/fecha reales, un saldo y vendedor elegido por admin',async()=>{
  const f=await fixture();
  try{
    const r=await f.service.confirmarEntregaTiendanube('n1','40',defaultBody({entrega_inicial_centavos:1000000,medio_pago_entrega:'transferencia',
      fecha_hora_cobro:'2026-11-09T15:00:00Z',confirmar_cobro:true,cobro_ya_registrado:false,comision_usuario_id:'emp',fecha_limite:'2026-12-15'}),'admin');
    const p=await db.prepare('SELECT * FROM pagos WHERE id=?').get(r.pago_inicial_id);
    assert.equal(p.monto_centavos,1000000);assert.equal(p.fecha_hora,'2026-11-09T12:00:00.000-03:00');assert.equal(p.medio_pago,'transferencia');
    assert.equal(r.saldo_inicial_centavos,3250000);assert.equal(r.fecha_limite,'2026-12-15');
    assert.equal(await f.count('pagos'),1);assert.equal(await f.count('cuotas'),1);
    const v=await db.prepare('SELECT * FROM ventas WHERE id=?').get(r.venta_id);
    assert.equal(v.usuario_id,'admin');assert.equal(v.vendedor_id,'emp');
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: contado conserva precio original, descuenta $2500, sin deuda ni segundo cobro',async()=>{
  const f=await fixture();
  try{
    f.remote=remote({discount:'2500.00',discount_gateway:'2500.00',total:'40000.00'});
    // Current catalog prices are deliberately different: agreed order wins.
    await db.exec("UPDATE productos SET precio_contado_centavos=6000000,precio_financiado_centavos=6250000 WHERE id='p1'");
    const b=defaultBody({condicion_precio:'contado',total_esperado_centavos:4000000,entrega_inicial_centavos:4000000,
      medio_pago_entrega:'efectivo',fecha_hora_cobro:'2026-11-09T14:00:00-03:00',confirmar_cobro:true,cobro_ya_registrado:false,cliente_id:null});
    const [r,again]=await Promise.all([f.service.confirmarEntregaTiendanube('n1','40',b,'emp'),f.service.confirmarEntregaTiendanube('n1','40',b,'emp')]);
    assert.equal(r.venta_id,again.venta_id);assert.equal(await f.count('pagos'),1);assert.equal(await f.count('cuotas'),0);
    assert.equal(r.saldo_inicial_centavos,0);
    const snap=await db.prepare('SELECT * FROM tiendanube_entrega_items').get();
    assert.equal(snap.precio_publicado_centavos,4250000);assert.equal(snap.descuento_unitario_centavos,250000);assert.equal(snap.precio_unitario_centavos,4000000);
    const persisted=await db.prepare('SELECT * FROM tiendanube_entregas').get();
    assert.equal(persisted.descuento_origen,'remoto');assert.equal(Object.hasOwn(persisted,'order_id'),false);
    assert.equal((await db.prepare('SELECT precio_unitario_centavos FROM venta_detalle WHERE venta_id=?').get(r.venta_id)).precio_unitario_centavos,4000000);
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',{...b,condicion_precio:'30_dias'},'emp'),{code:'PEDIDO_YA_ENTREGADO_CON_OTROS_DATOS'});
  }finally{await f.pg.close();}
});

test('PostgreSQL real: permisos, organizaciones, cliente/vendedor y payload manipulado no producen venta',async()=>{
  const f=await fixture();
  try{
    for(const [actor,extra,code] of [
      ['other',{},'SIN_PERMISO_ENTREGA_EN_NEGOCIO'],['admin-b',{},'ADMINISTRADOR_DE_OTRA_ORGANIZACION'],
      ['admin',{comision_usuario_id:'admin-b'},'ADMINISTRADOR_DE_OTRA_ORGANIZACION'],
      ['emp',{comision_usuario_id:'admin'},'NO_PUEDE_ATRIBUIR_OTRO_VENDEDOR'],
      ['admin',{comision_usuario_id:'other'},'VENDEDOR_DE_OTRO_NEGOCIO'],
      ['emp',{cliente_id:'c2'},'CLIENTE_NO_VINCULADO_AL_NEGOCIO'],['emp',{skip_stock:true},'CAMPOS_ENTREGA_INVALIDOS']]){
      await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(extra),actor),{code});
    }
    await db.exec(`UPDATE usuario_negocio SET permisos='{"ventas.crear":true,"tienda.pedidos":true,"clientes.ver":true}' WHERE usuario_id='emp'`);
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody({entrega_inicial_centavos:10000,medio_pago_entrega:'efectivo',
      fecha_hora_cobro:'2026-11-09T14:00:00-03:00',confirmar_cobro:true,cobro_ya_registrado:false}),'emp'),{code:'SIN_PERMISO_REGISTRAR_COBRO'});
    assert.equal(await f.count('ventas'),0);assert.equal(await f.count('pagos'),0);assert.equal(f.requests,0);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: no inventa fecha de anticipos ni permite conciliar pasarela como efectivo manual',async()=>{
  const f=await fixture();
  try{
    const cash=defaultBody({entrega_inicial_centavos:1000000,medio_pago_entrega:'efectivo',fecha_hora_cobro:'2026-11-08T12:00:00-03:00',confirmar_cobro:true,cobro_ya_registrado:false});
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',cash,'emp'),{code:'ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION'});
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',{...cash,fecha_hora_cobro:'2026-11-09T14:00:00-03:00',cobro_ya_registrado:true},'emp'),{code:'COBRO_EXISTENTE_REQUIERE_CONCILIACION'});
    f.remote=remote({payment_status:'paid',gateway:'mercadopago',paid_at:'2026-11-09T14:00:00-03:00'});
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'COBRO_PASARELA_REQUIERE_CONCILIACION'});
    f.remote=remote({payment_status:'partially_paid',total_paid_by_customer:'10000.00'});
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'COBRO_REMOTO_CONTRADICTORIO_REQUIERE_CONCILIACION'});
    f.remote=remote({payment_status:'paid',paid_at:'2026-11-08T14:00:00-03:00'});
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION'});
    assert.equal(await f.count('ventas'),0);assert.equal(await f.count('pagos'),0);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: rollback integral por comisión/configuración o reserva inválida',async()=>{
  const f=await fixture();
  try{
    await db.exec("UPDATE comision_config SET momento='cobro' WHERE negocio_id='n1'");
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'COMISION_A_LA_ENTREGA_NO_CONFIGURADA'});
    assert.equal(await f.count('ventas'),0);assert.equal(await f.count('creditos'),0);assert.equal(await f.count('producto_historial'),0);
    await db.exec("UPDATE comision_config SET momento='venta' WHERE negocio_id='n1';UPDATE tiendanube_pedido_stock SET cantidad_aplicada=2");
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'RESERVA_NO_COINCIDE'});
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
    assert.equal(await f.count('tiendanube_entregas'),0);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: privacidad y eventos pendientes bloquean antes del GET, sin reimportar datos',async()=>{
  const f=await fixture();
  try{
    await db.exec(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload) VALUES('101','order/updated','40','fixture-event','{}')`);
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION'});
    assert.equal(f.requests,0);
    await db.exec("UPDATE tiendanube_eventos SET procesado_at=NOW(),sync_estado='procesado'");
    await db.prepare(`INSERT INTO tiendanube_privacidad_solicitudes(id,clave,contenido_hash,store_id,negocio_id,tipo,estado,reporte)
      VALUES('r1',?,?,?,'n1','customer-redact','completada','{}')`).run('a'.repeat(64),'b'.repeat(64),'101');
    await db.prepare('INSERT INTO tiendanube_privacidad_borrados(store_id,order_hash,solicitud_id) VALUES(?,?,?)').run('101',hashPedidoPrivacidad('101','40'),'r1');
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'PEDIDO_REDACTADO'});
    assert.equal(f.requests,0);assert.equal(await f.count('ventas'),0);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: reserva central pendiente impide entrega sin stock, venta, cobro ni comisión nuevos',async()=>{
  const f=await fixture();
  try{
    await f.db.exec("UPDATE tiendanube_conexiones SET sync_reserva_token='fixture-in-flight'");
    await assert.rejects(f.service.confirmarEntregaTiendanube('n1','40',defaultBody(),'emp'),{code:'SINCRONIZACION_NO_LISTA_PARA_ENTREGA'});
    assert.equal(f.requests,0);assert.equal(await f.count('ventas'),0);assert.equal(await f.count('creditos'),0);
    assert.equal(await f.count('pagos'),0);assert.equal(await f.count('comision_eventos'),0);assert.equal(await f.count('producto_historial'),0);
    assert.equal((await f.db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
  }finally{await f.pg.close();}
});

test('PostgreSQL real: campos skip_stock de HTTP no desvían la venta legacy',async()=>{
  const f=await fixture();
  try{
    const r=await crearVenta({negocio_id:'n1',cliente_id:'c1',fecha:'2026-11-09',modalidad:'unico',
      items:[{producto_id:'p1',cantidad:1,precio_unitario_centavos:total}],monto_total_centavos:total,
      entrega_inicial_centavos:0,usuario_id:'emp',comision_usuario_id:'emp',solicitud_id:randomUUID(),
      skip_stock:true,reservaInterna:{adoptar:'no-es-funcion'},reserva_tiendanube:true});
    assert.ok(r.venta.id);assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,4);
    assert.equal(await f.count('tiendanube_entregas'),0);
    await assert.rejects(crearVentaConReservaTiendanube({},{}),/Falta validar/);
  }finally{await f.pg.close();}
});
