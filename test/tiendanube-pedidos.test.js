import test from 'node:test';
import assert from 'node:assert/strict';
import { resumenPedidoTiendanube, cambiosPedidoTiendanube } from '../src/lib/tiendanubeConciliacion.js';

const pedido=(props={})=>({id:22,status:'open',payment_status:'pending',products:[{variant_id:100,quantity:1},{variant_id:200,quantity:2}],...props});

test('pedido sin pagar se registra como pendiente y agrega variantes repetidas',()=>{
  const p=resumenPedidoTiendanube(pedido({products:[{variant_id:100,quantity:1},{variant_id:100,quantity:2}]}));
  assert.equal(p.pagado,false);
  assert.deepEqual(p.cantidades,{'100':3});
});

test('webhook duplicado o cambio de pago no crea delta de unidades',()=>{
  const antes=resumenPedidoTiendanube(pedido());
  assert.deepEqual(cambiosPedidoTiendanube(antes,antes).delta,{});
  const despues=resumenPedidoTiendanube(pedido({payment_status:'paid'}));
  assert.deepEqual(cambiosPedidoTiendanube(antes,despues),{delta:{},solo_cambio_pago:true,requiere_revision_cancelacion:false});
});

test('cambio de cantidades detecta edición; cancelación requiere revisión sin reponer automáticamente',()=>{
  const antes=resumenPedidoTiendanube(pedido());
  const editado=resumenPedidoTiendanube(pedido({products:[{variant_id:100,quantity:1},{variant_id:200,quantity:1}]}));
  assert.deepEqual(cambiosPedidoTiendanube(antes,editado).delta,{'200':-1});
  const cancelado=resumenPedidoTiendanube(pedido({status:'cancelled'}));
  assert.equal(cambiosPedidoTiendanube(antes,cancelado).requiere_revision_cancelacion,true);
});

test('rechaza cantidad inválida y pedidos sin detalle',()=>{
  assert.deepEqual(resumenPedidoTiendanube(pedido({products:[]})).cantidades,{});
  assert.throws(()=>resumenPedidoTiendanube(pedido({products:[{variant_id:100,quantity:-1}]})));
  assert.throws(()=>resumenPedidoTiendanube(pedido({products:null})));
});

test('stock remoto reservado admite issues ausente y cero explícito sin alterar cantidades',()=>{
  for(const issues of [undefined,null,{}, {unclaimed_stock:0}, {unclaimed_stock:'0'}]){
    const p=resumenPedidoTiendanube(pedido({products:[{variant_id:100,quantity:2,issues}]}));
    assert.deepEqual(p.cantidades,{'100':2});
  }
});

test('unclaimed_stock positivo se rechaza incluso si el pedido está pagado o repite variante',()=>{
  for(const value of [1,'1',2,'2']){
    assert.throws(()=>resumenPedidoTiendanube(pedido({payment_status:'paid',products:[
      {variant_id:100,quantity:1},
      {variant_id:100,quantity:2,issues:{unclaimed_stock:value}},
    ]})),err=>err.code==='STOCK_REMOTO_NO_RESERVADO'&&err.status===409);
  }
});

test('issues o unclaimed_stock ambiguos no se interpretan como una reserva válida',()=>{
  for(const issues of [[],false,true,0,'0',
    ...[undefined,null,false,true,-1,'-1',0.5,'0.0','',NaN,Infinity,[],{},'9007199254740993'].map(unclaimed_stock=>({unclaimed_stock})),
  ])assert.throws(()=>resumenPedidoTiendanube(pedido({products:[{variant_id:100,quantity:1,issues}]})));
});
