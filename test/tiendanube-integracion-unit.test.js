import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { stockPublicable, firmaWebhookValida, cifrarToken, descifrarToken, validarIdExterno, centavosAPesos, clienteTiendanube, detallePublicacion } from '../src/lib/tiendanube.js';

test('el stock agotado/negativo se publica como 0, sin convertir sin-control en inventario falso', () => {
  assert.equal(stockPublicable(0), 0);
  assert.equal(stockPublicable(-3), 0);
  assert.equal(stockPublicable(7), 7);
  assert.equal(stockPublicable(null), null);
  assert.throws(() => stockPublicable('7'));
});

test('precios publicados usan el precio de dos pagos y nunca suman dos veces 2500', () => {
  assert.deepEqual(detallePublicacion({id:'a',nombre:'Buzo',stock:1,precio_contado_centavos:4000000,precio_financiado_centavos:4250000}), {stock:1,price:'42500.00'});
  assert.equal(centavosAPesos(4050000),'40500.00');
});

test('webhook verifica cuerpo exacto con client secret y no acepta firmas corruptas', () => {
  const raw=Buffer.from('{"store_id":1,"id":2}');
  const secret='mi-secreto';
  const ok=createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal(firmaWebhookValida(raw,ok,secret),true);
  assert.equal(firmaWebhookValida(Buffer.from('{"store_id":1,"id":3}'),ok,secret),false);
  assert.equal(firmaWebhookValida(raw,ok.toUpperCase(),secret),true);
  assert.equal(firmaWebhookValida(raw,'x',secret),false);
});

test('token cifrado AES-GCM no se guarda en claro ni tolera alteraciones', () => {
  const previous=process.env.TIENDANUBE_TOKEN_KEY;
  process.env.TIENDANUBE_TOKEN_KEY=randomBytes(32).toString('hex');
  try {
    const token='access-token-privado';
    const value=cifrarToken(token);
    assert.equal(value.includes(token),false);
    assert.equal(descifrarToken(value),token);
    assert.throws(()=>descifrarToken(value.replace(/.$/,v=>v==='a'?'b':'a')));
  } finally {
    if(previous===undefined) delete process.env.TIENDANUBE_TOKEN_KEY;
    else process.env.TIENDANUBE_TOKEN_KEY=previous;
  }
});

test('cliente restringe ID y ruta, agrega User-Agent y no revela token en errores', async () => {
  assert.throws(()=>validarIdExterno('1/../../2'));
  let observed;
  const cliente=clienteTiendanube({tiendaId:'123',accessToken:'privado',contactEmail:'contacto@zilky.com',fetchImpl:async(url,options)=>{
    observed={url,options};return {ok:true,text:async()=>'{"id":1}'};
  }});
  assert.deepEqual(await cliente('GET','/products/1/variants/2'),{id:1});
  assert.equal(observed.url,'https://api.tiendanube.com/2025-03/123/products/1/variants/2');
  assert.equal(observed.options.headers.Authorization,'Bearer privado');
  assert.match(observed.options.headers['User-Agent'],/Zilky/);
  await assert.rejects(()=>cliente('GET','/../../admin'));
});
