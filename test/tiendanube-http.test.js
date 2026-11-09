import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import express from 'express';

// Nunca heredar la URL ni las credenciales de una base real. El Pool se crea
// con una dirección local falsa y queda interceptado ANTES de importar rutas.
// Estas pruebas ejercitan HTTP/middleware y contratos SQL, no PostgreSQL real.
process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.DATABASE_URL='postgresql://127.0.0.1:1/zilky_tiendanube_http_dummy_test';
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.JWT_SECRET='jwt-solo-test-http-no-corresponde-a-una-cuenta';
process.env.TIENDANUBE_APP_ID='123456789';
process.env.TIENDANUBE_APP_SECRET='secret-solo-test-http-no-real';
process.env.TIENDANUBE_TOKEN_KEY='a'.repeat(64);
process.env.TIENDANUBE_SYNC_ENABLED='true';

const {db,pool}=await import('../src/db/connection.js');
let state;
const calls=[];
const forbidden=()=>{throw Error('La prueba bloqueó un acceso no simulado a PostgreSQL');};
pool.connect=forbidden;
pool.query=forbidden;
db.exec=forbidden;
db.lockClienteNegocio=forbidden;
db.transaction=async fn=>fn();
db.query=async(sql,params=[])=>{
  calls.push({method:'query',sql,params});
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
  throw Error('Consulta SQL no simulada');
};

const compact=sql=>sql.replace(/\s+/g,' ').trim();
const projection=(sql,row)=>{
  if(!row)return undefined;
  const fields=sql.match(/^SELECT (.+) FROM /i)?.[1];
  if(fields==='*')return {...row};
  assert.ok(fields,'La consulta debe enumerar sus columnas');
  return Object.fromEntries(fields.split(',').map(field=>[field.trim(),row[field.trim()]]));
};

db.prepare=sql=>{
  const text=compact(sql);
  const record=(method,params)=>calls.push({method,sql:text,params});
  return {
    async get(...params){
      record('get',params);
      if(text.startsWith('SELECT n.id FROM negocios n')){
        assert.match(text,/JOIN usuario_organizacion uo ON uo\.organizacion_id=n\.organizacion_id/);
        assert.match(text,/n\.id=\? AND uo\.usuario_id=\?/);
        assert.match(text,/uo\.activo=1 AND uo\.rol='administrador'/);
        assert.match(text,/u\.activo=1 AND u\.rol='administrador'/);
        return state.membershipActive&&params[0]==='negocio-a'&&params[1]==='admin-a'?{id:'negocio-a'}:undefined;
      }
      if(text.startsWith('DELETE FROM tiendanube_oauth_estados')){
        const row=state.oauth;state.oauth=null;return row;
      }
      if(text.startsWith('UPDATE tiendanube_conexiones SET pausada=TRUE')){
        assert.match(text,/WHERE negocio_id=\? RETURNING negocio_id,sync_lease_token$/);
        if(params[0]!=='negocio-a'||!state.connection)return undefined;
        state.connection.pausada=true;state.connection.sync_motivo_pausa='PAUSA_ADMINISTRADOR';
        return {negocio_id:state.connection.negocio_id,sync_lease_token:state.connection.sync_lease_token};
      }
      if(text.includes('FROM tiendanube_conexiones WHERE negocio_id=?'))return params[0]==='negocio-a'?projection(text,state.connection):undefined;
      if(text.includes('FROM tiendanube_conexiones WHERE store_id=?'))return params[0]===state.connection?.store_id?projection(text,state.connection):undefined;
      if(text.includes('FROM tiendanube_variantes')&&text.includes('COUNT(*)'))return {total:state.variants,sin_baseline:state.withoutBaseline};
      if(text.includes('FROM tiendanube_stock_outbox')&&text.includes('COUNT(*)'))return {revision:state.outboxReview};
      if(text.includes('FROM tiendanube_eventos')&&text.includes('COUNT(*)'))return {revision:state.inboxReview};
      if(text.includes('FROM tiendanube_privacidad_borrados')){
        assert.match(text,/WHERE store_id=\? AND order_hash=\?/);
        assert.equal(params.length,2);assert.match(params[1],/^[a-f0-9]{64}$/);
        return state.deletedOrders.has(JSON.stringify(params))?{order_hash:params[1]}:undefined;
      }
      throw Error('Lectura SQL no simulada');
    },
    async all(...params){
      record('all',params);
      if(text.startsWith('SELECT v.producto_id,v.product_id,v.variant_id,p.nombre,p.stock,o.estado'))return state.links;
      throw Error('Lista SQL no simulada');
    },
    async run(...params){
      record('run',params);
      if(text.startsWith('INSERT INTO tiendanube_eventos')){
        const [store,topic,id,hash,payload]=params;
        const key=JSON.stringify([store,topic,id,hash]);
        const previous=state.events.get(key);
        if(!previous){
          state.events.set(key,{store_id:store,topic,recurso_id:id,body_hash:hash,payload:JSON.parse(payload),sync_version:1,sync_estado:'pendiente',procesado_at:null});
          return {changes:1};
        }
        // Simular únicamente la semántica que está explícita en el SQL real.
        if(/ON CONFLICT\([^)]*\) DO NOTHING/.test(text))return {changes:0};
        assert.match(text,/ON CONFLICT\([^)]*\) DO UPDATE SET/);
        assert.match(text,/sync_version\s*=\s*tiendanube_eventos\.sync_version\s*\+\s*1/);
        assert.match(text,/procesado_at\s*=\s*NULL/);
        assert.match(text,/sync_ultimo_evento_at\s*=\s*NOW\(\)/);
        assert.match(text,/sync_estado\s*=\s*CASE WHEN tiendanube_eventos\.sync_estado='revision_manual' THEN 'revision_manual' ELSE 'pendiente' END/);
        assert.match(text,/error\s*=\s*CASE WHEN tiendanube_eventos\.sync_estado='revision_manual' THEN tiendanube_eventos\.error ELSE NULL END/);
        previous.sync_version++;previous.procesado_at=null;
        if(previous.sync_estado!=='revision_manual'){previous.sync_estado='pendiente';previous.error=null;}
        return {changes:1};
      }
      if(text==='DELETE FROM tiendanube_oauth_estados WHERE negocio_id=?'){
        assert.equal(params[0],'negocio-a');state.oauth=null;return {changes:1};
      }
      if(text.startsWith('INSERT INTO tiendanube_oauth_estados')){
        state.oauth={state_hash:params[0],negocio_id:params[1],usuario_id:params[2]};return {changes:1};
      }
      throw Error('Escritura SQL no simulada');
    },
  };
};

