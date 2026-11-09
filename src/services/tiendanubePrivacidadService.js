import { createHash, randomUUID } from 'node:crypto';

const acciones=new Set(['customer-redact','customer-data-request','store-redact','uninstalled']);
const estadosPedido=new Set(['pendiente','open','closed','cancelled','archived']);
const fallo=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function idExterno(value){
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw fallo('Identificador de privacidad inválido');
  const id=String(value??'');
  if(!/^[1-9]\d{0,19}$/.test(id))throw fallo('Identificador de privacidad inválido');
  return id;
}
// Contrato compartido con el motor de stock. La marca es permanente para esa
// tienda/pedido y permite ignorar reentregas sin retener el pedido en claro.
export function hashPedidoPrivacidad(storeId,orderId){
  return hash(['tiendanube-order',idExterno(storeId),idExterno(orderId)]);
}
function ids(value,{opcional=false}={}){
  if(value===undefined&&opcional)return [];
  if(!Array.isArray(value)||value.length>1000)throw fallo('Lista de pedidos de privacidad inválida');
  return [...new Set(value.map(idExterno))].sort();
}
function fecha(value){
  if(value===undefined||value===null)return null;
  const parsed=new Date(value);
  return Number.isFinite(parsed.valueOf())?parsed.toISOString():null;
}
function fechaEvento(value){
  if(value===undefined||value===null)return null;
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<0||number>253402300799)throw fallo('Fecha de evento inválida');
  return fecha(number*1000);
}
function cantidadesSeguras(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([k,v])=>/^[1-9]\d{0,19}$/.test(k)&&Number.isSafeInteger(v)&&v>0));
}
function pedidoSeguro(row){
  return {order_id:idExterno(row.order_id),estado:estadosPedido.has(row.estado)?row.estado:'no_clasificado',
    cantidades:cantidadesSeguras(row.cantidades),pagado:row.pagado===true,cancelado:row.cancelado===true,
    actualizado_at:fecha(row.actualizado_at)};
}
function solicitudSegura(row){
  if(!row)return null;
  return {id:row.id,store_id:row.store_id,negocio_id:row.negocio_id??null,tipo:row.tipo,
    estado:row.estado,solicitud_ref:row.solicitud_ref??null,
    instalacion_actualizada_at:fecha(row.instalacion_actualizada_at),evento_fecha:fecha(row.evento_fecha),
    reporte:row.reporte,creada_at:fecha(row.creada_at),actualizada_at:fecha(row.actualizada_at)};
}

/**
 * Entrada: acción de la ruta, payload YA autenticado con HMAC por el router.
 * No devolver/guardar el payload recibido. No enviar correos ni informes desde
 * el webhook. Un informe preparado sigue pendiente de entrega al comerciante.
 * Las consultas administrativas requieren autorización del negocio en el router.
 * DI evita abrir PostgreSQL/leer configuración durante las pruebas puras.
 */
