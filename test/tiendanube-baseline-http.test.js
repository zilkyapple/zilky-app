import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DOTENV_CONFIG_PATH='/__zilky_baseline_http_fixture_no_env__';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/isolated';
process.env.JWT_SECRET='fixture-only-baseline-not-production';
const {pool}=await import('../src/db/connection.js');
pool.query=pool.connect=async()=>{throw Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
const {crearRouterBaselineTiendanube}=await import('../src/routes/tiendanubeBaseline.js');

async function server({reject}={}){
  const app=express(),calls=[];app.use(express.json());
  app.use((req,res,next)=>{
    if(req.headers['x-fixture-user']){req.usuarioId=String(req.headers['x-fixture-user']);req.usuario={id:req.usuarioId,rol:req.headers['x-fixture-role']||'administrador'};}
    next();
  });
  const record=method=>async(...args)=>{calls.push({method,args});if(reject)throw reject;return {modo:'solo_lectura',baseline_confirmable:false};};
  app.use('/api/tiendanube',crearRouterBaselineTiendanube({servicio:{preview:record('preview'),revalidar:record('revalidar')}}));
  app.get('/api/tiendanube/pedidos',(req,res)=>res.json({operativa:true}));
  const s=app.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));
  const base='http://127.0.0.1:'+s.address().port;
  return {calls,close:()=>new Promise(resolve=>s.close(resolve)),request:async(path,{user='admin',role='administrador',method='GET',body}={})=>{
    const r=await fetch(base+'/api/tiendanube'+path,{method,headers:{'Content-Type':'application/json',...(user?{'x-fixture-user':user,'x-fixture-role':role}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const raw=await r.text();return {status:r.status,headers:r.headers,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(raw):raw};
  }};
}

test('baseline HTTP requiere sesión y admin antes de invocar consultas; no bloquea pedidos de empleados',async()=>{
  const s=await server();try{
    for(const path of ['/baseline/preview?negocio_id=n1','/baseline/revalidar?negocio_id=n1']){
      const options={method:path.includes('revalidar')?'POST':'GET'};
      assert.equal((await s.request(path,{...options,user:null})).status,401);
      assert.equal((await s.request(path,{...options,user:'emp',role:'empleado'})).status,403);
    }
    assert.equal(s.calls.length,0);
    assert.equal((await s.request('/pedidos',{user:'emp',role:'empleado'})).status,200);
  }finally{await s.close();}
});
test('baseline HTTP conserva identidad autenticada, rechaza negocio ambiguo y no guarda en cache',async()=>{
  const s=await server();try{
    const view=await s.request('/baseline/preview?negocio_id=n1');assert.equal(view.status,200);assert.equal(view.headers.get('cache-control'),'no-store');
    assert.equal(view.headers.get('referrer-policy'),'no-referrer');
    const body={negocio_id:'n1',huella:'a'.repeat(64),corte_consulta_at:'2026-11-09T18:00:00.000Z',usuario_id:'spoof'};
    await s.request('/baseline/revalidar',{method:'POST',body});
    assert.deepEqual(s.calls,[{method:'preview',args:['n1','admin']},{method:'revalidar',args:['n1',body,'admin']}]);
    for(const path of ['/baseline/preview','/baseline/preview?negocio_id=n1&negocio_id=n2'])assert.equal((await s.request(path)).status,400);
    assert.equal((await s.request('/baseline/revalidar?negocio_id=n2',{method:'POST',body:{negocio_id:'n1'}})).status,400);
    assert.equal(s.calls.length,2);
  }finally{await s.close();}
});
test('no existe ruta para confirmar baseline, activar motores ni modificar stocks',async()=>{
  const s=await server();try{
    for(const path of ['/baseline/confirmar','/baseline/activar','/baseline/stock'])assert.equal((await s.request(path,{method:'POST',body:{negocio_id:'n1',activar:true}})).status,404);
    assert.equal(s.calls.length,0);
  }finally{await s.close();}
});
test('baseline HTTP responde bloqueos precisos sin revelar errores SQL, proveedor, PII ni secretos',async()=>{
  for(const [error,expectedStatus,expectedCode] of [
    [Object.assign(Error('PRIVATE_CANARY'),{status:403,code:'BASELINE_SIN_PERMISO'}),403,'BASELINE_SIN_PERMISO'],
    [Object.assign(Error('PRIVATE_CANARY'),{status:409,code:'BASELINE_CAMBIO_DESDE_PREVIEW'}),409,'BASELINE_CAMBIO_DESDE_PREVIEW'],
    [Object.assign(Error('PRIVATE_CANARY'),{status:502,code:'provider_error_PRIVATE_CANARY'}),502,'BASELINE_NO_VERIFICADA'],
    [Error('SELECT token_cifrado PRIVATE_CANARY'),500,'BASELINE_NO_VERIFICADA'],
  ]){
    const s=await server({reject:error});try{
      const r=await s.request('/baseline/preview?negocio_id=n1');assert.equal(r.status,expectedStatus);assert.equal(r.body.code,expectedCode);
      assert.doesNotMatch(JSON.stringify(r.body),/CANARY|SELECT|token_cifrado|provider_error/);
    }finally{await s.close();}
  }
});
