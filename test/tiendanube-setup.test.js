import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { crearServicioSetupTiendanube, destinoWebhookTiendanube, TIENDANUBE_WEBHOOKS_OPERATIVOS } from '../src/services/tiendanubeSetupService.js';

const url='https://zilky-prueba.invalid/api/tiendanube/webhook';
const hora='2026-11-09T12:00:00.000Z';
const complete=()=>TIENDANUBE_WEBHOOKS_OPERATIVOS.map((event,i)=>({id:i+1,event,url}));
async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  const storage=new AsyncLocalStorage();const current=()=>storage.getStore()||pg;
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
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT,stock INTEGER);
    INSERT INTO negocios VALUES('n1'),('n2');INSERT INTO usuarios VALUES('u1');
    INSERT INTO productos VALUES('p1','n1',5),('p2','n2',7);`);
  await db.exec(tiendanubeSchema);await db.exec(tiendanubeSyncSchema);await db.exec(tiendanubeSyncSchema);
  // Contrato del schema de reservas, probado por su suite independiente.
  await db.exec('ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_reserva_token TEXT');
  await db.exec(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes)
    VALUES('n1','101','51162','fixture-token-no-real','write_products,read_orders'),('n2','202','51162','token-otro-no-real','write_products,read_orders');`);
  const calls=[];let hooks=[];let intercept=null;
  const service=crearServicioSetupTiendanube({db,baseUrl:'https://zilky-prueba.invalid',now:()=>new Date(hora),uuid:()=> 'fixture-lease',
    apiFactory:con=>async(method,path,body)=>{
      calls.push({store:con.store_id,method,path,body});
      if(intercept){const value=await intercept(method,path,body);if(value!==undefined)return value;}
      if(method==='GET'){assert.equal(path,'/webhooks?page=1&per_page=100');return hooks.map(h=>({...h}));}
      assert.equal(method,'POST');assert.equal(path,'/webhooks');
      const row={id:hooks.length+1,...body};hooks.push(row);return {...row};
    }});
  return {db,pg,service,calls,get hooks(){return hooks;},set hooks(v){hooks=v;},set intercept(v){intercept=v;}};
}

test('destino de webhooks proviene solo del origen HTTPS configurado',()=>{
  assert.equal(destinoWebhookTiendanube('https://zilky-prueba.invalid/'),url);
  for(const base of [undefined,'http://example.com','https://user:pass@example.com','https://example.com/?token=secreto','https://example.com/path','https://localhost','https://www.tiendanube.com'])assert.throws(()=>destinoWebhookTiendanube(base));
});

