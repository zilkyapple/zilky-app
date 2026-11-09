import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { requireAdmin } from '../middleware/authorize.js';
import { TIENDANUBE_APP_ID, nuevoEstadoOAuth, cifrarToken, descifrarToken, firmaWebhookValida, validarIdExterno, hashEvento, clienteTiendanube, stockPublicable } from '../lib/tiendanube.js';
import { resumenPedidoTiendanube, cambiosPedidoTiendanube } from '../lib/tiendanubeConciliacion.js';
import { tiendanubePrivacidadService,hashPedidoPrivacidad } from '../services/tiendanubePrivacidadService.js';
import { crearServicioTiendanubeSync } from '../services/tiendanubeSyncService.js';
import { crearServicioSetupTiendanube } from '../services/tiendanubeSetupService.js';

export const tiendanubeAdminRouter = Router();
export const tiendanubePublicaRouter = Router();

const error = (mensaje, status=400) => Object.assign(new Error(mensaje),{status});
const checksum = value => createHash('sha256').update(value).digest('hex');
const scopeRequerido = ['write_products','read_orders'];
const portalId = process.env.TIENDANUBE_APP_ID || TIENDANUBE_APP_ID;
const contactEmail = 'zilkyindumentaria@gmail.com';
const wrap = f => async(req,res,next) => {try {await f(req,res);} catch(e){next(e);}};
const syncService=crearServicioTiendanubeSync({db});
const setupService=crearServicioSetupTiendanube({db});

function payloadFirmado(req){
  const secret=process.env.TIENDANUBE_APP_SECRET;
  if(!secret)throw error('Receptor todavía no configurado',503);
  if(!firmaWebhookValida(req.body,req.headers['x-linkedstore-hmac-sha256'],secret))throw error('Firma inválida',401);
  try {return JSON.parse(req.body.toString('utf8'));}catch {throw error('Evento inválido');}
}

function credenciales() {
  const secret=process.env.TIENDANUBE_APP_SECRET;
  if (!secret) throw error('Falta configurar la conexión privada en el servidor',503);
  return {client_id:portalId,client_secret:secret};
}
async function negocioValido(n,usuarioId) {
  if (typeof n !== 'string' || !n || n.length>100) throw error('negocio_id inválido');
  // El rol global no autoriza a gestionar la tienda de otra organización.
  // Volver a comprobar la membresía también en el callback, pues el permiso
  // puede haberse revocado mientras la persona completaba OAuth.
  const permitido=await db.prepare(`SELECT n.id FROM negocios n
    JOIN usuario_organizacion uo ON uo.organizacion_id=n.organizacion_id
    JOIN usuarios u ON u.id=uo.usuario_id
    WHERE n.id=? AND uo.usuario_id=? AND uo.activo=1 AND uo.rol='administrador'
      AND u.activo=1 AND u.rol='administrador'`).get(n,usuarioId);
  if (!permitido) throw error('Negocio no encontrado o sin autorización',404);
}

tiendanubeAdminRouter.use(requireAdmin);

tiendanubeAdminRouter.get('/diagnostico',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id,req.usuarioId);
  res.json(await syncService.readiness(req.query.negocio_id));
}));
tiendanubeAdminRouter.get('/webhooks/estado',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id,req.usuarioId);
  res.json(await setupService.estado(req.query.negocio_id));
}));
for(const accion of ['configurar','verificar'])tiendanubeAdminRouter.post(`/webhooks/${accion}`,wrap(async(req,res)=>{
  const negocio_id=req.body.negocio_id;
  await negocioValido(negocio_id,req.usuarioId);
  res.json(await setupService[accion](negocio_id,{autorizar:()=>negocioValido(negocio_id,req.usuarioId)}));
}));
tiendanubeAdminRouter.post('/pausar',wrap(async(req,res)=>{
  await negocioValido(req.body.negocio_id,req.usuarioId);
  const conexion=await db.prepare("UPDATE tiendanube_conexiones SET pausada=TRUE,sync_motivo_pausa='PAUSA_ADMINISTRADOR',actualizada_at=NOW() WHERE negocio_id=? RETURNING negocio_id,sync_lease_token,sync_reserva_token").get(req.body.negocio_id);
  if(!conexion)throw error('La tienda todavía no está conectada',409);
  res.json({pausada:true,operacion_en_curso:!!(conexion.sync_lease_token||conexion.sync_reserva_token)});
}));

