import {createHash,randomUUID} from 'node:crypto';
import {db} from '../db/connection.js';
import {auditar} from '../lib/audit.js';

export const LIMITES_MEDIA = Object.freeze({imagen_bytes:8*1024*1024,video_bytes:30*1024*1024,max_archivos_producto:12,negocio_bytes:200*1024*1024});
const MIME = Object.freeze({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'});
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const columnas='id,tienda_producto_id,negocio_id,tipo,mime,bytes,nombre,orden,hash,solicitud_id,created_at';

export function mimeMedia(value) {
  const mime=typeof value==='string'?value.split(';',1)[0].trim().toLowerCase():'';
  if(!Object.hasOwn(MIME,mime))throw error('Elegí una foto JPG, PNG o WebP, o un video MP4, WebM o MOV.',415);
  return mime;
}
export function nombreMedia(value='archivo') {
  if(typeof value!=='string'||value.length>1600)throw error('Nombre de archivo inválido');
  let nombre;
  try {nombre=decodeURIComponent(value);}catch {throw error('Nombre de archivo inválido');}
  // Es una etiqueta, nunca una ruta. No se utiliza para leer o crear archivos.
  nombre=nombre.replace(/[\\/\x00-\x1f\x7f]/g,' ').trim().slice(0,180);
  return nombre||'archivo';
}
export function validarMedia(datos,mime) {
  mime=mimeMedia(mime);
  if(!Buffer.isBuffer(datos)||!datos.length)throw error('El archivo está vacío');
  const tipo=mime.startsWith('image/')?'imagen':'video';
  const limite=tipo==='imagen'?LIMITES_MEDIA.imagen_bytes:LIMITES_MEDIA.video_bytes;
  if(datos.length>limite)throw error(tipo==='imagen'?'La foto supera los 8 MB.':'El video supera los 30 MB.',413);
  let firma=false;
  if(mime==='image/jpeg')firma=datos.length>=4&&datos[0]===0xff&&datos[1]===0xd8&&datos[2]===0xff&&datos.at(-2)===0xff&&datos.at(-1)===0xd9;
  if(mime==='image/png')firma=datos.length>=45&&datos.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&datos.toString('latin1',12,16)==='IHDR'&&datos.toString('latin1',datos.length-8,datos.length-4)==='IEND';
  if(mime==='image/webp')firma=datos.length>=20&&datos.toString('latin1',0,4)==='RIFF'&&datos.readUInt32LE(4)+8===datos.length&&datos.toString('latin1',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(datos.toString('latin1',12,16));
  if(mime==='video/webm') {
    const tipoWebm=Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d]);
    firma=datos.length>=12&&datos.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&datos.subarray(4,Math.min(datos.length,4096)).indexOf(tipoWebm)>=0;
  }
  if(mime==='video/mp4'||mime==='video/quicktime') {
    if(datos.length>=16&&datos.toString('latin1',4,8)==='ftyp') {
      const largo=datos.readUInt32BE(0);
      if(largo>=16&&largo<=datos.length&&largo<=4096&&largo%4===0) {
        const marcas=[datos.toString('latin1',8,12)];
        for(let i=16;i<largo;i+=4)marcas.push(datos.toString('latin1',i,i+4));
        firma=mime==='video/quicktime'?marcas.includes('qt  '):marcas.some(m=>['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','MSNV','dash','3gp4','3gp5','3g2a'].includes(m))&&!marcas.some(m=>['avif','avis','heic','heix','mif1'].includes(m));
      }
    }
  }
  if(!firma)throw error('El contenido del archivo no coincide con su formato. Volvé a exportar la foto o el video.',415);
  return {tipo,mime,bytes:datos.length,hash:hash(datos)};
}

export async function exigirProductoMedia(negocioId,productoId,{bloquear=false}={}) {
  const producto=await db.prepare(`SELECT id,negocio_id FROM tienda_productos WHERE id=? AND negocio_id=?${bloquear?' FOR UPDATE':''}`).get(productoId,negocioId);
  if(!producto)throw error('Producto de la tienda no encontrado',404);
  return producto;
}
export const mediaPublica=row=>({id:row.id,tipo:row.tipo,url:'/api/tienda-media/'+encodeURIComponent(row.id),orden:row.orden});
function metadata(row) {
  return {...row,url:'/api/tienda-media/'+encodeURIComponent(row.id),url_privada:'/api/tiendas/media/'+encodeURIComponent(row.id)+'?negocio_id='+encodeURIComponent(row.negocio_id)};
}
async function filasProducto(negocioId,productoId) {
  return db.prepare(`SELECT ${columnas} FROM tienda_media WHERE negocio_id=? AND tienda_producto_id=? ORDER BY orden,id`).all(negocioId,productoId);
}
const version=rows=>hash(JSON.stringify(rows.map(row=>[row.id,row.orden,row.hash])));
async function resumen(negocioId,productoId) {
  const rows=await filasProducto(negocioId,productoId);
  const usados=await db.prepare('SELECT COALESCE(sum(bytes),0) AS bytes FROM tienda_media WHERE negocio_id=?').get(negocioId);
  return {media:rows.map(metadata),version:version(rows),limites:LIMITES_MEDIA,usados_bytes:Number(usados.bytes)};
}
export async function listarMediaProducto(negocioId,productoId) {
  await exigirProductoMedia(negocioId,productoId);
  return resumen(negocioId,productoId);
}
async function bloquear(negocioId,productoId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['zilky:tienda-media:'+negocioId]);
  return exigirProductoMedia(negocioId,productoId,{bloquear:true});
}
function solicitud(value) {
  if(value!==undefined&&value!==null&&!uuid(value))throw error('Identificador de solicitud inválido');
  return value||null;
}
async function reintento(negocioId,solicitudId,actor,huella) {
  if(!solicitudId)return null;
  const row=await db.prepare('SELECT usuario_id,huella,resultado FROM tienda_media_solicitudes WHERE negocio_id=? AND solicitud_id=?').get(negocioId,solicitudId);
  if(!row)return null;
  if(row.usuario_id!==actor||row.huella!==huella)throw error('La solicitud ya se usó para otra operación',409);
  const resultado={...row.resultado,reintentado:true};
  if(resultado.media?.id)resultado.eliminado=!await db.prepare('SELECT 1 FROM tienda_media WHERE id=? AND negocio_id=?').get(resultado.media.id,negocioId);
  return resultado;
}
async function guardarSolicitud(negocioId,productoId,solicitudId,actor,operacion,huella,resultado) {
  if(solicitudId)await db.prepare('INSERT INTO tienda_media_solicitudes(negocio_id,solicitud_id,usuario_id,operacion,tienda_producto_id,huella,resultado) VALUES(?,?,?,?,?,?,?::jsonb)').run(negocioId,solicitudId,actor,operacion,productoId,huella,JSON.stringify(resultado));
}
export async function subirMediaProducto(negocioId,productoId,{datos,mime,nombre,solicitud_id},actor) {
  if(typeof actor!=='string'||!actor)throw error('Falta identificar al responsable',401);
  const validado=validarMedia(datos,mime),nombreLimpio=nombreMedia(nombre),solicitudId=solicitud(solicitud_id);
  const huella=hash(JSON.stringify({operacion:'subir',productoId,...validado,nombre:nombreLimpio}));
  return db.transaction(async()=>{
    await bloquear(negocioId,productoId);
    const previo=await reintento(negocioId,solicitudId,actor,huella);if(previo)return previo;
    const estado=await resumen(negocioId,productoId);
    // Los clientes antiguos sin UUID también pueden reintentar sin duplicar bytes.
    const repetido=!solicitudId&&estado.media.find(row=>row.hash===validado.hash&&row.mime===validado.mime);
    if(repetido)return {...estado,media:repetido,reintentado:true};
    if(estado.media.length>=LIMITES_MEDIA.max_archivos_producto)throw error('Este producto ya tiene 12 fotos o videos. Eliminá alguno antes de agregar otro.',409);
    if(estado.usados_bytes+validado.bytes>LIMITES_MEDIA.negocio_bytes)throw error('La tienda alcanzó los 200 MB disponibles para fotos y videos. Eliminá archivos que ya no uses.',409);
    const mediaId=randomUUID();
    await db.prepare('INSERT INTO tienda_media(id,tienda_producto_id,negocio_id,tipo,mime,bytes,nombre,orden,hash,solicitud_id,creado_por) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(mediaId,productoId,negocioId,validado.tipo,validado.mime,validado.bytes,nombreLimpio,estado.media.length,validado.hash,solicitudId,actor);
    await db.prepare('INSERT INTO tienda_media_contenido(media_id,datos) VALUES(?,?)').run(mediaId,datos);
    const nuevo=await resumen(negocioId,productoId),media=nuevo.media.find(row=>row.id===mediaId);
    const resultado={...nuevo,media};
    await auditar('tienda_media',mediaId,'subir',null,{...media,negocio_id:negocioId},actor);
    await guardarSolicitud(negocioId,productoId,solicitudId,actor,'subir',huella,resultado);
    return resultado;
  });
}
function datosMutacion(input,permitidas) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!permitidas.includes(key)))throw error('Datos de archivo inválidos');
  if(input.version!==undefined&&(typeof input.version!=='string'||!/^[a-f0-9]{64}$/.test(input.version)))throw error('Versión de archivos inválida');
}
export async function eliminarMediaProducto(negocioId,productoId,mediaId,input={},actor) {
  datosMutacion(input,['negocio_id','solicitud_id','version']);
  const solicitudId=solicitud(input.solicitud_id),huella=hash(JSON.stringify({operacion:'eliminar',productoId,mediaId,version:input.version||null}));
  return db.transaction(async()=>{
    await bloquear(negocioId,productoId);
    const previo=await reintento(negocioId,solicitudId,actor,huella);if(previo)return previo;
    const antes=await resumen(negocioId,productoId),media=antes.media.find(row=>row.id===mediaId);
    if(!media)throw error('Archivo no encontrado en este producto',404);
    if(input.version&&input.version!==antes.version)throw error('Los archivos cambiaron. Volvé a revisar el producto.',409);
    await db.prepare('DELETE FROM tienda_media WHERE id=? AND negocio_id=? AND tienda_producto_id=?').run(mediaId,negocioId,productoId);
    for(const [orden,row] of antes.media.filter(row=>row.id!==mediaId).entries())await db.prepare('UPDATE tienda_media SET orden=? WHERE id=?').run(orden,row.id);
    const resultado={...await resumen(negocioId,productoId),eliminado:true,media_id:mediaId};
    await auditar('tienda_media',mediaId,'eliminar',media,null,actor);
    await guardarSolicitud(negocioId,productoId,solicitudId,actor,'eliminar',huella,resultado);
    return resultado;
  });
}
export async function ordenarMediaProducto(negocioId,productoId,input,actor) {
  datosMutacion(input,['negocio_id','solicitud_id','version','ids']);
  if(typeof input.version!=='string')throw error('Volvé a cargar los archivos antes de ordenarlos');
  if(!Array.isArray(input.ids)||input.ids.length>LIMITES_MEDIA.max_archivos_producto||input.ids.some(value=>typeof value!=='string')||new Set(input.ids).size!==input.ids.length)throw error('Orden de archivos inválido');
  const solicitudId=solicitud(input.solicitud_id),huella=hash(JSON.stringify({operacion:'ordenar',productoId,version:input.version,ids:input.ids}));
  return db.transaction(async()=>{
    await bloquear(negocioId,productoId);
    const previo=await reintento(negocioId,solicitudId,actor,huella);if(previo)return previo;
    const antes=await resumen(negocioId,productoId);
    if(input.version!==antes.version)throw error('Los archivos cambiaron. Volvé a revisar el producto.',409);
    if(input.ids.length!==antes.media.length||input.ids.some(id=>!antes.media.some(row=>row.id===id)))throw error('El orden debe incluir únicamente todos los archivos de este producto');
    for(const [orden,mediaId] of input.ids.entries())await db.prepare('UPDATE tienda_media SET orden=? WHERE id=? AND negocio_id=? AND tienda_producto_id=?').run(orden,mediaId,negocioId,productoId);
    const resultado=await resumen(negocioId,productoId);
    await auditar('tienda_producto',productoId,'ordenar_media',{ids:antes.media.map(row=>row.id)},{ids:input.ids,negocio_id:negocioId},actor);
    await guardarSolicitud(negocioId,productoId,solicitudId,actor,'ordenar',huella,resultado);
    return resultado;
  });
}