export function crearServicioPrivacidadTiendanube({database}={}){
  let currentDb=database;
  const obtenerDb=async()=>currentDb||(currentDb=(await import('../db/connection.js')).db);

  async function procesar(accion,payload){
    if(!acciones.has(accion))throw fallo('Acción de privacidad desconocida',404);
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fallo('Solicitud de privacidad inválida');
    const storeId=idExterno(payload.store_id);
    const orderIds=accion==='customer-redact'?ids(payload.orders_to_redact):
      accion==='customer-data-request'?ids(payload.orders_requested,{opcional:true}):[];
    const solicitudRef=accion==='customer-data-request'?idExterno(payload.data_request?.id):null;
    const eventDate=fechaEvento(payload.event_launch_ts);
    const eventoApp=accion==='uninstalled'&&payload.id!==undefined?idExterno(payload.id):null;
    // Se descartan customer, email, teléfono, documentos, tokens y cualquier
    // campo no enumerado. El hash tampoco se calcula sobre datos personales.
    const contenidoHash=hash({accion,storeId,orderIds,solicitudRef,eventoApp});
    const database=await obtenerDb();
    return database.transaction(async()=>{
      // También serializa redact/report cuando la conexión ya fue retirada;
      // no depender de la existencia de una fila para bloquear la tienda.
      await database.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get('tiendanube:privacidad:'+storeId);
      const conexion=await database.prepare('SELECT negocio_id,app_id,actualizada_at FROM tiendanube_conexiones WHERE store_id=? FOR UPDATE').get(storeId);
      const instalacion=fecha(conexion?.actualizada_at);
      const revision=accion==='store-redact'||accion==='uninstalled';
      const clave=hash(revision?{accion,storeId,instalacion,eventDate,eventoApp}:
        solicitudRef?{accion,storeId,solicitudRef}:{accion,storeId,orderIds});
      const solicitudId=randomUUID();
      const estado=revision?'pendiente_revision':accion==='customer-data-request'?'pendiente_entrega':'completada';
      const creada=await database.prepare(`INSERT INTO tiendanube_privacidad_solicitudes
        (id,clave,contenido_hash,store_id,negocio_id,tipo,solicitud_ref,instalacion_actualizada_at,evento_fecha,estado,reporte)
        VALUES(?,?,?,?,?,?,?,?,?,?,?::jsonb) ON CONFLICT(clave) DO NOTHING RETURNING *`)
        .get(solicitudId,clave,contenidoHash,storeId,conexion?.negocio_id??null,accion,solicitudRef,instalacion,eventDate,estado,'{}');
      if(!creada){
        const existente=await database.prepare('SELECT * FROM tiendanube_privacidad_solicitudes WHERE clave=?').get(clave);
        if(!existente||existente.contenido_hash!==contenidoHash)throw fallo('La solicitud de privacidad cambió de contenido',409);
        return {...solicitudSegura(existente),duplicada:true};
      }
      let reporte;
      if(revision){
        reporte={version:1,accion_requerida:'verificar_instalacion_vigente',credenciales_modificadas:false,
          conexion_presente:!!conexion,revocacion_verificada:false,fecha_evento_disponible:!!eventDate,
          app_id_evento:eventoApp,app_id_instalacion:conexion?.app_id?String(conexion.app_id):null,
          evento_anterior_a_instalacion:!!(eventDate&&instalacion&&eventDate<instalacion),
          nota:'Revisar vigencia de la instalación antes de revocar o eliminar datos de integración.'};
      }else if(accion==='customer-data-request'){
        const rows=orderIds.length?await database.prepare(`SELECT order_id,estado,cantidades,pagado,cancelado,actualizado_at
          FROM tiendanube_pedidos WHERE store_id=? AND order_id=ANY(?::text[]) ORDER BY order_id`).all(storeId,orderIds):[];
        reporte={version:1,alcance:'tablas_de_integracion_tiendanube',pedidos:rows.map(pedidoSeguro),
          pedidos_solicitados:orderIds.length,pedidos_no_almacenados:orderIds.length-rows.length,
          estado_entrega:'pendiente',
          nota:'Informe preparado para el administrador; todavía no entregado al comerciante.'};
      }else{
        if(orderIds.length)await database.prepare(`INSERT INTO tiendanube_privacidad_borrados(store_id,order_hash,solicitud_id)
          SELECT ?,h.order_hash,? FROM unnest(?::text[]) AS h(order_hash)
          ON CONFLICT(store_id,order_hash) DO NOTHING`).run(storeId,solicitudId,orderIds.map(orderId=>hashPedidoPrivacidad(storeId,orderId)));
        const eliminados=orderIds.length?await database.prepare('DELETE FROM tiendanube_pedidos WHERE store_id=? AND order_id=ANY(?::text[])').run(storeId,orderIds):{changes:0};
        const eventos=orderIds.length?await database.prepare("DELETE FROM tiendanube_eventos WHERE store_id=? AND topic LIKE 'order/%' AND recurso_id=ANY(?::text[])").run(storeId,orderIds):{changes:0};
        // Los reportes anteriores también contienen resúmenes de pedidos: se
        // redactan sin conservar en otro campo los IDs que se pidió eliminar.
        const anteriores=orderIds.length?await database.prepare("SELECT id,reporte FROM tiendanube_privacidad_solicitudes WHERE store_id=? AND tipo='customer-data-request' FOR UPDATE").all(storeId):[];
        const redactados=new Set(orderIds);
        let informes=0;
        for(const row of anteriores){
          const prev=row.reporte;
          const pedidos=Array.isArray(prev?.pedidos)?prev.pedidos:[];
          const restantes=pedidos.filter(p=>!redactados.has(String(p.order_id)));
          if(restantes.length===pedidos.length)continue;
          informes++;
          const siguiente={...prev,pedidos:restantes,pedidos_redactados:(prev.pedidos_redactados||0)+pedidos.length-restantes.length};
          await database.prepare('UPDATE tiendanube_privacidad_solicitudes SET reporte=?::jsonb,actualizada_at=NOW() WHERE id=?').run(JSON.stringify(siguiente),row.id);
        }
        reporte={version:1,alcance:'tablas_de_integracion_tiendanube',pedidos_eliminados:eliminados.changes,
          eventos_eliminados:eventos.changes,informes_redactados:informes,marcas_no_reimportar:orderIds.length,
          datos_locales_zilky_modificados:false};
      }
      const resultado=await database.prepare('UPDATE tiendanube_privacidad_solicitudes SET reporte=?::jsonb,actualizada_at=NOW() WHERE id=? RETURNING *').get(JSON.stringify(reporte),solicitudId);
      return {...solicitudSegura(resultado),duplicada:false};
    });
  }

  async function listar(negocioId){
    if(typeof negocioId!=='string'||!negocioId||negocioId.length>100)throw fallo('Negocio inválido');
    const database=await obtenerDb();
    const rows=await database.prepare(`SELECT id,store_id,negocio_id,tipo,estado,solicitud_ref,
      instalacion_actualizada_at,evento_fecha,creada_at,actualizada_at
      FROM tiendanube_privacidad_solicitudes WHERE negocio_id=? ORDER BY creada_at DESC,id DESC LIMIT 100`).all(negocioId);
    return rows.map(solicitudSegura);
  }
  async function obtener(solicitudId,negocioId){
    if(typeof solicitudId!=='string'||!solicitudId||typeof negocioId!=='string'||!negocioId)throw fallo('Solicitud inválida');
    const database=await obtenerDb();
    return solicitudSegura(await database.prepare('SELECT * FROM tiendanube_privacidad_solicitudes WHERE id=? AND negocio_id=?').get(solicitudId,negocioId));
  }
  return {procesar,listar,obtener};
}

export const tiendanubePrivacidadService=crearServicioPrivacidadTiendanube();
