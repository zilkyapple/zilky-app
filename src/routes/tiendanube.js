import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { requireAdmin } from '../middleware/authorize.js';
import { TIENDANUBE_APP_ID, nuevoEstadoOAuth, cifrarToken, descifrarToken, firmaWebhookValida, validarIdExterno, hashEvento, clienteTiendanube, stockPublicable } from '../lib/tiendanube.js';
import { resumenPedidoTiendanube, cambiosPedidoTiendanube } from '../lib/tiendanubeConciliacion.js';

export const tiendanubeAdminRouter = Router();
export const tiendanubePublicaRouter = Router();

const error = (mensaje, status=400) => Object.assign(new Error(mensaje),{status});
const checksum = value => createHash('sha256').update(value).digest('hex');
const scopeRequerido = ['write_products','read_orders'];
const portalId = process.env.TIENDANUBE_APP_ID || TIENDANUBE_APP_ID;
const callbackUrl = 'https://zilky-app.onrender.com/api/tiendanube/oauth/callback';
const contactEmail = 'zilkyindumentaria@gmail.com';
const wrap = f => async(req,res,next) => {try {await f(req,res);} catch(e){next(e);}};

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
async function negocioValido(n) {
  if (typeof n !== 'string' || !n || n.length>100) throw error('negocio_id inválido');
  if (!await db.prepare('SELECT id FROM negocios WHERE id=?').get(n)) throw error('Negocio no encontrado',404);
}

tiendanubeAdminRouter.use(requireAdmin);

tiendanubeAdminRouter.get('/estado',wrap(async(req,res)=>{
  await negocioValido(req.query.negocio_id);
  const conexion=await db.prepare('SELECT negocio_id,store_id,app_id,scopes,pausada,creada_at,actualizada_at FROM tiendanube_conexiones WHERE negocio_id=?').get(req.query.negocio_id);
  const links=await db.prepare('SELECT v.producto_id,v.product_id,v.variant_id,p.nombre,p.stock,o.estado AS sincronizacion FROM tiendanube_variantes v JOIN productos p ON p.id=v.producto_id LEFT JOIN tiendanube_stock_outbox o ON o.producto_id=v.producto_id WHERE v.negocio_id=? ORDER BY p.nombre,v.producto_id').all(req.query.negocio_id);
  res.json({conexion:conexion||null,links,configuracion_servidor:!!process.env.TIENDANUBE_APP_SECRET&&!!process.env.TIENDANUBE_TOKEN_KEY});
}));

tiendanubeAdminRouter.post('/iniciar',wrap(async(req,res)=>{
  await negocioValido(req.body.negocio_id);
  credenciales();
  if (!/^[0-9a-f]{64}$/i.test(process.env.TIENDANUBE_TOKEN_KEY||'')) throw error('Falta clave de cifrado en el servidor',503);
  const state=nuevoEstadoOAuth();
  await db.prepare('INSERT INTO tiendanube_oauth_estados(state_hash,negocio_id,usuario_id,vence_at) VALUES(?,?,?,NOW()+INTERVAL \'10 minutes\')').run(checksum(state),req.body.negocio_id,req.usuarioId);
  res.json({url:`https://www.tiendanube.com/apps/${portalId}/authorize?state=${state}`,vence_en_segundos:600});
}));

// Este callback solo consume un estado aleatorio de un uso, previamente emitido
// para un administrador. Nunca confía en un negocio_id enviado por la redirección.
tiendanubePublicaRouter.get('/oauth/callback',wrap(async(req,res)=>{
  const {state,code}=req.query;
  if (typeof state!=='string'|| !/^[0-9a-f]{64}$/i.test(state) || typeof code!=='string'||code.length>1024||!code) throw error('Autorización inválida');
  const cred=credenciales();
  // Se retira el estado antes de consumir el código de autorización, para que
  // ni un callback repetido ni dos solicitudes simultáneas puedan reutilizarlo.
  const row=await db.prepare('DELETE FROM tiendanube_oauth_estados WHERE state_hash=? AND vence_at>NOW() RETURNING negocio_id,usuario_id').get(checksum(state));
  if (!row) throw error('La autorización venció o ya se utilizó',409);
  const response=await fetch('https://www.tiendanube.com/apps/authorize/token',{
    method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({...cred,grant_type:'authorization_code',code}),signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw error('Tiendanube no autorizó la conexión. Iniciá el enlace otra vez',502);
  const body=await response.json();
  const storeId=validarIdExterno(body.user_id??body.store_id);
  const scopes=typeof body.scope==='string'?body.scope.split(',').map(x=>x.trim()):[];
  if (!scopeRequerido.every(scope=>scopes.includes(scope))) throw error('La autorización no incluyó los permisos necesarios',403);
  if (typeof body.access_token!=='string'||!body.access_token) throw error('Tiendanube no devolvió un token válido',502);
  const tokenCifrado=cifrarToken(body.access_token);
  await db.transaction(async()=>{
    const actual=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(row.negocio_id);
    if (actual && actual.store_id!==storeId) {
      const links=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE negocio_id=? LIMIT 1').get(row.negocio_id);
      if(links) throw error('Este negocio tiene variantes vinculadas a otra tienda; conciliá los vínculos antes de cambiarla',409);
    }
    const otro=await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=? AND negocio_id<>?').get(storeId,row.negocio_id);
    if (otro) throw error('Esta tienda de Tiendanube ya está vinculada con otro negocio',409);
    await db.prepare(`INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada)
      VALUES(?,?,?,?,?,TRUE) ON CONFLICT(negocio_id) DO UPDATE SET store_id=EXCLUDED.store_id,app_id=EXCLUDED.app_id,token_cifrado=EXCLUDED.token_cifrado,scopes=EXCLUDED.scopes,pausada=TRUE,actualizada_at=NOW()`).run(row.negocio_id,storeId,portalId,tokenCifrado,scopes.join(','));
  });
  res.setHeader('Cache-Control','no-store');
  res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Conexión preparada</title><body><h1>Conexión autorizada</h1><p>La sincronización quedó pausada. Volvé al panel de Zilky para revisar los productos.</p></body></html>');
}));

tiendanubeAdminRouter.post('/vinculos',wrap(async(req,res)=>{
  const {negocio_id,producto_id,product_id,variant_id}=req.body;
  await negocioValido(negocio_id);
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
    // No vincular silenciosamente una variante externa a un producto distinto.
    const conflict=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE store_id=? AND variant_id=? AND producto_id<>?').get(con.store_id,remoteVariant,producto_id);
    if(conflict)throw error('Esta variante ya está vinculada a otro producto de Zilky',409);
    const prior=await db.prepare('SELECT producto_id FROM tiendanube_variantes WHERE producto_id=?').get(producto_id);
    if(prior)throw error('Este producto ya está vinculado; revisá su relación antes de modificarla',409);
    await db.prepare('INSERT INTO tiendanube_variantes(producto_id,negocio_id,store_id,product_id,variant_id) VALUES(?,?,?,?,?)').run(producto_id,negocio_id,con.store_id,remoteProduct,remoteVariant);
    await db.prepare('INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado) VALUES(?,?,?)').run(producto_id,negocio_id,stockPublicable(producto.stock));
  });
  res.status(201).json({producto_id,product_id:remoteProduct,variant_id:remoteVariant,sincronizacion:'pausada'});
}));

