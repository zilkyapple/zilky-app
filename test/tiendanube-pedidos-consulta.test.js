import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { crearConsultasPedidosTiendanube } from '../src/services/tiendanubePedidosConsultaService.js';
import { hashPedidoPrivacidad } from '../src/services/tiendanubePrivacidadService.js';

const now=()=>new Date('2026-11-09T18:00:00Z');
const rawOrder=()=>({id:40,store_id:101,created_at:'2026-11-09T12:00:00Z',currency:'ARS',status:'open',payment_status:'pending',gateway:'offline',
  products:[{product_id:11,variant_id:111,quantity:1,price:'42500.00'}],subtotal:'42500.00',total:'42500.00',discount:'0.00',discount_gateway:'0.00',discount_coupon:'0.00',coupon:[],
  contact_name:'EXTERNAL_PRIVATE_CANARY',contact_email:'EXTERNAL_PRIVATE_CANARY',extra:{token:'EXTERNAL_PRIVATE_CANARY'}});

async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const als=new AsyncLocalStorage(),calls=[],current=()=>als.getStore()||pg;
  let revokeDuringRemote=null,revokedActor=null;
  const db={query:async(sql,params=[])=>{
    calls.push({sql,params});
    // Deterministically model the next READ COMMITTED membership read seeing
    // an independent permission revocation while the provider GET was pending.
    if(revokedActor&&/FROM usuario_(?:negocio|organizacion)\b/.test(sql)&&params.includes(revokedActor))return {rows:[]};
    return current().query(sql,params);
  },
    transaction:fn=>als.getStore()?fn():pg.transaction(tx=>als.run(tx,fn)),prepare(sql){
      let i=0;const converted=sql.replace(/\?/g,()=>'$'+(++i));
      return {get:async(...params)=>(await db.query(converted,params)).rows[0],all:async(...params)=>(await db.query(converted,params)).rows};
    }};
  await pg.exec(`
    CREATE TABLE negocios(id TEXT PRIMARY KEY,organizacion_id TEXT);
    CREATE TABLE usuarios(id TEXT PRIMARY KEY,nombre TEXT,rol TEXT,activo INT);
    CREATE TABLE usuario_organizacion(usuario_id TEXT,organizacion_id TEXT,rol TEXT,activo INT);
    CREATE TABLE usuario_negocio(usuario_id TEXT,negocio_id TEXT,permisos JSONB,activo INT);
    CREATE TABLE clientes(id TEXT PRIMARY KEY,nombre TEXT,apellido TEXT,consumidor_final_negocio TEXT);
    CREATE TABLE cliente_negocio(cliente_id TEXT,negocio_id TEXT);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT,nombre TEXT,variante TEXT,costo_centavos INT);
    CREATE TABLE tiendanube_conexiones(negocio_id TEXT PRIMARY KEY,store_id TEXT,token_cifrado TEXT,pausada BOOLEAN,
      sync_baseline_at TIMESTAMPTZ,sync_activada_at TIMESTAMPTZ,sync_webhooks_at TIMESTAMPTZ,sync_lease_token TEXT,sync_reserva_token TEXT);
    CREATE TABLE tiendanube_pedidos(negocio_id TEXT,store_id TEXT,order_id TEXT,estado TEXT,cantidades JSONB,pagado BOOLEAN,cancelado BOOLEAN,pendiente_revision BOOLEAN,actualizado_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tiendanube_entregas(negocio_id TEXT,store_id TEXT,order_hash TEXT,venta_id TEXT,credito_id TEXT,
      condicion_precio TEXT,fecha_entrega TEXT,fecha_limite TEXT,total_centavos INT,entrega_inicial_centavos INT);
    CREATE TABLE tiendanube_privacidad_borrados(store_id TEXT,order_hash TEXT);
    CREATE TABLE tiendanube_eventos(id INT,store_id TEXT,recurso_id TEXT,topic TEXT,procesado_at TIMESTAMPTZ,sync_estado TEXT);
    CREATE TABLE tiendanube_variantes(negocio_id TEXT,store_id TEXT,variant_id TEXT,product_id TEXT,producto_id TEXT);
    CREATE TABLE tiendanube_pedido_stock(store_id TEXT,order_hash TEXT,variant_id TEXT,producto_id TEXT,cantidad_aplicada INT);
    INSERT INTO negocios VALUES('n1','org1'),('n2','org2');
    INSERT INTO usuarios VALUES('admin','Admin','administrador',1),('admin2','Ajeno','administrador',1),('emp','Lucas','empleado',1),('other','Otro','empleado',1);
    INSERT INTO usuario_organizacion VALUES('admin','org1','administrador',1),('admin2','org2','administrador',1);
    INSERT INTO usuario_negocio VALUES('emp','n1','{"ventas.crear":true,"tienda.pedidos":true,"clientes.ver":true,"pagos.registrar":true}',1),('other','n2','{"ventas.crear":true,"tienda.pedidos":true,"clientes.ver":true,"pagos.registrar":true}',1);
    INSERT INTO clientes VALUES('c1','Ana','Local',NULL),('c2','Ajeno','Privado',NULL),('cf','Consumidor','Final','n1');
    INSERT INTO cliente_negocio VALUES('c1','n1'),('c2','n2'),('cf','n1');
    INSERT INTO productos VALUES('p1','n1','Remera Street','Único · Azul',2000000);
    INSERT INTO tiendanube_conexiones VALUES('n1','101','SECRET_CANARY',FALSE,'2026-11-09T10:00:00Z','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z',NULL,NULL);
    INSERT INTO tiendanube_pedidos(negocio_id,store_id,order_id,estado,cantidades,pagado,cancelado,pendiente_revision) VALUES('n1','101','40','open','{"111":1}',FALSE,FALSE,FALSE);
    INSERT INTO tiendanube_variantes VALUES('n1','101','111','11','p1');
  `);
  const hash=hashPedidoPrivacidad('101','40');
  await pg.query('INSERT INTO tiendanube_pedido_stock VALUES($1,$2,$3,$4,$5)',['101',hash,'111','p1',1]);
  let raw=rawOrder(),requests=0;
  const service=crearConsultasPedidosTiendanube({database:db,enabled:true,now,apiFactory:()=>async(method,path)=>{
    requests++;assert.equal(method,'GET');assert.equal(path,'/orders/40');revokedActor=revokeDuringRemote;return structuredClone(raw);
  }});
  calls.length=0;
  return {pg,db,service,calls,hash,get requests(){return requests;},set raw(v){raw=v;},set revokeDuringRemote(v){revokeDuringRemote=v;}};
}

