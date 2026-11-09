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