tiendanubeAdminRouter.get('/estado',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id,req.usuarioId);
  const conexion=await db.prepare('SELECT negocio_id,store_id,app_id,scopes,pausada,creada_at,actualizada_at FROM tiendanube_conexiones WHERE negocio_id=?').get(req.query.negocio_id);
  const links=await db.prepare('SELECT v.producto_id,v.product_id,v.variant_id,p.nombre,p.stock,o.estado AS sincronizacion FROM tiendanube_variantes v JOIN productos p ON p.id=v.producto_id LEFT JOIN tiendanube_stock_outbox o ON o.producto_id=v.producto_id WHERE v.negocio_id=? ORDER BY p.nombre,v.producto_id').all(req.query.negocio_id);
  const configurada=!!process.env.TIENDANUBE_APP_SECRET&&/^[0-9a-f]{64}$/i.test(process.env.TIENDANUBE_TOKEN_KEY||'');
  const diagnostico=await syncService.readiness(req.query.negocio_id);
  res.json({conexion:conexion||null,links,configuracion_servidor:configurada,
    sincronizacion_habilitada:configurada&&diagnostico.listo,diagnostico});
}));

tiendanubeAdminRouter.get('/catalogo',wrap(async(req,res)=>{
  const negocio_id=req.query.negocio_id;
  await negocioValido(negocio_id,req.usuarioId);
  const locales=await db.prepare('SELECT id,nombre,variante,sku,stock FROM productos WHERE negocio_id=? ORDER BY nombre,variante,id').all(negocio_id);
  const con=await db.prepare('SELECT store_id,token_cifrado FROM tiendanube_conexiones WHERE negocio_id=?').get(negocio_id);
  if(!con)return res.json({locales,remotos:[],conectada:false});
  const api=clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail});
  const idioma=v=>typeof v==='string'?v:(v?.es||v?.en||v?.pt||'');
  const remotos=[];
  let completo=false;
  for(let pagina=1;pagina<=10;pagina++){
    const productos=await api('GET',`/products?page=${pagina}&per_page=100`);
    if(!Array.isArray(productos))throw error('Tiendanube devolvió un catálogo inválido',502);
    for(const p of productos){
      if(!Array.isArray(p.variants))continue;
      for(const v of p.variants)remotos.push({product_id:validarIdExterno(p.id),variant_id:validarIdExterno(v.id),
        nombre:idioma(p.name),valores:(v.values||[]).map(idioma),sku:typeof v.sku==='string'?v.sku:'',
        stock:v.stock_management===false?null:v.stock,atributos:(p.attributes||[]).map(idioma)});
    }
    if(productos.length<100){completo=true;break;}
  }
  res.json({locales,remotos,conectada:true,catalogo_completo:completo});
}));

tiendanubeAdminRouter.get('/privacidad',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id,req.usuarioId);
  res.json(await tiendanubePrivacidadService.listar(req.query.negocio_id));
}));
tiendanubeAdminRouter.get('/privacidad/:id',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id,req.usuarioId);
  const solicitud=await tiendanubePrivacidadService.obtener(req.params.id,req.query.negocio_id);
  if(!solicitud)throw error('Solicitud no encontrada en este negocio',404);
  res.json(solicitud);
}));

