import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { crearServicioBaselineTiendanube } from '../src/services/tiendanubeBaselineService.js';

// Run against the production migration definitions, not a parallel hand-written
// schema. The adapter is an isolated in-memory PostgreSQL; no network or .env.
process.env.DOTENV_CONFIG_PATH='/__zilky_baseline_schema_test_no_env__';
process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/isolated';
const {db,pool}=await import('../src/db/connection.js');
pool.query=pool.connect=async()=>{throw Error('NETWORK_DATABASE_FORBIDDEN_IN_TEST');};
const {migrate}=await import('../src/db/migrate.js');

test('baseline con esquema de producción y cero vínculos informa bloqueos sin alterar datos',async()=>{
  const pg=new PGlite();await pg.waitReady;
  const als=new AsyncLocalStorage(),current=()=>als.getStore()||pg,queries=[],remote=[];
  db.query=async(sql,params=[])=>{queries.push(sql);const result=await current().query(sql,params);return {...result,rowCount:result.affectedRows};};
  db.exec=sql=>current().exec(sql);
  db.transaction=fn=>als.getStore()?fn(als.getStore()):pg.transaction(tx=>als.run(tx,()=>fn(tx)));
  try{
    await migrate();
    await db.exec(`INSERT INTO organizaciones(id,nombre) VALUES('org1','Prueba aislada');
      INSERT INTO negocios(id,nombre,organizacion_id) VALUES('n1','Prueba','org1');
      INSERT INTO usuarios(id,email,rol,activo) VALUES('admin','admin@fixture.invalid','administrador',1);
      INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES('admin','org1','administrador',1);
      INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada)
        VALUES('n1','101','51162','fixture-no-access','write_products,read_orders',TRUE);`);
    queries.length=0;
    const service=crearServicioBaselineTiendanube({database:db,syncEnabled:false,deliveriesEnabled:false,
      now:()=>new Date('2026-11-09T18:00:00Z'),apiFactory:()=>async(method,path)=>{remote.push({method,path});return [];}});
    const view=await service.preview('n1','admin');
    assert.equal(view.baseline_confirmable,false);assert.equal(view.stock_modificado,false);
    assert.deepEqual(view.variantes,[]);assert.ok(view.bloqueos.includes('SIN_VARIANTES_VINCULADAS'));
    assert.equal(remote.length,1);assert.equal(remote[0].method,'GET');
    assert.equal(queries.some(sql=>/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)),false);
  }finally{await pg.close();}
});
