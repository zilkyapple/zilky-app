import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {tiendaMediaSchema} from '../src/db/tiendaMediaSchema.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearProducto} from '../src/repositories/productos.js';
import {crearUsuario,asignarNegocio} from '../src/repositories/usuarios.js';
import {firmarToken} from '../src/lib/auth.js';
import {app} from '../src/app.js';
import {LIMITES_MEDIA,validarMedia,rangoMedia} from '../src/services/tiendaMediaService.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const owner=await crearUsuario({email:'owner@media.invalid',nombre:'Dueño QA',password_hash:'unused'});
const editor=await crearUsuario({email:'editor@media.invalid',nombre:'Editor QA',rol:'empleado',password_hash:'unused'});
const viewer=await crearUsuario({email:'viewer@media.invalid',nombre:'Consulta QA',rol:'empleado',password_hash:'unused'});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yck8AAAAASUVORK5CYII=','base64');
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,0,0]),Buffer.from('isommp42'),Buffer.from([0,0,0,12]),Buffer.from('mdat'),Buffer.from([1,2,3,4])]);
const server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
const base='http://127.0.0.1:'+server.address().port;
test.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();});

async function fixture() {
  const n=await crearNegocio({nombre:'Media '+randomUUID()});
  const p=await crearProducto({negocio_id:n.id,nombre:'Producto con fotos',stock:8});
  const listing={id:randomUUID(),negocio_id:n.id,producto_id:p.id};
  await db.prepare('INSERT INTO tiendas_config(negocio_id,slug,nombre) VALUES(?,?,?)').run(n.id,'media-'+randomUUID(),'Tienda de prueba');
  await db.prepare('INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,precio_centavos) VALUES(?,?,?,?,?)').run(listing.id,n.id,p.id,'Producto publicado',100000);
  await asignarNegocio(editor.id,n.id,{'tienda.editar':true});
  await asignarNegocio(viewer.id,n.id,{'productos.ver':true});
  return {n,p,listing,path:'/api/tiendas/productos/'+listing.id+'/media?negocio_id='+n.id};
}
function req(path,{user=owner,method='GET',body,headers={}}={}) {
  const h={...(user?{Authorization:'Bearer '+firmarToken(user)}:{}),...headers};
  if(body&&!Buffer.isBuffer(body)){h['Content-Type']='application/json';body=JSON.stringify(body);}
  return fetch(base+path,{method,headers:h,body});
}
function upload(f,{body=png,mime='image/png',user=owner,solicitudId=randomUUID(),nombre='foto cliente.png',path=f.path}={}) {
  return req(path,{user,method:'POST',body,headers:{'Content-Type':mime,'X-Filename':encodeURIComponent(nombre),...(solicitudId?{'X-Solicitud-Id':solicitudId}:{})}});
}
async function uploaded(f,options) {
  const response=await upload(f,options),body=await response.json();
  assert.ok([200,201].includes(response.status),JSON.stringify(body));return body;
}
async function publicar(f) {
  await db.prepare('UPDATE tiendas_config SET habilitada=TRUE WHERE negocio_id=?').run(f.n.id);
  await db.prepare('UPDATE tienda_productos SET publicado=TRUE WHERE id=?').run(f.listing.id);
}

test('Media: firmas, formatos y tamaños rechazan HTML/SVG y MIME falsos antes de guardar',async()=>{
  assert.equal(validarMedia(png,'image/png').tipo,'imagen');assert.equal(validarMedia(mp4,'video/mp4').tipo,'video');
  for(const mime of ['image/svg+xml','text/html','application/octet-stream'])assert.throws(()=>validarMedia(png,mime),e=>e.status===415);
  for(const [body,mime] of [[Buffer.from('<html>archivo</html>'),'image/png'],[png,'image/jpeg'],[png,'video/mp4'],[mp4,'video/quicktime'],[Buffer.alloc(0),'image/png']])assert.throws(()=>validarMedia(body,mime),e=>[400,415].includes(e.status));
  assert.throws(()=>validarMedia(Buffer.alloc(LIMITES_MEDIA.imagen_bytes+1),'image/png'),e=>e.status===413);
  assert.throws(()=>validarMedia(Buffer.alloc(LIMITES_MEDIA.video_bytes+1),'video/mp4'),e=>e.status===413);
  const f=await fixture();const before=await db.prepare('SELECT count(*) total FROM tienda_media').get();
  assert.equal((await upload(f,{body:Buffer.from('<svg onload="alert(1)">'),'mime':'image/png'})).status,415);
  assert.equal((await upload(f,{body:png,mime:'image/svg+xml'})).status,415);
  assert.equal((await upload(f,{body:Buffer.alloc(LIMITES_MEDIA.imagen_bytes+1)})).status,413);
  assert.deepEqual(await db.prepare('SELECT count(*) total FROM tienda_media').get(),before);
});

