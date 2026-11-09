import { createHash } from 'node:crypto';
import { clienteTiendanube, descifrarToken, validarIdExterno } from '../lib/tiendanube.js';
import { hashPedidoPrivacidad } from './tiendanubePrivacidadService.js';

const VERSION='tiendanube-baseline-lectura-v1';
const DESCUENTO_CONTADO=250000;
const MAX_VARIANTES=500,MAX_FILAS=1000,MAX_PAGINAS=10,POR_PAGINA=100;
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const localId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value))throw fail('BASELINE_IDENTIFICADOR_INVALIDO',400);return value;};
const external=value=>{try{return validarIdExterno(value);}catch{throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);}};
const texto=value=>typeof value==='string'?value.slice(0,300):'';
const idioma=value=>typeof value==='string'?texto(value):texto(value?.es||value?.en||value?.pt);
const normalizar=value=>texto(value).normalize('NFKC').trim().toLocaleLowerCase('es-AR');
const iso=value=>value!=null&&Number.isFinite(new Date(value).valueOf())?new Date(value).toISOString():null;
const stock=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const dinero=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const pesos=value=>{
  if(!['number','string'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))return null;
  const [a,b='']=String(value).split('.');return dinero(Number(a)*100+Number(b.padEnd(2,'0')));
};
const estable=value=>typeof value==='bigint'?String(value):value instanceof Date?value.toISOString():Array.isArray(value)?value.map(estable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,estable(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(estable(value))).digest('hex');
const unique=rows=>[...new Set(rows)].sort();
const json=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
// Only fixed diagnostic categories cross the service boundary. Provider/SQL
// messages can contain URLs, credentials, query parameters or customer data.
// In particular, a 404 from /orders is NOT evidence of an empty collection.
const falloRemoto=(error,recurso)=>{
  let code='BASELINE_LECTURA_REMOTA_FALLIDA';
  const status=error?.status;
  if(status===400)code='BASELINE_CONSULTA_REMOTA_INVALIDA';
  else if(status===401||status===403)code='BASELINE_ACCESO_REMOTO_REVOCADO';
  else if(status===402)code='BASELINE_ACCESO_REMOTO_SUSPENDIDO';
  else if(status===404)code=recurso==='pedidos'?'BASELINE_PEDIDOS_REMOTOS_NO_ENCONTRADOS':'BASELINE_PRODUCTO_REMOTO_NO_ENCONTRADO';
  else if(status===422)code='BASELINE_CONSULTA_REMOTA_NO_PROCESABLE';
  else if(status===429)code='BASELINE_LIMITE_REMOTO';
  else if(Number.isInteger(status)&&status>=500&&status<=599)code='BASELINE_SERVICIO_REMOTO_NO_DISPONIBLE';
  else if(error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.code)
    ||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code))code='BASELINE_TIEMPO_REMOTO_AGOTADO';
  else if(error?.name==='SyntaxError')code='BASELINE_RESPUESTA_REMOTA_INVALIDA';
  return fail(code,502);
};
const falloLocal=error=>{
  if(['42P01','42703'].includes(error?.code))return fail('BASELINE_ESQUEMA_LOCAL_INCOMPLETO',500);
  if(['42601','42883','42804','42P18'].includes(error?.code))return fail('BASELINE_CONSULTA_LOCAL_INVALIDA',500);
  if(['22003','22P02'].includes(error?.code))return fail('BASELINE_DATOS_LOCALES_INVALIDOS',500);
  return error;
};

/**
 * Initial reconciliation PREVIEW, deliberately without an activation or commit
 * path. GET /orders has page/per_page and date filters, not a documented atomic
 * snapshot. The existing client also does not expose Link/x-total-count. A short
 * page, equal stock or a matching digest is NOT proof of an exclusive cutover.
 *
 * Consequently even revalidar() only rereads and compares: no baseline markers,
 * order ledgers, inbox acknowledgements, stocks, prices or money are written.
 * A later activation workflow must first establish a verifiable operational
 * cutoff and explicitly reconcile pre-cutoff reservations and pending events.
 */