export async function obtenerMedia(mediaId,negocioId=null) {
  const row=negocioId
    ?await db.prepare(`SELECT ${columnas} FROM tienda_media WHERE id=? AND negocio_id=?`).get(mediaId,negocioId)
    :await db.prepare(`SELECT m.id,m.tienda_producto_id,m.negocio_id,m.tipo,m.mime,m.bytes,m.nombre,m.orden,m.hash,m.solicitud_id,m.created_at
       FROM tienda_media m JOIN tienda_productos p ON p.id=m.tienda_producto_id AND p.negocio_id=m.negocio_id
       JOIN tiendas_config t ON t.negocio_id=p.negocio_id
       WHERE m.id=? AND p.publicado=TRUE AND t.habilitada=TRUE`).get(mediaId);
  if(!row)throw error('Archivo no encontrado',404);
  return row;
}
export function rangoMedia(value,bytes) {
  if(value===undefined)return {inicio:0,fin:bytes-1,parcial:false};
  const match=typeof value==='string'&&value.length<120&&/^bytes=(\d*)-(\d*)$/i.exec(value);
  if(!match||(!match[1]&&!match[2]))throw error('Rango de archivo inválido',416);
  const first=match[1]?Number(match[1]):null,last=match[2]?Number(match[2]):null;
  if((first!==null&&!Number.isSafeInteger(first))||(last!==null&&!Number.isSafeInteger(last)))throw error('Rango de archivo inválido',416);
  if(first===null) {
    if(last<=0)throw error('Rango de archivo inválido',416);
    return {inicio:Math.max(0,bytes-last),fin:bytes-1,parcial:true};
  }
  if(first>=bytes||(last!==null&&last<first))throw error('Rango de archivo inválido',416);
  return {inicio:first,fin:last===null?bytes-1:Math.min(last,bytes-1),parcial:true};
}
export async function leerRangoMedia(mediaId,inicio,longitud) {
  const row=await db.query('SELECT substring(datos from $2 for $3) AS datos FROM tienda_media_contenido WHERE media_id=$1',[mediaId,inicio+1,longitud]);
  if(!row.rows[0])throw error('Archivo no encontrado',404);
  return row.rows[0].datos;
}
export const extensionMedia=mime=>MIME[mime];