const httpFetch=globalThis.fetch;
let externalCalls=0;
globalThis.fetch=async()=>{externalCalls++;throw Error('La prueba bloqueó una llamada externa');};
const {tiendanubeAdminRouter,tiendanubePublicaRouter}=await import('../src/routes/tiendanube.js');
const {hashPedidoPrivacidad}=await import('../src/services/tiendanubePrivacidadService.js');

function reset(){
  calls.length=0;externalCalls=0;
  process.env.TIENDANUBE_SYNC_ENABLED='true';
  state={membershipActive:true,variants:1,withoutBaseline:1,outboxReview:0,inboxReview:0,links:[],events:new Map(),deletedOrders:new Set(),oauth:null,
    connection:{negocio_id:'negocio-a',store_id:'321',app_id:'123456789',scopes:'write_products,read_orders',pausada:false,sync_lease_token:null,
      sync_activada_at:'2026-11-09T00:00:00.000Z',sync_baseline_at:null,sync_webhooks_at:null,sync_motivo_pausa:null,
      creada_at:'2026-11-09T00:00:00.000Z',actualizada_at:'2026-11-09T00:00:00.000Z',token_cifrado:'NO-EXPONER-TOKEN-FAKE'}};
}

async function fixture(run){
  reset();
  const app=express();
  app.use('/api/tiendanube/webhook',express.raw({type:'application/json',limit:'100kb',inflate:false}));
  app.use('/api/tiendanube/privacy',express.raw({type:'application/json',limit:'100kb',inflate:false}));
  app.use(express.json({inflate:false}));
  app.use('/api/tiendanube',tiendanubePublicaRouter);
  // Identidades ficticias del harness; se prueba requireAdmin y el scope SQL,
  // no la implementación JWT de cargarUsuario.
  app.use((req,res,next)=>{
    const identity=req.headers['x-test-identity'];
    if(identity==='admin-a'||identity==='admin-b'){
      req.usuario={id:identity,rol:'administrador'};req.usuarioId=identity;
    }else if(identity==='empleado'){
      req.usuario={id:identity,rol:'empleado'};req.usuarioId=identity;
    }
    next();
  });
  app.use('/api/tiendanube',tiendanubeAdminRouter);
  app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.status&&error.status<500?error.message:'Error interno de prueba'}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(path,{identity,...options}={})=>httpFetch(origin+path,{...options,headers:{...(identity?{'x-test-identity':identity}:{}),...options.headers}});
  const signed=(payload,options={})=>{
    const raw=typeof payload==='string'?payload:JSON.stringify(payload);
    return request('/api/tiendanube/webhook',{...options,method:'POST',headers:{'Content-Type':'application/json','x-linkedstore-hmac-sha256':createHmac('sha256',process.env.TIENDANUBE_APP_SECRET).update(raw).digest('hex'),...options.headers},body:raw});
  };
  try{await run({request,signed});}
  finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