test('Media: permisos y pertenencia se comprueban antes de procesar el archivo y sin dar acceso a otros negocios',async()=>{
  const a=await fixture(),b=await fixture();
  assert.equal((await upload(a,{user:null,body:Buffer.from('no es una foto')})).status,401);
  assert.equal((await upload(a,{user:viewer,body:Buffer.from('no es una foto')})).status,403);
  assert.equal((await upload(a,{user:editor,path:'/api/tiendas/productos/'+b.listing.id+'/media?negocio_id='+a.n.id})).status,404);
  await asignarNegocio(editor.id,b.n.id,{'productos.ver':true});
  assert.equal((await upload(b,{user:editor})).status,403);
  assert.equal((await upload(a,{path:'/api/tiendas/productos/'+a.listing.id+'/media'})).status,400);
  const media=(await uploaded(a,{user:editor})).media;
  assert.equal((await req(media.url_privada,{user:viewer})).status,403);
  assert.equal((await req('/api/tiendas/media/'+media.id+'?negocio_id='+b.n.id)).status,404);
  assert.equal((await req('/api/tiendas/media/'+media.id+'?negocio_id='+b.n.id,{user:editor})).status,403);
  const privateResponse=await req(media.url_privada,{user:editor});assert.equal(privateResponse.status,200);assert.deepEqual(Buffer.from(await privateResponse.arrayBuffer()),png);
  const before=await db.prepare('SELECT stock FROM productos WHERE id=?').get(a.p.id);
  assert.deepEqual(before,{stock:8});
});

test('Media: guarda binarios duraderos separados y devuelve sólo metadatos, límites y versión al administrar',async()=>{
  const f=await fixture(),result=await uploaded(f,{nombre:'../fotos\\prueba.png'});
  assert.match(result.media.id,/^[a-f0-9-]{36}$/i);assert.equal(result.media.tipo,'imagen');assert.equal(result.media.mime,'image/png');
  assert.equal(result.media.bytes,png.length);assert.equal(result.media.orden,0);assert.equal(result.media.negocio_id,f.n.id);
  assert.equal(result.media.tienda_producto_id,f.listing.id);assert.doesNotMatch(result.media.nombre,/[\\/]/);
  assert.match(result.version,/^[a-f0-9]{64}$/);assert.deepEqual(result.limites,LIMITES_MEDIA);assert.equal(result.usados_bytes,png.length);
  const content=await db.prepare('SELECT datos FROM tienda_media_contenido WHERE media_id=?').get(result.media.id);assert.deepEqual(content.datos,png);
  const listResponse=await req(f.path),list=await listResponse.json();assert.equal(listResponse.status,200);assert.equal(list.media.length,1);assert.equal(list.media[0].id,result.media.id);assert.equal(list.version,result.version);
  assert.equal(list.media[0].datos,undefined);assert.equal(JSON.stringify(list).includes(png.toString('base64')),false);
  const audit=await db.prepare("SELECT * FROM auditoria WHERE entidad='tienda_media' AND entidad_id=? AND accion='subir'").get(result.media.id);
  assert.equal(audit.empleado,owner.id);assert.equal(JSON.parse(audit.datos_nuevos).bytes,png.length);assert.equal(audit.datos_nuevos.includes(png.toString('base64')),false);
});

