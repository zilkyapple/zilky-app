import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {clienteTiendanube,descifrarToken} from '../lib/tiendanube.js';
import {huellaInstalacionPrivacidad} from './tiendanubePrivacidadService.js';

const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const local=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value))throw fail('PRIVACIDAD_IDENTIFICADOR_INVALIDO',400);return value;};
const iso=value=>value&&Number.isFinite(new Date(value).valueOf())?new Date(value).toISOString():null;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const revisiones=new Set(['store-redact','uninstalled']);
const canales=new Set(['recepcion_administrador','entrega_externa_declarada']);
const conteosInforme=['pedidos_solicitados','pedidos_no_almacenados','pedidos_redactados'];

function solicitudPublica(row){
  return {id:row.id,store_id:row.store_id,negocio_id:row.negocio_id,tipo:row.tipo,estado:row.estado,
    solicitud_ref:row.solicitud_ref??null,creada_at:iso(row.creada_at),actualizada_at:iso(row.actualizada_at),
    instalacion_creada_at:iso(row.instalacion_creada_at),evento_fecha:iso(row.evento_fecha)};
}
function informePara(row){
  const report=row.reporte||{};
  const pedidos=(Array.isArray(report.pedidos)?report.pedidos:[]).filter(p=>p&&/^[1-9]\d{0,19}$/.test(String(p.order_id))).map(p=>({
    order_id:String(p.order_id),estado:['pendiente','open','closed','cancelled','archived'].includes(p.estado)?p.estado:'no_clasificado',
    cantidades:Object.fromEntries(Object.entries(p.cantidades&&typeof p.cantidades==='object'&&!Array.isArray(p.cantidades)?p.cantidades:{}).filter(([k,v])=>/^[1-9]\d{0,19}$/.test(k)&&Number.isSafeInteger(v)&&v>0)),
    pagado:p.pagado===true,cancelado:p.cancelado===true,actualizado_at:iso(p.actualizado_at)}));
  return {version:1,solicitud_id:row.id,solicitud_ref:row.solicitud_ref,store_id:row.store_id,
    alcance:'resumenes_operativos_integracion_tiendanube',
    ...Object.fromEntries(conteosInforme.map(k=>[k,nonnegative(report[k])])),pedidos,
    limitaciones:['No contiene datos de contacto ni documentos de clientes.',
      'No se almacenan carritos abandonados ni borradores de pedido en esta integración.',
      'No exporta registros comerciales independientes de Zilky; requieren revisión separada si corresponde.']};
}
const entregaPublica=row=>row?{exportacion_id:row.exportacion_id,informe_hash:row.informe_hash,canal:row.canal,
  actor_id:row.actor_id,declarada_at:iso(row.declarada_at),enviado_por_sistema:false,verificacion_externa:false}:null;

/** Gestión operativa, no certificado legal ni automatización de envío.
 * Solo administradores activos de la organización propietaria. Las escrituras
 * conservan autor, fecha y huellas sin duplicar informes ni contactos. */
