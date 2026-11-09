import test from 'node:test';
import assert from 'node:assert/strict';
import { iniciarTiendanubeWorker } from '../src/services/tiendanubeWorker.js';

test('worker apagado no abre DB ni consulta Tiendanube',async()=>{
  const worker=iniciarTiendanubeWorker({db:null,enabled:false});
  assert.equal(worker.activo,false);
  assert.deepEqual(await worker.tick(),{estado:'deshabilitado'});
  worker.stop();
});

test('worker procesa entradas antes de salida, sin intervalos superpuestos',async()=>{
  const calls=[];let release;
  const gate=new Promise(r=>release=r);
  const worker=iniciarTiendanubeWorker({enabled:true,intervalMs:60000,
    db:{prepare:()=>({all:async()=>[{negocio_id:'n1'}]})},
    service:{procesarEntrada:async n=>{calls.push('in:'+n);await gate;return {estado:'vacio'};},
      procesarSalida:async n=>{calls.push('out:'+n);return {estado:'vacio'};}},
  });
  try{
    const first=worker.tick();
    assert.deepEqual(await worker.tick(),{estado:'omitido'});
    release();await first;
    assert.deepEqual(calls,['in:n1','out:n1']);
  }finally{worker.stop();}
});

test('worker no envía al log mensajes privados de fallos',async()=>{
  const logs=[];
  const worker=iniciarTiendanubeWorker({enabled:true,intervalMs:60000,
    db:{prepare:()=>({all:async()=>{throw Error('texto privado que no se debe mostrar');}})},service:{},
    onError:code=>logs.push(code),
  });
  try{assert.deepEqual(await worker.tick(),{estado:'error'});assert.deepEqual(logs,['TIENDANUBE_WORKER_ERROR']);}
  finally{worker.stop();}
});

test('un negocio averiado no bloquea al siguiente ni filtra su error',async()=>{
  const logs=[],calls=[];
  const worker=iniciarTiendanubeWorker({enabled:true,intervalMs:60000,
    db:{prepare:()=>({all:async()=>[{negocio_id:'n1'},{negocio_id:'n2'}]})},
    service:{
      procesarEntrada:async n=>{calls.push('in:'+n);if(n==='n1')throw Error('secreto de n1');return {estado:'vacio'};},
      procesarSalida:async n=>{calls.push('out:'+n);return {estado:'vacio'};},
    },onError:code=>logs.push(code),
  });
  try{
    assert.deepEqual(await worker.tick(),{estado:'ejecutado_con_errores'});
    assert.deepEqual(calls,['in:n1','in:n2','out:n2']);
    assert.deepEqual(logs,['TIENDANUBE_WORKER_ERROR']);
  }finally{worker.stop();}
});