test('Media pública: publicación de tienda y producto requerida incluso antes de responder 304',async()=>{
  const f=await fixture(),result=await uploaded(f),url=result.media.url;
  assert.equal((await req(url,{user:null})).status,404);
  await db.prepare('UPDATE tiendas_config SET habilitada=TRUE WHERE negocio_id=?').run(f.n.id);
  assert.equal((await req(url,{user:null})).status,404);
  await publicar(f);
  const response=await req(url,{user:null});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('content-length'),String(png.length));
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(response.headers.get('cache-control'),'public, max-age=0, must-revalidate');
  const etag=response.headers.get('etag');assert.equal(etag,'"'+result.media.hash+'"');
  assert.equal((await req(url,{user:null,headers:{'If-None-Match':etag}})).status,304);
  const head=await req(url,{user:null,method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(png.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  await db.prepare('UPDATE tienda_productos SET publicado=FALSE WHERE id=?').run(f.listing.id);
  assert.equal((await req(url,{user:null,headers:{'If-None-Match':etag}})).status,404);
  await publicar(f);await db.prepare('UPDATE tiendas_config SET habilitada=FALSE WHERE negocio_id=?').run(f.n.id);
  assert.equal((await req(url,{user:null,headers:{'If-None-Match':etag}})).status,404);
  assert.equal((await req(result.media.url_privada)).status,200,'El dueño conserva la vista previa privada');
});

test('Video: Range entrega sólo los bytes solicitados, admite sufijo y devuelve 416 para rangos inválidos',async()=>{
  const f=await fixture(),result=await uploaded(f,{body:mp4,mime:'video/mp4',nombre:'video.mp4'});await publicar(f);
  const url=result.media.url,etag='"'+result.media.hash+'"';
  for(const [range,first,last] of [['bytes=5-18',5,18],['bytes=-5',mp4.length-5,mp4.length-1],['bytes=10-',10,mp4.length-1],['bytes=0-999',0,mp4.length-1]]) {
    const response=await req(url,{user:null,headers:{Range:range}});assert.equal(response.status,206,range);
    assert.equal(response.headers.get('content-range'),`bytes ${first}-${last}/${mp4.length}`);assert.equal(response.headers.get('content-length'),String(last-first+1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4.subarray(first,last+1));
  }
  for(const range of ['bytes=','bytes=-0','bytes=20-5','bytes=999-','bytes=0-1,5-8','bits=0-2','bytes=9007199254740992-']) {
    const response=await req(url,{user:null,headers:{Range:range}});assert.equal(response.status,416,range);assert.equal(response.headers.get('content-range'),'bytes */'+mp4.length);
  }
  const full=await req(url,{user:null,headers:{Range:'bytes=1-3','If-Range':'"otra-revision"'}});assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),mp4);
  assert.equal((await req(url,{user:null,headers:{Range:'bytes=1-3','If-Range':etag}})).status,206);
  assert.equal((await req(url,{user:null,headers:{Range:'bytes=1-3','If-None-Match':etag}})).status,304);
  assert.deepEqual(rangoMedia('bytes=-999',mp4.length),{inicio:0,fin:mp4.length-1,parcial:true});
});

test('Media: reintentos concurrentes conservan un único archivo y UUID reutilizado con otro archivo o responsable da 409',async()=>{
  const f=await fixture(),solicitudId=randomUUID();
  const responses=await Promise.all([upload(f,{solicitudId}),upload(f,{solicitudId})]);
  const results=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].media.id,results[1].media.id);
  assert.equal((await db.prepare('SELECT count(*) total FROM tienda_media WHERE tienda_producto_id=?').get(f.listing.id)).total,1);
  assert.equal((await db.prepare('SELECT count(*) total FROM tienda_media_contenido WHERE media_id=?').get(results[0].media.id)).total,1);
  assert.equal((await db.prepare("SELECT count(*) total FROM auditoria WHERE entidad_id=? AND accion='subir'").get(results[0].media.id)).total,1);
  assert.equal((await upload(f,{solicitudId,nombre:'otro nombre.png'})).status,409);
  assert.equal((await upload(f,{solicitudId,user:editor})).status,409);
  const legacy=await uploaded(f,{solicitudId:null});assert.equal(legacy.reintentado,true);assert.equal(legacy.media.id,results[0].media.id);
});

