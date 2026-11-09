import { clienteTiendanube, descifrarToken, validarIdExterno } from '../lib/tiendanube.js';
import { dateISO } from '../lib/validation.js';
import { hashPedidoPrivacidad } from './tiendanubePrivacidadService.js';
import { validarPedidoEntregaTiendanube } from './tiendanubeEntregasService.js';

const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const localId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value))throw fail('IDENTIFICADOR_LOCAL_INVALIDO',400);return value;};
const external=value=>{try{return validarIdExterno(value);}catch{throw fail('IDENTIFICADOR_REMOTO_INVALIDO',400);}};
const json=value=>{try{const p=typeof value==='string'?JSON.parse(value):value;return p&&typeof p==='object'&&!Array.isArray(p)?p:{};}catch{return {};}};
const dayAR=value=>new Date(new Date(value).valueOf()-3*3600000).toISOString().slice(0,10);
const sameQuantities=(a,b)=>JSON.stringify(Object.entries(json(a)).sort())===JSON.stringify(Object.entries(json(b)).sort());

function entregaPublica(row){
  return row?{estado:'entregada',venta_id:row.venta_id,credito_id:row.credito_id,
    condicion_precio:row.condicion_precio,fecha_entrega:row.fecha_entrega,fecha_limite:row.fecha_limite||null,
    total_centavos:row.total_centavos,entrega_inicial_centavos:row.entrega_inicial_centavos,
    saldo_inicial_centavos:row.total_centavos-row.entrega_inicial_centavos}:null;
}

