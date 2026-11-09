import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PGlite} from '@electric-sql/pglite';
import {tiendanubeSchema} from '../src/db/tiendanubeSchema.js';
import {tiendanubePrivacidadSchema} from '../src/db/tiendanubePrivacidadSchema.js';
import {tiendanubeSyncSchema} from '../src/db/tiendanubeSyncSchema.js';
import {tiendanubeEntregasSchema} from '../src/db/tiendanubeEntregasSchema.js';
import {tiendanubeReservasSchema} from '../src/db/tiendanubeReservasSchema.js';
import {crearServicioPrivacidadTiendanube,hashPedidoPrivacidad} from '../src/services/tiendanubePrivacidadService.js';
import {crearGestionPrivacidadTiendanube} from '../src/services/tiendanubePrivacidadGestionService.js';

const fixed='2026-11-09T12:00:00.000Z';
const eventTs=Math.floor(new Date(fixed).valueOf()/1000);

async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const storage=new AsyncLocalStorage(),current=()=>storage.getStore()||pg;
  const db={
    async query(sql,params=[]){const r=await current().query(sql,params);return {...r,rowCount:r.affectedRows};},
    exec:sql=>current().exec(sql),
    transaction:fn=>storage.getStore()?fn():pg.transaction(tx=>storage.run(tx,fn)),
    prepare(sql){let i=0;const q=sql.replace(/\?/g,()=>`$${++i}`);return {
      get:async(...p)=>(await db.query(q,p)).rows[0],all:async(...p)=>(await db.query(q,p)).rows,
      run:async(...p)=>({changes:(await db.query(q,p)).rowCount}),
    };},
  };
  await db.exec(`CREATE TABLE negocios(id TEXT PRIMARY KEY,organizacion_id TEXT);
    CREATE TABLE usuarios(id TEXT PRIMARY KEY,rol TEXT,activo INTEGER);
    CREATE TABLE usuario_organizacion(organizacion_id TEXT,usuario_id TEXT,rol TEXT,activo INTEGER,PRIMARY KEY(organizacion_id,usuario_id));
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT,stock INTEGER);
    CREATE TABLE ventas(id TEXT PRIMARY KEY,total INTEGER);
    CREATE TABLE creditos(id TEXT PRIMARY KEY,saldo INTEGER);
    CREATE TABLE pagos(id TEXT PRIMARY KEY,monto INTEGER);
    CREATE TABLE clientes(id TEXT PRIMARY KEY,nombre TEXT);
    CREATE TABLE comisiones(id TEXT PRIMARY KEY,monto INTEGER);
    CREATE TABLE configuracion_web(negocio_id TEXT,publicada BOOLEAN);
    INSERT INTO negocios VALUES('n1','org1'),('n2','org2');
    INSERT INTO usuarios VALUES('admin1','administrador',1),('admin2','administrador',1),('foreign','administrador',1),('seller','empleado',1),('inactive','administrador',0);
    INSERT INTO usuario_organizacion VALUES('org1','admin1','administrador',1),('org1','admin2','administrador',1),('org2','foreign','administrador',1),('org1','seller','empleado',1),('org1','inactive','administrador',1);
    INSERT INTO productos VALUES('p1','n1',3),('p2','n2',9);
    INSERT INTO ventas VALUES('sale1',4250000);INSERT INTO creditos VALUES('credit1',4250000);
    INSERT INTO clientes VALUES('client1','No modificar');INSERT INTO comisiones VALUES('commission1',250000);
    INSERT INTO configuracion_web VALUES('n1',TRUE);
    INSERT INTO pagos VALUES('payment1',1000000);`);
  for(const s of [tiendanubeSchema,tiendanubePrivacidadSchema,tiendanubeSyncSchema,tiendanubeEntregasSchema,tiendanubeReservasSchema])await db.exec(s);
  await db.exec(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,creada_at,actualizada_at)
    VALUES('n1','101','51162','credential-fixture-a','write_products,read_orders','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z'),
      ('n2','202','51162','credential-fixture-b','write_products,read_orders','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
    INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id) VALUES('p1','n1','101','10','11'),('p2','n2','202','20','21');
    INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado,estado) VALUES('p1','n1',3,'sincronizado'),('p2','n2',9,'sincronizado');
    INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,procesado_at,sync_estado)
      VALUES('101','product/updated','10','fixture-a','{}',NOW(),'procesado'),('202','product/updated','20','fixture-b','{}',NOW(),'procesado');
    INSERT INTO tiendanube_pedidos(negocio_id,store_id,order_id,estado,cantidades,pagado,cancelado,pendiente_revision)
      VALUES('n1','101','100','closed','{"11":1}',FALSE,FALSE,FALSE),('n2','202','200','open','{"21":1}',FALSE,FALSE,FALSE);`);
  const orderHash=hashPedidoPrivacidad('101','100');
  await db.prepare(`INSERT INTO tiendanube_entregas(store_id,order_hash,negocio_id,venta_id,credito_id,
    confirmado_por,vendedor_id,solicitud_id,solicitud_hash,condicion_precio,fecha_entrega,fecha_limite,
    precio_publicado_centavos,descuento_centavos,descuento_origen,total_centavos,entrega_inicial_centavos)
    VALUES('101',?,'n1','sale1','credit1','admin1','admin1','delivery1',?,'30_dias','2026-11-01','2026-12-01',4250000,0,'ninguno',4250000,0)`)
    .run(orderHash,'d'.repeat(64));
  await db.prepare(`INSERT INTO tiendanube_entrega_items(store_id,order_hash,posicion,producto_id,variant_id,cantidad,precio_publicado_centavos,descuento_unitario_centavos,precio_unitario_centavos)
    VALUES('101',?,0,'p1','11',1,4250000,0,4250000)`).run(orderHash);
  await db.prepare(`INSERT INTO tiendanube_pedido_stock(store_id,order_hash,variant_id,producto_id,cantidad_aplicada) VALUES('101',?,'11','p1',1)`).run(orderHash);
  const calls=[],clock={value:new Date(fixed).valueOf()},provider={status:401,callback:null};
  const gestor=crearGestionPrivacidadTiendanube({database:db,now:()=>new Date(clock.value),apiFactory:con=>async(method,path)=>{
    calls.push({method,path,store:con.store_id});assert.equal(method,'GET');assert.equal(path,'/store');
    if(provider.callback)await provider.callback();
    if(provider.status===200)return {id:con.store_id};
    throw Object.assign(new Error('DO-NOT-EXPOSE-provider-details'),{status:provider.status});
  }});
  const webhook=crearServicioPrivacidadTiendanube({database:db});
  return {pg,db,gestor,webhook,calls,clock,provider,
    request:()=>webhook.procesar('store-redact',{store_id:'101',event_launch_ts:eventTs}),
    report:()=>webhook.procesar('customer-data-request',{store_id:'101',data_request:{id:7},orders_requested:['100']}),
    close:()=>pg.close()};
}
const bodyFor=preview=>({confirmacion_token:preview.confirmacion_token,confirmar_borrado:true,frase:preview.frase_requerida});
const receiptFor=exported=>({exportacion_id:exported.exportacion_id,informe_hash:exported.informe_hash,canal:'recepcion_administrador',confirmar_entrega:true});
async function comerciales(f){
  const result={};for(const t of ['productos','ventas','creditos','pagos','clientes','comisiones','configuracion_web','tiendanube_entregas','tiendanube_entrega_items','tiendanube_pedido_stock'])result[t]=(await f.db.query(`SELECT * FROM ${t} ORDER BY 1,2`)).rows;
  return result;
}

test('privacidad gestión: solo administrador activo de la organización, sin consultas remotas para actores ajenos',async()=>{
  const f=await fixture();try{
    const req=await f.request();
    for(const actor of ['foreign','seller','inactive']){
      await assert.rejects(()=>f.gestor.listar('n1',actor),{status:403});
      await assert.rejects(()=>f.gestor.detalle('n1',req.id,actor),{status:403});
      await assert.rejects(()=>f.gestor.previewBorrado('n1',req.id,actor),{status:403});
    }
    assert.equal(f.calls.length,0);
    await assert.rejects(()=>f.gestor.detalle('n2',req.id,'foreign'),{status:404});
    const own=await f.gestor.listar('n1','admin1');assert.equal(own.solicitudes[0].id,req.id);
    assert.doesNotMatch(JSON.stringify(own),/credential-fixture|token_cifrado|instalacion_huella/);
  }finally{await f.close();}
});

test('exportar no equivale entregar; declaración explícita, huella ligada a exportación/actor e idempotencia',async()=>{
  const f=await fixture();try{
    const req=await f.report(),before=await comerciales(f);
    const exported=await f.gestor.exportar('n1',req.id,'admin1');
    assert.equal(exported.estado,'pendiente_entrega');assert.equal(exported.enviado_por_sistema,false);
    assert.equal(exported.informe.pedidos[0].order_id,'100');
    assert.equal((await f.gestor.detalle('n1',req.id,'admin1')).solicitud.estado,'pendiente_entrega');
    assert.equal((await f.db.query('SELECT * FROM tiendanube_privacidad_entregas')).rows.length,0);
    await assert.rejects(()=>f.gestor.confirmarEntrega('n1',req.id,'admin1',{...receiptFor(exported),confirmar_entrega:false}),{status:400});
    await assert.rejects(()=>f.gestor.confirmarEntrega('n1',req.id,'admin2',receiptFor(exported)),{code:'PRIVACIDAD_INFORME_CAMBIO'});
    const receipt=await f.gestor.confirmarEntrega('n1',req.id,'admin1',receiptFor(exported));
    assert.equal(receipt.estado,'completada');assert.equal(receipt.entrega.enviado_por_sistema,false);assert.equal(receipt.entrega.verificacion_externa,false);
    assert.equal((await f.gestor.confirmarEntrega('n1',req.id,'admin1',receiptFor(exported))).duplicada,true);
    assert.equal((await f.db.query('SELECT * FROM tiendanube_privacidad_entregas')).rows.length,1);
    assert.deepEqual(await comerciales(f),before);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('un informe redactado después de exportar exige una nueva exportación, no constancia engañosa',async()=>{
  const f=await fixture();try{
    const req=await f.report(),exported=await f.gestor.exportar('n1',req.id,'admin1');
    await f.webhook.procesar('customer-redact',{store_id:'101',orders_to_redact:['100']});
    await assert.rejects(()=>f.gestor.confirmarEntrega('n1',req.id,'admin1',receiptFor(exported)),{code:'PRIVACIDAD_INFORME_CAMBIO'});
    assert.equal((await f.gestor.detalle('n1',req.id,'admin1')).solicitud.estado,'pendiente_entrega');
    const next=await f.gestor.exportar('n1',req.id,'admin1');assert.notEqual(next.informe_hash,exported.informe_hash);assert.equal(next.informe.pedidos.length,0);
    assert.equal((await f.gestor.confirmarEntrega('n1',req.id,'admin1',receiptFor(next))).estado,'completada');
  }finally{await f.close();}
});

test('preview solo informa y comprueba revocación; no altera inventario ni borra conexión',async()=>{
  const f=await fixture();try{
    const req=await f.request(),before=await comerciales(f);
    const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');
    assert.deepEqual(preview.bloqueos,[]);assert.equal(preview.puede_confirmar,true);assert.equal(preview.revocacion_verificada,true);
    assert.match(preview.confirmacion_token,/^[a-f0-9]{64}$/);assert.equal(preview.eliminar.vinculos,1);assert.equal(preview.conservar.entregas_comerciales,1);
    assert.equal((await f.db.query('SELECT * FROM tiendanube_conexiones')).rows.length,2);
    assert.equal((await f.gestor.detalle('n1',req.id,'admin1')).solicitud.estado,'pendiente_revision');
    assert.deepEqual(await comerciales(f),before);assert.deepEqual(f.calls,[{method:'GET',path:'/store',store:'101'}]);
    assert.doesNotMatch(JSON.stringify(preview),/credential-fixture|token_cifrado|snapshot_hash|instalacion_huella/);
  }finally{await f.close();}
});

test('confirmación elimina solo datos operativos de la instalación exacta, conserva comercio y deja epoch/auditoría',async()=>{
  const f=await fixture();try{
    const report=await f.report(),exported=await f.gestor.exportar('n1',report.id,'admin1');
    await f.gestor.confirmarEntrega('n1',report.id,'admin1',receiptFor(exported));
    await f.db.exec("INSERT INTO tiendanube_oauth_estados(state_hash,negocio_id,usuario_id,vence_at) VALUES('state-fixture','n1','admin1',NOW()+INTERVAL '1 day')");
    const req=await f.request(),before=await comerciales(f);
    const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');
    const result=await f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview));
    assert.equal(result.estado,'completada');assert.equal(result.datos_locales_zilky_modificados,false);assert.equal(result.obligaciones_externas_verificadas,false);
    assert.deepEqual(await comerciales(f),before);
    for(const t of ['tiendanube_conexiones','tiendanube_variantes','tiendanube_eventos','tiendanube_pedidos']){
      const rows=(await f.db.query(`SELECT store_id FROM ${t}`)).rows;assert.deepEqual(rows.map(r=>r.store_id),['202']);
    }
    assert.deepEqual((await f.db.query('SELECT negocio_id FROM tiendanube_stock_outbox')).rows,[{negocio_id:'n2'}]);
    assert.equal((await f.db.query('SELECT * FROM tiendanube_oauth_estados')).rows.length,0);
    assert.equal(Number((await f.db.query("SELECT epoca FROM tiendanube_privacidad_epocas WHERE negocio_id='n1'")).rows[0].epoca),1);
    const saved=(await f.db.query('SELECT * FROM tiendanube_privacidad_confirmaciones')).rows[0];assert.ok(saved.consumida_at);
    assert.equal(saved.resultado.actor_id,'admin1');assert.doesNotMatch(JSON.stringify(saved.resultado),/credential-fixture/);
    assert.equal((await f.db.prepare('SELECT reporte FROM tiendanube_privacidad_solicitudes WHERE id=?').get(report.id)).reporte.pedidos.length,0);
    await assert.rejects(()=>f.gestor.exportar('n1',report.id,'admin1'),{code:'PRIVACIDAD_INFORME_YA_REDACTADO'});
    assert.equal((await f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview))).duplicada,true);
    assert.equal(f.calls.length,2);
  }finally{await f.close();}
});

test('nuevo OAuth o reinstalación no es borrable; replay posterior no toca la conexión nueva',async()=>{
  const f=await fixture();try{
    const req=await f.request(),preview=await f.gestor.previewBorrado('n1',req.id,'admin1');
    await f.db.exec("UPDATE tiendanube_conexiones SET token_cifrado='new-credential-fixture',creada_at='2026-11-09T12:00:01Z' WHERE negocio_id='n1'");
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{code:'PRIVACIDAD_INSTALACION_DISTINTA'});
    const blocked=await f.gestor.previewBorrado('n1',req.id,'admin1');assert.equal(blocked.puede_confirmar,false);assert.equal(blocked.confirmacion_token,undefined);
    assert.equal(f.calls.length,1);
    await f.db.exec("UPDATE tiendanube_conexiones SET token_cifrado='credential-fixture-a',creada_at='2026-11-01T00:00:00Z' WHERE negocio_id='n1'");
    const fresh=await f.gestor.previewBorrado('n1',req.id,'admin1');
    await f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(fresh));
    await f.db.exec("INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes) VALUES('n1','101','51162','reinstalled-fixture','write_products,read_orders')");
    const repeated=await f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(fresh));assert.equal(repeated.duplicada,true);
    assert.equal((await f.db.prepare('SELECT token_cifrado FROM tiendanube_conexiones WHERE negocio_id=?').get('n1')).token_cifrado,'reinstalled-fixture');
  }finally{await f.close();}
});

test('preview tiene actor, frase, vencimiento y snapshot; cualquier cambio exige revisar de nuevo',async()=>{
  const f=await fixture();try{
    const req=await f.request(),preview=await f.gestor.previewBorrado('n1',req.id,'admin1');
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin2',bodyFor(preview)),{code:'PRIVACIDAD_PREVIEW_REQUERIDO'});
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',{...bodyFor(preview),frase:'BORRAR TODO'}),{status:400});
    f.clock.value+=600001;
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{code:'PRIVACIDAD_PREVIEW_VENCIDO'});
    f.clock.value=new Date(fixed).valueOf();
    // Igual cantidad de filas, cambia un dato: no basta revisar conteos.
    await f.db.exec("UPDATE tiendanube_eventos SET recurso_id='12' WHERE store_id='101'");
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{code:'PRIVACIDAD_PREVIEW_CAMBIO'});
    assert.equal((await f.db.query("SELECT * FROM tiendanube_conexiones WHERE negocio_id='n1'")).rows.length,1);
    assert.equal((await f.db.query('SELECT * FROM tiendanube_privacidad_epocas')).rows.length,0);
  }finally{await f.close();}
});

test('solo 401 verifica revocación; 200/403/timeout no autorizan borrar y se comprueba de nuevo al confirmar',async()=>{
  const f=await fixture();try{
    const req=await f.request();
    for(const status of [200,403,500,undefined]){
      f.provider.status=status;
      const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');assert.equal(preview.puede_confirmar,false);assert.equal(preview.confirmacion_token,undefined);
      assert.ok(preview.bloqueos.includes(status===200?'PRIVACIDAD_CREDENCIAL_VIGENTE':'PRIVACIDAD_REVOCACION_NO_VERIFICADA'));
    }
    f.provider.status=401;const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');f.provider.status=200;
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{code:'PRIVACIDAD_CREDENCIAL_VIGENTE'});
    assert.equal((await f.db.query('SELECT * FROM tiendanube_conexiones')).rows.length,2);
  }finally{await f.close();}
});

test('legacy sin huella, evento anterior y app ajena no permiten eliminar la instalación',async()=>{
  const f=await fixture();try{
    const req=await f.request();
    for(const [sql,code] of [
      ["UPDATE tiendanube_privacidad_solicitudes SET instalacion_huella=NULL",'PRIVACIDAD_INSTALACION_SIN_EVIDENCIA'],
      ["UPDATE tiendanube_privacidad_solicitudes SET evento_fecha='2026-10-01T00:00:00Z'",'PRIVACIDAD_EVENTO_ANTERIOR'],
      ["UPDATE tiendanube_privacidad_solicitudes SET reporte=reporte||'{\"app_id_evento\":\"999\"}'::jsonb",'PRIVACIDAD_APP_DISTINTA'],
    ]){
      await f.db.exec(sql);const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');assert.ok(preview.bloqueos.includes(code));assert.equal(preview.puede_confirmar,false);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('efectos comerciales pendientes, leases y reservas bloquean incluso si son antiguos',async()=>{
  const cases=[
    ["UPDATE tiendanube_conexiones SET pausada=FALSE WHERE negocio_id='n1'",'PRIVACIDAD_REQUIERE_PAUSA'],
    ["UPDATE tiendanube_conexiones SET sync_lease_token='lease-fixture',sync_lease_hasta='2000-01-01' WHERE negocio_id='n1'",'PRIVACIDAD_OPERACION_EN_CURSO'],
    ["UPDATE tiendanube_conexiones SET sync_reserva_token='reserva-fixture',sync_reserva_iniciada_at='2000-01-01' WHERE negocio_id='n1'",'PRIVACIDAD_OPERACION_EN_CURSO'],
    ["UPDATE tiendanube_stock_outbox SET estado='revision_manual' WHERE negocio_id='n1'",'PRIVACIDAD_STOCK_PENDIENTE'],
    ["UPDATE tiendanube_eventos SET procesado_at=NULL,sync_estado='pendiente' WHERE store_id='101'",'PRIVACIDAD_NOTIFICACIONES_PENDIENTES'],
    ["UPDATE tiendanube_pedidos SET pendiente_revision=TRUE WHERE store_id='101'",'PRIVACIDAD_PEDIDOS_REVISION'],
    [`INSERT INTO tiendanube_pedido_stock(store_id,order_hash,variant_id,producto_id,cantidad_aplicada) VALUES('101','${'a'.repeat(64)}','11','p1',1)`,'PRIVACIDAD_RESERVAS_SIN_ENTREGA'],
    [`INSERT INTO tiendanube_reserva_intentos(id,negocio_id,usuario_id,solicitud_id,solicitud_hash,store_id,instalacion_hash,estado,items,total_centavos) VALUES('r1','n1','admin1','r1','fixture','101','fixture','revision_manual','[]',1)`,'PRIVACIDAD_RESERVAS_PENDIENTES'],
  ];
  const f=await fixture();try{
    const req=await f.request();
    for(const [sql,code] of cases){
      await f.db.transaction(async()=>{
        await f.db.exec('SAVEPOINT blocked_case');
        await f.db.exec(sql);
        const preview=await f.gestor.previewBorrado('n1',req.id,'admin1');assert.ok(preview.bloqueos.includes(code),code);assert.equal(preview.puede_confirmar,false);
        await f.db.exec('ROLLBACK TO SAVEPOINT blocked_case');
      });
    }
    const report=await f.report();const blocked=await f.gestor.previewBorrado('n1',req.id,'admin1');assert.ok(blocked.bloqueos.includes('PRIVACIDAD_INFORMES_PENDIENTES'));
    assert.equal((await f.gestor.detalle('n1',report.id,'admin1')).solicitud.estado,'pendiente_entrega');
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('cambio durante verificación remota o pérdida de membresía revierte toda la eliminación',async()=>{
  const f=await fixture();try{
    const req=await f.request(),preview=await f.gestor.previewBorrado('n1',req.id,'admin1');
    f.provider.callback=()=>f.db.exec("UPDATE usuario_organizacion SET activo=0 WHERE usuario_id='admin1'");
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{status:403});
    assert.equal((await f.db.query('SELECT * FROM tiendanube_conexiones')).rows.length,2);
    // The transaction rollback restores the simulated permission change too.
    f.provider.callback=()=>f.db.exec("UPDATE tiendanube_eventos SET recurso_id='14' WHERE store_id='101'");
    await assert.rejects(()=>f.gestor.confirmarBorrado('n1',req.id,'admin1',bodyFor(preview)),{code:'PRIVACIDAD_PREVIEW_CAMBIO'});
    assert.equal((await f.db.query('SELECT * FROM tiendanube_privacidad_epocas')).rows.length,0);
  }finally{await f.close();}
});

test('migraciones aditivas son repetibles y no fabrican huellas para solicitudes antiguas',async()=>{
  const f=await fixture();try{
    await f.db.exec(`INSERT INTO tiendanube_privacidad_solicitudes(id,clave,contenido_hash,store_id,negocio_id,tipo,estado)
      VALUES('legacy','legacy','legacy','101','n1','store-redact','pendiente_revision')`);
    await f.db.exec(tiendanubePrivacidadSchema);await f.db.exec(tiendanubePrivacidadSchema);
    const row=await f.db.prepare('SELECT instalacion_huella,instalacion_creada_at FROM tiendanube_privacidad_solicitudes WHERE id=?').get('legacy');
    assert.deepEqual(row,{instalacion_huella:null,instalacion_creada_at:null});
  }finally{await f.close();}
});

test('listado prioriza pendientes aunque existan más de cien solicitudes completas más recientes',async()=>{
  const f=await fixture();try{
    const pending=await f.request();
    await f.db.exec(`INSERT INTO tiendanube_privacidad_solicitudes(id,clave,contenido_hash,store_id,negocio_id,tipo,estado,creada_at)
      SELECT 'complete-'||i,'complete-'||i,'fixture','101','n1','customer-redact','completada','2099-01-01T00:00:00Z'
      FROM generate_series(1,105) i`);
    const listed=await f.gestor.listar('n1','admin1');
    assert.equal(listed.solicitudes[0].id,pending.id);assert.equal(listed.solicitudes.length,100);assert.equal(listed.hay_mas,true);
  }finally{await f.close();}
});