export function crearServicioBaselineTiendanube({database,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  syncEnabled=()=>process.env.TIENDANUBE_SYNC_ENABLED==='true',
  deliveriesEnabled=()=>process.env.TIENDANUBE_ENTREGAS_ENABLED==='true',
  now=()=>new Date(),clock=Date.now}={}){
  let currentDb=database;
  const obtenerDb=async()=>currentDb||(currentDb=(await import('../db/connection.js')).db);
  const on=v=>typeof v==='function'?v()===true:v===true;
  const flagsApagadas=()=>{if(on(syncEnabled)||on(deliveriesEnabled))throw fail('BASELINE_REQUIERE_MOTORES_APAGADOS');};

  async function autorizar(db,n,actor){
    localId(n);localId(actor);
    const row=await db.prepare(`SELECT n.id FROM negocios n
      JOIN usuario_organizacion uo ON uo.organizacion_id=n.organizacion_id
      JOIN usuarios u ON u.id=uo.usuario_id
      WHERE n.id=? AND uo.usuario_id=? AND uo.activo=1 AND uo.rol='administrador'
        AND u.activo=1 AND u.rol='administrador'`).get(n,actor);
    if(!row)throw fail('BASELINE_SIN_PERMISO',403);
  }

  async function leerLocal(db,n,store){
    // Lock only the exact, explicitly linked inventory; product names are
    // presentation, never keys. A stock/price edit cannot change these rows
    // during the remote comparison. The connection lock excludes new links.
    const links=await db.prepare(`SELECT v.producto_id,v.store_id,v.product_id,v.variant_id,v.vinculada_at,
      v.sync_baseline_at,v.sync_stock_remoto,v.sync_verificar_despues,
      p.nombre,p.variante,p.sku,p.stock,p.precio_contado_centavos,p.precio_financiado_centavos
      FROM tiendanube_variantes v JOIN productos p ON p.id=v.producto_id AND p.negocio_id=v.negocio_id
      WHERE v.negocio_id=? ORDER BY v.producto_id LIMIT ${MAX_VARIANTES+1} FOR SHARE OF v,p`).all(n);
    const count=await db.prepare('SELECT COUNT(*)::int AS total FROM tiendanube_variantes WHERE negocio_id=?').get(n);
    const ids=links.slice(0,MAX_VARIANTES).map(l=>l.producto_id);
    const web=ids.length?await db.prepare(`SELECT producto_id,talle,color FROM tienda_productos
      WHERE negocio_id=? AND producto_id=ANY(?::text[]) ORDER BY producto_id FOR SHARE`).all(n,ids):[];
    const outbox=await db.prepare(`SELECT producto_id,stock_deseado,version,estado,envio_token,envio_version,
      envio_stock,envio_delta,envio_put_iniciado,envio_iniciado_at
      FROM tiendanube_stock_outbox WHERE negocio_id=? ORDER BY producto_id LIMIT ${MAX_FILAS+1}`).all(n);
    const inbox=await db.prepare(`SELECT id,topic,recurso_id,body_hash,sync_version,sync_estado,procesado_at
      FROM tiendanube_eventos WHERE store_id=? AND (procesado_at IS NULL OR sync_estado='revision_manual')
      ORDER BY id LIMIT ${MAX_FILAS+1}`).all(store);
    const intentos=await db.prepare(`SELECT id,estado,order_hash FROM tiendanube_reserva_intentos
      WHERE negocio_id=? AND estado IN ('enviando','reservada','revision_manual') ORDER BY id LIMIT ${MAX_FILAS+1}`).all(n);
    const reservas=await db.prepare(`SELECT r.order_hash,r.variant_id,r.producto_id,r.cantidad_aplicada
      FROM tiendanube_pedido_stock r JOIN productos p ON p.id=r.producto_id
      WHERE r.store_id=? AND p.negocio_id=? AND r.cantidad_aplicada>0
      ORDER BY r.order_hash,r.variant_id LIMIT ${MAX_FILAS+1}`).all(store,n);
    const pedidos=await db.prepare(`SELECT order_id,estado,cantidades,pagado,cancelado,pendiente_revision
      FROM tiendanube_pedidos WHERE negocio_id=? AND store_id=? ORDER BY order_id LIMIT ${MAX_FILAS+1}`).all(n,store);
    const blockers=[];
    if(!count?.total)blockers.push('SIN_VARIANTES_VINCULADAS');
    if(count?.total!==links.length||links.length>MAX_VARIANTES)blockers.push('VINCULOS_INCOMPLETOS_O_INVALIDOS');
    if(links.some(l=>String(l.store_id)!==store))blockers.push('VINCULO_DE_OTRA_TIENDA');
    if(outbox.some(o=>o.estado!=='sincronizado'||o.envio_token||o.envio_put_iniciado))blockers.push('SALIDAS_PENDIENTES_O_INCIERTAS');
    if(inbox.some(e=>e.sync_estado!=='ignorado'))blockers.push('EVENTOS_PENDIENTES_O_EN_REVISION');
    if(intentos.length||reservas.length)blockers.push('RESERVAS_PREVIAS_REQUIEREN_CONCILIACION');
    if(pedidos.some(p=>p.pendiente_revision))blockers.push('PEDIDOS_LOCALES_EN_REVISION');
    if([outbox,inbox,intentos,reservas,pedidos].some(a=>a.length>MAX_FILAS))blockers.push('LECTURA_LOCAL_LIMITADA');
    return {links:links.slice(0,MAX_VARIANTES),web,outbox,inbox,intentos,reservas,pedidos,total_vinculos:count?.total||0,blockers};
  }

  function compararVariante(link,web,product){
    const blockers=[],warnings=[];
    const variants=Array.isArray(product?.variants)?product.variants:[];
    const matches=variants.filter(v=>String(v?.id)===String(link.variant_id));
    const v=matches.length===1?matches[0]:null;
    const localStock=stock(link.stock),local30=dinero(link.precio_financiado_centavos),localCash=dinero(link.precio_contado_centavos);
    const localSku=texto(link.sku).trim(),remoteSku=texto(v?.sku).trim();
    if(!v||String(product?.id)!==String(link.product_id)||String(v.product_id)!==String(link.product_id))blockers.push('VARIANTE_REMOTA_NO_COINCIDE');
    if(localStock===null)blockers.push('STOCK_LOCAL_SIN_CONTROL');
    const remoteStock=v?.stock_management===true?stock(v.stock):null;
    if(remoteStock===null)blockers.push('STOCK_REMOTO_SIN_CONTROL');
    if(v&&Object.hasOwn(v,'inventory_levels'))blockers.push('MULTIPLES_UBICACIONES_NO_CONFIGURADAS');
    if(localStock!==null&&remoteStock!==null&&localStock!==remoteStock)blockers.push('DIFERENCIA_STOCK');
    const remote30=pesos(v?.price),promo=v?.promotional_price==null||v?.promotional_price===''?null:pesos(v.promotional_price);
    if(!local30||!localCash||local30-localCash!==DESCUENTO_CONTADO)blockers.push('PRECIOS_LOCALES_NO_CUMPLEN_REGLA');
    if((local30!==null&&local30%50000!==0)||(localCash!==null&&localCash%50000!==0))blockers.push('PRECIOS_LOCALES_SIN_REDONDEO');
    if(remote30===null||remote30!==local30)blockers.push('DIFERENCIA_PRECIO_PUBLICADO');
    if(v?.promotional_price!=null&&v.promotional_price!==''&&(promo===null||(promo>0&&promo!==remote30)))blockers.push('PROMOCION_REMOTA_NO_CONCILIADA');
    if(localSku&&remoteSku&&localSku!==remoteSku)blockers.push('DIFERENCIA_SKU');
    if(!localSku||!remoteSku)warnings.push('SKU_NO_INFORMADO');
    const attributes=Array.isArray(product?.attributes)?product.attributes.map(idioma):[];
    const values=Array.isArray(v?.values)?v.values.map(idioma):[];
    const findAttribute=names=>{
      const positions=attributes.flatMap((a,i)=>names.includes(normalizar(a))?[i]:[]);
      return positions.length===1?texto(values[positions[0]]).trim():'';
    };
    const remoteSize=findAttribute(['talle','tamaño','size']),remoteColor=findAttribute(['color','colour']);
    const localSize=texto(web?.talle).trim(),localColor=texto(web?.color).trim();
    if(!localSize||!localColor||!remoteSize||!remoteColor||attributes.length!==values.length)blockers.push('TALLE_COLOR_NO_VERIFICABLES');
    if(localSize&&remoteSize&&normalizar(localSize)!==normalizar(remoteSize))blockers.push('DIFERENCIA_TALLE');
    if(localColor&&remoteColor&&normalizar(localColor)!==normalizar(remoteColor))blockers.push('DIFERENCIA_COLOR');
    return {producto_id:link.producto_id,product_id:String(link.product_id),variant_id:String(link.variant_id),
      nombre:texto(link.nombre),variante_local:texto(link.variante),
      sku_local:localSku,sku_remoto:remoteSku,talle_local:localSize,talle_remoto:remoteSize,color_local:localColor,color_remoto:remoteColor,
      stock_local:localStock,stock_remoto:remoteStock,precio_30_dias_local_centavos:local30,precio_contado_local_centavos:localCash,
      precio_publicado_remoto_centavos:remote30,precio_contado_segun_regla_centavos:remote30!==null&&remote30>=DESCUENTO_CONTADO?remote30-DESCUENTO_CONTADO:null,
      descuento_checkout_verificado:false,coincide:!blockers.length,bloqueos:unique(blockers),advertencias:unique(warnings)};
  }

  function resumirPedido(raw,store,corte){
    const id=external(raw?.id);
    if(external(raw?.store_id)!==store)throw fail('BASELINE_PEDIDO_DE_OTRA_TIENDA',502);
    const created=iso(raw?.created_at),updated=iso(raw?.updated_at);
    if(!created||created>corte||!updated||!['open','closed','cancelled'].includes(raw.status)||!Array.isArray(raw.products)||raw.products.length>1000)throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);
    const items=raw.products.map(line=>{
      const quantity=line?.quantity;
      if(!Number.isSafeInteger(quantity)||quantity<=0)throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);
      return {product_id:external(line.product_id),variant_id:external(line.variant_id),cantidad:quantity};
    }).sort((a,b)=>a.variant_id.localeCompare(b.variant_id)||a.product_id.localeCompare(b.product_id));
    return {order_id:id,created_at:created,updated_at:updated,estado:raw.status,
      pago_estado:texto(raw.payment_status),envio_estado:texto(raw.shipping_status),
      cancelado:raw.status==='cancelled'||!!raw.cancelled_at,items};
  }

  async function recolectar(n,actor,corte){
    flagsApagadas();const db=await obtenerDb();
    try{return await db.transaction(async()=>{
      await autorizar(db,n,actor);
      const first=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      if(!first)throw fail('BASELINE_CONEXION_NO_DISPONIBLE');
      const store=external(first.store_id);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${store}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(n);
      if(!con||String(con.store_id)!==store)throw fail('BASELINE_CONEXION_CAMBIO');
      if(con.pausada!==true)throw fail('BASELINE_REQUIERE_PAUSA');
      // Expired lease/reservation deadlines are not proof that a remote write
      // did not happen. Keep all durable claims blocking, including old ones.
      if(con.sync_lease_token||con.sync_reserva_token)throw fail('BASELINE_OPERACION_PENDIENTE');
      if(con.sync_activada_at||con.sync_baseline_at)throw fail('BASELINE_EXISTENTE_REQUIERE_REVISION');
      const scopes=new Set(String(con.scopes).split(',').map(s=>s.trim()));
      if(!scopes.has('write_products')||!scopes.has('read_orders'))throw fail('BASELINE_PERMISOS_REMOTOS_INSUFICIENTES',403);
      const local=await leerLocal(db,n,store),web=new Map(local.web.map(w=>[w.producto_id,w]));
      const blockers=[...local.blockers,'CORTE_REMOTO_NO_VERIFICABLE','PAGINACION_SIN_METADATOS'];
      const api=apiFactory(con),started=clock();let calls=0;
      const get=async(path,recurso)=>{
        if(++calls>60||clock()-started>25000)throw fail('BASELINE_LIMITE_LECTURA',503);
        try{return await api('GET',path);}catch(e){
          if(e?.code==='BASELINE_LIMITE_LECTURA')throw e;
          throw falloRemoto(e,recurso);
        }
      };
      const products=new Map(),remoteProducts=[];
      for(const link of local.links){
        if(String(link.store_id)!==store)continue;
        const product=external(link.product_id);external(link.variant_id);
        if(products.has(product))continue;
        const raw=await get(`/products/${product}?fields=id%2Cattributes%2Cvariants`,'producto');
        if(!raw||external(raw.id)!==product||!Array.isArray(raw.variants)||raw.variants.length>1000)throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);
        const ids=new Set();
        for(const v of raw.variants){const id=external(v?.id);if(ids.has(id))throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);ids.add(id);}
        products.set(product,raw);
      }
      const variants=local.links.map(link=>compararVariante(link,web.get(link.producto_id),products.get(String(link.product_id))));
      for(const v of variants)blockers.push(...v.bloqueos);
      // Only values needed for linked variants enter the digest. Never retain
      // the full provider product or customer/order response in the preview.
      remoteProducts.push(...variants);
      const remoteOrders=[],seen=new Set();let pages=0,finished=false;
      for(let page=1;page<=MAX_PAGINAS;page++){
        const fields='id,store_id,created_at,updated_at,status,payment_status,shipping_status,cancelled_at,products';
        const query=new URLSearchParams({page:String(page),per_page:String(POR_PAGINA),status:'any',payment_status:'any',shipping_status:'any',created_at_max:corte,fields});
        // The shared client allows percent escapes but not literal dots in a
        // resource path. Encode ISO milliseconds too (URLSearchParams leaves
        // them literal) without changing the exact cutoff used for the digest.
        const rows=await get('/orders?'+query.toString().replace(/\./g,'%2E'),'pedidos');
        if(!Array.isArray(rows)||rows.length>POR_PAGINA)throw fail('BASELINE_RESPUESTA_REMOTA_INVALIDA',502);
        pages=page;
        for(const raw of rows){
          const order=resumirPedido(raw,store,corte);
          if(seen.has(order.order_id))throw fail('BASELINE_PAGINACION_INESTABLE',502);
          seen.add(order.order_id);remoteOrders.push(order);
        }
        if(rows.length<POR_PAGINA){finished=true;break;}
      }
      if(!finished)blockers.push('LECTURA_PEDIDOS_LIMITADA');
      remoteOrders.sort((a,b)=>a.order_id.localeCompare(b.order_id));
      const orderHashes=remoteOrders.map(o=>hashPedidoPrivacidad(store,o.order_id));
      const tombstones=orderHashes.length?await db.prepare(`SELECT order_hash FROM tiendanube_privacidad_borrados
        WHERE store_id=? AND order_hash=ANY(?::text[]) ORDER BY order_hash`).all(store,orderHashes):[];
      const deliveries=orderHashes.length?await db.prepare(`SELECT order_hash FROM tiendanube_entregas
        WHERE negocio_id=? AND store_id=? AND order_hash=ANY(?::text[]) ORDER BY order_hash`).all(n,store,orderHashes):[];
      const deleted=new Set(tombstones.map(t=>t.order_hash)),delivered=new Set(deliveries.map(d=>d.order_hash));
      const localOrders=new Map(local.pedidos.map(p=>[p.order_id,p]));
      const byVariant=new Map(local.links.filter(l=>String(l.store_id)===store).map(l=>[String(l.variant_id),l]));
      let redacted=0;
      const orders=remoteOrders.flatMap(order=>{
        const key=hashPedidoPrivacidad(store,order.order_id);
        if(deleted.has(key)){redacted++;return [];}
        const saved=localOrders.get(order.order_id),hasDelivery=delivered.has(key);
        const linked=order.items.map(item=>{
          const link=byVariant.get(item.variant_id),valid=!!link&&String(link.product_id)===item.product_id;
          if(!valid)blockers.push('PEDIDO_CON_VARIANTE_SIN_VINCULO_EXACTO');
          return {...item,producto_id:valid?link.producto_id:null};
        });
        // "fulfilled" is shipped, not proof of physical delivery, and "paid"
        // does not prove that a cash entry was reconciled. Be conservative.
        const review=!order.cancelado&&(!hasDelivery||order.pago_estado!=='paid'||order.envio_estado!=='fulfilled');
        if(review)blockers.push('PEDIDOS_EN_TRANSITO_O_SIN_CONCILIAR');
        if(saved?.pendiente_revision)blockers.push('PEDIDOS_LOCALES_EN_REVISION');
        return [{...order,items:linked,registro_local:!!saved,entrega_local_registrada:hasDelivery,
          requiere_revision:review,situacion:order.cancelado?'cancelado':review?'posible_en_transito':'entrega_registrada'}];
      });
      if(redacted)blockers.push('PEDIDOS_OMITIDOS_POR_PRIVACIDAD');
      if(local.pedidos.some(p=>!seen.has(p.order_id)))blockers.push('PEDIDOS_LOCALES_FUERA_DE_LECTURA');
      // Inbox rows can arrive without taking the worker lock. A local change
      // during a slow read invalidates the view instead of certifying old data.
      const localAfter=await leerLocal(db,n,store);
      if(hash(local)!==hash(localAfter))throw fail('BASELINE_CAMBIO_DURANTE_LECTURA');
      // Re-read after potentially slow network work; an old administrator JWT
      // is not authority after membership/role revocation.
      await autorizar(db,n,actor);flagsApagadas();
      const snapshot={version:VERSION,negocio_id:n,store_id:store,corte_at:corte,
        instalacion:hash({store:con.store_id,app:con.app_id,token:con.token_cifrado,scopes:con.scopes,creada_at:iso(con.creada_at)}),
        local:{...local,pedidos:local.pedidos.map(p=>({...p,cantidades:json(p.cantidades)}))},
        remoto:{variantes:remoteProducts,pedidos:orders,redactados:redacted},tombstones,deliveries,pages,finished};
      return {version:VERSION,negocio_id:n,store_id:store,corte_consulta_at:corte,consultado_at:iso(now()),huella:hash(snapshot),
        modo:'solo_lectura',baseline_confirmable:false,baseline_guardado:false,sincronizacion_activada:false,stock_modificado:false,
        corte_exclusivo_verificado:false,bloqueos:unique(blockers),
        variantes:variants,pedidos:orders,pedidos_omitidos_por_privacidad:redacted,
        paginacion_pedidos:{paginas_recorridas:pages,fin_observado:finished,completa_verificada:false,metadatos_disponibles:false,limite_filas:MAX_PAGINAS*POR_PAGINA},
        pendientes:{salidas:local.outbox.filter(o=>o.estado!=='sincronizado'||o.envio_token||o.envio_put_iniciado).length,
          eventos:local.inbox.filter(e=>e.sync_estado!=='ignorado').length,intentos_reserva:local.intentos.length,reservas:local.reservas.length},
        advertencia:'Esta lectura no confirma un corte exclusivo ni habilita sincronización. No se ajustó ningún stock y el descuento contado del checkout no fue verificado.'};
    });}catch(e){throw falloLocal(e);}
  }

  async function preview(n,actor){return recolectar(n,actor,iso(now()));}
  async function revalidar(n,input,actor){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['negocio_id','huella','corte_consulta_at'].includes(k))
      ||(input.negocio_id!==undefined&&input.negocio_id!==n)||typeof input.huella!=='string'||!/^[a-f0-9]{64}$/.test(input.huella)
      ||typeof input.corte_consulta_at!=='string'||iso(input.corte_consulta_at)!==input.corte_consulta_at)throw fail('BASELINE_HUELLA_INVALIDA',400);
    const age=new Date(now()).valueOf()-new Date(input.corte_consulta_at).valueOf();
    if(age<0||age>15*60*1000)throw fail('BASELINE_VISTA_VENCIDA');
    const result=await recolectar(n,actor,input.corte_consulta_at);
    if(result.huella!==input.huella)throw fail('BASELINE_CAMBIO_DESDE_PREVIEW');
    // This is a fresh comparison of the same exact view, never a commit of the
    // old browser snapshot. Even equality cannot authorize activation.
    return {...result,coincide_con_preview:true,baseline_confirmable:false,baseline_guardado:false};
  }
  return {preview,revalidar};
}

export const baselineTiendanube=crearServicioBaselineTiendanube();