export function crearGestionPrivacidadTiendanube({database,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  now=()=>new Date(),uuid=randomUUID,nonce=()=>randomBytes(32).toString('hex')}={}){
  let currentDb=database;
  const obtenerDb=async()=>currentDb||(currentDb=(await import('../db/connection.js')).db);
  const time=()=>new Date(now()).valueOf();
  async function autorizar(db,n,actor){
    local(n);local(actor);
    const negocio=await db.prepare('SELECT organizacion_id FROM negocios WHERE id=? FOR SHARE').get(n);
    const usuario=await db.prepare('SELECT rol,activo FROM usuarios WHERE id=? FOR SHARE').get(actor);
    if(!negocio?.organizacion_id||usuario?.rol!=='administrador'||usuario.activo!==1)throw fail('PRIVACIDAD_SOLO_ADMINISTRADOR',403);
    const miembro=await db.prepare('SELECT rol,activo FROM usuario_organizacion WHERE organizacion_id=? AND usuario_id=? FOR SHARE').get(negocio.organizacion_id,actor);
    if(miembro?.activo!==1||miembro.rol!=='administrador')throw fail('PRIVACIDAD_SOLO_ADMINISTRADOR',403);
  }
  async function contexto(n,id,actor,fn){
    local(id);const db=await obtenerDb();
    return db.transaction(async()=>{
      await autorizar(db,n,actor);
      const first=await db.prepare('SELECT store_id FROM tiendanube_privacidad_solicitudes WHERE id=? AND negocio_id=?').get(id,n);
      if(!first)throw fail('PRIVACIDAD_NO_ENCONTRADA',404);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${first.store_id}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(n);
      const row=await db.prepare('SELECT * FROM tiendanube_privacidad_solicitudes WHERE id=? AND negocio_id=? FOR UPDATE').get(id,n);
      if(!row||row.store_id!==first.store_id)throw fail('PRIVACIDAD_SOLICITUD_CAMBIO');
      return fn({db,row,con});
    });
  }
  async function listar(n,actor){
    const db=await obtenerDb();
    return db.transaction(async()=>{
      await autorizar(db,n,actor);
      const rows=await db.prepare(`SELECT id,store_id,negocio_id,tipo,estado,solicitud_ref,creada_at,actualizada_at,instalacion_creada_at,evento_fecha
        FROM tiendanube_privacidad_solicitudes WHERE negocio_id=? ORDER BY CASE WHEN estado='completada' THEN 1 ELSE 0 END,creada_at DESC,id DESC LIMIT 101`).all(n);
      return {solicitudes:rows.slice(0,100).map(solicitudPublica),hay_mas:rows.length>100};
    });
  }
  async function detalle(n,id,actor){
    return contexto(n,id,actor,async({db,row})=>({solicitud:solicitudPublica(row),
      informe:row.tipo==='customer-data-request'?informePara(row):null,
      informe_disponible:row.tipo==='customer-data-request'&&row.reporte?.datos_operativos_eliminados!==true,
      entrega:entregaPublica(await db.prepare('SELECT * FROM tiendanube_privacidad_entregas WHERE solicitud_id=? AND negocio_id=?').get(id,n)),
      cierre:row.estado==='completada'&&revisiones.has(row.tipo)?{
        accion:row.reporte?.accion||null,completada_at:iso(row.reporte?.completada_at),
        datos_locales_zilky_modificados:false,obligaciones_externas_verificadas:false}:null}));
  }
  async function exportar(n,id,actor){
    return contexto(n,id,actor,async({db,row})=>{
      if(row.tipo!=='customer-data-request')throw fail('PRIVACIDAD_NO_ES_INFORME',400);
      if(row.reporte?.datos_operativos_eliminados===true)throw fail('PRIVACIDAD_INFORME_YA_REDACTADO',410);
      const informe=informePara(row),informeHash=digest(informe),exportacionId=uuid();
      await db.prepare(`INSERT INTO tiendanube_privacidad_exportaciones(id,solicitud_id,negocio_id,actor_id,informe_hash)
        VALUES(?,?,?,?,?)`).run(exportacionId,id,n,actor,informeHash);
      return {exportacion_id:exportacionId,informe_hash:informeHash,nombre_archivo:`tiendanube-informe-${id}.json`,informe,
        estado:row.estado,entrega_confirmada:false,enviado_por_sistema:false};
    });
  }
  async function confirmarEntrega(n,id,actor,input={}){
    if(input?.confirmar_entrega!==true||!canales.has(input?.canal)||!validHash(input?.informe_hash))throw fail('PRIVACIDAD_CONFIRMACION_ENTREGA_REQUERIDA',400);
    local(input.exportacion_id);
    return contexto(n,id,actor,async({db,row})=>{
      if(row.tipo!=='customer-data-request')throw fail('PRIVACIDAD_NO_ES_INFORME',400);
      const existing=await db.prepare('SELECT * FROM tiendanube_privacidad_entregas WHERE solicitud_id=? AND negocio_id=?').get(id,n);
      if(existing){
        if(existing.exportacion_id!==input.exportacion_id||existing.actor_id!==actor||existing.informe_hash!==input.informe_hash||existing.canal!==input.canal)throw fail('PRIVACIDAD_ENTREGA_YA_DECLARADA');
        return {estado:'completada',duplicada:true,entrega:entregaPublica(existing)};
      }
      if(row.estado!=='pendiente_entrega'||row.reporte?.datos_operativos_eliminados===true)throw fail('PRIVACIDAD_ESTADO_NO_PERMITE_ENTREGA');
      const exported=await db.prepare('SELECT * FROM tiendanube_privacidad_exportaciones WHERE id=? AND solicitud_id=? AND negocio_id=? AND actor_id=?').get(input.exportacion_id,id,n,actor);
      if(!exported||exported.informe_hash!==input.informe_hash||digest(informePara(row))!==input.informe_hash)throw fail('PRIVACIDAD_INFORME_CAMBIO');
      const receipt=await db.prepare(`INSERT INTO tiendanube_privacidad_entregas(solicitud_id,exportacion_id,negocio_id,actor_id,informe_hash,canal)
        VALUES(?,?,?,?,?,?) RETURNING *`).get(id,input.exportacion_id,n,actor,input.informe_hash,input.canal);
      const report={...row.reporte,estado_entrega:'declarada_por_administrador',enviado_por_sistema:false,verificacion_externa:false};
      await db.prepare("UPDATE tiendanube_privacidad_solicitudes SET estado='completada',reporte=?::jsonb,actualizada_at=NOW() WHERE id=? AND negocio_id=?")
        .run(JSON.stringify(report),id,n);
      return {estado:'completada',duplicada:false,entrega:entregaPublica(receipt)};
    });
  }

  // Digerir cada fila en PostgreSQL evita devolver PII/credenciales al navegador
  // y detecta cambios aun con igual cantidad y fecha. Las condiciones son
  // constantes, jamás nombres de tabla/campos aportados por el cliente.
  async function estadistica(db,tabla,where,params){
    const result=await db.query(`SELECT count(*)::int AS cantidad,
      encode(sha256(convert_to(COALESCE(string_agg(firma,'' ORDER BY firma),''),'UTF8')),'hex') AS huella
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS firma FROM ${tabla} t WHERE ${where}) s`,params);
    return result.rows[0];
  }
  async function panorama(db,row,con){
    const n=row.negocio_id,store=row.store_id,bloqueos=[];
    if(!revisiones.has(row.tipo)||row.estado!=='pendiente_revision')bloqueos.push('PRIVACIDAD_NO_ES_REVISION_PENDIENTE');
    if(!row.instalacion_huella||!row.instalacion_creada_at)bloqueos.push('PRIVACIDAD_INSTALACION_SIN_EVIDENCIA');
    if(!con)bloqueos.push('PRIVACIDAD_INSTALACION_NO_PRESENTE');
    else{
      if(con.store_id!==store||huellaInstalacionPrivacidad(con)!==row.instalacion_huella)bloqueos.push('PRIVACIDAD_INSTALACION_DISTINTA');
      if(con.pausada!==true)bloqueos.push('PRIVACIDAD_REQUIERE_PAUSA');
      if(con.sync_lease_token||con.sync_reserva_token)bloqueos.push('PRIVACIDAD_OPERACION_EN_CURSO');
    }
    if(row.evento_fecha&&row.instalacion_creada_at&&new Date(row.evento_fecha)<new Date(row.instalacion_creada_at))bloqueos.push('PRIVACIDAD_EVENTO_ANTERIOR');
    if(row.reporte?.app_id_evento&&con&&String(row.reporte.app_id_evento)!==String(con.app_id))bloqueos.push('PRIVACIDAD_APP_DISTINTA');
    // No inspeccionar ni mostrar conteos de una instalación posterior o de una
    // tienda que ahora pertenezca a otro negocio. Primero debe ser atribuible.
    if(bloqueos.length)return {bloqueos,snapshot_hash:null,eliminar:{},conservar:{}};
    const snap={};
    const specs=[
      ['conexion','tiendanube_conexiones','t.negocio_id=$1',[n]],
      ['vinculos','tiendanube_variantes','t.negocio_id=$1 AND t.store_id=$2',[n,store]],
      ['salidas_stock','tiendanube_stock_outbox','t.negocio_id=$1',[n]],
      ['notificaciones','tiendanube_eventos','t.store_id=$1',[store]],
      ['resumenes_pedidos','tiendanube_pedidos','t.negocio_id=$1 AND t.store_id=$2',[n,store]],
      ['ledger_stock','tiendanube_pedido_stock','t.store_id=$1 AND EXISTS(SELECT 1 FROM productos p WHERE p.id=t.producto_id AND p.negocio_id=$2)',[store,n]],
      ['entregas_comerciales','tiendanube_entregas','t.negocio_id=$1 AND t.store_id=$2',[n,store]],
      ['intentos_reserva','tiendanube_reserva_intentos','t.negocio_id=$1 AND t.store_id=$2',[n,store]],
      ['solicitudes_privacidad','tiendanube_privacidad_solicitudes','t.negocio_id=$1 AND t.store_id=$2',[n,store]],
      ['autorizaciones_pendientes','tiendanube_oauth_estados','t.negocio_id=$1',[n]],
    ];
    for(const [name,table,where,params] of specs)snap[name]=await estadistica(db,table,where,params);
    const checks=await db.query(`SELECT
      EXISTS(SELECT 1 FROM tiendanube_eventos WHERE store_id=$2 AND (procesado_at IS NULL OR sync_estado NOT IN ('procesado','ignorado'))) AS inbox_pendiente,
      EXISTS(SELECT 1 FROM tiendanube_stock_outbox WHERE negocio_id=$1 AND (estado<>'sincronizado' OR envio_token IS NOT NULL OR envio_put_iniciado=TRUE)) AS outbox_pendiente,
      EXISTS(SELECT 1 FROM tiendanube_pedidos WHERE store_id=$2 AND pendiente_revision=TRUE) AS pedidos_revision,
      EXISTS(SELECT 1 FROM tiendanube_pedido_stock s WHERE s.store_id=$2 AND s.cantidad_aplicada>0
        AND NOT EXISTS(SELECT 1 FROM tiendanube_entregas e WHERE e.store_id=s.store_id AND e.order_hash=s.order_hash AND e.negocio_id=$1)) AS reservas_sin_entrega,
      EXISTS(SELECT 1 FROM tiendanube_reserva_intentos WHERE (negocio_id=$1 OR store_id=$2) AND estado IN ('enviando','revision_manual')) AS reservas_pendientes,
      EXISTS(SELECT 1 FROM tiendanube_privacidad_solicitudes WHERE negocio_id=$1 AND store_id=$2 AND tipo='customer-data-request' AND estado='pendiente_entrega') AS informes_pendientes,
      (EXISTS(SELECT 1 FROM tiendanube_variantes WHERE (negocio_id=$1 OR store_id=$2) AND (negocio_id<>$1 OR store_id<>$2))
        OR EXISTS(SELECT 1 FROM tiendanube_stock_outbox o WHERE o.negocio_id=$1 AND NOT EXISTS(SELECT 1 FROM tiendanube_variantes v WHERE v.producto_id=o.producto_id AND v.negocio_id=$1 AND v.store_id=$2))
        OR EXISTS(SELECT 1 FROM tiendanube_pedidos WHERE store_id=$2 AND negocio_id<>$1)
        OR EXISTS(SELECT 1 FROM tiendanube_entregas WHERE store_id=$2 AND negocio_id<>$1)
        OR EXISTS(SELECT 1 FROM tiendanube_reserva_intentos WHERE (negocio_id=$1 OR store_id=$2) AND (negocio_id<>$1 OR store_id<>$2))) AS inconsistente`,[n,store]);
    const codes={inbox_pendiente:'PRIVACIDAD_NOTIFICACIONES_PENDIENTES',outbox_pendiente:'PRIVACIDAD_STOCK_PENDIENTE',
      pedidos_revision:'PRIVACIDAD_PEDIDOS_REVISION',reservas_sin_entrega:'PRIVACIDAD_RESERVAS_SIN_ENTREGA',
      reservas_pendientes:'PRIVACIDAD_RESERVAS_PENDIENTES',informes_pendientes:'PRIVACIDAD_INFORMES_PENDIENTES',inconsistente:'PRIVACIDAD_DATOS_INCONSISTENTES'};
    for(const [key,code] of Object.entries(codes))if(checks.rows[0][key])bloqueos.push(code);
    return {bloqueos,snapshot_hash:digest(snap),eliminar:{credenciales:snap.conexion.cantidad,vinculos:snap.vinculos.cantidad,
      salidas_stock:snap.salidas_stock.cantidad,notificaciones:snap.notificaciones.cantidad,resumenes_pedidos:snap.resumenes_pedidos.cantidad,
      autorizaciones_pendientes:snap.autorizaciones_pendientes.cantidad},
      conservar:{ledger_stock:snap.ledger_stock.cantidad,entregas_comerciales:snap.entregas_comerciales.cantidad,
        intentos_reserva:snap.intentos_reserva.cantidad,solicitudes_privacidad:snap.solicitudes_privacidad.cantidad}};
  }
  async function verificarRevocacion(con){
    try{await apiFactory(con)('GET','/store');return 'PRIVACIDAD_CREDENCIAL_VIGENTE';}
    catch(e){return Number(e?.status)===401?null:'PRIVACIDAD_REVOCACION_NO_VERIFICADA';}
  }
  async function bloquearProductos(db,n,store){
    // Las ventas locales bloquean producto antes de ejecutar el trigger de
    // outbox. Esperarlas antes del snapshot evita borrar una salida nueva y
    // serializa la retirada de vínculos con los ajustes de inventario.
    await db.prepare(`SELECT p.id FROM productos p JOIN tiendanube_variantes v ON v.producto_id=p.id
      WHERE v.negocio_id=? AND v.store_id=? AND p.negocio_id=? ORDER BY p.id FOR UPDATE OF p`).all(n,store,n);
  }
  async function previewBorrado(n,id,actor){
    return contexto(n,id,actor,async({db,row,con})=>{
      await bloquearProductos(db,n,row.store_id);
      const plan=await panorama(db,row,con);
      let revocada=false;
      if(!plan.bloqueos.length){const motivo=await verificarRevocacion(con);if(motivo)plan.bloqueos.push(motivo);else revocada=true;}
      await autorizar(db,n,actor);
      const result={solicitud:solicitudPublica(row),puede_confirmar:plan.bloqueos.length===0,bloqueos:plan.bloqueos,
        eliminar:plan.eliminar,conservar:plan.conservar,revocacion_verificada:revocada,
        datos_locales_zilky_modificados:false,obligaciones_externas_verificadas:false,
        frase_requerida:`BORRAR INTEGRACION ${row.store_id}`};
      if(result.puede_confirmar){
        const token=nonce();if(!validHash(token))throw fail('PRIVACIDAD_CONFIRMACION_NO_DISPONIBLE',503);
        const vencimiento=new Date(time()+10*60000).toISOString();
        await db.prepare(`INSERT INTO tiendanube_privacidad_confirmaciones(id,solicitud_id,negocio_id,actor_id,token_hash,snapshot_hash,vence_at)
          VALUES(?,?,?,?,?,?,?)`).run(uuid(),id,n,actor,digest(token),plan.snapshot_hash,vencimiento);
        Object.assign(result,{confirmacion_token:token,vence_at:vencimiento});
      }
      return result;
    });
  }
  async function confirmarBorrado(n,id,actor,input={}){
    if(input?.confirmar_borrado!==true||!validHash(input?.confirmacion_token)||typeof input.frase!=='string')throw fail('PRIVACIDAD_CONFIRMACION_BORRADO_REQUERIDA',400);
    return contexto(n,id,actor,async({db,row,con})=>{
      if(input.frase!==`BORRAR INTEGRACION ${row.store_id}`)throw fail('PRIVACIDAD_CONFIRMACION_BORRADO_REQUERIDA',400);
      const prev=await db.prepare(`SELECT * FROM tiendanube_privacidad_confirmaciones
        WHERE token_hash=? AND solicitud_id=? AND negocio_id=? AND actor_id=? FOR UPDATE`).get(digest(input.confirmacion_token),id,n,actor);
      if(!prev)throw fail('PRIVACIDAD_PREVIEW_REQUERIDO');
      // Un reintento devuelve la constancia original; nunca toca una conexión
      // nueva aunque se haya instalado después del primer resultado.
      if(prev.consumida_at)return {...prev.resultado,duplicada:true};
      if(!iso(prev.vence_at)||new Date(prev.vence_at).valueOf()<=time())throw fail('PRIVACIDAD_PREVIEW_VENCIDO');
      await bloquearProductos(db,n,row.store_id);
      const plan=await panorama(db,row,con);
      if(plan.bloqueos.length)throw fail(plan.bloqueos[0]);
      if(plan.snapshot_hash!==prev.snapshot_hash)throw fail('PRIVACIDAD_PREVIEW_CAMBIO');
      const motivo=await verificarRevocacion(con);if(motivo)throw fail(motivo);
      await autorizar(db,n,actor);
      const after=await panorama(db,row,con);
      if(after.bloqueos.length||after.snapshot_hash!==prev.snapshot_hash)throw fail('PRIVACIDAD_PREVIEW_CAMBIO');
      // La época invalida también los callbacks que ya consumieron su state y
      // están esperando una respuesta OAuth fuera de esta transacción.
      await db.prepare(`INSERT INTO tiendanube_privacidad_epocas(negocio_id,epoca) VALUES(?,1)
        ON CONFLICT(negocio_id) DO UPDATE SET epoca=tiendanube_privacidad_epocas.epoca+1`).run(n);
      await db.prepare('DELETE FROM tiendanube_oauth_estados WHERE negocio_id=?').run(n);
      await db.prepare('DELETE FROM tiendanube_stock_outbox WHERE negocio_id=?').run(n);
      await db.prepare('DELETE FROM tiendanube_eventos WHERE store_id=?').run(row.store_id);
      await db.prepare('DELETE FROM tiendanube_pedidos WHERE negocio_id=? AND store_id=?').run(n,row.store_id);
      await db.prepare('DELETE FROM tiendanube_variantes WHERE negocio_id=? AND store_id=?').run(n,row.store_id);
      const deleted=await db.prepare('DELETE FROM tiendanube_conexiones WHERE negocio_id=? AND store_id=? AND token_cifrado=?').run(n,row.store_id,con.token_cifrado);
      if(deleted.changes!==1)throw fail('PRIVACIDAD_INSTALACION_DISTINTA');
      // Informes ya entregados: retirar los resúmenes en claro; sus huellas y
      // las constancias de recepción permanecen para trazabilidad.
      await db.prepare(`UPDATE tiendanube_privacidad_solicitudes SET reporte=(reporte-'pedidos')||?::jsonb,actualizada_at=NOW()
        WHERE negocio_id=? AND store_id=? AND tipo='customer-data-request'`).run(JSON.stringify({pedidos:[],datos_operativos_eliminados:true}),n,row.store_id);
      const result={solicitud_id:id,estado:'completada',accion:'datos_operativos_de_integracion_eliminados',completada_at:new Date(time()).toISOString(),
        store_id:row.store_id,actor_id:actor,eliminados:plan.eliminar,conservados:plan.conservar,
        revocacion_verificada:true,datos_locales_zilky_modificados:false,obligaciones_externas_verificadas:false,duplicada:false};
      await db.prepare(`UPDATE tiendanube_privacidad_solicitudes SET estado='completada',reporte=?::jsonb,actualizada_at=NOW()
        WHERE id=? AND negocio_id=?`).run(JSON.stringify(result),id,n);
      await db.prepare(`UPDATE tiendanube_privacidad_confirmaciones SET consumida_at=NOW(),resultado=?::jsonb WHERE id=?`)
        .run(JSON.stringify(result),prev.id);
      return result;
    });
  }
  return {listar,detalle,exportar,confirmarEntrega,previewBorrado,confirmarBorrado};
}

export const tiendanubePrivacidadGestion=crearGestionPrivacidadTiendanube();
