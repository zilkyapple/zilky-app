import { randomUUID } from 'node:crypto';
import { clienteTiendanube, descifrarToken, validarIdExterno, centavosAPesos } from '../lib/tiendanube.js';
import { resumenPedidoTiendanube } from '../lib/tiendanubeConciliacion.js';
import { huella, solicitudId } from '../lib/solicitud.js';
import { integer } from '../lib/validation.js';
import { crearRepositorioTiendanubeSync } from './tiendanubeSyncService.js';
import { pesosTiendanubeACentavos } from './tiendanubeEntregasService.js';
import { hashPedidoPrivacidad } from './tiendanubePrivacidadService.js';

const fallo=(code,status=409)=>Object.assign(new Error(code),{code,status});
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const local=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(v))throw fallo('IDENTIFICADOR_LOCAL_INVALIDO',400);return v;};
const fecha=v=>v==null?NaN:new Date(v).getTime();
const permiso=(v,k)=>{try{const p=typeof v==='string'?JSON.parse(v):v;return obj(p)&&p[k]===true;}catch{return false;}};
const instalacion=c=>huella({store_id:c.store_id,app_id:c.app_id,token_cifrado:c.token_cifrado,scopes:c.scopes,sync_activada_at:c.sync_activada_at});
const iguales=(a,b)=>huella(a)===huella(b);
function normalizar(input){
  if(!obj(input)||Object.keys(input).some(k=>!['solicitud_id','items','total_esperado_centavos'].includes(k)))throw fallo('RESERVA_INPUT_INVALIDO',400);
  solicitudId(input.solicitud_id);integer(input.total_esperado_centavos,'total esperado',{min:1});
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100)throw fallo('RESERVA_ITEMS_INVALIDOS',400);
  const q=new Map();
  for(const it of input.items){
    if(!obj(it)||Object.keys(it).some(k=>!['producto_id','cantidad'].includes(k)))throw fallo('RESERVA_ITEM_INVALIDO',400);
    local(it.producto_id);integer(it.cantidad,'cantidad',{min:1,max:10000});
    q.set(it.producto_id,integer((q.get(it.producto_id)||0)+it.cantidad,'cantidad total',{min:1,max:10000}));
  }
  return {solicitud_id:input.solicitud_id.toLowerCase(),total_esperado_centavos:input.total_esperado_centavos,
    items:[...q].sort(([a],[b])=>a.localeCompare(b)).map(([producto_id,cantidad])=>({producto_id,cantidad}))};
}
function validarRespuesta(raw,intento){
  if(!obj(raw)||String(raw.store_id)!==intento.store_id)throw fallo('RESPUESTA_RESERVA_OTRA_TIENDA');
  const p=resumenPedidoTiendanube(raw),order=validarIdExterno(raw.id);
  if(raw.currency!=='ARS'||raw.status!=='open'||raw.payment_status!=='pending'||raw.cancelled_at||raw.paid_at)throw fallo('RESPUESTA_RESERVA_ESTADO_INVALIDO');
  if(raw.gateway!=='offline'||raw.note!==`ZILKY-RESERVA:${intento.id}`)throw fallo('RESPUESTA_RESERVA_CORRELACION_INVALIDA');
  const expected=Object.fromEntries(intento.items.map(i=>[i.variant_id,i.cantidad]));
  if(!iguales(p.cantidades,expected))throw fallo('RESPUESTA_RESERVA_CANTIDADES_DISTINTAS');
  for(const line of raw.products){
    const item=intento.items.find(i=>i.variant_id===String(line.variant_id));
    if(!item||String(line.product_id)!==item.product_id||line.kit||line.catalog_kit_id||line.order_kit_id
      ||pesosTiendanubeACentavos(line.price)!==item.precio_publicado_centavos)throw fallo('RESPUESTA_RESERVA_PRODUCTO_O_PRECIO_DISTINTO');
  }
  if(pesosTiendanubeACentavos(raw.subtotal)!==intento.total_centavos||pesosTiendanubeACentavos(raw.total)!==intento.total_centavos)throw fallo('RESPUESTA_RESERVA_TOTAL_DISTINTO');
  for(const key of ['discount','discount_coupon','discount_gateway','shipping_cost','shipping_cost_customer','shipping_cost_owner','tax','taxes','fee','fees','total_paid_by_customer']){
    if(raw[key]!=null&&pesosTiendanubeACentavos(raw[key])!==0)throw fallo('RESPUESTA_RESERVA_CARGOS_O_PAGOS');
  }
  if(raw.coupon!=null&&(!Array.isArray(raw.coupon)||raw.coupon.length))throw fallo('RESPUESTA_RESERVA_DESCUENTO');
  const promo=raw.promotional_discount;
  if(promo!=null&&(!obj(promo)||(promo.total_discount_amount!=null&&pesosTiendanubeACentavos(promo.total_discount_amount)!==0)
    ||promo.contents?.length||promo.promotions_applied?.length))throw fallo('RESPUESTA_RESERVA_DESCUENTO');
  if(!Number.isFinite(fecha(raw.created_at)))throw fallo('RESPUESTA_RESERVA_SIN_FECHA');
  return {p,order};
}