test('consulta deshabilitada no abre DB ni solicita orden remota',async()=>{
  const service=crearConsultasPedidosTiendanube({database:{transaction(){assert.fail('no DB');}},enabled:false});
  await assert.rejects(service.listar('n1','emp'),{code:'ENTREGAS_TIENDANUBE_DESHABILITADAS',status:409});
});
test('consulta aplica membresía del negocio incluso para administrador y vendedor operativo',async()=>{
  const f=await fixture();try{
    for(const actor of ['admin2','other','missing'])await assert.rejects(f.service.listar('n1',actor),{status:403});
    await f.pg.exec(`UPDATE usuario_negocio SET permisos='{"tienda.pedidos":true}' WHERE usuario_id='emp'`);
    await assert.rejects(f.service.detalle('n1','40','emp'),{status:403});
    assert.equal(f.requests,0);
  }finally{await f.pg.close();}
});
test('listado operativo y opciones no exponen montos globales, costos, vendedores ajenos ni clientes sin permiso',async()=>{
  const f=await fixture();try{
    const list=await f.service.listar('n1','emp'),opts=await f.service.opciones('n1','emp');
    assert.deepEqual(list.pedidos.map(p=>p.order_id),['40']);assert.equal(list.pedidos[0].estado,'pendiente');
    assert.deepEqual(opts.clientes.map(c=>c.id),['c1']);assert.deepEqual(opts.vendedores,[]);
    const admin=await f.service.opciones('n1','admin');assert.deepEqual(admin.vendedores.map(v=>v.id).sort(),['admin','emp']);
    await f.pg.exec(`UPDATE usuario_negocio SET permisos='{"ventas.crear":true,"tienda.pedidos":true}' WHERE usuario_id='emp'`);
    const restricted=await f.service.opciones('n1','emp');assert.deepEqual(restricted.clientes,[]);assert.equal(restricted.capacidades.puede_cobrar,false);
    assert.doesNotMatch(JSON.stringify({list,opts,admin,restricted}),/SECRET_CANARY|costo|comision|contact|Ajeno|Privado|total_centavos/);
    assert.equal(f.requests,0);
  }finally{await f.pg.close();}
});
test('preview toma precio histórico, descuento exacto por prenda y reserva sin escrituras ni PII',async()=>{
  const f=await fixture();try{
    const d=await f.service.detalle('n1','40','emp');
    assert.equal(d.estado,'pendiente');assert.equal(d.fecha_entrega,'2026-11-09');assert.equal(f.requests,1);
    assert.deepEqual(d.condiciones.map(m=>[m.condicion_precio,m.total_centavos]),[['30_dias',4250000],['contado',4000000]]);
    assert.equal(d.condiciones[0].lineas[0].nombre,'Remera Street');
    assert.doesNotMatch(JSON.stringify(d),/PRIVATE_CANARY|SECRET_CANARY|costo|comision|token|contact/);
    assert.equal(f.calls.some(c=>/^\s*(INSERT|UPDATE|DELETE|ALTER)/i.test(c.sql)),false);
  }finally{await f.pg.close();}
});
test('preview de contado con descuento remoto no duplica descuento y elimina modalidad incompatible',async()=>{
  const f=await fixture();try{
    f.raw={...rawOrder(),total:'40000.00',discount:'2500.00',discount_gateway:'2500.00'};
    const d=await f.service.detalle('n1','40','admin');
    assert.equal(d.condiciones.length,1);assert.equal(d.condiciones[0].total_centavos,4000000);assert.equal(d.condiciones[0].descuento_centavos,250000);
  }finally{await f.pg.close();}
});
test('pausa, reserva incompleta y eventos pendientes bloquean preview',async()=>{
  const f=await fixture();try{
    await f.pg.exec('UPDATE tiendanube_conexiones SET pausada=TRUE');
    await assert.rejects(f.service.detalle('n1','40','emp'),{code:'SINCRONIZACION_NO_LISTA_PARA_ENTREGA'});assert.equal(f.requests,0);
    await f.pg.exec("UPDATE tiendanube_conexiones SET pausada=FALSE;INSERT INTO tiendanube_eventos VALUES(1,'101','40','order/updated',NULL,'pendiente')");
    await assert.rejects(f.service.detalle('n1','40','emp'),{code:'EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION'});assert.equal(f.requests,0);
    await f.pg.exec("UPDATE tiendanube_eventos SET procesado_at=NOW(),sync_estado='procesado';UPDATE tiendanube_pedido_stock SET cantidad_aplicada=2");
    await assert.rejects(f.service.detalle('n1','40','emp'),{code:'RESERVA_NO_COINCIDE'});
  }finally{await f.pg.close();}
});
test('pedido redactado se omite y no vuelve a consultarse al proveedor',async()=>{
  const f=await fixture();try{
    await f.pg.query('INSERT INTO tiendanube_privacidad_borrados VALUES($1,$2)',['101',f.hash]);
    assert.deepEqual((await f.service.listar('n1','emp')).pedidos,[]);
    await assert.rejects(f.service.detalle('n1','40','emp'),{code:'PEDIDO_REDACTADO'});assert.equal(f.requests,0);
  }finally{await f.pg.close();}
});
test('reserva central en curso bloquea preview antes del proveedor y sin mutaciones',async()=>{
  const f=await fixture();try{
    await f.pg.exec("UPDATE tiendanube_conexiones SET sync_reserva_token='fixture-in-flight'");
    await assert.rejects(f.service.detalle('n1','40','emp'),{code:'SINCRONIZACION_NO_LISTA_PARA_ENTREGA'});
    assert.equal(f.requests,0);assert.equal(f.calls.some(c=>/^\s*(INSERT|UPDATE|DELETE|ALTER)/i.test(c.sql)),false);
  }finally{await f.pg.close();}
});
test('permisos revocados durante GET se revalidan antes de devolver detalle',async()=>{
  for(const actor of ['emp','admin']){
    const f=await fixture();try{
      f.revokeDuringRemote=actor;
      await assert.rejects(f.service.detalle('n1','40',actor),{status:403});
      assert.equal(f.requests,1);assert.equal(f.calls.some(c=>/^\s*(INSERT|UPDATE|DELETE|ALTER)/i.test(c.sql)),false);
    }finally{await f.pg.close();}
  }
});
test('entrega existente se lee sin API ni nueva venta aunque integración esté pausada',async()=>{
  const f=await fixture();try{
    await f.pg.query(`INSERT INTO tiendanube_entregas VALUES('n1','101',$1,'v1','cr1','30_dias','2026-11-09','2026-12-09',4250000,0)`,[f.hash]);
    await f.pg.exec('UPDATE tiendanube_conexiones SET pausada=TRUE');
    const list=await f.service.listar('n1','emp'),d=await f.service.detalle('n1','40','emp');
    assert.equal(list.pedidos[0].estado,'entregada');assert.equal(d.entrega.saldo_inicial_centavos,4250000);assert.equal(f.requests,0);
  }finally{await f.pg.close();}
});
test('pasarela, cargos y fecha de anticipo no se ofrecen como cobro manual',async()=>{
  const f=await fixture();try{
    for(const patch of [{gateway:'mercadopago',payment_status:'paid'},{shipping_cost_customer:'500.00'},{payment_status:'paid',paid_at:'2026-11-08T12:00:00Z'}]){
      f.raw={...rawOrder(),...patch};await assert.rejects(f.service.detalle('n1','40','emp'),{status:409});
    }
    assert.equal(f.calls.some(c=>/^\s*(INSERT|UPDATE|DELETE|ALTER)/i.test(c.sql)),false);
  }finally{await f.pg.close();}
});