tiendanubeAdminRouter.post('/iniciar',wrap(async(req,res)=>{
  await negocioValido(req.body.negocio_id,req.usuarioId);
  credenciales();
  if (!/^[0-9a-f]{64}$/i.test(process.env.TIENDANUBE_TOKEN_KEY||'')) throw error('Falta clave de cifrado en el servidor',503);
  const state=nuevoEstadoOAuth();
  await db.transaction(async()=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${req.body.negocio_id}`]);
    const con=await db.prepare('SELECT pausada,sync_lease_token,sync_reserva_token FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(req.body.negocio_id);
    if(con&&(!con.pausada||con.sync_lease_token||con.sync_reserva_token))throw error('Pausá y conciliá las operaciones en curso antes de volver a autorizar',409);
    const privacidad=await db.prepare('SELECT epoca FROM tiendanube_privacidad_epocas WHERE negocio_id=?').get(req.body.negocio_id);
    await db.prepare('DELETE FROM tiendanube_oauth_estados WHERE negocio_id=?').run(req.body.negocio_id);
    await db.prepare('INSERT INTO tiendanube_oauth_estados(state_hash,negocio_id,usuario_id,privacidad_epoca,vence_at) VALUES(?,?,?,?,NOW()+INTERVAL \'10 minutes\')').run(checksum(state),req.body.negocio_id,req.usuarioId,privacidad?.epoca??0);
  });
  res.json({url:`https://www.tiendanube.com/apps/${portalId}/authorize?state=${state}`,vence_en_segundos:600});
}));

// Este callback solo consume un estado aleatorio de un uso, previamente emitido
// para un administrador. Nunca confía en un negocio_id enviado por la redirección.
tiendanubePublicaRouter.get('/oauth/callback',wrap(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  const {state,code}=req.query;
  if (typeof state!=='string'|| !/^[0-9a-f]{64}$/i.test(state) || typeof code!=='string'||code.length>1024||!code) throw error('Autorización inválida');
  const cred=credenciales();
  // Se retira el estado antes de consumir el código de autorización, para que
  // ni un callback repetido ni dos solicitudes simultáneas puedan reutilizarlo.
  const row=await db.prepare('DELETE FROM tiendanube_oauth_estados WHERE state_hash=? AND vence_at>NOW() RETURNING negocio_id,usuario_id,privacidad_epoca').get(checksum(state));
  if (!row) throw error('La autorización venció o ya se utilizó',409);
  await negocioValido(row.negocio_id,row.usuario_id);
  const response=await fetch('https://www.tiendanube.com/apps/authorize/token',{
    method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({...cred,grant_type:'authorization_code',code}),signal:AbortSignal.timeout(15000),redirect:'error',
  });
  if (!response.ok) throw error('Tiendanube no autorizó la conexión. Iniciá el enlace otra vez',502);
  const body=await response.json();
  const storeId=validarIdExterno(body.user_id??body.store_id);
  const scopes=typeof body.scope==='string'?body.scope.split(',').map(x=>x.trim()):[];
  if (!scopeRequerido.every(scope=>scopes.includes(scope))) throw error('La autorización no incluyó los permisos necesarios',403);
  if (typeof body.access_token!=='string'||!body.access_token) throw error('Tiendanube no devolvió un token válido',502);
  const tokenCifrado=cifrarToken(body.access_token);
  await db.transaction(async()=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${storeId}`]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${row.negocio_id}`]);
    // La autorización puede tardar: comprobar de nuevo tanto la membresía
    // como la pausa/lease antes de reemplazar credenciales de una conexión.
    await negocioValido(row.negocio_id,row.usuario_id);
    // El estado se consumió antes del canje remoto. Si se atendió un borrado
    // mientras Tiendanube respondía, ese OAuth no puede reinstalar credenciales.
    const privacidad=await db.prepare('SELECT epoca FROM tiendanube_privacidad_epocas WHERE negocio_id=?').get(row.negocio_id);
    if(String(row.privacidad_epoca??0)!==String(privacidad?.epoca??0))throw error('La conexión fue eliminada por privacidad durante la autorización; iniciá una autorización nueva',409);
    const actual=await db.prepare('SELECT store_id,pausada,sync_lease_token,sync_reserva_token FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(row.negocio_id);
    if(actual&&(!actual.pausada||actual.sync_lease_token||actual.sync_reserva_token))throw error('La conexión comenzó una operación durante la autorización; pausá y conciliá antes de reintentar',409);
    if (actual && actual.store_id!==storeId) {
      const links=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE negocio_id=? LIMIT 1').get(row.negocio_id);
      if(links) throw error('Este negocio tiene variantes vinculadas a otra tienda; conciliá los vínculos antes de cambiarla',409);
    }
    const otro=await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=? AND negocio_id<>?').get(storeId,row.negocio_id);
    if (otro) throw error('Esta tienda de Tiendanube ya está vinculada con otro negocio',409);
    await db.prepare(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada)
      VALUES(?,?,?,?,?,TRUE) ON CONFLICT(negocio_id) DO UPDATE SET store_id=EXCLUDED.store_id,app_id=EXCLUDED.app_id,token_cifrado=EXCLUDED.token_cifrado,scopes=EXCLUDED.scopes,
      pausada=TRUE,creada_at=NOW(),actualizada_at=NOW(),sync_activada_at=NULL,sync_baseline_at=NULL,sync_webhooks_at=NULL,
      setup_webhooks_url=NULL,setup_webhooks_registrados_at=NULL,setup_webhooks_error=NULL,
      sync_motivo_pausa='AUTORIZACION_PENDIENTE_CONCILIACION'`).run(row.negocio_id,storeId,portalId,tokenCifrado,scopes.join(','));
    await db.prepare('UPDATE tiendanube_variantes SET sync_baseline_at=NULL,sync_stock_remoto=NULL,sync_verificar_despues=NULL WHERE negocio_id=?').run(row.negocio_id);
  });
  res.setHeader('Cache-Control','no-store');
  res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conexión preparada</title><body><h1>Conexión autorizada</h1><p>La sincronización quedó pausada. Volvé al panel de Zilky para revisar los productos.</p><p><a href="/#/tiendanube">Volver a Zilky App</a></p></body></html>');
}));

tiendanubeAdminRouter.post('/vinculos',wrap(async(req,res)=>{
  const {negocio_id,producto_id,product_id,variant_id}=req.body;
  await negocioValido(negocio_id,req.usuarioId);
  if (typeof producto_id!=='string'||!producto_id) throw error('Producto inválido');
  const remoteProduct=validarIdExterno(product_id), remoteVariant=validarIdExterno(variant_id);
  const producto=await db.prepare('SELECT id,stock FROM productos WHERE id=? AND negocio_id=?').get(producto_id,negocio_id);
  if(!producto) throw error('Producto no encontrado en este negocio',404);
  const con=await db.prepare('SELECT store_id,token_cifrado FROM tiendanube_conexiones WHERE negocio_id=?').get(negocio_id);
  if(!con) throw error('Primero vinculá tu tienda de Tiendanube',409);
  const api=clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail});
  const variante=await api('GET',`/products/${remoteProduct}/variants/${remoteVariant}`);
  if(String(variante?.id)!==remoteVariant || String(variante?.product_id)!==remoteProduct) throw error('La variante no pertenece al producto de Tiendanube',409);
  await db.transaction(async()=>{
    // La lectura inicial y la consulta remota pueden coincidir con una venta
    // o una reconexión. Revalidar y bloquear antes de crear el vínculo.
    const conexionActual=await db.prepare('SELECT store_id,token_cifrado,pausada,sync_lease_token,sync_reserva_token FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(negocio_id);
    if(!conexionActual||conexionActual.store_id!==con.store_id||conexionActual.token_cifrado!==con.token_cifrado)throw error('La conexión cambió durante la vinculación. Reintentá.',409);
    if(!conexionActual.pausada)throw error('Pausá la sincronización antes de vincular variantes',409);
    if(conexionActual.sync_lease_token||conexionActual.sync_reserva_token)throw error('Hay una operación pendiente de conciliación antes de vincular variantes',409);
    const productoActual=await db.prepare('SELECT id,stock FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(producto_id,negocio_id);
    if(!productoActual)throw error('Producto no encontrado en este negocio',404);
    // El permiso pudo revocarse durante la consulta remota. Revalidarlo
    // bajo los bloqueos antes de guardar el vínculo o preparar el outbox.
    await negocioValido(negocio_id,req.usuarioId);
    // No vincular silenciosamente una variante externa a un producto distinto.
    const conflict=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE store_id=? AND variant_id=? AND producto_id<>?').get(con.store_id,remoteVariant,producto_id);
    if(conflict)throw error('Esta variante ya está vinculada a otro producto de Zilky',409);
    const prior=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE producto_id=?').get(producto_id);
    if(prior)throw error('Este producto ya está vinculado; revisá su relación antes de modificarla',409);
    await db.prepare('INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id) VALUES(?,?,?,?,?)').run(producto_id,negocio_id,con.store_id,remoteProduct,remoteVariant);
    await db.prepare('INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado) VALUES(?,?,?)').run(producto_id,negocio_id,stockPublicable(productoActual.stock));
  });
  res.status(201).json({producto_id,product_id:remoteProduct,variant_id:remoteVariant,sincronizacion:'pausada'});
}));

// Auditoría manual sin efecto comercial. Permite comparar el pedido verdadero
// de la API con nuestras variantes ANTES de permitir cualquier descuento.
tiendanubeAdminRouter.post('/pedidos/conciliar',wrap(async(req,res)=>{
  const {negocio_id,order_id}=req.body;
  await negocioValido(negocio_id,req.usuarioId);
  const remoteOrder=validarIdExterno(order_id);
  const con=await db.prepare('SELECT store_id,token_cifrado FROM tiendanube_conexiones WHERE negocio_id=?').get(negocio_id);
  if(!con) throw error('Primero vinculá tu tienda de Tiendanube',409);
  const redactado=await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(con.store_id,hashPedidoPrivacidad(con.store_id,remoteOrder));
  if(redactado)throw error('Este pedido fue eliminado por una solicitud de privacidad',410);
  const api=clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail});
  const pedido=resumenPedidoTiendanube(await api('GET',`/orders/${remoteOrder}`));
  if(pedido.order_id!==remoteOrder) throw error('Tiendanube devolvió un pedido distinto',502);
  const vinculos=await db.prepare('SELECT variant_id,producto_id FROM tiendanube_variantes WHERE store_id=? AND negocio_id=?').all(con.store_id,negocio_id);
  const porVariante=new Map(vinculos.map(v=>[v.variant_id,v.producto_id]));
  const sinVincular=Object.keys(pedido.cantidades).filter(k=>!porVariante.has(k));
  let comparacion;
  await db.transaction(async()=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['tiendanube:privacidad:'+con.store_id]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${negocio_id}`]);
    const actual=await db.prepare('SELECT store_id,token_cifrado,pausada,sync_lease_token,sync_reserva_token FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(negocio_id);
    if(!actual||actual.store_id!==con.store_id||actual.token_cifrado!==con.token_cifrado)throw error('La conexión cambió durante la conciliación',409);
    if(!actual.pausada)throw error('Pausá la sincronización antes de una conciliación manual',409);
    if(actual.sync_lease_token||actual.sync_reserva_token)throw error('Hay una operación pendiente de conciliación antes de revisar manualmente el pedido',409);
    const borrado=await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(con.store_id,hashPedidoPrivacidad(con.store_id,remoteOrder));
    if(borrado)throw error('Este pedido fue eliminado por una solicitud de privacidad',410);
    const anterior=await db.prepare('SELECT cantidades,pagado,cancelado FROM tiendanube_pedidos WHERE store_id=? AND order_id=? FOR UPDATE').get(con.store_id,remoteOrder);
    comparacion=cambiosPedidoTiendanube(anterior?{...anterior,order_id:remoteOrder}:null,pedido);
    await db.prepare(`INSERT INTO tiendanube_pedidos(negocio_id,store_id,order_id,estado,cantidades,pagado,cancelado,pendiente_revision)
      VALUES(?,?,?,?,?::jsonb,?,?,TRUE)
      ON CONFLICT(store_id,order_id) DO UPDATE SET estado=EXCLUDED.estado,cantidades=EXCLUDED.cantidades,
      pagado=EXCLUDED.pagado,cancelado=EXCLUDED.cancelado,pendiente_revision=TRUE,actualizado_at=NOW()`)
      .run(negocio_id,con.store_id,remoteOrder,pedido.estado,JSON.stringify(pedido.cantidades),pedido.pagado,pedido.cancelado);
  });
  res.json({pedido,comparacion,sin_vincular:sinVincular,stock_actualizado:false,
    mensaje:'Solo conciliación para revisión; no se descontó stock ni se registraron cobros'});
}));

