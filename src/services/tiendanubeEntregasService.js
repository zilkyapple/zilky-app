import { randomUUID } from 'node:crypto';
import { clienteTiendanube, descifrarToken, validarIdExterno } from '../lib/tiendanube.js';
import { dateISO, integer } from '../lib/validation.js';
import { addDays } from '../lib/dates.js';
import { huella, solicitudId } from '../lib/solicitud.js';
import { hashPedidoPrivacidad } from './tiendanubePrivacidadService.js';

const fallo=(code,status=409)=>Object.assign(new Error(code),{code,status});
const ID=/^[A-Za-z0-9_-]{1,200}$/;
const DESCUENTO=250000;
const MAX=2147483647;
const permitidos=new Set(['negocio_id','solicitud_id','cliente_id','comision_usuario_id','fecha_entrega',
  'condicion_precio','entrega_inicial_centavos','medio_pago_entrega','fecha_hora_cobro','fecha_limite',
  'total_esperado_centavos','confirmar_entrega','confirmar_cobro','cobro_ya_registrado']);
const diaAR=value=>new Date(new Date(value).valueOf()-3*3600000).toISOString().slice(0,10);
const localId=value=>{if(typeof value!=='string'||!ID.test(value))throw fallo('IDENTIFICADOR_LOCAL_INVALIDO',400);return value;};
const external=value=>{try{return validarIdExterno(value);}catch{throw fallo('IDENTIFICADOR_REMOTO_INVALIDO',400);}};
const sumar=(a,b)=>integer(a+b,'importe total',{max:MAX});
const objeto=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const permiso=(value,key)=>{try{const p=typeof value==='string'?JSON.parse(value):value;return objeto(p)&&p[key]===true;}catch{return false;}};

// No binary floating-point multiplication/rounding: a non-cent amount or an
// ambiguous decimal is rejected rather than silently changing agreed prices.
export function pesosTiendanubeACentavos(value){
  if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw fallo('IMPORTE_REMOTO_INVALIDO');
  const text=String(value);
  if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text))throw fallo('IMPORTE_REMOTO_INVALIDO');
  const [pesos,fraccion='']=text.split('.');
  const cents=BigInt(pesos)*100n+BigInt(fraccion.padEnd(2,'0'));
  if(cents>BigInt(MAX))throw fallo('IMPORTE_REMOTO_FUERA_DE_RANGO');
  return Number(cents);
}

