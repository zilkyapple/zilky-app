import { randomUUID } from 'node:crypto';
import { clienteTiendanube, descifrarToken, validarIdExterno } from '../lib/tiendanube.js';
import { resumenPedidoTiendanube } from '../lib/tiendanubeConciliacion.js';
import { hashPedidoPrivacidad } from './tiendanubePrivacidadService.js';

// This engine synchronizes AVAILABLE inventory, not financial sales. A web
// order reserves units even when unpaid. Delivery, payments and commissions
// must be reconciled separately; importing a reservation is never a sale.
// Relative POST stock adjustments preserve concurrent remote decrements. They
// do NOT reserve a last unit atomically across platforms: the remote endpoint
// clamps negative results to zero, and an ambiguous write must not be retried.
// Unexpected drift is reconciled read-only, then stops for manual review.
const ORDER_TOPICS=new Set(['order/created','order/updated','order/paid','order/cancelled','order/edited','order/pending','order/voided','order/fulfilled','order/packed','order/unpacked','order/in_preparation','order/in_fraud_analysis']);
const finiteStock=v=>Number.isSafeInteger(v)&&v>=0;
const timestamp=v=>v==null?NaN:new Date(v).getTime();
const fail=code=>Object.assign(new Error(code),{code});
const active=c=>!!c&&!c.pausada&&Number.isFinite(timestamp(c.sync_activada_at))&&!!c.sync_baseline_at&&!!c.sync_webhooks_at;

export function stockRemotoVerificado(v,link){
  if(!v||String(v.id)!==String(link.variant_id)||String(v.product_id)!==String(link.product_id))throw fail('VARIANTE_REMOTA_DISTINTA');
  // inventory_levels only appears for stores with Multiple Locations enabled.
  // Aggregate stock must not be written for those stores.
  if(Object.hasOwn(v,'inventory_levels'))throw fail('MULTIPLES_UBICACIONES_NO_CONFIGURADAS');
  if(v.stock_management!==true||!finiteStock(v.stock))throw fail('STOCK_REMOTO_SIN_CONTROL');
  return v.stock;
}

export function clasificarFalloSync(err,{escritura=false,intentos=0,ahora=Date.now()}={}){
  const status=Number(err?.status);
  if(status===401||status===403)return {estado:'revision_manual',pausar:true,codigo:'ACCESO_REVOCADO'};
  if(status===429){
    const header=err?.retryAfter;
    let delay=header==null||String(header).trim()===''?NaN:Number(header)*1000;
    if((!Number.isFinite(delay)||delay<0)&&header!=null)delay=Date.parse(header)-ahora;
    if(!Number.isFinite(delay)||delay<0)delay=Math.min(3600000,30000*2**Math.min(intentos,7));
    return {estado:'reintento',pausar:false,codigo:'LIMITE_API',delay:Math.max(1000,Math.min(delay,86400000))};
  }
  if(escritura)return {estado:'revision_manual',pausar:true,codigo:'RESULTADO_POST_STOCK_AMBIGUO'};
  if(status>=500||!Number.isFinite(status)||status===0)return {estado:'reintento',pausar:false,codigo:'LECTURA_API_NO_DISPONIBLE',delay:Math.min(3600000,15000*2**Math.min(intentos,8))};
  return {estado:'revision_manual',pausar:true,codigo:'RECURSO_REMOTO_NO_VALIDO'};
}

