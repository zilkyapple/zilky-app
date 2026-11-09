import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Duplex} from 'node:stream';
import {IncomingMessage, ServerResponse} from 'node:http';
import {PGlite} from '@electric-sql/pglite';

// Esta regresión usa PostgreSQL WASM en memoria y el middleware HTTP real.
// No hereda secretos, no abre sockets y bloquea el Pool y el proveedor remoto.
process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/tiendanube_onboarding_disposable';
process.env.JWT_SECRET='jwt-solo-onboarding-test-no-real';
process.env.TIENDANUBE_APP_SECRET='tiendanube-solo-onboarding-test-no-real';
process.env.TIENDANUBE_TOKEN_KEY='a'.repeat(64);
process.env.TIENDANUBE_SYNC_ENABLED='false';

const {db,pool}=await import('../src/db/connection.js');
const originalFetch=globalThis.fetch;
let externalCalls=0;
const forbidden=()=>{externalCalls++;throw Error('La prueba bloqueó acceso externo');};
pool.connect=pool.query=forbidden;
globalThis.fetch=forbidden;
const pg=new PGlite();
const storage=new AsyncLocalStorage();
const current=()=>storage.getStore()||pg;
db.query=async(sql,params=[])=>{const result=await current().query(sql,params);return {...result,rowCount:result.affectedRows};};
db.exec=sql=>current().exec(sql);
db.transaction=fn=>storage.getStore()?fn(storage.getStore()):pg.transaction(tx=>storage.run(tx,()=>fn(tx)));
const {migrate}=await import('../src/db/migrate.js');
const {firmarToken}=await import('../src/lib/auth.js');
const {app}=await import('../src/app.js');

before(async()=>{await pg.waitReady;await migrate();});
after(async()=>{try{assert.equal(externalCalls,0);}finally{globalThis.fetch=originalFetch;await pg.close();await pool.end();}});

async function seed(){
  await db.exec(`TRUNCATE organizaciones,usuarios,negocios CASCADE;
    INSERT INTO organizaciones(id,nombre) VALUES('org-a','Organización A'),('org-b','Organización B');
    INSERT INTO usuarios(id,email,nombre,rol,activo) VALUES
      ('actor','actor@fixture.invalid','Admin original','administrador',1),
      ('foreign','foreign@fixture.invalid','Admin ajeno','administrador',1);
    INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES
      ('actor','org-a','administrador',1),('foreign','org-b','administrador',1);
    INSERT INTO negocios(id,organizacion_id,nombre) VALUES
      ('business-a','org-a','Negocio A'),('business-b','org-b','Negocio B');`);
  return firmarToken(await db.prepare('SELECT * FROM usuarios WHERE id=?').get('actor'));
}

// IncomingMessage/ServerResponse conservan el contrato HTTP de Express sin
// escuchar en un puerto ni enviar tráfico. complete evita el gate de abortos
// de express.raw-body al recibir un cuerpo a través de este stream en memoria.
function request(path,{method='GET',body,bearer}={}){
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Timeout HTTP en memoria: '+method+' '+path)),10000);
    const chunks=[];
    const socket=new Duplex({read(){},write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
    const req=new IncomingMessage(socket),res=new ServerResponse(req);
    req.method=method;req.url='/api'+path;req.httpVersion='1.1';req.httpVersionMajor=1;req.httpVersionMinor=1;req.complete=true;
    const raw=body===undefined?'':JSON.stringify(body);
    req.headers={connection:'close',...(bearer?{authorization:'Bearer '+bearer}:{}),
      ...(body===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(raw))})};
    res.assignSocket(socket);
    res.once('error',error=>{clearTimeout(timeout);reject(error);});
    res.once('finish',()=>{
      clearTimeout(timeout);
      try{
        const wire=Buffer.concat(chunks).toString('utf8');
        const payload=wire.slice(wire.indexOf('\r\n\r\n')+4);
        resolve({status:res.statusCode,body:JSON.parse(payload)});
      }catch(error){reject(error);}
    });
    app.handle(req,res);if(raw)req.push(Buffer.from(raw));req.push(null);
  });
}