tiendanubePublicaRouter.post('/webhook',wrap(async(req,res)=>{
  const raw=req.body;
  const payload=payloadFirmado(req);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw error('Evento inválido');
  const storeId=validarIdExterno(payload.store_id ?? payload.store);
  const topic=typeof payload.event==='string'?payload.event:typeof payload.topic==='string'?payload.topic:null;
  if(!topic||topic.length>100)throw error('Tipo de evento inválido');
  const rid=validarIdExterno(payload.id ?? payload.data?.id ?? storeId);
  if(topic==='app/store_redact'||topic==='app/uninstalled') {
    const solicitud=await tiendanubePrivacidadService.procesar(topic==='app/store_redact'?'store-redact':'uninstalled',payload);
    return res.status(202).json({recibido:true,solicitud_id:solicitud.id,estado:solicitud.estado});
  }
  const permitidos=new Set(['order/created','order/updated','order/paid','order/cancelled','order/edited','order/fulfilled','order/pending','order/voided','product/updated']);
  if(!permitidos.has(topic))return res.status(200).json({recibido:true,ignorado:true});
  // Lista cerrada: jamás almacenar el body arbitrario (que podría incluir PII).
  const minimo={store_id:storeId,event:topic,id:rid};
  if(Number.isSafeInteger(payload.event_launch_ts))minimo.event_launch_ts=payload.event_launch_ts;
  // Una segunda edición puede tener exactamente el mismo cuerpo que la
  // primera. Reencolar la lectura del estado actual; el ledger de reservas
  // aporta la idempotencia del stock. FOR UPDATE en el motor serializa este
  // UPSERT con la lectura/procesamiento de una notificación previa.
  let ignorado=false;
  await db.transaction(async()=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${storeId}`]);
    const vigente=await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=?').get(storeId);
    if(!vigente){ignorado=true;return;}
    if(topic.startsWith('order/')){
      const borrado=await db.prepare('SELECT order_hash FROM tiendanube_privacidad_borrados WHERE store_id=? AND order_hash=?').get(storeId,hashPedidoPrivacidad(storeId,rid));
      if(borrado){ignorado=true;return;}
    }
    await db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload,hmac_validada_at)
      VALUES(?,?,?,?,?::jsonb,NOW()) ON CONFLICT(store_id,topic,recurso_id,body_hash) DO UPDATE SET
      sync_version=tiendanube_eventos.sync_version+1,sync_ultimo_evento_at=NOW(),procesado_at=NULL,
      hmac_validada_at=NOW(),
      sync_estado=CASE WHEN tiendanube_eventos.sync_estado='revision_manual' THEN 'revision_manual' ELSE 'pendiente' END,
      sync_proximo_intento=NOW(),error=CASE WHEN tiendanube_eventos.sync_estado='revision_manual' THEN tiendanube_eventos.error ELSE NULL END`).run(storeId,topic,rid,hashEvento(raw),JSON.stringify(minimo));
  });
  res.status(202).json({recibido:true,...(ignorado?{ignorado:true}:{})});
}));

// Las notificaciones obligatorias de privacidad NO incluyen campo `event`.
// Se identifican por URL distinta y se verifica la misma firma del cuerpo.
tiendanubePublicaRouter.post('/privacy/:accion',wrap(async(req,res)=>{
  const accion=req.params.accion;
  if(!['store-redact','customer-redact','customer-data-request'].includes(accion))throw error('Notificación desconocida',404);
  const payload=payloadFirmado(req);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw error('Solicitud inválida');
  const solicitud=await tiendanubePrivacidadService.procesar(accion,payload);
  res.status(solicitud.estado==='completada'?200:202).json({recibido:true,solicitud_id:solicitud.id,estado:solicitud.estado});
}));
