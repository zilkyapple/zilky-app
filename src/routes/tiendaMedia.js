import {Router,raw} from 'express';
import {requirePermiso,exigirPermisoNegocio,negocioSolicitado} from '../middleware/authorize.js';
import {LIMITES_MEDIA,mimeMedia,exigirProductoMedia,listarMediaProducto,subirMediaProducto,eliminarMediaProducto,ordenarMediaProducto,obtenerMedia,rangoMedia,leerRangoMedia,extensionMedia} from '../services/tiendaMediaService.js';

export const tiendaMediaRouter=Router();
export const tiendaMediaPublicaRouter=Router();
const fallo=(message,status=400)=>Object.assign(new Error(message),{status});
function negocio(req) {
  const id=negocioSolicitado(req);if(!id)throw fallo('Seleccioná el negocio de la tienda');
  exigirPermisoNegocio(req,id,'tienda.editar');return id;
}
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
async function autorizarProducto(req,res,next) {
  req.mediaNegocio=negocio(req);
  await exigirProductoMedia(req.mediaNegocio,req.params.id);
  next();
}
let subidasActivas=0;
function limitarSubidas(req,res,next) {
  if(subidasActivas>=3){res.setHeader('Retry-After','2');return next(fallo('Hay varias subidas en curso. Volvé a intentarlo en unos segundos.',429));}
  subidasActivas++;
  let liberada=false;const liberar=()=>{if(!liberada){liberada=true;subidasActivas--;}};
  res.once('finish',liberar);res.once('close',liberar);req.once('aborted',liberar);next();
}
function archivoCrudo(req,res,next) {
  try {
    req.mediaMime=mimeMedia(req.headers['content-type']);
    if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw fallo('Enviá el archivo original sin compresión HTTP.',415);
    const limite=req.mediaMime.startsWith('image/')?LIMITES_MEDIA.imagen_bytes:LIMITES_MEDIA.video_bytes;
    raw({type:()=>true,limit:limite,inflate:false})(req,res,next);
  }catch(error){next(error);}
}

tiendaMediaRouter.get('/productos/:id/media',requirePermiso('tienda.editar'),asyncRoute(async(req,res)=>res.json(await listarMediaProducto(negocio(req),req.params.id))));
tiendaMediaRouter.post('/productos/:id/media',requirePermiso('tienda.editar'),asyncRoute(autorizarProducto),limitarSubidas,archivoCrudo,asyncRoute(async(req,res)=>{
  const resultado=await subirMediaProducto(req.mediaNegocio,req.params.id,{datos:req.body,mime:req.mediaMime,nombre:req.headers['x-filename'],solicitud_id:req.headers['x-solicitud-id']},req.usuarioId);
  res.status(resultado.reintentado?200:201).json(resultado);
}));
tiendaMediaRouter.delete('/productos/:id/media/:mediaId',requirePermiso('tienda.editar'),asyncRoute(async(req,res)=>{
  res.json(await eliminarMediaProducto(negocio(req),req.params.id,req.params.mediaId,req.body||{},req.usuarioId));
}));
tiendaMediaRouter.put('/productos/:id/media/orden',requirePermiso('tienda.editar'),asyncRoute(async(req,res)=>{
  res.json(await ordenarMediaProducto(negocio(req),req.params.id,req.body,req.usuarioId));
}));

async function servir(req,res,privado=false) {
  const media=await obtenerMedia(req.params.mediaId,privado?negocio(req):null);
  const etag='"'+media.hash+'"';
  const cabeceras=()=>{
    res.setHeader('Content-Type',media.mime);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Cache-Control',privado?'private, no-store':'public, max-age=0, must-revalidate');
    res.setHeader('ETag',etag);
    res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Disposition','inline; filename="'+(media.tipo==='imagen'?'foto':'video')+'.'+extensionMedia(media.mime)+'"');
  };
  // obtenerMedia verifica publicación incluso cuando el navegador conserva ETag.
  if(!privado&&typeof req.headers['if-none-match']==='string'&&req.headers['if-none-match'].split(',').map(v=>v.trim()).some(v=>v===etag||v==='W/'+etag||v==='*')){cabeceras();return res.status(304).end();}
  let rango;
  try {rango=rangoMedia(req.headers['if-range']&&req.headers['if-range']!==etag?undefined:req.headers.range,media.bytes);}
  catch(error){if(error.status!==416)throw error;cabeceras();res.setHeader('Content-Range','bytes */'+media.bytes);return res.status(416).end();}
  const largo=rango.fin-rango.inicio+1;
  // Leer antes de fijar Content-Length permite devolver un error JSON íntegro
  // si el archivo se eliminó mientras la solicitud estaba en curso.
  const datos=req.method==='HEAD'?null:await leerRangoMedia(media.id,rango.inicio,largo);
  if(datos&&datos.length!==largo)throw fallo('Archivo temporalmente no disponible',503);
  cabeceras();
  res.setHeader('Content-Length',String(largo));
  if(rango.parcial){res.status(206);res.setHeader('Content-Range',`bytes ${rango.inicio}-${rango.fin}/${media.bytes}`);}
  if(req.method==='HEAD')return res.end();
  res.end(datos);
}
tiendaMediaRouter.get('/media/:mediaId',requirePermiso('tienda.editar'),asyncRoute((req,res)=>servir(req,res,true)));
tiendaMediaPublicaRouter.get('/:mediaId',asyncRoute((req,res)=>servir(req,res,false)));