const registration=(email,extra={})=>({email,password:'password-local-only',nombre:'Admin nuevo',...extra});
const counts=async()=>({
  users:(await db.prepare('SELECT COUNT(*)::int AS n FROM usuarios').get()).n,
  businesses:(await db.prepare('SELECT COUNT(*)::int AS n FROM negocios').get()).n,
  memberships:(await db.prepare('SELECT COUNT(*)::int AS n FROM usuario_organizacion').get()).n,
});
const state=(business,bearer)=>request('/tiendanube/estado?negocio_id='+encodeURIComponent(business),{bearer});
const denied=(response,statuses=[403,404])=>assert.ok(statuses.includes(response.status),JSON.stringify(response));

test('crear un negocio desde un admin conserva su organización y permite gestionar Tiendanube',async()=>{
  const bearer=await seed();
  assert.equal((await state('business-a',bearer)).status,200);
  const result=await request('/negocios',{method:'POST',bearer,body:{nombre:'Nuevo negocio'}});
  assert.equal(result.status,201);assert.equal(result.body.organizacion_id,'org-a');
  assert.equal((await state(result.body.id,bearer)).status,200);
  const foreignToken=firmarToken(await db.prepare('SELECT * FROM usuarios WHERE id=?').get('foreign'));
  assert.equal((await state(result.body.id,foreignToken)).status,404);
});

test('registro administrativo crea una membresía activa en la misma organización e ignora el rol del body',async()=>{
  const bearer=await seed();
  const result=await request('/auth/registro',{method:'POST',bearer,body:registration('new@fixture.invalid',{rol:'empleado'})});
  assert.equal(result.status,201);assert.equal(result.body.usuario.rol,'administrador');
  assert.deepEqual(await db.prepare('SELECT organizacion_id,rol,activo FROM usuario_organizacion WHERE usuario_id=?').all(result.body.usuario.id),
    [{organizacion_id:'org-a',rol:'administrador',activo:1}]);
  assert.equal((await state('business-a',result.body.token)).status,200);
  assert.equal((await state('business-b',result.body.token)).status,404);
});

test('onboarding y Tiendanube rechazan membresía ausente, inactiva o con rol empleado sin insertar filas',async()=>{
  for(const change of [
    "DELETE FROM usuario_organizacion WHERE usuario_id='actor'",
    "UPDATE usuario_organizacion SET activo=0 WHERE usuario_id='actor'",
    "UPDATE usuario_organizacion SET rol='empleado' WHERE usuario_id='actor'",
  ]){
    const bearer=await seed();await db.exec(change);const before=await counts();
    denied(await request('/negocios',{method:'POST',bearer,body:{nombre:'No debe crearse'}}));
    denied(await request('/auth/registro',{method:'POST',bearer,body:registration('denied@fixture.invalid')}));
    assert.equal((await state('business-a',bearer)).status,404);
    assert.deepEqual(await counts(),before);
  }
});

test('actor global inactivo, eliminado o con rol revocado no puede hacer onboarding ni gestionar Tiendanube',async()=>{
  for(const [change,status] of [
    ["UPDATE usuarios SET activo=0 WHERE id='actor'",401],
    ["DELETE FROM usuario_organizacion WHERE usuario_id='actor';DELETE FROM usuarios WHERE id='actor'",401],
    ["UPDATE usuarios SET rol='empleado' WHERE id='actor'",403],
  ]){
    const bearer=await seed();await db.exec(change);const before=await counts();
    denied(await request('/negocios',{method:'POST',bearer,body:{nombre:'No debe crearse'}}),[status]);
    denied(await request('/auth/registro',{method:'POST',bearer,body:registration('inactive@fixture.invalid')}),[status]);
    assert.equal((await state('business-a',bearer)).status,status);
    assert.deepEqual(await counts(),before);
  }
});