/** INTERNAL preparation; not wired to a route or ordinary sales.
 * Tiendanube claim is a reservation, not a receipt, physical delivery or sale.
 * `canalesCentralizados` must be supplied by a future server-only adapter that
 * has closed ALL old stock-decrement paths for linked variants. The default
 * false prevents env flags alone from enabling an unsafe mixed-authority flow.
 * Until that adapter and real concurrent-checkout tests exist, do not enable.
 */
export function crearServicioReservasTiendanube({db,enabled=()=>process.env.TIENDANUBE_RESERVAS_ENABLED==='true',
  syncEnabled=()=>process.env.TIENDANUBE_SYNC_ENABLED==='true',canalesCentralizados=()=>false,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  now=()=>new Date(),uuid=randomUUID}={}){
  if(!db)throw new Error('Falta adaptador PostgreSQL de reservas');
  const repo=crearRepositorioTiendanubeSync(db),flag=v=>typeof v==='function'?v()===true:v===true;
  async function autorizar(n,actor){
    const negocio=await db.prepare('SELECT organizacion_id FROM negocios WHERE id=? FOR SHARE').get(n);
    const u=await db.prepare('SELECT rol,activo FROM usuarios WHERE id=? FOR SHARE').get(actor);
    if(!negocio?.organizacion_id||!u||u.activo!==1)throw fallo('ACTOR_NO_AUTORIZADO',403);
    if(u.rol==='administrador'){
      const m=await db.prepare('SELECT rol,activo FROM usuario_organizacion WHERE organizacion_id=? AND usuario_id=? FOR SHARE').get(negocio.organizacion_id,actor);
      if(m?.activo!==1||m.rol!=='administrador')throw fallo('ADMINISTRADOR_DE_OTRA_ORGANIZACION',403);
    }else{
      const m=await db.prepare('SELECT activo,permisos FROM usuario_negocio WHERE negocio_id=? AND usuario_id=? FOR SHARE').get(n,actor);
      if(m?.activo!==1||!permiso(m.permisos,'ventas.crear')||!permiso(m.permisos,'tienda.pedidos'))throw fallo('SIN_PERMISO_RESERVAR_EN_NEGOCIO',403);
    }
  }
  async function resultado(row,repetida=false){
    const p=row.order_hash?await db.prepare('SELECT order_id FROM tiendanube_pedidos WHERE negocio_id=? AND store_id=? AND reserva_intento_id=?').get(row.negocio_id,row.store_id,row.id):null;
    return {reserva_id:row.id,estado:row.estado,codigo:row.codigo||null,pedido_id:p?.order_id||null,
      total_publicado_centavos:row.total_centavos,stock_reservado:row.estado==='reservada',venta_creada:false,cobro_creado:false,repetida};
  }
  async function marcar(n,intento,estado,codigo,{pausar=true}={}){
    return repo.transaccion(n,async con=>{
      const row=await db.prepare('SELECT * FROM tiendanube_reserva_intentos WHERE id=? AND negocio_id=? FOR UPDATE').get(intento.id,n);
      if(!row)throw fallo('INTENTO_RESERVA_NO_ENCONTRADO');
      if(row.estado!=='enviando')return resultado(row,true);
      await db.prepare('UPDATE tiendanube_reserva_intentos SET estado=?,codigo=?,finalizada_at=? WHERE id=?').run(estado,codigo,now().toISOString(),row.id);
      if(con?.sync_reserva_token===row.id){
        if(pausar)await repo.pausar(n,codigo);
        else await db.prepare('UPDATE tiendanube_conexiones SET sync_reserva_token=NULL,sync_reserva_iniciada_at=NULL WHERE negocio_id=? AND sync_reserva_token=?').run(n,row.id);
      }
      return resultado({...row,estado,codigo});
    });
  }
  async function reservarProductosTiendanube(n,input,actor){
    if(!flag(enabled))throw fallo('RESERVAS_TIENDANUBE_DESHABILITADAS',503);
    local(n);local(actor);const body=normalizar(input),requestHash=huella({actor,...body});
    const prepared=await repo.transaccion(n,async con=>{
      await autorizar(n,actor);
      const old=await db.prepare('SELECT * FROM tiendanube_reserva_intentos WHERE negocio_id=? AND solicitud_id=? FOR UPDATE').get(n,body.solicitud_id);
      if(old){
        if(old.solicitud_hash!==requestHash||old.usuario_id!==actor)throw fallo('SOLICITUD_RESERVA_REUTILIZADA');
        return {old};
      }
      if(!flag(syncEnabled)||!con||con.pausada||con.sync_lease_token||con.sync_reserva_token
        ||![con.sync_activada_at,con.sync_baseline_at,con.sync_webhooks_at].every(v=>Number.isFinite(fecha(v))))throw fallo('SINCRONIZACION_NO_LISTA_PARA_RESERVAR');
      if(typeof canalesCentralizados!=='function'||await canalesCentralizados(con)!==true)throw fallo('CANALES_NO_CENTRALIZADOS');
      if(!String(con.scopes).split(/[\s,]+/).includes('write_orders'))throw fallo('FALTA_SCOPE_WRITE_ORDERS',403);
      if(await repo.hayEntradas(con.store_id))throw fallo('EVENTOS_PENDIENTES_ANTES_DE_RESERVAR');
      if(await db.prepare("SELECT producto_id FROM tiendanube_stock_outbox WHERE negocio_id=? AND (estado<>'sincronizado' OR envio_token IS NOT NULL) LIMIT 1").get(n))throw fallo('SALIDA_STOCK_PENDIENTE_ANTES_DE_RESERVAR');
      if(await db.prepare("SELECT id FROM tiendanube_reserva_intentos WHERE negocio_id=? AND estado IN ('enviando','revision_manual') LIMIT 1").get(n))throw fallo('RESERVA_CENTRAL_REQUIERE_REVISION');
      const items=[];let total=0;
      for(const requested of body.items){
        const p=await db.prepare(`SELECT v.producto_id,v.product_id,v.variant_id,v.store_id,v.sync_stock_remoto,v.sync_baseline_at,
          p.stock,p.precio_financiado_centavos FROM tiendanube_variantes v JOIN productos p ON p.id=v.producto_id AND p.negocio_id=v.negocio_id
          WHERE v.negocio_id=? AND v.producto_id=? FOR UPDATE OF p,v`).get(n,requested.producto_id);
        if(!p||p.store_id!==con.store_id||!p.sync_baseline_at)throw fallo('VARIANTE_NO_VINCULADA_PARA_RESERVAR');
        if(!Number.isSafeInteger(p.stock)||!Number.isSafeInteger(p.sync_stock_remoto)||p.stock!==p.sync_stock_remoto||p.stock<requested.cantidad)throw fallo('STOCK_NO_DISPONIBLE_PARA_RESERVAR');
        if(await db.prepare('SELECT producto_id FROM producto_combo_componentes WHERE combo_id=? LIMIT 1').get(p.producto_id))throw fallo('COMBO_NO_SOPORTADO_PARA_RESERVAR');
        const variant=Number(validarIdExterno(p.variant_id));if(!Number.isSafeInteger(variant))throw fallo('ID_VARIANTE_FUERA_DE_RANGO');
        validarIdExterno(p.product_id);
        const price=integer(p.precio_financiado_centavos,'precio publicado',{min:1});
        if(price%50000!==0)throw fallo('PRECIO_PUBLICADO_NO_REDONDEADO');
        total=integer(total+price*requested.cantidad,'total publicado',{min:1});
        items.push({producto_id:p.producto_id,product_id:p.product_id,variant_id:p.variant_id,cantidad:requested.cantidad,
          precio_publicado_centavos:price,stock_antes:p.stock,baseline_antes:p.sync_stock_remoto});
      }
      if(total!==body.total_esperado_centavos)throw fallo('PRECIO_CAMBIO_ANTES_DE_RESERVAR');
      const row={id:uuid(),negocio_id:n,usuario_id:actor,solicitud_id:body.solicitud_id,solicitud_hash:requestHash,
        store_id:con.store_id,instalacion_hash:instalacion(con),estado:'enviando',items,total_centavos:total};
      await db.prepare(`INSERT INTO tiendanube_reserva_intentos(id,negocio_id,usuario_id,solicitud_id,solicitud_hash,store_id,instalacion_hash,estado,items,total_centavos,creada_at)
        VALUES(?,?,?,?,?,?,?,'enviando',?::jsonb,?,?)`).run(row.id,n,actor,body.solicitud_id,requestHash,con.store_id,row.instalacion_hash,JSON.stringify(items),total,now().toISOString());
      await db.prepare('UPDATE tiendanube_conexiones SET sync_reserva_token=?,sync_reserva_iniciada_at=? WHERE negocio_id=?').run(row.id,now().toISOString(),n);
      return {row,con};
    });
    if(prepared.old)return resultado(prepared.old,true); // No automatic resend, even after process loss.
    const {row,con}=prepared;
    let raw;
    try{
      raw=await apiFactory(con)('POST','/orders',{
        currency:'ARS',language:'es',gateway:'offline',payment_status:'pending',status:'open',inventory_behaviour:'claim',
        // The provider's documented default buyer/address values are used for
        // stock-only local reservations, never fabricated personal information.
        customer:{},billing_address:{},shipping_address:{},shipping_pickup_type:'pickup',shipping:'branch',
        shipping_option:'Retiro en local',shipping_cost_customer:0,shipping_cost_owner:0,
        send_confirmation_email:false,send_fulfillment_email:false,note:`ZILKY-RESERVA:${row.id}`,
        products:row.items.map(i=>({variant_id:Number(i.variant_id),quantity:i.cantidad,price:centavosAPesos(i.precio_publicado_centavos)})),
        total:centavosAPesos(row.total_centavos),
      });
    }catch(err){
      // Only documented validation rejection is a definite non-creation here.
      // No blind retry of 429, timeout, 5xx or malformed/uncertain responses.
      return marcar(n,row,Number(err?.status)===422?'rechazada':'revision_manual',Number(err?.status)===422?'RESERVA_RECHAZADA_POR_TIENDANUBE':'RESULTADO_POST_PEDIDO_AMBIGUO',{pausar:Number(err?.status)!==422});
    }
    let parsed;
    try{parsed=validarRespuesta(raw,row);}catch(err){
      raw=null;
      return marcar(n,row,'revision_manual',err?.code==='STOCK_REMOTO_NO_RESERVADO'?'STOCK_REMOTO_NO_RESERVADO':'RESPUESTA_POST_PEDIDO_NO_VERIFICADA');
    }
    const created=fecha(raw.created_at);raw=null;
    try{
      return await repo.transaccion(n,async current=>{
        const intent=await db.prepare('SELECT * FROM tiendanube_reserva_intentos WHERE id=? FOR UPDATE').get(row.id);
        if(!current||current.sync_reserva_token!==row.id||instalacion(current)!==row.instalacion_hash||current.pausada
          ||current.sync_lease_token||!flag(enabled)||!flag(syncEnabled)||await canalesCentralizados(current)!==true
          ||intent?.estado!=='enviando'||created<fecha(current.sync_activada_at))throw fallo('RESERVA_CAMBIO_DURANTE_ENVIO');
        await autorizar(n,actor);
        const orderHash=hashPedidoPrivacidad(row.store_id,parsed.order);
        if(await repo.estaRedactado(row.store_id,parsed.order)||await repo.entrega(row.store_id,parsed.order))throw fallo('PEDIDO_NO_ADOPTABLE');
        const oldOrder=await repo.pedido(row.store_id,parsed.order);
        if(oldOrder?.reserva_intento_id&&oldOrder.reserva_intento_id!==row.id)throw fallo('PEDIDO_VINCULADO_A_OTRO_INTENTO');
        const applied=await repo.aplicados(row.store_id,parsed.order);
        if(applied.length)throw fallo('PEDIDO_YA_RESERVADO_REQUIERE_REVISION');
        const links=[];
        for(const item of row.items){
          const link=await repo.variante(n,row.store_id,item.variant_id);
          if(!link||link.producto_id!==item.producto_id||link.product_id!==item.product_id||link.stock!==item.stock_antes
            ||link.sync_stock_remoto!==item.baseline_antes)throw fallo('STOCK_CAMBIO_DURANTE_RESERVA');
          links.push(link);
        }
        await repo.guardarPedido(current,parsed.p,false);
        await db.prepare('UPDATE tiendanube_pedidos SET reserva_intento_id=? WHERE negocio_id=? AND store_id=? AND order_id=?').run(row.id,n,row.store_id,parsed.order);
        for(let i=0;i<row.items.length;i++)await repo.aplicarReserva(current,parsed.p,links[i],row.items[i].cantidad,row.items[i].cantidad);
        await db.prepare("UPDATE tiendanube_reserva_intentos SET estado='reservada',order_hash=?,finalizada_at=? WHERE id=?").run(orderHash,now().toISOString(),row.id);
        await db.prepare('UPDATE tiendanube_conexiones SET sync_reserva_token=NULL,sync_reserva_iniciada_at=NULL WHERE negocio_id=? AND sync_reserva_token=?').run(n,row.id);
        return resultado({...row,estado:'reservada',order_hash:orderHash});
      });
    }catch{
      // A failed local commit cannot undo a remote claim or authorize another
      // POST. Keep its durable token and require explicit reconciliation.
      return marcar(n,row,'revision_manual','RESERVA_REMOTA_PENDIENTE_DE_CONCILIACION');
    }
  }
  return {reservarProductosTiendanube};
}