test('Media: orden completo versionado y eliminación atómica no aceptan archivos de otro producto ni reintentos distintos',async()=>{
  const f=await fixture(),other=await fixture(),a=await uploaded(f),b=await uploaded(f),foreign=await uploaded(other);
  const ordenUrl='/api/tiendas/productos/'+f.listing.id+'/media/orden';
  const order={negocio_id:f.n.id,solicitud_id:randomUUID(),version:b.version,ids:[b.media.id,a.media.id]};
  let response=await req(ordenUrl,{method:'PUT',body:order});assert.equal(response.status,200);const ordered=await response.json();assert.deepEqual(ordered.media.map(m=>m.id),order.ids);assert.deepEqual(ordered.media.map(m=>m.orden),[0,1]);
  response=await req(ordenUrl,{method:'PUT',body:order});assert.equal(response.status,200);assert.equal((await response.json()).reintentado,true);
  assert.equal((await req(ordenUrl,{method:'PUT',body:{...order,solicitud_id:randomUUID()}})).status,409);
  assert.equal((await req(ordenUrl,{method:'PUT',body:{...order,solicitud_id:randomUUID(),version:ordered.version,ids:[foreign.media.id,a.media.id]}})).status,400);
  assert.equal((await req(ordenUrl,{method:'PUT',body:{...order,solicitud_id:randomUUID(),version:ordered.version,ids:[a.media.id,a.media.id]}})).status,400);
  const deleteUrl='/api/tiendas/productos/'+f.listing.id+'/media/'+b.media.id;
  const deletion={negocio_id:f.n.id,solicitud_id:randomUUID(),version:ordered.version};
  response=await req(deleteUrl,{method:'DELETE',body:deletion});assert.equal(response.status,200);const removed=await response.json();assert.equal(removed.eliminado,true);assert.equal(removed.usados_bytes,png.length);assert.equal(removed.media[0].orden,0);
  assert.equal(await db.prepare('SELECT 1 FROM tienda_media_contenido WHERE media_id=?').get(b.media.id),undefined);
  assert.equal((await req(deleteUrl,{method:'DELETE',body:deletion})).status,200);
  const retry=await uploaded(f,{solicitudId:b.media.solicitud_id});assert.equal(retry.reintentado,true);assert.equal(retry.eliminado,true);assert.equal((await req(f.path)).status,200);
  assert.equal((await req('/api/tiendas/productos/'+f.listing.id+'/media/'+foreign.media.id+'?negocio_id='+f.n.id,{method:'DELETE'})).status,404);
  assert.equal((await req('/api/tiendas/productos/'+f.listing.id+'/media/'+a.media.id,{method:'DELETE',body:{negocio_id:f.n.id,version:ordered.version}})).status,409);
  assert.equal((await req('/api/tiendas/productos/'+f.listing.id+'/media/'+a.media.id+'?negocio_id='+f.n.id,{method:'DELETE',body:{negocio_id:other.n.id}})).status,400);
});

test('Media: límite de doce archivos permanece correcto con dos subidas concurrentes',async()=>{
  const f=await fixture();
  for(let i=0;i<11;i++)await uploaded(f);
  const responses=await Promise.all([upload(f),upload(f)]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  const list=await (await req(f.path)).json();assert.equal(list.media.length,12);assert.equal(list.usados_bytes,12*png.length);
});

test('Media: cuota de 200 MB se aplica por negocio entre productos y vuelve a liberarse al eliminar',async()=>{
  const f=await fixture();
  // Metadatos de un inventario de medios ya guardado: no se transfieren 200 MB
  // en la prueba para comprobar únicamente la contabilidad y su bloqueo.
  for(let i=0;i<7;i++)await db.prepare('INSERT INTO tienda_media(id,tienda_producto_id,negocio_id,tipo,mime,bytes,nombre,orden,hash) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.listing.id,f.n.id,'video','video/mp4',(i===6?20:30)*1024*1024,'video.mp4',i,'a'.repeat(64));
  assert.equal((await upload(f)).status,409);
  const list=await (await req(f.path)).json();assert.equal(list.usados_bytes,LIMITES_MEDIA.negocio_bytes);
  assert.equal((await req('/api/tiendas/productos/'+f.listing.id+'/media/'+list.media[0].id+'?negocio_id='+f.n.id,{method:'DELETE'})).status,200);
  assert.equal((await upload(f)).status,201);
  const other=await fixture();assert.equal((await upload(other)).status,201,'La cuota de un negocio no bloquea a otro');
});

test('Media: si falla la auditoría revierte archivo, binario y solicitud; la migración repetida conserva los medios',async()=>{
  const f=await fixture(),solicitudId=randomUUID();
  await db.exec(`CREATE OR REPLACE FUNCTION media_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entidad='tienda_media' THEN RAISE EXCEPTION 'MEDIA_AUDIT_FORCED_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER media_audit_failure BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION media_audit_failure();`);
  try {assert.equal((await upload(f,{solicitudId})).status,500);}finally {await db.exec('DROP TRIGGER media_audit_failure ON auditoria; DROP FUNCTION media_audit_failure()');}
  assert.equal((await db.prepare('SELECT count(*) total FROM tienda_media WHERE tienda_producto_id=?').get(f.listing.id)).total,0);
  assert.equal((await db.prepare('SELECT count(*) total FROM tienda_media_solicitudes WHERE negocio_id=?').get(f.n.id)).total,0);
  const created=await uploaded(f,{solicitudId});
  const snapshot=async()=>({media:await db.prepare('SELECT * FROM tienda_media WHERE id=?').get(created.media.id),contenido:await db.prepare('SELECT * FROM tienda_media_contenido WHERE media_id=?').get(created.media.id),solicitud:await db.prepare('SELECT * FROM tienda_media_solicitudes WHERE negocio_id=? AND solicitud_id=?').get(f.n.id,solicitudId)});
  const before=await snapshot();await db.exec(tiendaMediaSchema);await db.exec(tiendaMediaSchema);assert.deepEqual(await snapshot(),before);
});
