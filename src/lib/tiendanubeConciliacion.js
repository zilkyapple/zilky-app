import { validarIdExterno } from './tiendanube.js';

function validarReservaRemota(item) {
  const issues=item?.issues;
  if(issues==null)return;
  if(typeof issues!=='object'||Array.isArray(issues))throw new Error('Información de reserva remota inválida');
  if(!Object.hasOwn(issues,'unclaimed_stock'))return;
  const value=issues.unclaimed_stock;
  // A missing issues object is normal. An explicit unclaimed_stock must be a
  // non-negative integer, never a truthy/falsy coercion such as null or false.
  if(!['number','string'].includes(typeof value)
    ||typeof value==='string'&&!/^(?:0|[1-9]\d*)$/.test(value)
    ||!Number.isSafeInteger(Number(value))||Number(value)<0)throw new Error('Cantidad de stock no reservado inválida');
  if(Number(value)>0)throw Object.assign(new Error('Tiendanube informa unidades sin reserva de stock'),{
    code:'STOCK_REMOTO_NO_RESERVADO',status:409,
  });
}

// Un pedido no equivale a dinero cobrado ni a mercadería entregada. Este
// resumen se obtiene de la API actual y jamás del orden de los webhooks.
export function resumenPedidoTiendanube(pedido) {
  const orderId=validarIdExterno(pedido?.id);
  if (!Array.isArray(pedido.products)) throw new Error('Pedido sin detalle de productos');
  const cantidades=new Map();
  for (const item of pedido.products) {
    // Do not import quantities that the remote checkout failed to claim. This
    // check precedes every stock/ledger write in the caller, including paid or
    // repeated order notifications; payment is not evidence of a reservation.
    validarReservaRemota(item);
    const variantId=validarIdExterno(item.variant_id);
    const qty=Number(item.quantity);
    if (!Number.isSafeInteger(qty)||qty<1) throw new Error('Cantidad inválida en pedido');
    const anterior=cantidades.get(variantId)||0;
    if (!Number.isSafeInteger(anterior+qty)) throw new Error('Cantidad demasiado grande');
    cantidades.set(variantId,anterior+qty);
  }
  return {
    order_id:orderId,
    estado:String(pedido.status||'open').slice(0,60),
    pago_estado:String(pedido.payment_status||'pending').slice(0,60),
    pagado:pedido.payment_status==='paid',
    cancelado:pedido.status==='cancelled',
    cantidades:Object.fromEntries([...cantidades].sort(([a],[b])=>Number(a)-Number(b))),
  };
}

// Nunca crear movimientos locales por un webhook duplicado o porque un
// pedido aparece como pagado: la salida de dinero y de stock son distintas.
export function cambiosPedidoTiendanube(anterior,actual) {
  if (anterior?.order_id && anterior.order_id!==actual.order_id) throw new Error('Se mezclaron dos pedidos');
  const prev=anterior?.cantidades||{};
  const next=actual.cantidades;
  const delta={};
  for (const key of new Set([...Object.keys(prev),...Object.keys(next)])) {
    const diff=(next[key]||0)-(prev[key]||0);
    if (diff) delta[key]=diff;
  }
  return {delta,solo_cambio_pago:Object.keys(delta).length===0&&anterior?.pagado!==actual.pagado,
    requiere_revision_cancelacion:actual.cancelado&&!anterior?.cancelado};
}