test('una revocación posterior a cargar la sesión se vuelve a comprobar dentro del alta',async()=>{
  for(const change of [
    "UPDATE usuarios SET activo=0 WHERE id='actor'",
    "UPDATE usuarios SET rol='empleado' WHERE id='actor'",
    "UPDATE usuario_organizacion SET activo=0 WHERE usuario_id='actor'",
    "UPDATE usuario_organizacion SET rol='empleado' WHERE usuario_id='actor'",
  ]){
    for(const path of ['/negocios','/auth/registro']){
      const bearer=await seed();const before=await counts();
      const query=db.query;let revoked=false;
      db.query=async(sql,params=[])=>{
        const result=await query(sql,params);
        // cargarUsuario ya leyó el rol/activo globales. Completar ahora una
        // revocación antes de que el handler use ese snapshot de la sesión.
        if(!revoked&&/FROM usuario_negocio WHERE usuario_id\s*=/.test(sql)&&params[0]==='actor'){
          revoked=true;await query(change);
        }
        return result;
      };
      try{
        const body=path==='/negocios'?{nombre:'Revocado durante el request'}:registration('late-revoked@fixture.invalid');
        denied(await request(path,{method:'POST',bearer,body}));
        assert.equal(revoked,true);assert.deepEqual(await counts(),before);
      }finally{db.query=query;}
    }
  }
});

test('administrador de varias organizaciones debe indicar destino y no crea filas ante ambigüedad',async()=>{
  const bearer=await seed();
  await db.exec("INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES('actor','org-b','administrador',1)");
  const before=await counts();
  assert.equal((await request('/negocios',{method:'POST',bearer,body:{nombre:'Ambiguo'}})).status,409);
  assert.equal((await request('/auth/registro',{method:'POST',bearer,body:registration('ambiguous@fixture.invalid')})).status,409);
  assert.deepEqual(await counts(),before);
  for(const org of ['org-a','org-b']){
    const business=await request('/negocios',{method:'POST',bearer,body:{nombre:'Destino '+org,organizacion_id:org}});
    assert.equal(business.status,201);assert.equal(business.body.organizacion_id,org);
    assert.equal((await state(business.body.id,bearer)).status,200);
    const admin=await request('/auth/registro',{method:'POST',bearer,body:registration(org+'@fixture.invalid',{organizacion_id:org})});
    assert.equal(admin.status,201);
    assert.deepEqual(await db.prepare('SELECT organizacion_id FROM usuario_organizacion WHERE usuario_id=?').all(admin.body.usuario.id),[{organizacion_id:org}]);
    assert.equal((await state(business.body.id,admin.body.token)).status,200);
    assert.equal((await state(org==='org-a'?'business-b':'business-a',admin.body.token)).status,404);
  }
});

test('organización explícita ajena se rechaza sin filas; la autorizada conserva aislamiento',async()=>{
  const bearer=await seed();const before=await counts();
  denied(await request('/negocios',{method:'POST',bearer,body:{nombre:'Ajeno',organizacion_id:'org-b'}}));
  denied(await request('/auth/registro',{method:'POST',bearer,body:registration('foreign-target@fixture.invalid',{organizacion_id:'org-b'})}));
  assert.deepEqual(await counts(),before);
  const business=await request('/negocios',{method:'POST',bearer,body:{nombre:'Autorizado',organizacion_id:'org-a'}});
  assert.equal(business.status,201);assert.equal(business.body.organizacion_id,'org-a');
  assert.equal((await state(business.body.id,bearer)).status,200);
  assert.equal((await state('business-b',bearer)).status,404);
});

test('si falla la membresía administrativa se revierte también el usuario nuevo',async()=>{
  const bearer=await seed();const before=await counts();
  await db.exec(`CREATE FUNCTION onboarding_reject_membership() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Fallo de membresía inducido por la regresión'; END $$;
    CREATE TRIGGER onboarding_reject_membership BEFORE INSERT ON usuario_organizacion
    FOR EACH ROW EXECUTE FUNCTION onboarding_reject_membership();`);
  try{
    const result=await request('/auth/registro',{method:'POST',bearer,body:registration('rollback@fixture.invalid')});
    assert.equal(result.status,500);
    assert.equal(await db.prepare('SELECT id FROM usuarios WHERE email=?').get('rollback@fixture.invalid'),undefined);
    assert.deepEqual(await counts(),before);
  }finally{
    await db.exec('DROP TRIGGER onboarding_reject_membership ON usuario_organizacion;DROP FUNCTION onboarding_reject_membership();');
  }
});