function cantidad(value){
  if(!['number','string'].includes(typeof value))throw fallo('CANTIDAD_REMOTA_INVALIDA');
  if(typeof value==='string'&&!/^[1-9]\d*$/.test(value))throw fallo('CANTIDAD_REMOTA_INVALIDA');
  try{return integer(Number(value),'cantidad',{min:1,max:10000});}catch{throw fallo('CANTIDAD_REMOTA_INVALIDA');}
}
function cantidades(value){
  if(!objeto(value)||!Object.keys(value).length||Object.keys(value).length>100)throw fallo('RESUMEN_PEDIDO_INVALIDO');
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[external(k),cantidad(v)]).sort(([a],[b])=>a.localeCompare(b)));
}
function iguales(a,b){return huella(a)===huella(b);}
function fechaCobro(value,fecha,now){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw fallo('FECHA_COBRO_INVALIDA',400);
  dateISO(value.slice(0,10),'fecha de cobro');
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)||ms>new Date(now).valueOf())throw fallo('FECHA_COBRO_INVALIDA',400);
  if(diaAR(ms)!==fecha)throw fallo('ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION');
  // Cash/dashboard queries use the stored calendar prefix, so normalize to AR.
  return new Date(ms-3*3600000).toISOString().replace('Z','-03:00');
}
function normalizarInput(n,input,now){
  localId(n);
  if(!objeto(input)||Object.keys(input).some(k=>!permitidos.has(k)))throw fallo('CAMPOS_ENTREGA_INVALIDOS',400);
  if(input.negocio_id!==undefined&&input.negocio_id!==n)throw fallo('NEGOCIO_CONTRADICTORIO',403);
  solicitudId(input.solicitud_id);
  if(input.confirmar_entrega!==true)throw fallo('CONFIRMAR_ENTREGA_FISICA',400);
  if(!['contado','30_dias'].includes(input.condicion_precio))throw fallo('CONDICION_PRECIO_INVALIDA',400);
  dateISO(input.fecha_entrega,'fecha de entrega');
  if(input.fecha_entrega>diaAR(now))throw fallo('ENTREGA_FUTURA_NO_PERMITIDA',400);
  integer(input.entrega_inicial_centavos,'dinero recibido');
  integer(input.total_esperado_centavos,'total esperado',{min:1});
  if(input.entrega_inicial_centavos>input.total_esperado_centavos)throw fallo('COBRO_SUPERA_TOTAL',400);
  if(input.condicion_precio==='contado'&&input.entrega_inicial_centavos!==input.total_esperado_centavos)throw fallo('CONTADO_REQUIERE_COBRO_COMPLETO',400);
  if(input.cobro_ya_registrado===true)throw fallo('COBRO_EXISTENTE_REQUIERE_CONCILIACION');
  const recibio=input.entrega_inicial_centavos>0;
  if(recibio&&(input.confirmar_cobro!==true||input.cobro_ya_registrado!==false))throw fallo('CONFIRMAR_COBRO_REAL_NO_REGISTRADO',400);
  if(recibio&&!['efectivo','transferencia'].includes(input.medio_pago_entrega))throw fallo('MEDIO_COBRO_NO_SOPORTADO',400);
  if(!recibio&&(input.fecha_hora_cobro!=null||input.medio_pago_entrega!=null))throw fallo('COBRO_CERO_SIN_FECHA_NI_MEDIO',400);
  const limite=input.fecha_limite||addDays(input.fecha_entrega,30);
  dateISO(limite,'fecha límite');
  if(limite<input.fecha_entrega)throw fallo('VENCIMIENTO_ANTERIOR_A_ENTREGA',400);
  const saldo=input.total_esperado_centavos-input.entrega_inicial_centavos;
  if(saldo>0&&!input.cliente_id)throw fallo('CLIENTE_REQUERIDO_PARA_SALDO',400);
  return {solicitud_id:input.solicitud_id,cliente_id:input.cliente_id?localId(input.cliente_id):null,
    comision_usuario_id:input.comision_usuario_id?localId(input.comision_usuario_id):null,
    fecha_entrega:input.fecha_entrega,condicion_precio:input.condicion_precio,
    entrega_inicial_centavos:input.entrega_inicial_centavos,total_esperado_centavos:input.total_esperado_centavos,
    fecha_limite:saldo>0?limite:null,medio_pago_entrega:recibio?input.medio_pago_entrega:null,
    fecha_hora_cobro:recibio?fechaCobro(input.fecha_hora_cobro,input.fecha_entrega,now):null};
}

/** Only a strict, supported subset is accepted. Shipping, coupons, promotions,
 * fees, refunds, kits and unclear discounts stay in manual reconciliation.
 * Never read customer/contact/payment card fields or infer receipts from paid.
 */