// This read model is intentionally separate from the administrator connection
// panel. Operational sellers receive individual orders, never costs, commission
// values, tokens, aggregate revenue or provider customer/contact payloads.
export function crearConsultasPedidosTiendanube({database,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  enabled=()=>process.env.TIENDANUBE_ENTREGAS_ENABLED==='true',now=()=>new Date()}={}){
  let currentDb=database;
  const obtenerDb=async()=>currentDb||(currentDb=(await import('../db/connection.js')).db);
  const disponible=()=>{if(!(typeof enabled==='function'?enabled():enabled===true))throw fail('ENTREGAS_TIENDANUBE_DESHABILITADAS');};

  async function autorizar(db,n,actor){
    localId(n);localId(actor);
    const negocio=await db.prepare('SELECT organizacion_id FROM negocios WHERE id=?').get(n);
    const user=await db.prepare('SELECT rol,activo FROM usuarios WHERE id=?').get(actor);
    if(!negocio?.organizacion_id||!user||user.activo!==1)throw fail('SIN_PERMISO_ENTREGA_EN_NEGOCIO',403);
    if(user.rol==='administrador'){
      const miembro=await db.prepare('SELECT rol,activo FROM usuario_organizacion WHERE organizacion_id=? AND usuario_id=?').get(negocio.organizacion_id,actor);
      if(miembro?.activo!==1||miembro.rol!=='administrador')throw fail('ADMINISTRADOR_DE_OTRA_ORGANIZACION',403);
      return {organizacion_id:negocio.organizacion_id,actor_id:actor,administrador:true,puede_cobrar:true,puede_elegir_cliente:true};
    }
    const miembro=await db.prepare('SELECT activo,permisos FROM usuario_negocio WHERE negocio_id=? AND usuario_id=?').get(n,actor);
    const p=json(miembro?.permisos);
    if(miembro?.activo!==1||p['ventas.crear']!==true||p['tienda.pedidos']!==true)throw fail('SIN_PERMISO_ENTREGA_EN_NEGOCIO',403);
    return {organizacion_id:negocio.organizacion_id,actor_id:actor,administrador:false,
      puede_cobrar:p['pagos.registrar']===true,puede_elegir_cliente:p['clientes.ver']===true};
  }
  const capacidades=scope=>({actor_id:scope.actor_id,elegir_vendedor:scope.administrador,
    puede_cobrar:scope.puede_cobrar,puede_elegir_cliente:scope.puede_elegir_cliente});

  async function contexto(n,actor,fn,{token=false}={}){
    disponible();const db=await obtenerDb();
    return db.transaction(async()=>{
      const scope=await autorizar(db,n,actor);
      const first=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      if(!first)throw fail('CONEXION_NO_DISPONIBLE',404);
      const store=external(first.store_id);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${store}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare(`SELECT store_id,pausada,sync_baseline_at,sync_activada_at,sync_webhooks_at,sync_lease_token,sync_reserva_token${token?',token_cifrado':''}
        FROM tiendanube_conexiones WHERE negocio_id=?`).get(n);
      if(!con||String(con.store_id)!==store)throw fail('CONEXION_CAMBIO_DURANTE_BLOQUEO');
      return fn({db,scope,con,store});
    });
  }

  async function listar(n,actor){
    return contexto(n,actor,async({db,scope,con,store})=>{
      const rows=await db.prepare(`SELECT order_id,estado,pagado,cancelado,pendiente_revision,actualizado_at
        FROM tiendanube_pedidos WHERE negocio_id=? AND store_id=? ORDER BY actualizado_at DESC,order_id DESC LIMIT 101`).all(n,store);
      const ids=rows.map(p=>hashPedidoPrivacidad(store,external(p.order_id)));
      const tombstones=ids.length?(await db.query('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=$1 AND order_hash=ANY($2::text[])',[store,ids])).rows:[];
      const borrados=new Set(tombstones.map(r=>r.order_hash));
      const deliveries=ids.length?(await db.query(`SELECT order_hash,venta_id,credito_id,condicion_precio,fecha_entrega,fecha_limite,total_centavos,entrega_inicial_centavos
        FROM tiendanube_entregas WHERE negocio_id=$1 AND store_id=$2 AND order_hash=ANY($3::text[])`,[n,store,ids])).rows:[];
      const entregas=new Map(deliveries.map(r=>[r.order_hash,r]));
      return {capacidades:capacidades(scope),sincronizacion_pausada:con.pausada===true,
        hay_mas:rows.length>100,pedidos:rows.slice(0,100).filter(p=>!borrados.has(hashPedidoPrivacidad(store,p.order_id))).map(p=>{
          const e=entregas.get(hashPedidoPrivacidad(store,p.order_id));
          return {order_id:p.order_id,estado:e?'entregada':p.cancelado?'cancelado':p.pendiente_revision?'revision':'pendiente',
            actualizado_at:p.actualizado_at,pago_informado_por_tiendanube:p.pagado===true};
        })};
    });
  }

  async function opciones(n,actor,buscar=''){
    if(typeof buscar!=='string'||buscar.length>120)throw fail('BUSQUEDA_INVALIDA',400);
    return contexto(n,actor,async({db,scope})=>{
      const clientes=scope.puede_elegir_cliente?await db.prepare(`SELECT c.id,c.nombre,c.apellido FROM clientes c
        JOIN cliente_negocio cn ON cn.cliente_id=c.id WHERE cn.negocio_id=? AND c.consumidor_final_negocio IS NULL
          AND position(lower(?) in lower(coalesce(c.nombre,'')||' '||coalesce(c.apellido,'')))>0
        ORDER BY c.nombre,c.apellido,c.id LIMIT 50`).all(n,buscar.trim()):[];
      const vendedores=scope.administrador?await db.prepare(`SELECT u.id,u.nombre FROM usuarios u WHERE u.activo=1 AND (
        (u.rol='administrador' AND EXISTS(SELECT 1 FROM usuario_organizacion uo WHERE uo.usuario_id=u.id AND uo.organizacion_id=? AND uo.activo=1 AND uo.rol='administrador'))
        OR (u.rol<>'administrador' AND EXISTS(SELECT 1 FROM usuario_negocio un WHERE un.usuario_id=u.id AND un.negocio_id=? AND un.activo=1)))
        ORDER BY u.nombre,u.id`).all(scope.organizacion_id,n):[];
      return {capacidades:capacidades(scope),clientes,vendedores};
    });
  }

  async function detalle(n,orderId,actor,{fecha_entrega=dayAR(now())}={}){
    const order=external(orderId);dateISO(fecha_entrega,'fecha de entrega');
    if(fecha_entrega>dayAR(now()))throw fail('ENTREGA_FUTURA_NO_PERMITIDA',400);
    return contexto(n,actor,async({db,scope,con,store})=>{
      const hash=hashPedidoPrivacidad(store,order);
      if(await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(store,hash))throw fail('PEDIDO_REDACTADO',410);
      const p=await db.prepare('SELECT estado,cantidades,cancelado,pendiente_revision FROM tiendanube_pedidos WHERE negocio_id=? AND store_id=? AND order_id=?').get(n,store,order);
      if(!p)throw fail('PEDIDO_NO_ENCONTRADO',404);
      const delivered=await db.prepare(`SELECT venta_id,credito_id,condicion_precio,fecha_entrega,fecha_limite,total_centavos,entrega_inicial_centavos
        FROM tiendanube_entregas WHERE negocio_id=? AND store_id=? AND order_hash=?`).get(n,store,hash);
      if(delivered)return {order_id:order,estado:'entregada',capacidades:capacidades(scope),entrega:entregaPublica(delivered)};
      if(con.pausada||!con.sync_baseline_at||!con.sync_activada_at||!con.sync_webhooks_at||con.sync_lease_token||con.sync_reserva_token)throw fail('SINCRONIZACION_NO_LISTA_PARA_ENTREGA');
      if(p.cancelado||p.pendiente_revision||!['open','closed'].includes(p.estado))throw fail('PEDIDO_NO_CONCILIADO_PARA_ENTREGA');
      const event=await db.prepare(`SELECT id FROM tiendanube_eventos WHERE store_id=? AND recurso_id=? AND topic LIKE 'order/%'
        AND (topic='order/edited' OR (procesado_at IS NULL AND sync_estado<>'ignorado')) LIMIT 1`).get(store,order);
      if(event)throw fail('EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION');
      let raw;
      try{raw=await apiFactory(con)('GET',`/orders/${order}`);}catch{throw fail('NO_SE_PUDO_VERIFICAR_PEDIDO_REMOTO',503);}
      const created=Date.parse(raw?.created_at),cutoff=new Date(con.sync_activada_at).valueOf();
      if(!Number.isFinite(created)||!Number.isFinite(cutoff)||created<cutoff||dayAR(created)>fecha_entrega)throw fail('FECHA_PEDIDO_FUERA_DEL_PERIODO_CONCILIADO');
      const opcionesPrecio=[],errors=[];
      for(const condicion of ['30_dias','contado']){
        try{opcionesPrecio.push({condicion_precio:condicion,...validarPedidoEntregaTiendanube(raw,{storeId:store,orderId:order,condicionPrecio:condicion,fechaEntrega:fecha_entrega})});}
        catch(e){errors.push(e);}
      }
      const reportaCobro=['paid','partially_paid'].includes(raw?.payment_status)||!!raw?.paid_at||Number(raw?.total_paid_by_customer)>0;
      raw=null;
      if(!opcionesPrecio.length)throw errors[0]||fail('PEDIDO_NO_CONCILIADO_PARA_ENTREGA');
      if(!sameQuantities(p.cantidades,opcionesPrecio[0].cantidades))throw fail('PEDIDO_REMOTO_EDITADO_REQUIERE_CONCILIACION');
      const reservas=await db.prepare(`SELECT r.variant_id,r.producto_id,r.cantidad_aplicada,v.product_id,p.nombre,p.variante
        FROM tiendanube_pedido_stock r JOIN tiendanube_variantes v ON v.store_id=r.store_id AND v.variant_id=r.variant_id AND v.producto_id=r.producto_id
        JOIN productos p ON p.id=r.producto_id AND p.negocio_id=v.negocio_id
        WHERE r.store_id=? AND r.order_hash=? AND v.negocio_id=?`).all(store,hash,n);
      if(reservas.length!==Object.keys(opcionesPrecio[0].cantidades).length)throw fail('RESERVA_INCOMPLETA');
      const byVariant=new Map(reservas.map(r=>[r.variant_id,r]));
      for(const r of reservas)if(r.cantidad_aplicada!==opcionesPrecio[0].cantidades[r.variant_id])throw fail('RESERVA_NO_COINCIDE');
      // The remote GET may take time. Re-read current membership/permissions
      // before returning order details; do not reuse pre-request privileges.
      const scopeActual=await autorizar(db,n,actor);
      return {order_id:order,estado:'pendiente',fecha_entrega,capacidades:capacidades(scopeActual),
        cobro_informado_por_tiendanube:reportaCobro,condiciones:opcionesPrecio.map(mode=>({
          condicion_precio:mode.condicion_precio,total_centavos:mode.total_centavos,precio_publicado_centavos:mode.precio_publicado_centavos,
          descuento_centavos:mode.descuento_centavos,lineas:mode.lineas.map(line=>{
            const r=byVariant.get(line.variant_id);
            if(!r||String(r.product_id)!==line.product_id)throw fail('PRODUCTO_REMOTO_NO_COINCIDE');
            return {producto_id:r.producto_id,nombre:r.nombre,variante:r.variante||'',cantidad:line.cantidad,
              precio_unitario_centavos:line.precio_unitario_centavos};
          })}))};
    },{token:true});
  }
  return {listar,opciones,detalle};
}

export const consultasPedidosTiendanube=crearConsultasPedidosTiendanube();