// Auditoría manual sin efecto comercial. Permite comparar el pedido verdadero
// de la API con nuestras variantes ANTES de permitir cualquier descuento.
tiendanubeAdminRouter.post('/pedidos/conciliar',wrap(async(req,res)=>{
  const {negocio_id,order_id}=req.body;
  await negocioValido(negocio_id);
  const remoteOrder=validarIdExterno(order_id);
  const con=await db.prepare('SELECT store_id,token_cifrado FROM tiendanube_conexiones WHERE negocio_id=?').get(negocio_id);
  if(!con) throw error('Primero vinculá tu tienda de Tiendanube',409);
  const api=clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail});
  const pedido=resumenPedidoTiendanube(await api('GET',`/orders/${remoteOrder}`));
  if(pedido.order_id!==remoteOrder) throw error('Tiendanube devolvió un pedido distinto',502);
  const vinculos=await db.prepare('SELECT variant_id,producto_id FROM tiendanube_variantes WHERE store_id=? AND negocio_id=?').all(con.store_id,negocio_id);
  const porVariante=new Map(vinculos.map(v=>[v.variant_id,v.producto_id]));
  const sinVincular=Object.keys(pedido.cantidades).filter(k=>!porVariante.has(k));
  let comparacion;
  await db.transaction(async()=>{
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
    // Revocar credenciales de esta tienda y borrar solo los datos internos de
    // la integración. Nunca borrar productos, clientes ni ventas de Zilky.
    await db.transaction(async()=>{
      await db.prepare('DELETE FROM tiendanube_stock_outbox WHERE negocio_id IN (SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=?)').run(storeId);
      await db.prepare('DELETE FROM tiendanube_variantes WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_pedidos WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_eventos WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_conexiones WHERE store_id=?').run(storeId);
    });
    return res.status(200).json({recibido:true});
  }
  // No persistimos datos personales de compradores en esta integración: para
  // customers/redact y customers/data_request basta el registro firmado del
  // evento, sin replicar información privada.
  // Conservar el evento auténtico para reconciliar luego; no alterar inventario
  // ni cobros en el proceso HTTP que responde a Tiendanube.
  await db.prepare(`INSERT INTO tiendanube_eventos(store_id,topic,recurso_id,body_hash,payload)
    VALUES(?,?,?,?,?::jsonb) ON CONFLICT(store_id,topic,recurso_id,body_hash) DO NOTHING`).run(storeId,topic,rid,hashEvento(raw),JSON.stringify(payload));
  res.status(202).json({recibido:true});
}));

// Las notificaciones obligatorias de privacidad NO incluyen campo `event`.
// Se identifican por URL distinta y se verifica la misma firma del cuerpo.
tiendanubePublicaRouter.post('/privacy/:accion',wrap(async(req,res)=>{
  const accion=req.params.accion;
  if(!['store-redact','customer-redact','customer-data-request'].includes(accion))throw error('Notificación desconocida',404);
  const payload=payloadFirmado(req);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw error('Solicitud inválida');
  const storeId=validarIdExterno(payload.store_id);
  if(accion==='store-redact'){
    await db.transaction(async()=>{
      await db.prepare('DELETE FROM tiendanube_stock_outbox WHERE negocio_id IN (SELECT negocio_id FROM tiendanube_conexiones WHERE store_id=?)').run(storeId);
      await db.prepare('DELETE FROM tiendanube_variantes WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_pedidos WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_eventos WHERE store_id=?').run(storeId);
      await db.prepare('DELETE FROM tiendanube_conexiones WHERE store_id=?').run(storeId);
    });
  }
  // No guardamos identificadores de consumidores, email, teléfono ni pedidos
  // con datos personales en las tablas de Tiendanube. No guardar el payload
  // de customer-redact o customer-data-request, que sí contiene PII.
  res.status(200).json({recibido:true});
}));