export function validarPedidoEntregaTiendanube(raw,{storeId,orderId,condicionPrecio,fechaEntrega,entregaInicialCentavos}){
  if(!['contado','30_dias'].includes(condicionPrecio))throw fallo('CONDICION_PRECIO_INVALIDA',400);
  dateISO(fechaEntrega,'fecha de entrega');
  if(!objeto(raw)||external(raw.id)!==external(orderId)||external(raw.store_id)!==external(storeId))throw fallo('PEDIDO_REMOTO_DISTINTO');
  if(raw.currency!=='ARS')throw fallo('MONEDA_NO_SOPORTADA');
  if(!['open','closed'].includes(raw.status)||raw.cancelled_at)throw fallo('PEDIDO_CANCELADO_O_NO_ENTREGABLE');
  if(!['pending','authorized','paid','partially_paid'].includes(raw.payment_status))throw fallo('ESTADO_PAGO_REQUIERE_CONCILIACION');
  if(raw.paid_at&&(Number.isNaN(Date.parse(raw.paid_at))||diaAR(raw.paid_at)!==fechaEntrega))throw fallo('ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION');
  const totalCobradoRemoto=raw.total_paid_by_customer==null?null:pesosTiendanubeACentavos(raw.total_paid_by_customer);
  const reportaCobro=['paid','partially_paid'].includes(raw.payment_status)||!!raw.paid_at||totalCobradoRemoto>0;
  if(reportaCobro&&(!['offline','custom','internal','not-provided'].includes(raw.gateway)||raw.payment_details?.credit_card_company))throw fallo('COBRO_PASARELA_REQUIERE_CONCILIACION');
  // This amount is only a discrepancy detector, never a source for a new
  // receipt. A contradictory positive amount requires human reconciliation.
  if(totalCobradoRemoto>0&&entregaInicialCentavos!==undefined&&totalCobradoRemoto!==entregaInicialCentavos)throw fallo('COBRO_REMOTO_CONTRADICTORIO_REQUIERE_CONCILIACION');
  if(raw.total_paid_by_customer_including_fees!=null&&totalCobradoRemoto!=null
    &&pesosTiendanubeACentavos(raw.total_paid_by_customer_including_fees)!==totalCobradoRemoto)throw fallo('CARGOS_PASARELA_REQUIEREN_CONCILIACION');
  if(!Array.isArray(raw.products)||!raw.products.length||raw.products.length>100)throw fallo('DETALLE_REMOTO_INVALIDO');
  const lines=[],qty={};let subtotal=0,units=0;
  for(const p of raw.products){
    if(!objeto(p)||p.catalog_kit_id||p.order_kit_id||p.kit)throw fallo('KIT_REMOTO_NO_SOPORTADO');
    if(p.issues?.unclaimed_stock&&Number(p.issues.unclaimed_stock)!==0)throw fallo('STOCK_REMOTO_NO_RESERVADO');
    const variant=external(p.variant_id),product=external(p.product_id),q=cantidad(p.quantity);
    const price=pesosTiendanubeACentavos(p.price);
    if(price<=0||price%50000!==0)throw fallo('PRECIO_PACTADO_REQUIERE_REVISION');
    qty[variant]=sumar(qty[variant]||0,q);units=sumar(units,q);
    subtotal=sumar(subtotal,integer(price*q,'subtotal'));
    lines.push({variant_id:variant,product_id:product,cantidad:q,precio_publicado_centavos:price});
  }
  if(pesosTiendanubeACentavos(raw.subtotal)!==subtotal)throw fallo('SUBTOTAL_REMOTO_NO_COINCIDE');
  const zero=v=>v==null||pesosTiendanubeACentavos(v)===0;
  for(const key of ['shipping_cost','shipping_cost_customer','shipping_cost_owner','tax','taxes','fee','fees'])if(!zero(raw[key]))throw fallo('ENVIO_IMPUESTOS_O_CARGOS_REQUIEREN_CONCILIACION');
  if(raw.subtotal_without_taxes!=null&&pesosTiendanubeACentavos(raw.subtotal_without_taxes)!==subtotal)throw fallo('IMPUESTOS_REQUIEREN_CONCILIACION');
  if(raw.coupon_id!=null||raw.coupon!=null&&(!Array.isArray(raw.coupon)||raw.coupon.length))throw fallo('CUPON_REQUIERE_CONCILIACION');
  if(!zero(raw.discount_coupon))throw fallo('CUPON_REQUIERE_CONCILIACION');
  const promo=raw.promotional_discount;
  if(promo!=null&&(!objeto(promo)||!zero(promo.total_discount_amount)||(promo.contents?.length||promo.promotions_applied?.length)))throw fallo('PROMOCION_REQUIERE_CONCILIACION');
  const discount=pesosTiendanubeACentavos(raw.discount),gateway=raw.discount_gateway==null?0:pesosTiendanubeACentavos(raw.discount_gateway);
  const total=pesosTiendanubeACentavos(raw.total),cash=condicionPrecio==='contado';
  const expectedDiscount=cash?integer(DESCUENTO*units,'descuento'):0;
  let origin='ninguno';
  if(discount===0&&gateway===0&&total===subtotal)origin=cash?'local':'ninguno';
  else if(cash&&discount===expectedDiscount&&gateway===discount&&total===subtotal-discount)origin='remoto';
  else throw fallo('DESCUENTO_O_TOTAL_REMOTO_REQUIERE_CONCILIACION');
  for(const line of lines){
    line.descuento_unitario_centavos=cash?DESCUENTO:0;
    line.precio_unitario_centavos=line.precio_publicado_centavos-line.descuento_unitario_centavos;
    if(line.precio_unitario_centavos<=0)throw fallo('DESCUENTO_SUPERA_PRECIO');
  }
  lines.sort((a,b)=>a.variant_id.localeCompare(b.variant_id)||a.precio_unitario_centavos-b.precio_unitario_centavos);
  return {lineas:lines,cantidades:cantidades(qty),precio_publicado_centavos:subtotal,
    descuento_centavos:expectedDiscount,descuento_origen:origin,total_centavos:subtotal-expectedDiscount};
}
function resultado(row,repetida=false){
  return {estado:'entregada',venta_id:row.venta_id,credito_id:row.credito_id,pago_inicial_id:row.pago_inicial_id||null,
    condicion_precio:row.condicion_precio,fecha_entrega:row.fecha_entrega,fecha_limite:row.fecha_limite||null,
    total_centavos:row.total_centavos,entrega_inicial_centavos:row.entrega_inicial_centavos,
    saldo_inicial_centavos:row.total_centavos-row.entrega_inicial_centavos,
    reserva_adoptada:true,stock_descontado_ahora:0,repetida};
}

