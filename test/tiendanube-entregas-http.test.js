import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DOTENV_CONFIG_PATH='/__zilky_tn_http_test_config_does_not_exist__';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/isolated';
process.env.JWT_SECRET='fixture-only-tiendanube-http-not-a-production-secret';
const {pool}=await import('../src/db/connection.js');
pool.connect=async()=>{throw Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
pool.query=async()=>{throw Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
const {crearRouterPedidosTiendanube}=await import('../src/routes/tiendanubePedidos.js');

async function server(options={}){
  const calls=[],app=express();app.use(express.json());
  app.use((req,res,next)=>{if(req.headers['x-fixture-user']){req.usuario={id:'emp',rol:'empleado'};req.usuarioId=String(req.headers['x-fixture-user']);}next();});
  const record=method=>async(...args)=>{calls.push({method,args});if(options.reject)throw options.reject;return {ok:true};};
  app.use('/api/tiendanube',crearRouterPedidosTiendanube({enabled:options.enabled??true,
    consultas:{listar:record('listar'),opciones:record('opciones'),detalle:record('detalle')},confirmarEntrega:record('confirmar')}));
  const s=app.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));
  const base='http://127.0.0.1:'+s.address().port;
  return {calls,close:()=>new Promise(resolve=>s.close(resolve)),request:async(path,{user='emp',method='GET',body}={})=>{
    const response=await fetch(base+'/api/tiendanube'+path,{method,headers:{'Content-Type':'application/json',...(user?{'x-fixture-user':user}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  }};
}

test('rutas operativas requieren sesión y flag; apagadas devuelven 409 sin llamar a servicios',async()=>{
  const s=await server({enabled:false});try{
    for(const path of ['/pedidos?negocio_id=n1','/pedidos/opciones?negocio_id=n1','/pedidos/40/entrega?negocio_id=n1']){
      assert.equal((await s.request(path,{user:null})).status,401);
      const r=await s.request(path);assert.equal(r.status,409);assert.equal(r.body.code,'ENTREGAS_TIENDANUBE_DESHABILITADAS');
    }
    assert.equal((await s.request('/pedidos/40/entrega',{method:'POST',body:{negocio_id:'n1'}})).status,409);
    assert.equal(s.calls.length,0);
  }finally{await s.close();}
});
test('rutas pasan identidad autenticada, negocio y orden exactos al servicio autorizado',async()=>{
  const s=await server();try{
    assert.equal((await s.request('/pedidos?negocio_id=n1')).status,200);
    assert.equal((await s.request('/pedidos/opciones?negocio_id=n1&buscar=Ana')).status,200);
    assert.equal((await s.request('/pedidos/40/entrega?negocio_id=n1&fecha_entrega=2026-11-09')).status,200);
    const body={negocio_id:'n1',usuario_id:'admin-spoof'};
    assert.equal((await s.request('/pedidos/40/entrega',{method:'POST',body})).status,200);
    assert.deepEqual(s.calls,[{method:'listar',args:['n1','emp']},{method:'opciones',args:['n1','emp','Ana']},
      {method:'detalle',args:['n1','40','emp',{fecha_entrega:'2026-11-09'}]},
      {method:'confirmar',args:['n1','40',body,'emp']}]);
  }finally{await s.close();}
});
test('negocio faltante, repetido o contradictorio no llega al servicio',async()=>{
  const s=await server();try{
    assert.equal((await s.request('/pedidos')).status,400);
    assert.equal((await s.request('/pedidos?negocio_id=n1&negocio_id=n2')).status,400);
    assert.equal((await s.request('/pedidos/40/entrega?negocio_id=n2',{method:'POST',body:{negocio_id:'n1'}})).status,400);
    assert.equal(s.calls.length,0);
  }finally{await s.close();}
});
test('rechazos de permisos se conservan, errores de proveedor y comisión no se filtran',async()=>{
  for(const [error,status,code] of [
    [Object.assign(Error('SECRET_PRIVATE_CANARY'),{status:403,code:'SIN_PERMISO_ENTREGA_EN_NEGOCIO'}),403,'SIN_PERMISO_ENTREGA_EN_NEGOCIO'],
    [Object.assign(Error('comision $2500 SECRET_PRIVATE_CANARY'),{status:409,code:'COMISION_PRODUCTO_NO_CONFIGURADA'}),409,'CONFIGURACION_ENTREGA_REQUIERE_REVISION'],
    [Object.assign(Error('TOKEN_PRIVATE_CANARY'),{code:'SECRET_PRIVATE_CANARY'}),500,'PEDIDO_REQUIERE_REVISION']]){
    const s=await server({reject:error});try{
      const r=await s.request('/pedidos?negocio_id=n1');assert.equal(r.status,status);assert.equal(r.body.code,code);
      assert.doesNotMatch(JSON.stringify(r.body),/CANARY|2500|comision|COMISION|token/i);
    }finally{await s.close();}
  }
});
