import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.DATABASE_URL='postgresql://127.0.0.1:1/privacidad_http_fixture';
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.JWT_SECRET='fixture-http-privacy-no-real';
const {pool}=await import('../src/db/connection.js');
pool.connect=()=>{throw Error('Base externa bloqueada en prueba');};
pool.query=()=>{throw Error('Base externa bloqueada en prueba');};
const {crearRouterPrivacidadTiendanube}=await import('../src/routes/tiendanubePrivacidad.js');
const fetchLocal=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Servicios externos bloqueados en prueba');};

test('HTTP privacidad autentica, reserva el flujo a admin, conserva negocio/actor y oculta errores',async()=>{
  const calls=[];let error=null;
  const gestion=Object.fromEntries(['listar','detalle','exportar','confirmarEntrega','previewBorrado','confirmarBorrado'].map(name=>[name,async(...args)=>{
    calls.push({name,args});if(error)throw error;
    if(name==='previewBorrado')return {puede_confirmar:false,bloqueos:['PRIVACIDAD_CREDENCIAL_VIGENTE'],datos_locales_zilky_modificados:false};
    return {ok:true};
  }]));
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{
    const actor=req.headers['x-fixture-actor'];
    if(actor){req.usuarioId=String(actor);req.usuario={rol:actor==='seller'?'empleado':'administrador'};}
    next();
  });
  app.use('/api/tiendanube/privacidad-gestion',crearRouterPrivacidadTiendanube({gestion}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}/api/tiendanube/privacidad-gestion`;
  const send=(path='',{actor='admin1',method='GET',body}={})=>fetchLocal(base+path,{method,
    headers:{...(actor?{'x-fixture-actor':actor}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{
    for(const [actor,status] of [[null,401],['seller',403]]){
      const response=await send('?negocio_id=n',{actor});assert.equal(response.status,status);await response.json();
      assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    }
    assert.equal(calls.length,0);
    for(const [path,method] of [['?negocio_id=n','GET'],['/r1?negocio_id=n','GET'],['/r1/exportar','POST'],['/r1/entrega','POST'],['/r1/borrado/preview','POST'],['/r1/borrado/confirmar','POST']]){
      const response=await send(path,{method,...(method==='POST'?{body:{negocio_id:'n',actor_id:'spoofed',confirmar_borrado:true}}:{})});
      assert.equal(response.status,200);const result=await response.json();
      assert.equal(calls.at(-1).args[0],'n');assert.equal(calls.at(-1).args[method==='GET'&&path.startsWith('?')?1:2],'admin1');
      if(path.endsWith('preview'))assert.match(result.bloqueos_detalle[0].mensaje,/todavía acepta la credencial/);
    }
    const before=calls.length;
    for(const [path,body] of [['/r1/entrega?negocio_id=other',{negocio_id:'n'}],['/r1/exportar',{negocio_id:['n']}],['/r1/borrado/confirmar',{}]]){
      const response=await send(path,{method:'POST',body});assert.equal(response.status,400);await response.text();
    }
    assert.equal(calls.length,before);
    error=Object.assign(new Error('DO-NOT-EXPOSE-token=fixture'),{status:409,code:'PRIVACIDAD_PREVIEW_CAMBIO'});
    const blocked=await send('/r1/borrado/confirmar',{method:'POST',body:{negocio_id:'n'}});
    assert.equal(blocked.status,409);const msg=await blocked.text();assert.match(msg,/vista previa/);assert.doesNotMatch(msg,/DO-NOT-EXPOSE/);
    error=new Error('postgres credentials private');
    const failed=await send('?negocio_id=n');assert.equal(failed.status,500);assert.doesNotMatch(await failed.text(),/postgres|credentials private/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