/** Experimental and off by default. Call only for a human-confirmed delivery,
 * never from a webhook. The service enforces its own business permissions.
 * All DB work, sale, cash, commission and link share one transaction. The
 * only remote operation is GET; there is no cross-platform atomicity claim.
 */
export function crearServicioEntregasTiendanube({database,crearVentaReservada,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  enabled=()=>process.env.TIENDANUBE_ENTREGAS_ENABLED==='true',now=()=>new Date()}={}){
  let currentDb=database,currentVenta=crearVentaReservada;
  const obtenerDb=async()=>currentDb||(currentDb=(await import('../db/connection.js')).db);
  const ventaReservada=async(...args)=>(currentVenta||(currentVenta=(await import('./ventasService.js')).crearVentaConReservaTiendanube))(...args);
  async function confirmarEntregaTiendanube(n,orderId,input,actor){
    if(!(typeof enabled==='function'?enabled():enabled===true))throw fallo('ENTREGAS_TIENDANUBE_DESHABILITADAS',503);
    const b=normalizarInput(n,input,now()),order=external(orderId);localId(actor);
    const db=await obtenerDb();
    return db.transaction(async()=>{
      const first=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      if(!first)throw fallo('CONEXION_NO_DISPONIBLE',404);
      const store=external(first.store_id),orderHash=hashPedidoPrivacidad(store,order);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${store}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(n);
      if(!con||con.store_id!==store)throw fallo('CONEXION_CAMBIO_DURANTE_BLOQUEO');
      const negocio=await db.prepare('SELECT id,organizacion_id FROM negocios WHERE id=? FOR SHARE').get(n);
      if(!negocio?.organizacion_id)throw fallo('NEGOCIO_NO_DISPONIBLE',404);
      const user=await db.prepare('SELECT id,rol,activo FROM usuarios WHERE id=? FOR SHARE').get(actor);
      if(!user||user.activo!==1)throw fallo('ACTOR_NO_AUTORIZADO',403);
      const verificarAdminOrganizacion=async u=>{
        const membership=await db.prepare('SELECT activo,rol FROM usuario_organizacion WHERE organizacion_id=? AND usuario_id=? FOR SHARE').get(negocio.organizacion_id,u);
        if(membership?.activo!==1||membership.rol!=='administrador')throw fallo('ADMINISTRADOR_DE_OTRA_ORGANIZACION',403);
      };
      let permisos={};
      if(user.rol==='administrador')await verificarAdminOrganizacion(actor);
      else{
        const membership=await db.prepare('SELECT activo,permisos FROM usuario_negocio WHERE negocio_id=? AND usuario_id=? FOR SHARE').get(n,actor);
        permisos=membership?.permisos;
        if(membership?.activo!==1||!permiso(permisos,'ventas.crear')||!permiso(permisos,'tienda.pedidos'))throw fallo('SIN_PERMISO_ENTREGA_EN_NEGOCIO',403);
        if(b.cliente_id&&!permiso(permisos,'clientes.ver'))throw fallo('SIN_PERMISO_CLIENTE',403);
        if(b.entrega_inicial_centavos>0&&!permiso(permisos,'pagos.registrar'))throw fallo('SIN_PERMISO_REGISTRAR_COBRO',403);
        if(b.comision_usuario_id&&b.comision_usuario_id!==actor)throw fallo('NO_PUEDE_ATRIBUIR_OTRO_VENDEDOR',403);
      }
      const vendedor=b.comision_usuario_id||actor;
      const seller=await db.prepare('SELECT id,rol,activo FROM usuarios WHERE id=? FOR SHARE').get(vendedor);
      if(!seller||seller.activo!==1)throw fallo('VENDEDOR_NO_AUTORIZADO',403);
      if(seller.rol==='administrador')await verificarAdminOrganizacion(vendedor);
      else{
        const membership=await db.prepare('SELECT activo,permisos FROM usuario_negocio WHERE negocio_id=? AND usuario_id=? FOR SHARE').get(n,vendedor);
        if(membership?.activo!==1)throw fallo('VENDEDOR_DE_OTRO_NEGOCIO',403);
      }
      const redactado=async()=>!!await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(store,orderHash);
      if(await redactado())throw fallo('PEDIDO_REDACTADO',410);
      const {solicitud_id,...semantic}=b,requestHash=huella({...semantic,comision_usuario_id:vendedor});
      const used=await db.prepare('SELECT store_id,order_hash FROM tiendanube_entregas WHERE negocio_id=? AND confirmado_por=? AND solicitud_id=?').get(n,actor,solicitud_id);
      if(used&&(used.store_id!==store||used.order_hash!==orderHash))throw fallo('SOLICITUD_ENTREGA_REUTILIZADA');
      const old=await db.prepare('SELECT * FROM tiendanube_entregas WHERE store_id=? AND order_hash=? FOR UPDATE').get(store,orderHash);
      if(old){if(old.negocio_id!==n||old.solicitud_hash!==requestHash)throw fallo('PEDIDO_YA_ENTREGADO_CON_OTROS_DATOS');return resultado(old,true);}
      if(con.pausada||!con.sync_baseline_at||!con.sync_activada_at||!con.sync_webhooks_at||con.sync_lease_token)throw fallo('SINCRONIZACION_NO_LISTA_PARA_ENTREGA');
      const cargarResumen=async()=>{
        const p=await db.prepare('SELECT * FROM tiendanube_pedidos WHERE store_id=? AND order_id=? FOR UPDATE').get(store,order);
        if(!p||p.negocio_id!==n||p.cancelado||p.pendiente_revision||!['open','closed'].includes(p.estado))throw fallo('PEDIDO_NO_CONCILIADO_PARA_ENTREGA');
        return p;
      };
      const verificarEventos=async()=>{
        const e=await db.prepare(`SELECT id FROM tiendanube_eventos WHERE store_id=? AND recurso_id=? AND topic LIKE 'order/%'
          AND (topic='order/edited' OR (procesado_at IS NULL AND sync_estado<>'ignorado')) LIMIT 1`).get(store,order);
        if(e)throw fallo('EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION');
      };
      const summary=await cargarResumen();await verificarEventos();
      // Ordinary crearVenta takes the request lock before the customer lock.
      // Keep that order even when a request UUID collides with a legacy sale.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`venta:${n}:${actor}:${solicitud_id}`]);
      if(b.cliente_id){
        // Same customer-before-finance/row lock order as ordinary sales and
        // corrections. Do not hold a customer row while waiting on its lock.
        await db.lockClienteNegocio(b.cliente_id,n);
        const c=await db.prepare(`SELECT c.id,c.consumidor_final_negocio FROM clientes c JOIN cliente_negocio cn ON cn.cliente_id=c.id
          WHERE c.id=? AND cn.negocio_id=? FOR SHARE OF c,cn`).get(b.cliente_id,n);
        if(!c)throw fallo('CLIENTE_NO_VINCULADO_AL_NEGOCIO',404);
        if(c.consumidor_final_negocio&&(c.consumidor_final_negocio!==n||b.entrega_inicial_centavos!==b.total_esperado_centavos))throw fallo('CLIENTE_ANONIMO_NO_ADMITE_SALDO');
      }
      let remote;
      try{remote=await apiFactory(con)('GET',`/orders/${order}`);}catch{throw fallo('NO_SE_PUDO_VERIFICAR_PEDIDO_REMOTO',503);}
      const creado=Date.parse(remote?.created_at),corte=new Date(con.sync_activada_at).valueOf();
      if(!Number.isFinite(creado)||!Number.isFinite(corte)||creado<corte||diaAR(creado)>b.fecha_entrega)throw fallo('FECHA_PEDIDO_FUERA_DEL_PERIODO_CONCILIADO');
      const priced=validarPedidoEntregaTiendanube(remote,{storeId:store,orderId:order,condicionPrecio:b.condicion_precio,
        fechaEntrega:b.fecha_entrega,entregaInicialCentavos:b.entrega_inicial_centavos});
      remote=null; // Never retain/store/log customer, tokens, notes or arbitrary payload.
      if(!iguales(priced.cantidades,cantidades(summary.cantidades)))throw fallo('PEDIDO_REMOTO_EDITADO_REQUIERE_CONCILIACION');
      if(priced.total_centavos!==b.total_esperado_centavos)throw fallo('PRECIO_CAMBIO_REVISAR_ANTES_DE_ENTREGAR');
      const reservas=await db.prepare('SELECT variant_id,producto_id,cantidad_aplicada FROM tiendanube_pedido_stock WHERE store_id=? AND order_hash=? ORDER BY variant_id FOR UPDATE').all(store,orderHash);
      if(!reservas.length||reservas.length!==Object.keys(priced.cantidades).length)throw fallo('RESERVA_INCOMPLETA');
      const byVariant=new Map(),stockEsperado=new Map();
      for(const r of reservas){
        if(r.cantidad_aplicada!==priced.cantidades[r.variant_id]||byVariant.has(r.variant_id))throw fallo('RESERVA_NO_COINCIDE');
        const link=await db.prepare(`SELECT v.producto_id,v.product_id,v.variant_id,p.negocio_id FROM tiendanube_variantes v
          JOIN productos p ON p.id=v.producto_id WHERE v.negocio_id=? AND v.store_id=? AND v.variant_id=?`).get(n,store,r.variant_id);
        if(!link||link.negocio_id!==n||link.producto_id!==r.producto_id)throw fallo('VINCULO_RESERVA_CAMBIO');
        byVariant.set(r.variant_id,link);stockEsperado.set(r.producto_id,sumar(stockEsperado.get(r.producto_id)||0,r.cantidad_aplicada));
      }
      const lines=priced.lineas.map(line=>{
        const link=byVariant.get(line.variant_id);
        if(!link||String(link.product_id)!==line.product_id)throw fallo('PRODUCTO_REMOTO_NO_COINCIDE');
        return {...line,producto_id:link.producto_id};
      });
      const saleInput={negocio_id:n,cliente_id:b.cliente_id,fecha:b.fecha_entrega,modalidad:'unico',canal:'minorista',
        items:lines.map(l=>({producto_id:l.producto_id,cantidad:l.cantidad,precio_unitario_centavos:l.precio_unitario_centavos})),
        monto_total_centavos:priced.total_centavos,entrega_inicial_centavos:b.entrega_inicial_centavos,
        medio_pago_entrega:b.medio_pago_entrega,plan:{fecha_limite:b.fecha_limite||addDays(b.fecha_entrega,30)},
        usuario_id:actor,comision_usuario_id:vendedor,solicitud_id};
      let adopted=false;
      const result=await ventaReservada(saleInput,{fechaHoraCobro:b.fecha_hora_cobro,adoptar:async({negocio_id,venta_id,stock,lineas})=>{
        if(adopted||negocio_id!==n||!(stock instanceof Map)||!iguales([...stock].sort(),[...stockEsperado].sort())||!Array.isArray(lineas)||lineas.some(l=>l.componentes?.length))throw fallo('ADOPCION_RESERVA_INVALIDA');
        if(await redactado())throw fallo('PEDIDO_REDACTADO',410);
        const latest=await cargarResumen();await verificarEventos();
        if(!iguales(cantidades(latest.cantidades),priced.cantidades))throw fallo('PEDIDO_CAMBIO_DURANTE_CONFIRMACION');
        const current=await db.prepare('SELECT variant_id,producto_id,cantidad_aplicada FROM tiendanube_pedido_stock WHERE store_id=? AND order_hash=? ORDER BY variant_id FOR UPDATE').all(store,orderHash);
        if(!iguales(current,reservas))throw fallo('RESERVA_CAMBIO_DURANTE_CONFIRMACION');
        const cfg=await db.prepare('SELECT activa,momento FROM comision_config WHERE negocio_id=? FOR SHARE').get(n);
        if(!cfg?.activa||cfg.momento!=='venta')throw fallo('COMISION_A_LA_ENTREGA_NO_CONFIGURADA');
        const cierre=await db.prepare('SELECT max(mes) mes FROM comision_cierres WHERE negocio_id=? AND usuario_id=?').get(n,vendedor);
        if(cierre?.mes&&b.fecha_entrega.slice(0,7)<=cierre.mes)throw fallo('MES_COMISION_CERRADO_REQUIERE_REVISION');
        for(const [product] of [...stockEsperado].sort()){
          const p=await db.prepare('SELECT id,stock FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(product,n);
          if(!p||!Number.isSafeInteger(p.stock)||p.stock<0)throw fallo('PRODUCTO_RESERVADO_NO_DISPONIBLE');
          const combo=await db.prepare('SELECT producto_id FROM producto_combo_componentes WHERE combo_id=? LIMIT 1').get(product);
          if(combo)throw fallo('COMBO_RESERVADO_NO_SOPORTADO');
          const rule=await db.prepare(`SELECT tipo,valor FROM comision_reglas WHERE negocio_id=? AND producto_id=? AND canal='minorista'
            AND (usuario_id=? OR usuario_id IS NULL) ORDER BY usuario_id NULLS LAST LIMIT 1`).get(n,product,vendedor)
            ||await db.prepare('SELECT tipo,valor FROM comision_producto WHERE producto_id=?').get(product);
          if(!rule)throw fallo('COMISION_PRODUCTO_NO_CONFIGURADA');
          await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,usuario_id,venta_id,solicitud_id)
            VALUES(?,?,?,'entrega_tiendanube',?,?,?,?,?,?)`).run(randomUUID(),product,n,p.stock,p.stock,'Reserva Tiendanube convertida en venta',actor,venta_id,`tn-entrega:${orderHash}`);
        }
        adopted=true;
      }});
      if(!adopted||!result?.venta?.id||!result?.credito?.id)throw fallo('VENTA_NO_ADOPTO_RESERVA');
      if(result.venta.negocio_id!==n||result.venta.monto_total_centavos!==priced.total_centavos||result.venta.entrega_inicial_centavos!==b.entrega_inicial_centavos||result.venta.vendedor_id!==vendedor
        ||result.credito.venta_id!==result.venta.id||result.credito.negocio_id!==n)throw fallo('RESULTADO_VENTA_NO_COINCIDE');
      const payment=result.entregaInicial?.pago;
      if(b.entrega_inicial_centavos>0?(!payment?.id||payment.monto_centavos!==b.entrega_inicial_centavos||payment.fecha_hora!==b.fecha_hora_cobro||payment.credito_id!==result.credito.id):!!payment)throw fallo('RESULTADO_COBRO_NO_COINCIDE');
      const row=await db.prepare(`INSERT INTO tiendanube_entregas(store_id,order_hash,negocio_id,venta_id,credito_id,pago_inicial_id,confirmado_por,vendedor_id,
        solicitud_id,solicitud_hash,condicion_precio,fecha_entrega,fecha_limite,fecha_hora_cobro,medio_pago,precio_publicado_centavos,descuento_centavos,
        descuento_origen,total_centavos,entrega_inicial_centavos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(
          store,orderHash,n,result.venta.id,result.credito.id,payment?.id||null,actor,vendedor,solicitud_id,requestHash,b.condicion_precio,
          b.fecha_entrega,b.fecha_limite,b.fecha_hora_cobro,b.medio_pago_entrega,priced.precio_publicado_centavos,priced.descuento_centavos,
          priced.descuento_origen,priced.total_centavos,b.entrega_inicial_centavos);
      for(let i=0;i<lines.length;i++){
        const l=lines[i];
        await db.prepare(`INSERT INTO tiendanube_entrega_items(store_id,order_hash,posicion,producto_id,variant_id,cantidad,precio_publicado_centavos,
          descuento_unitario_centavos,precio_unitario_centavos) VALUES(?,?,?,?,?,?,?,?,?)`).run(store,orderHash,i,l.producto_id,l.variant_id,l.cantidad,
            l.precio_publicado_centavos,l.descuento_unitario_centavos,l.precio_unitario_centavos);
      }
      return resultado(row);
    });
  }
  return {confirmarEntregaTiendanube};
}

export const tiendanubeEntregasService=crearServicioEntregasTiendanube();
export const confirmarEntregaTiendanube=(...args)=>tiendanubeEntregasService.confirmarEntregaTiendanube(...args);
