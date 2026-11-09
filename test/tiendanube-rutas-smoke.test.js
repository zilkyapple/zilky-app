import test from 'node:test';
import assert from 'node:assert/strict';

test('la integración no expone acciones sin login y la web original sigue respondiendo', async () => {
  // URL falsa local: el test solo prueba middleware y páginas estáticas; nunca
  // abre conexiones PostgreSQL ni lee usuarios, productos o ventas reales.
  process.env.DATABASE_URL='postgresql://localhost:5432/zilky_integration_dummy_test';
  process.env.JWT_SECRET='jwt-prueba-local-que-no-corresponde-a-ninguna-cuenta-real';
  process.env.TIENDANUBE_APP_SECRET='clave-de-prueba-no-real';
  const { app } = await import('../src/app.js');
  const server=await new Promise(resolve=>{
    const candidate=app.listen(0,'127.0.0.1',()=>resolve(candidate));
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const unauthorized=await fetch(base+'/api/tiendanube/estado?negocio_id=un-negocio');
    assert.equal(unauthorized.status,401);
    const unsigned=await fetch(base+'/api/tiendanube/webhook',{
      method:'POST',headers:{'Content-Type':'application/json','x-linkedstore-hmac-sha256':'00'.repeat(32)},
      body:JSON.stringify({store_id:123,event:'order/created',id:5}),
    });
    assert.equal(unsigned.status,401);
    const privateUnsigned=await fetch(base+'/api/tiendanube/privacy/store-redact',{
      method:'POST',headers:{'Content-Type':'application/json','x-linkedstore-hmac-sha256':'00'.repeat(32)},
      body:JSON.stringify({store_id:123}),
    });
    assert.equal(privateUnsigned.status,401);
    const original=await fetch(base+'/tienda/zilky-indumentaria');
    assert.equal(original.status,200);
    assert.match(await original.text(),/html/i);
  } finally {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
