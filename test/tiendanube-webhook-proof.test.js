import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { tiendanubeSchema } from '../src/db/tiendanubeSchema.js';
import { tiendanubeSyncSchema } from '../src/db/tiendanubeSyncSchema.js';
import { tiendanubePrivacidadSchema } from '../src/db/tiendanubePrivacidadSchema.js';
import { crearServicioSetupTiendanube,TIENDANUBE_WEBHOOKS_OPERATIVOS } from '../src/services/tiendanubeSetupService.js';

// Unir el receptor HTTP real con PostgreSQL en memoria, nunca con la base ni
// la API del negocio. No heredar .env, credenciales ni URLs de producción.
process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.DATABASE_URL='postgresql://127.0.0.1:1/tiendanube_webhook_proof_dummy';
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.JWT_SECRET='jwt-fixture-proof-no-real';
process.env.TIENDANUBE_APP_SECRET='hmac-fixture-no-real';
process.env.TIENDANUBE_SYNC_ENABLED='false';
const {db,pool}=await import('../src/db/connection.js');
pool.connect=()=>{throw Error('Acceso a PostgreSQL externo bloqueado por prueba');};
pool.query=()=>{throw Error('Acceso a PostgreSQL externo bloqueado por prueba');};
const httpFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Acceso externo bloqueado por prueba');};
const {tiendanubePublicaRouter}=await import('../src/routes/tiendanube.js');

test('solo un webhook HTTP con HMAC válido aporta evidencia de recepción a setup',async()=>{
  const pg=new PGlite();await pg.waitReady;
  const storage=new AsyncLocalStorage();const current=()=>storage.getStore()||pg;
  db.query=async(sql,params=[])=>{const r=await current().query(sql,params);return {...r,rowCount:r.affectedRows};};
  db.exec=sql=>current().exec(sql);
  db.transaction=fn=>storage.getStore()?fn(storage.getStore()):pg.transaction(tx=>storage.run(tx,()=>fn(tx)));
  await db.exec(`CREATE TABLE negocios(id TEXT PRIMARY KEY);CREATE TABLE usuarios(id TEXT PRIMARY KEY);
    CREATE TABLE productos(id TEXT PRIMARY KEY,negocio_id TEXT,stock INTEGER);
    INSERT INTO negocios VALUES('n1');INSERT INTO productos VALUES('p1','n1',3);`);
  await db.exec(tiendanubeSchema);
  // Simular fila de una versión anterior. La migración no debe acreditar una
  // firma ni una fecha de recepción que nunca se comprobó.
  await db.exec(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload)
    VALUES('101','product/updated','11','legacy-fixture','{}');`);
  await db.exec(tiendanubeSyncSchema);await db.exec(tiendanubePrivacidadSchema);
  await db.exec(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes)
    VALUES('n1','101','51162','fixture-no-real','write_products,read_orders');`);
  const app=express();
  app.use('/api/tiendanube/webhook',express.raw({type:'application/json',limit:'100kb',inflate:false}));
  app.use(express.json({inflate:false}));app.use('/api/tiendanube',tiendanubePublicaRouter);
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:'Error de prueba'}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const endpoint=`http://127.0.0.1:${server.address().port}/api/tiendanube/webhook`;
  try{
    const url='https://zilky-prueba.invalid/api/tiendanube/webhook';
    const hooks=TIENDANUBE_WEBHOOKS_OPERATIVOS.map((event,i)=>({id:i+1,event,url}));
    const setup=crearServicioSetupTiendanube({db,baseUrl:'https://zilky-prueba.invalid',now:()=>new Date('2000-01-01T00:00:00Z'),
      apiFactory:()=>async(method,path)=>{assert.equal(method,'GET');assert.equal(path,'/webhooks?page=1&per_page=100');return hooks;}});
    assert.equal((await setup.verificar('n1')).recepcion_firmada_confirmada,false);
    assert.equal((await db.prepare('SELECT hmac_validada_at FROM tiendanube_eventos WHERE body_hash=?').get('legacy-fixture')).hmac_validada_at,null);
    // Inbox interno reciente (sin HMAC) tampoco cuenta.
    await db.exec(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,sync_ultimo_evento_at)
      VALUES('101','product/updated','12','internal-fixture','{}',NOW());`);
    assert.equal((await setup.verificar('n1')).recepcion_firmada_confirmada,false);
    const raw=JSON.stringify({store_id:101,event:'product/updated',id:13});
    const send=signature=>httpFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-linkedstore-hmac-sha256':signature},body:raw});
    const invalid=await send('0'.repeat(64));assert.equal(invalid.status,401);await invalid.text();
    assert.equal((await setup.verificar('n1')).recepcion_firmada_confirmada,false);
    const signature=createHmac('sha256',process.env.TIENDANUBE_APP_SECRET).update(raw).digest('hex');
    const accepted=await send(signature);assert.equal(accepted.status,202);assert.deepEqual(await accepted.json(),{recibido:true});
    const evidence=await db.prepare('SELECT hmac_validada_at FROM tiendanube_eventos WHERE recurso_id=?').get('13');
    assert.ok(evidence.hmac_validada_at);
    const verified=await setup.verificar('n1');assert.equal(verified.recepcion_firmada_confirmada,true);
    assert.equal(verified.pausada,true);assert.equal(verified.stock_actualizado,false);assert.equal(verified.sincronizacion_activada,false);
    assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get('p1')).stock,3);
  }finally{
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));await pg.close();
  }
});