export function crearRepositorioTiendanubeSync(db){
  if(!db?.transaction||!db?.prepare||!db?.query)throw new Error('Falta adaptador PostgreSQL');
  return {
    async transaccion(n,fn){return db.transaction(async()=>{
      const first=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      // Same lock ordering as privacy redaction: store privacy -> worker -> row.
      // A redaction cannot race a successful import of that same order.
      if(first)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${first.store_id}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(n);
      if(con&&con.store_id!==first?.store_id)throw fail('CONEXION_CAMBIO_DURANTE_BLOQUEO');
      return fn(con);
    });},
    async resumen(n){
      const con=await db.prepare('SELECT negocio_id,store_id,pausada,sync_activada_at,sync_baseline_at,sync_webhooks_at,sync_motivo_pausa,(sync_reserva_token IS NOT NULL) AS reserva_central_pendiente FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      const v=await db.prepare('SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE sync_baseline_at IS NULL OR sync_stock_remoto IS NULL)::int AS sin_baseline FROM tiendanube_variantes WHERE negocio_id=?').get(n);
      const o=await db.prepare("SELECT COUNT(*)::int AS revision FROM tiendanube_stock_outbox WHERE negocio_id=? AND (estado='revision_manual' OR envio_token IS NOT NULL)").get(n);
      const e=await db.prepare("SELECT COUNT(*)::int AS revision FROM tiendanube_eventos WHERE store_id=? AND sync_estado='revision_manual'").get(con?.store_id||'');
      return {conexion:con||null,variantes:v?.total||0,sin_baseline:v?.sin_baseline||0,revision:(o?.revision||0)+(e?.revision||0)};
    },
    async pausar(n,codigo){await db.prepare('UPDATE tiendanube_conexiones SET pausada=TRUE,sync_motivo_pausa=?,actualizada_at=NOW() WHERE negocio_id=?').run(codigo,n);},
    evento(store,now){return db.prepare("SELECT * FROM tiendanube_eventos WHERE store_id=? AND procesado_at IS NULL AND sync_estado IN ('pendiente','reintento') AND sync_proximo_intento<=? ORDER BY CASE WHEN topic LIKE 'order/%' THEN 0 ELSE 1 END,id LIMIT 1 FOR UPDATE SKIP LOCKED").get(store,now);},
    async marcarEvento(e,estado,codigo=null,retry=null){
      await db.prepare(`UPDATE tiendanube_eventos SET sync_estado=?,error=?,sync_intentos=sync_intentos+1,
       sync_proximo_intento=COALESCE(?::timestamptz,sync_proximo_intento),
       procesado_at=CASE WHEN ? IN ('procesado','ignorado') THEN NOW() ELSE NULL END WHERE id=? AND sync_version=?`).run(estado,codigo,retry,estado,e.id,e.sync_version??1);
    },
    async hayEntradas(store){return !!await db.prepare("SELECT id FROM tiendanube_eventos WHERE store_id=? AND procesado_at IS NULL AND sync_estado<>'ignorado' LIMIT 1").get(store);},
    async estaRedactado(store,order){return !!await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(store,hashPedidoPrivacidad(store,order));},
    async entrega(store,order){return db.prepare('SELECT venta_id FROM tiendanube_entregas WHERE store_id=? AND order_hash=?').get(store,hashPedidoPrivacidad(store,order));},
    variantesDeProducto(n,store,product){return db.prepare('SELECT * FROM tiendanube_variantes WHERE negocio_id=? AND store_id=? AND product_id=? ORDER BY producto_id FOR UPDATE').all(n,store,product);},
    pedido(store,order){return db.prepare('SELECT * FROM tiendanube_pedidos WHERE store_id=? AND order_id=? FOR UPDATE').get(store,order);},
    aplicados(store,order){return db.prepare('SELECT variant_id,producto_id,cantidad_aplicada FROM tiendanube_pedido_stock WHERE store_id=? AND order_hash=? ORDER BY variant_id FOR UPDATE').all(store,hashPedidoPrivacidad(store,order));},
    variante(n,store,variant){return db.prepare(`SELECT v.*,p.stock FROM tiendanube_variantes v JOIN productos p ON p.id=v.producto_id AND p.negocio_id=v.negocio_id
      WHERE v.negocio_id=? AND v.store_id=? AND v.variant_id=? FOR UPDATE OF p,v`).get(n,store,variant);},
    async guardarPedido(con,p,revision){await db.prepare(`INSERT INTO tiendanube_pedidos(negocio_id,store_id,order_id,estado,cantidades,pagado,cancelado,pendiente_revision)
      VALUES(?,?,?,?,?::jsonb,?,?,?) ON CONFLICT(store_id,order_id) DO UPDATE SET estado=EXCLUDED.estado,cantidades=EXCLUDED.cantidades,
      pagado=EXCLUDED.pagado,cancelado=EXCLUDED.cancelado,pendiente_revision=EXCLUDED.pendiente_revision,actualizado_at=NOW()`)
      .run(con.negocio_id,con.store_id,p.order_id,p.estado,JSON.stringify(p.cantidades),p.pagado,p.cancelado,revision);},
    async aplicarReserva(con,p,link,qty,delta){
      const next=link.stock-delta;
      await db.prepare('UPDATE productos SET stock=? WHERE id=? AND negocio_id=?').run(next,link.producto_id,con.negocio_id);
      await db.prepare('UPDATE tiendanube_variantes SET sync_stock_remoto=sync_stock_remoto-? WHERE producto_id=? AND store_id=?').run(delta,link.producto_id,con.store_id);
      const orderHash=hashPedidoPrivacidad(con.store_id,p.order_id);
      await db.prepare(`INSERT INTO tiendanube_pedido_stock(store_id,order_hash,variant_id,producto_id,cantidad_aplicada)
        VALUES(?,?,?,?,?) ON CONFLICT(store_id,order_hash,variant_id) DO UPDATE SET cantidad_aplicada=EXCLUDED.cantidad_aplicada,actualizado_at=NOW()`)
        .run(con.store_id,orderHash,link.variant_id,link.producto_id,qty);
      await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,solicitud_id,detalles)
       VALUES(?,?,?,'reserva_tiendanube',?,?,?,?,'{}'::jsonb)`)
       .run(randomUUID(),link.producto_id,con.negocio_id,link.stock,next,'Reserva de pedido Tiendanube',`tn:${con.store_id}:${orderHash}:${link.variant_id}:${qty}`);
    },
    candidato(n,now){return db.prepare(`SELECT o.producto_id FROM tiendanube_stock_outbox o
      JOIN tiendanube_variantes v ON v.producto_id=o.producto_id AND v.negocio_id=o.negocio_id
      WHERE o.negocio_id=? AND o.estado='pendiente' AND o.envio_token IS NULL AND o.proximo_intento<=?
        AND (v.sync_verificar_despues IS NULL OR v.sync_verificar_despues<=?)
      ORDER BY o.actualizado_at,o.producto_id LIMIT 1`).get(n,now,now);},
    // Lock product before outbox, matching ordinary stock mutations + trigger.
    async salida(n,product){
      const p=await db.prepare('SELECT id,stock FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(product,n);
      if(!p)return null;
      const o=await db.prepare('SELECT * FROM tiendanube_stock_outbox WHERE producto_id=? AND negocio_id=? FOR UPDATE').get(product,n);
      const v=await db.prepare('SELECT * FROM tiendanube_variantes WHERE producto_id=? AND negocio_id=? FOR UPDATE').get(product,n);
      return o&&v?{...o,...v,stock:p.stock}:null;
    },
    async lease(con,token,hasta){await db.prepare('UPDATE tiendanube_conexiones SET sync_lease_token=?,sync_lease_hasta=? WHERE negocio_id=?').run(token,hasta,con.negocio_id);},
    async liberar(n,token){await db.prepare('UPDATE tiendanube_conexiones SET sync_lease_token=NULL,sync_lease_hasta=NULL WHERE negocio_id=? AND sync_lease_token=?').run(n,token);},
    async reclamar(o,token,now){await db.prepare(`UPDATE tiendanube_stock_outbox SET estado='enviando',envio_token=?,envio_version=version,
      envio_stock=?,envio_delta=?,envio_put_iniciado=FALSE,envio_iniciado_at=?,intentos=intentos+1 WHERE producto_id=?`).run(token,o.stock,o.stock-o.sync_stock_remoto,now,o.producto_id);},
    async iniciarEscritura(o,token){await db.prepare('UPDATE tiendanube_stock_outbox SET envio_put_iniciado=TRUE WHERE producto_id=? AND envio_token=?').run(o.producto_id,token);},
    async terminar(o,token,{estado,codigo=null,retry=null,esperado,verificarDespues=null}){
      // A successful variation advances OUR expected baseline, not the raw
      // response, which can already include a concurrent remote checkout.
      if(esperado!==undefined)await db.prepare('UPDATE tiendanube_variantes SET sync_stock_remoto=?,sync_verificar_despues=? WHERE producto_id=? AND store_id=?').run(esperado,verificarDespues,o.producto_id,o.store_id);
      // Preserve the exact attempted delta/snapshot on review. Later local
      // sales can change desired stock; they cannot reconstruct an unknown POST.
      const conservar=estado==='revision_manual';
      await db.prepare(`UPDATE tiendanube_stock_outbox SET estado=CASE WHEN ?='sincronizado' AND version<>? THEN 'pendiente' ELSE ? END,
       ultimo_error=?,proximo_intento=COALESCE(?::timestamptz,NOW()),
       envio_token=CASE WHEN ? THEN envio_token ELSE NULL END,envio_version=CASE WHEN ? THEN envio_version ELSE NULL END,
       envio_stock=CASE WHEN ? THEN envio_stock ELSE NULL END,envio_delta=CASE WHEN ? THEN envio_delta ELSE NULL END,
       envio_put_iniciado=CASE WHEN ? THEN envio_put_iniciado ELSE FALSE END,envio_iniciado_at=CASE WHEN ? THEN envio_iniciado_at ELSE NULL END,
       actualizado_at=NOW() WHERE producto_id=? AND envio_token=?`)
       .run(estado,o.version,estado,codigo,retry,conservar,conservar,conservar,conservar,conservar,conservar,o.producto_id,token);
    },
    async abandonados(n){return db.prepare('SELECT * FROM tiendanube_stock_outbox WHERE negocio_id=? AND envio_token IS NOT NULL ORDER BY producto_id').all(n);},
    async marcarRevision(o,codigo){await db.prepare("UPDATE tiendanube_stock_outbox SET estado='revision_manual',ultimo_error=? WHERE producto_id=?").run(codigo,o.producto_id);},
  };
}

export function crearServicioTiendanubeSync({db,repo=db?crearRepositorioTiendanubeSync(db):null,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  enabled=()=>process.env.TIENDANUBE_SYNC_ENABLED==='true',now=()=>new Date(),uuid=randomUUID,graciaOrdenMs=60000}={}){
  if(!repo)throw new Error('Falta repositorio de sincronización');
  const habilitado=()=>typeof enabled==='function'?enabled():enabled===true;
  const iso=()=>new Date(now()).toISOString();
  const ocupado=con=>con.sync_lease_token&&timestamp(con.sync_lease_hasta)>timestamp(now());
  async function revisar(con,e,p,codigo){
    if(p)await repo.guardarPedido(con,p,true);
    if(e)await repo.marcarEvento(e,'revision_manual',codigo);
    await repo.pausar(con.negocio_id,codigo);
    return {estado:'revision_manual',codigo};
  }
  async function readiness(n){
    const info=await repo.resumen(n);const c=info.conexion;const bloqueos=[];
    if(!habilitado())bloqueos.push('FEATURE_FLAG_APAGADA');
    if(!c)bloqueos.push('SIN_CONEXION');
    else {
      if(c.pausada)bloqueos.push('CONEXION_PAUSADA');
      if(!c.sync_activada_at)bloqueos.push('SIN_FECHA_DE_CORTE');
      if(!c.sync_baseline_at||info.sin_baseline)bloqueos.push('BASELINE_PENDIENTE');
      if(!c.sync_webhooks_at)bloqueos.push('WEBHOOKS_NO_VERIFICADOS');
      if(c.reserva_central_pendiente)bloqueos.push('RESERVA_CENTRAL_PENDIENTE');
    }
    if(!info.variantes)bloqueos.push('SIN_VARIANTES_VINCULADAS');
    if(info.revision)bloqueos.push('REVISIONES_PENDIENTES');
    return {...info,listo:bloqueos.length===0,bloqueos};
  }
  async function procesarProducto(con,e){
    const links=await repo.variantesDeProducto(con.negocio_id,con.store_id,e.recurso_id);
    if(!links.length){await repo.marcarEvento(e,'ignorado','PRODUCTO_SIN_VINCULOS');return {estado:'ignorado'};}
    if(links.length>50)return revisar(con,e,null,'PRODUCTO_DEMASIADAS_VARIANTES_PARA_VERIFICAR');
    let drift=false;
    try {
      const api=apiFactory(con);
      for(const link of links){
        if(!link.sync_baseline_at||!finiteStock(link.sync_stock_remoto))throw fail('VARIANTE_SIN_BASELINE');
        const remote=await api('GET',`/products/${validarIdExterno(link.product_id)}/variants/${validarIdExterno(link.variant_id)}`);
        if(stockRemotoVerificado(remote,link)!==link.sync_stock_remoto)drift=true;
      }
    }catch(err){
      const f=err?.code?{estado:'revision_manual',pausar:true,codigo:err.code}:clasificarFalloSync(err,{intentos:e.sync_intentos||0,ahora:timestamp(now())});
      await repo.marcarEvento(e,f.estado,f.codigo,f.delay?new Date(timestamp(now())+f.delay).toISOString():null);
      if(f.pausar)await repo.pausar(con.negocio_id,f.codigo);return f;
    }
    if(drift){
      // product/updated can arrive before order/created. Give the independent
      // order notification time to arrive; outbound stays blocked by this inbox.
      const from=timestamp(e.sync_ultimo_evento_at||e.recibido_at);
      const postDeadline=Math.max(0,...links.map(link=>timestamp(link.sync_verificar_despues)||0));
      const deadline=Math.max(from+Math.max(0,graciaOrdenMs),postDeadline);
      if(Number.isFinite(deadline)&&timestamp(now())<deadline){
        await repo.marcarEvento(e,'reintento','ESPERANDO_WEBHOOK_PEDIDO',new Date(deadline).toISOString());
        return {estado:'esperando_pedidos'};
      }
      return revisar(con,e,null,'STOCK_REMOTO_CAMBIO_FUERA_DE_COLA');
    }
    await repo.marcarEvento(e,'procesado');return {estado:'procesado',stock_verificado:true};
  }
  async function procesarEntrada(n){
    if(!habilitado())return {estado:'deshabilitado'};
    return repo.transaccion(n,async con=>{
      if(!active(con))return {estado:'pausado'};
      if(con.sync_reserva_token)return {estado:'esperando_reserva_central'};
      if(ocupado(con))return {estado:'ocupado'};
      if(con.sync_lease_token)return {estado:'requiere_recuperacion_salida'};
      const e=await repo.evento(con.store_id,iso());if(!e)return {estado:'vacio'};
      if(e.topic==='product/updated')return procesarProducto(con,e);
      if(!ORDER_TOPICS.has(e.topic)){await repo.marcarEvento(e,'ignorado','TOPIC_NO_SOPORTADO');return {estado:'ignorado'};}
      if(await repo.estaRedactado(con.store_id,e.recurso_id)){await repo.marcarEvento(e,'ignorado','PEDIDO_REDACTADO');return {estado:'redactado_ignorado'};}
      let raw,p;
      try {raw=await apiFactory(con)('GET',`/orders/${validarIdExterno(e.recurso_id)}`);}
      catch(err){
        const f=err?.code?{estado:'revision_manual',pausar:true,codigo:err.code}:clasificarFalloSync(err,{intentos:e.sync_intentos||0,ahora:timestamp(now())});
        await repo.marcarEvento(e,f.estado,f.codigo,f.delay?new Date(timestamp(now())+f.delay).toISOString():null);
        if(f.pausar)await repo.pausar(n,f.codigo);return f;
      }
      try {p=resumenPedidoTiendanube(raw);}catch(err){
        return revisar(con,e,null,err?.code==='STOCK_REMOTO_NO_RESERVADO'?'STOCK_REMOTO_NO_RESERVADO':'PEDIDO_REMOTO_MALFORMADO');
      }
      if(p.order_id!==String(e.recurso_id)||(raw.store_id!=null&&String(raw.store_id)!==con.store_id))return revisar(con,e,null,'PEDIDO_REMOTO_DISTINTO');
      const fecha=timestamp(raw.created_at);
      if(!Number.isFinite(fecha))return revisar(con,e,p,'PEDIDO_SIN_FECHA_VERIFICABLE');
      if(fecha<timestamp(con.sync_activada_at)){await repo.marcarEvento(e,'ignorado','PEDIDO_ANTERIOR_AL_CORTE');return {estado:'historico_ignorado'};}
      await repo.pedido(con.store_id,p.order_id);
      const prev=await repo.aplicados(con.store_id,p.order_id);const applied=new Map(prev.map(x=>[x.variant_id,x]));
      const entregado=await repo.entrega(con.store_id,p.order_id);
      if(entregado&&(p.cancelado||[...new Set([...Object.keys(p.cantidades),...applied.keys()])].some(v=>(p.cantidades[v]||0)!==(applied.get(v)?.cantidad_aplicada||0))))return revisar(con,e,p,'PEDIDO_ENTREGADO_REQUIERE_REVISION');
      if(p.cancelado){
        if(prev.some(x=>x.cantidad_aplicada>0))return revisar(con,e,p,'CANCELACION_RESTOCK_POR_VERIFICAR');
        await repo.guardarPedido(con,p,false);await repo.marcarEvento(e,'procesado');return {estado:'cancelado_sin_reserva'};
      }
      const changes=[];
      for(const variant of [...new Set([...Object.keys(p.cantidades),...applied.keys()])].sort()){
        const qty=p.cantidades[variant]||0,old=applied.get(variant)?.cantidad_aplicada||0,delta=qty-old;
        if(delta<0)return revisar(con,e,p,'EDICION_CON_REPOSICION_POR_VERIFICAR');
        const link=await repo.variante(n,con.store_id,variant);
        if(!link||!link.sync_baseline_at||!finiteStock(link.sync_stock_remoto))return revisar(con,e,p,'VARIANTE_SIN_BASELINE');
        if(applied.has(variant)&&applied.get(variant).producto_id!==link.producto_id)return revisar(con,e,p,'VINCULO_CAMBIO_DESPUES_DE_RESERVAR');
        if(!finiteStock(link.stock)||link.stock<delta)return revisar(con,e,p,'STOCK_LOCAL_INSUFICIENTE');
        if(link.sync_stock_remoto<delta)return revisar(con,e,p,'RESERVA_SUPERA_BASELINE_REMOTA');
        if(delta)changes.push({link,qty,delta});
      }
      await repo.guardarPedido(con,p,false);
      for(const c of changes)await repo.aplicarReserva(con,p,c.link,c.qty,c.delta);
      await repo.marcarEvento(e,'procesado');
      return {estado:'procesado',order_id:p.order_id,unidades_reservadas:changes.reduce((a,c)=>a+c.delta,0),cobros_creados:0,comisiones_creadas:0};
    });
  }
  async function procesarSalida(n){
    if(!habilitado())return {estado:'deshabilitado'};
    const prepared=await repo.transaccion(n,async con=>{
      if(!active(con))return {estado:'pausado'};
      if(con.sync_reserva_token)return {estado:'esperando_reserva_central'};
      if(ocupado(con))return {estado:'ocupado'};
      if(con.sync_lease_token){
        const abandoned=await repo.abandonados(n);
        for(const o of abandoned)await repo.marcarRevision(o,o.envio_put_iniciado?'RESULTADO_POST_STOCK_AMBIGUO':'ENVIO_INTERRUMPIDO');
        await repo.pausar(n,'ENVIO_INTERRUMPIDO_REVISAR');return {estado:'revision_manual',codigo:'ENVIO_INTERRUMPIDO_REVISAR'};
      }
      if(await repo.hayEntradas(con.store_id))return {estado:'esperando_entradas'};
      const candidate=await repo.candidato(n,iso());if(!candidate)return {estado:'vacio'};
      const o=await repo.salida(n,candidate.producto_id);
      if(!o||o.store_id!==con.store_id){
        if(o)await repo.marcarRevision(o,'VINCULO_INVALIDO');
        await repo.pausar(n,'VINCULO_INVALIDO');return {estado:'revision_manual',codigo:'VINCULO_INVALIDO'};
      }
      if(!o.sync_baseline_at||!finiteStock(o.stock)||!finiteStock(o.sync_stock_remoto)){
        await repo.marcarRevision(o,'STOCK_O_BASELINE_INVALIDO');await repo.pausar(n,'STOCK_O_BASELINE_INVALIDO');return {estado:'revision_manual',codigo:'STOCK_O_BASELINE_INVALIDO'};
      }
      const token=uuid();await repo.lease(con,token,new Date(timestamp(now())+90000).toISOString());await repo.reclamar(o,token,iso());
      return {con,o,token};
    });
    if(!prepared.token)return prepared;
    const {con,o,token}=prepared;let writing=false;
    const finish=async result=>repo.transaccion(n,async current=>{
      if(!current||current.sync_lease_token!==token)return {estado:'revision_manual',codigo:'LEASE_PERDIDO'};
      await repo.terminar(o,token,result);await repo.liberar(n,token);
      if(result.pausar)await repo.pausar(n,result.codigo);return result;
    });
    try {
      const api=apiFactory(con),path=`/products/${validarIdExterno(o.product_id)}/variants/${validarIdExterno(o.variant_id)}`;
      const observed=stockRemotoVerificado(await api('GET',path),o);
      if(observed!==o.sync_stock_remoto)return finish({estado:'revision_manual',pausar:true,codigo:'STOCK_REMOTO_CAMBIO_FUERA_DE_COLA'});
      const allowed=await repo.transaccion(n,async current=>{
        if(!current||current.sync_lease_token!==token||!active(current))return false;
        const latest=await repo.salida(n,o.producto_id);
        if(!latest||latest.envio_token!==token||Number(latest.version)!==Number(o.version)||latest.stock!==o.stock||await repo.hayEntradas(con.store_id))return false;
        if(observed===o.stock)return 'noop';
        await repo.iniciarEscritura(o,token);return 'variation';
      });
      if(!allowed)return finish({estado:'pendiente',codigo:'CAMBIO_DURANTE_PREPARACION'});
      // A web reservation is already reflected remotely; no adjustment needed.
      if(allowed==='noop')return finish({estado:'sincronizado',esperado:observed,sin_escritura:true});
      const variantId=Number(validarIdExterno(o.variant_id));
      if(!Number.isSafeInteger(variantId))throw fail('ID_VARIANTE_FUERA_DE_RANGO');
      const delta=o.stock-o.sync_stock_remoto;
      writing=true;
      // id MUST be explicit: omitting it would mutate every product variant.
      const changed=await api('POST',`/products/${validarIdExterno(o.product_id)}/variants/stock`,{action:'variation',value:delta,id:variantId});
      if(!Array.isArray(changed)||changed.length!==1)throw fail('RESPUESTA_VARIACION_INVALIDA');
      const result=stockRemotoVerificado(changed[0],o);
      if(result!==o.stock){
        // Do not issue this variation again and do not absorb a remote order
        // into the baseline: its later webhook must subtract that order once.
        const retry=new Date(timestamp(now())+Math.max(0,graciaOrdenMs)).toISOString();
        return finish({estado:'pendiente',codigo:'VARIACION_APLICADA_ESPERANDO_PEDIDOS',esperado:o.stock,retry,verificarDespues:retry});
      }
      return finish({estado:'sincronizado',esperado:o.stock});
    }catch(err){
      const f=err?.code?{estado:'revision_manual',pausar:true,codigo:err.code}:clasificarFalloSync(err,{escritura:writing,intentos:o.intentos||0,ahora:timestamp(now())});
      return finish({...f,estado:f.estado==='reintento'?'pendiente':f.estado,retry:f.delay?new Date(timestamp(now())+f.delay).toISOString():null});
    }
  }
  return {readiness,procesarEntrada,procesarSalida};
}