test('configurar webhooks crea solo faltantes y no activa ni toca stock',async()=>{
  const f=await fixture();
  try{
    const before=await f.db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get('n2');
    const result=await f.service.configurar('n1');
    assert.equal(result.creados,TIENDANUBE_WEBHOOKS_OPERATIVOS.length);assert.equal(result.registrados,true);
    assert.equal(result.recepcion_firmada_confirmada,false);assert.equal(result.sincronizacion_activada,false);
    assert.equal(result.stock_actualizado,false);assert.equal(result.pausada,true);
    assert.doesNotMatch(JSON.stringify(result),/fixture-token|token_cifrado|lease/);
    assert.ok(f.calls.every(c=>c.store==='101'));assert.ok(f.calls.every(c=>c.method==='GET'||c.path==='/webhooks'));
    const con=await f.db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get('n1');
    assert.equal(con.pausada,true);assert.equal(con.sync_webhooks_at,null);assert.equal(con.sync_activada_at,null);assert.equal(con.sync_baseline_at,null);assert.equal(con.sync_lease_token,null);
    assert.equal((await f.db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,5);
    assert.deepEqual(await f.db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get('n2'),before);
  }finally{await f.pg.close();}
});

test('repetir registro es idempotente; verificar exige evidencia de recepción posterior',async()=>{
  const f=await fixture();
  try{
    const first=await f.service.configurar('n1');f.calls.length=0;
    const second=await f.service.configurar('n1');assert.equal(second.creados,0);
    assert.equal(second.registrados_at,first.registrados_at);assert.ok(f.calls.every(c=>c.method==='GET'));
    assert.equal((await f.service.verificar('n1')).recepcion_firmada_confirmada,false);
    // Evidencia que normalmente inserta el router SOLO tras validar el HMAC.
    await f.db.exec(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_ultimo_evento_at)
      VALUES('101','product/updated','11','falso-solo-fixture','{}','2026-11-09T12:01:00Z');`);
    assert.equal((await f.service.verificar('n1')).recepcion_firmada_confirmada,false,'Una fila interna con fecha reciente no prueba una firma');
    await f.db.exec("UPDATE tiendanube_eventos SET hmac_validada_at='2026-11-09T12:01:00Z' WHERE store_id='101'");
    const verified=await f.service.verificar('n1');assert.equal(verified.recepcion_firmada_confirmada,true);
    assert.equal(verified.recepcion_at,'2026-11-09T12:01:00.000Z');assert.equal(verified.pausada,true);
    const estado=await f.service.estado('n1');assert.equal(estado.registrados,true);assert.equal(estado.recepcion_firmada_confirmada,true);
    assert.equal((await f.db.prepare('SELECT sync_activada_at FROM tiendanube_conexiones WHERE negocio_id=?').get('n1')).sync_activada_at,null);
  }finally{await f.pg.close();}
});

test('URLs previas o duplicados se informan sin borrar, editar ni crear más',async()=>{
  const f=await fixture();
  try{
    f.hooks=[{id:1,event:'order/created',url:'https://otra.invalid/?token=NO-EXHIBIR'}];
    let result=await f.service.configurar('n1');assert.equal(result.registrados,false);assert.deepEqual(result.otras_urls,['order/created']);
    assert.ok(f.calls.every(c=>c.method==='GET'));assert.doesNotMatch(JSON.stringify(result),/NO-EXHIBIR|otra.invalid/);
    f.calls.length=0;f.hooks=[...complete(),{id:999,event:'order/created',url}];
    result=await f.service.configurar('n1');assert.equal(result.registrados,false);assert.deepEqual(result.duplicados,['order/created']);
    assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(result.recepcion_firmada_confirmada,false);
  }finally{await f.pg.close();}
});

test('POST incierto nunca se reintenta ciegamente ni se libera por un GET incompleto',async()=>{
  const f=await fixture();
  try{
    f.intercept=async(method)=>{if(method==='POST')throw new Error('fallo de red NO-PUBLICAR');};
    await assert.rejects(f.service.configurar('n1'),e=>e.code==='REGISTRO_WEBHOOK_AMBIGUO'&&!e.message.includes('NO-PUBLICAR'));
    assert.equal((await f.service.estado('n1')).error,'REGISTRO_WEBHOOK_AMBIGUO');
    f.intercept=null;f.calls.length=0;
    await assert.rejects(f.service.configurar('n1'),/resultado incierto/);assert.equal(f.calls.length,0);
    const incomplete=await f.service.verificar('n1');assert.equal(incomplete.registrados,false);
    assert.equal((await f.service.estado('n1')).error,'REGISTRO_WEBHOOK_AMBIGUO');
    await assert.rejects(f.service.configurar('n1'),/resultado incierto/);
    // Al confirmar la colección completa, una verificación de solo lectura sí
    // puede resolver el resultado incierto sin repetir el POST.
    f.hooks=complete();assert.equal((await f.service.verificar('n1')).registrados,true);
    assert.equal((await f.service.estado('n1')).error,null);
    assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{await f.pg.close();}
});

test('conexión activa, lease, scopes incompletos o admin revocado bloquean antes de API',async()=>{
  const f=await fixture();
  try{
    for(const update of ["pausada=FALSE","pausada=TRUE,sync_lease_token='ocupado'",
      "sync_lease_token=NULL,sync_reserva_token='reserva-incierta'","sync_reserva_token=NULL,scopes='read_orders'"]){
      await f.db.exec(`UPDATE tiendanube_conexiones SET ${update} WHERE negocio_id='n1'`);
      await assert.rejects(f.service.configurar('n1'));assert.equal(f.calls.length,0);
    }
    await f.db.exec("UPDATE tiendanube_conexiones SET scopes='write_products,read_orders' WHERE negocio_id='n1'");
    await assert.rejects(f.service.configurar('n1',{autorizar:async()=>{throw Object.assign(new Error('Revocado'),{status:404});}}),/Revocado/);
    assert.equal(f.calls.length,0);
  }finally{await f.pg.close();}
});

test('revocar administrador durante verificación no guarda readiness ni activa',async()=>{
  const f=await fixture();
  try{
    f.hooks=complete();let authorized=true;
    f.intercept=async()=>{authorized=false;};
    await assert.rejects(f.service.verificar('n1',{autorizar:async()=>{if(!authorized)throw Object.assign(new Error('Revocado'),{status:404});}}),/Revocado/);
    const con=await f.db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get('n1');
    assert.equal(con.setup_webhooks_registrados_at,null);assert.equal(con.sync_webhooks_at,null);assert.equal(con.pausada,true);assert.equal(con.sync_lease_token,null);
  }finally{await f.pg.close();}
});

test('revocar administrador durante la lista inicial impide crear suscripciones',async()=>{
  const f=await fixture();
  try{
    let authorized=true;f.intercept=async()=>{authorized=false;};
    await assert.rejects(f.service.configurar('n1',{autorizar:async()=>{if(!authorized)throw Object.assign(new Error('Revocado'),{status:404});}}),/Revocado/);
    assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.hooks.length,0);
    assert.equal((await f.service.estado('n1')).registrados,false);
  }finally{await f.pg.close();}
});

test('lista remota inválida no declara registrados ni expone mensajes externos',async()=>{
  const f=await fixture();
  try{
    f.intercept=async()=>({error:'NO-PUBLICAR-CONTENIDO-API'});
    await assert.rejects(f.service.verificar('n1'),e=>e.status===502&&!e.message.includes('NO-PUBLICAR'));
    const con=await f.db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=?').get('n1');
    assert.equal(con.setup_webhooks_registrados_at,null);assert.equal(con.sync_webhooks_at,null);assert.equal(con.sync_lease_token,null);
  }finally{await f.pg.close();}
});