const adminActions=[
  {path:'/api/tiendanube/estado?negocio_id=negocio-a'},
  {path:'/api/tiendanube/diagnostico?negocio_id=negocio-a'},
  {path:'/api/tiendanube/catalogo?negocio_id=negocio-a'},
  {path:'/api/tiendanube/privacidad?negocio_id=negocio-a'},
  {path:'/api/tiendanube/pausar',method:'POST'},
  {path:'/api/tiendanube/iniciar',method:'POST'},
  {path:'/api/tiendanube/vinculos',method:'POST'},
  {path:'/api/tiendanube/pedidos/conciliar',method:'POST'},
];

test('Tiendanube HTTP aislado: permisos, readiness y recepción de webhooks',async t=>{
  await t.test('anónimo y empleado no administran conexión, catálogo, privacidad ni stock',async()=>fixture(async({request})=>{
    for(const identity of [undefined,'empleado'])for(const action of adminActions){
      const response=await request(action.path,{identity,method:action.method||'GET',...(action.method?{headers:{'Content-Type':'application/json'},body:JSON.stringify({negocio_id:'negocio-a'})}:{})});
      assert.equal(response.status,identity?403:401,`${identity||'anónimo'}: ${action.path}`);
      await response.text();
    }
    assert.equal(calls.length,0);assert.equal(externalCalls,0);
  }));

  await t.test('administrador de otra organización no accede ni escribe',async()=>fixture(async({request})=>{
    for(const action of adminActions){
      const response=await request(action.path,{identity:'admin-b',method:action.method||'GET',...(action.method?{headers:{'Content-Type':'application/json'},body:JSON.stringify({negocio_id:'negocio-a'})}:{})});
      assert.equal(response.status,404,action.path);await response.text();
    }
    assert.equal(calls.length,adminActions.length);
    assert.ok(calls.every(c=>c.method==='get'&&c.sql.startsWith('SELECT n.id FROM negocios n')));
    assert.ok(calls.every(c=>c.params[0]==='negocio-a'&&c.params[1]==='admin-b'));
    assert.equal(externalCalls,0);
  }));

  await t.test('membresía revocada invalida también al administrador autenticado',async()=>fixture(async({request})=>{
    state.membershipActive=false;
    const response=await request('/api/tiendanube/estado?negocio_id=negocio-a',{identity:'admin-a'});
    assert.equal(response.status,404);await response.text();assert.equal(calls.length,1);
  }));

  await t.test('estado no afirma habilitada por pausada=false cuando faltan baseline y webhooks',async()=>fixture(async({request})=>{
    const response=await request('/api/tiendanube/estado?negocio_id=negocio-a',{identity:'admin-a'});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.conexion.pausada,false);assert.equal(result.configuracion_servidor,true);
    assert.equal(result.sincronizacion_habilitada,false);assert.equal(result.diagnostico.listo,false);
    assert.ok(result.diagnostico.bloqueos.includes('BASELINE_PENDIENTE'));
    assert.ok(result.diagnostico.bloqueos.includes('WEBHOOKS_NO_VERIFICADOS'));
    assert.doesNotMatch(JSON.stringify(result),/NO-EXPONER-TOKEN-FAKE|token_cifrado|secret-solo/);
    assert.equal(calls.filter(c=>c.method==='run').length,0);
  }));

  await t.test('feature apagada impide declarar lista una conexión conciliada',async()=>fixture(async({request})=>{
    process.env.TIENDANUBE_SYNC_ENABLED='false';
    state.connection.sync_baseline_at=state.connection.sync_activada_at;state.connection.sync_webhooks_at=state.connection.sync_activada_at;state.withoutBaseline=0;
    const response=await request('/api/tiendanube/estado?negocio_id=negocio-a',{identity:'admin-a'});
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.sincronizacion_habilitada,false);
    assert.ok(result.diagnostico.bloqueos.includes('FEATURE_FLAG_APAGADA'));
  }));

  await t.test('pausa informa una operación en curso sin exponer el lease ni borrar datos',async()=>fixture(async({request})=>{
    state.connection.sync_lease_token='LEASE-INTERNO-NO-EXPONER';
    const response=await request('/api/tiendanube/pausar',{identity:'admin-a',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({negocio_id:'negocio-a'})});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{pausada:true,operacion_en_curso:true});
    assert.equal(state.connection.pausada,true);assert.equal(state.connection.sync_motivo_pausa,'PAUSA_ADMINISTRADOR');
    assert.equal(state.connection.sync_lease_token,'LEASE-INTERNO-NO-EXPONER');
    assert.equal(calls.length,2);assert.equal(calls[1].method,'get');
    assert.match(calls[1].sql,/UPDATE tiendanube_conexiones SET pausada=TRUE/);
    assert.deepEqual(calls[1].params,['negocio-a']);assert.equal(externalCalls,0);
  }));

  await t.test('pausar una tienda no conectada no devuelve un éxito ficticio',async()=>fixture(async({request})=>{
    state.connection=null;
    const response=await request('/api/tiendanube/pausar',{identity:'admin-a',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({negocio_id:'negocio-a'})});
    assert.equal(response.status,409);assert.equal((await response.json()).pausada,undefined);
    assert.equal(state.connection,null);assert.equal(externalCalls,0);
  }));

  await t.test('volver a autorizar exige pausa y ausencia de lease antes de renovar el estado',async()=>fixture(async({request})=>{
    const initiate=()=>request('/api/tiendanube/iniciar',{identity:'admin-a',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({negocio_id:'negocio-a'})});
    for(const config of [{pausada:false,sync_lease_token:null},{pausada:true,sync_lease_token:'LEASE-OCUPADO'}]){
      Object.assign(state.connection,config);
      const blocked=await initiate();assert.equal(blocked.status,409);await blocked.text();
    }
    assert.equal(calls.filter(c=>c.method==='run').length,0);
    state.connection.pausada=true;state.connection.sync_lease_token=null;
    state.oauth={state_hash:'ESTADO-ANTERIOR',negocio_id:'negocio-a',usuario_id:'admin-a'};
    const response=await initiate();assert.equal(response.status,200);
    const result=await response.json();const authorization=new URL(result.url);
    assert.equal(authorization.origin,'https://www.tiendanube.com');
    assert.equal(authorization.pathname,'/apps/123456789/authorize');
    assert.match(authorization.searchParams.get('state'),/^[a-f0-9]{64}$/);
    assert.deepEqual([...authorization.searchParams.keys()],['state']);
    assert.equal(result.vence_en_segundos,600);
    assert.deepEqual(state.oauth,{state_hash:createHash('sha256').update(authorization.searchParams.get('state')).digest('hex'),negocio_id:'negocio-a',usuario_id:'admin-a'});
    const writes=calls.filter(c=>c.method==='run');assert.equal(writes.length,2);
    assert.match(writes[0].sql,/^DELETE FROM tiendanube_oauth_estados WHERE negocio_id=\?$/);
    assert.match(writes[1].sql,/^INSERT INTO tiendanube_oauth_estados/);
    assert.equal(state.connection.pausada,true);assert.equal(externalCalls,0);
    assert.doesNotMatch(JSON.stringify(result),/secret-solo|token_cifrado|LEASE/);
  }));

  await t.test('callback revalida organización antes de canjear el código OAuth',async()=>fixture(async({request})=>{
    state.oauth={negocio_id:'negocio-a',usuario_id:'admin-b'};
    const response=await request('/api/tiendanube/oauth/callback?state='+'b'.repeat(64)+'&code=code-local-de-prueba');
    assert.equal(response.status,404);await response.text();assert.equal(externalCalls,0);
    assert.equal(calls.filter(c=>c.method==='run').length,0);
    assert.ok(calls.some(c=>c.sql.startsWith('SELECT n.id')&&c.params[1]==='admin-b'));
  }));

  await t.test('webhook firmado guarda solo lista mínima, sin PII ni stock/pagos',async()=>fixture(async({signed})=>{
    const response=await signed({store_id:321,event:'order/created',id:55,event_launch_ts:1794182400,customer:{email:'persona@privada.invalid',phone:'TELEFONO-NO-GUARDAR'},access_token:'TOKEN-NO-GUARDAR',address:'DOMICILIO-NO-GUARDAR'});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{recibido:true});
    assert.equal(state.events.size,1);
    const saved=[...state.events.values()][0];
    assert.deepEqual(saved.payload,{store_id:'321',event:'order/created',id:'55',event_launch_ts:1794182400});
    assert.doesNotMatch(JSON.stringify(calls),/persona@|TELEFONO-NO-GUARDAR|TOKEN-NO-GUARDAR|DOMICILIO-NO-GUARDAR/);
    assert.equal(calls.filter(c=>c.method==='run').length,1);
    assert.ok(calls.filter(c=>c.method==='run').every(c=>c.sql.startsWith('INSERT INTO tiendanube_eventos')));
  }));

  await t.test('eventos fuera de whitelist se reconocen sin persistir ni consultar datos',async()=>fixture(async({signed})=>{
    const response=await signed({store_id:321,event:'customer/created',id:8,email:'no-guardar@privada.invalid'});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{recibido:true,ignorado:true});
    assert.equal(calls.length,0);assert.equal(state.events.size,0);
  }));

  await t.test('tienda desconocida no puede sembrar eventos en un negocio distinto',async()=>fixture(async({signed})=>{
    const response=await signed({store_id:999,event:'order/created',id:55});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{recibido:true,ignorado:true});
    assert.equal(state.events.size,0);assert.equal(calls.filter(c=>c.method==='run').length,0);
  }));

  await t.test('pedido borrado no reintroduce ID claro ni payload aunque la conexión y el motor estén pausados',async()=>fixture(async({signed})=>{
    const order='98765432198765432109';
    state.connection.pausada=true;process.env.TIENDANUBE_SYNC_ENABLED='false';
    state.deletedOrders.add(JSON.stringify(['321',hashPedidoPrivacidad('321',order)]));
    const response=await signed({store_id:'321',event:'order/updated',id:order,customer:{email:'NO-REINTRODUCIR@privada.invalid'}});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{recibido:true,ignorado:true});
    assert.equal(state.events.size,0);assert.equal(calls.filter(c=>c.method==='run').length,0);
    assert.equal(externalCalls,0);
    assert.doesNotMatch(JSON.stringify(calls),/98765432198765432109|NO-REINTRODUCIR/);
    const lock=calls.findIndex(c=>c.method==='query'&&c.params[0]==='tiendanube:privacidad:321');
    const tombstone=calls.findIndex(c=>c.sql.includes('FROM tiendanube_privacidad_borrados'));
    assert.ok(lock>=0&&tombstone>lock,'La marca de privacidad se debe comprobar bajo su bloqueo');
    assert.ok(calls.slice(lock+1,tombstone).some(c=>c.sql==='SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=?'),'Revalidar la conexión después del bloqueo');
  }));

  await t.test('webhook duplicado reencola una nueva versión después del procesamiento',async()=>fixture(async({signed})=>{
    const payload={store_id:321,event:'order/updated',id:55};
    const first=await signed(payload);assert.equal(first.status,202);await first.text();
    const saved=[...state.events.values()][0];assert.equal(saved.sync_version,1);
    saved.procesado_at='2026-11-09T12:00:00.000Z';saved.sync_estado='procesado';
    const second=await signed(payload);assert.equal(second.status,202);await second.text();
    assert.equal(state.events.size,1);assert.equal(saved.sync_version,2);
    assert.equal(saved.procesado_at,null);assert.equal(saved.sync_estado,'pendiente');
  }));

  await t.test('duplicado conserva el bloqueo y motivo de revisión manual',async()=>fixture(async({signed})=>{
    const payload={store_id:321,event:'order/updated',id:55};
    const first=await signed(payload);assert.equal(first.status,202);await first.text();
    const saved=[...state.events.values()][0];saved.sync_estado='revision_manual';saved.error='REVISION-DE-STOCK';
    const duplicate=await signed(payload);assert.equal(duplicate.status,202);await duplicate.text();
    assert.equal(state.events.size,1);assert.equal(saved.sync_version,2);
    assert.equal(saved.sync_estado,'revision_manual');assert.equal(saved.error,'REVISION-DE-STOCK');
  }));

  await t.test('firma incorrecta y cuerpos firmados inválidos no escriben nada',async()=>fixture(async({request,signed})=>{
    const invalidSignature=await request('/api/tiendanube/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-linkedstore-hmac-sha256':'00'.repeat(32)},body:JSON.stringify({store_id:321,event:'order/created',id:55})});
    assert.equal(invalidSignature.status,401);await invalidSignature.text();
    for(const raw of ['{','null','[]','{"store_id":321,"id":55}','{"store_id":{},"event":"order/created","id":55}','{"store_id":321,"event":"order/created","id":"no-numérico"}']){
      const response=await signed(raw);assert.equal(response.status,400,raw);await response.text();
    }
    assert.equal(calls.length,0);assert.equal(state.events.size,0);assert.equal(externalCalls,0);
  }));
});
