import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {integer,text,badRequest} from '../lib/validation.js';
import {crearProducto,getProducto} from '../repositories/productos.js';
const fail=(m,s=400)=>Object.assign(new Error(m),{status:s});
const strings={nombre:180,categoria:120,variante:200,sku:100,imei:100,estado:80};
const amounts=['costo_centavos','precio_contado_centavos','precio_financiado_centavos','stock_minimo'];
function photo(v){
 if(v==null||v==='')return null;
 if(typeof v!=='string'||v.length>70000)throw badRequest('Foto demasiado grande');
 if(v.startsWith('https://')){try{const u=new URL(v);if(u.username||u.password||v.length>2000)throw Error();return v;}catch{throw badRequest('URL de foto inválida');}}
 const m=v.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);if(!m)throw badRequest('La foto debe ser JPG, PNG o una URL HTTPS');
 const b=Buffer.from(m[2],'base64');if(m[1]==='jpeg' ? !(b[0]===255&&b[1]===216&&b[2]===255) : b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw badRequest('Foto inválida');return v;
}
function fields(b,creating=false){
 const out={};for(const [k,max] of Object.entries(strings)){if(k in b){if(k==='nombre')out[k]=text(b[k],'Nombre',max);else {if(b[k]!=null&&(typeof b[k]!=='string'||b[k].length>max))throw badRequest(k+' inválido');out[k]=b[k]?.trim()||null;}}}
 if(creating&&!out.nombre)throw badRequest('El nombre es obligatorio');
 for(const k of amounts)if(k in b)out[k]=integer(b[k],k);
 if('foto_url' in b)out.foto_url=photo(b.foto_url);
 return out;
}
const safe=p=>{const {foto_url,...rest}=p;return {...rest,tiene_foto:!!foto_url};};
async function event(p,t,old,now,motive,actor,request=null,details={}){
 await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,usuario_id,solicitud_id,detalles) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(),p.id,p.negocio_id,t,old,now,motive,actor,request,JSON.stringify(details));
}
export async function nuevoProducto(b,actor){const values=fields(b,true);if(b.stock!=null&&b.stock!=='')integer(b.stock,'Stock inicial');
 return db.transaction(async()=>{if(!await db.prepare('SELECT id FROM negocios WHERE id=?').get(b.negocio_id))throw fail('Negocio no encontrado',404);
 const p=await crearProducto({...values,negocio_id:b.negocio_id,stock:b.stock});await event(p,'creacion',null,p.stock,'Producto creado',actor);return p;});
}
async function locked(p,n){const v=await db.prepare('SELECT * FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(p,n);if(!v)throw fail('Producto no encontrado en este negocio',404);return v;}
export async function editarProducto(p,n,b,actor){const values=fields(b);if('stock' in b)throw badRequest('Usá la acción de stock para cambiar existencias');integer(b.revision,'Revisión',{min:1});
 return db.transaction(async()=>{const old=await locked(p,n);if(old.revision!==b.revision)throw fail('El producto cambió. Volvé a abrirlo antes de guardar.',409);
 const keys=Object.keys(values);if(!keys.length)throw badRequest('No hay cambios');
 await db.prepare(`UPDATE productos SET ${keys.map(k=>k+'=?').join(',')},revision=revision+1 WHERE id=?`).run(...keys.map(k=>values[k]),p);
 const next=await getProducto(p);await event(next,'edicion',old.stock,next.stock,'Datos del producto editados',actor,null,{anterior:safe(old),nuevo:safe(next),foto_modificada:old.foto_url!==next.foto_url});return next;});
}
export async function moverStock(p,n,b,actor){const type=b.tipo;if(!['reposicion','conteo','sin_control'].includes(type))throw badRequest('Movimiento inválido');const motive=text(b.motivo,'Motivo',500);
 if(typeof b.solicitud_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.solicitud_id))throw badRequest('Identificador de movimiento inválido');
 if(type!=='sin_control')integer(b.cantidad,'Cantidad',{min:type==='reposicion'?1:0});
 return db.transaction(async()=>{const old=await locked(p,n);const prior=await db.prepare('SELECT * FROM producto_historial WHERE producto_id=? AND solicitud_id=?').get(p,b.solicitud_id);
 if(prior){if(prior.tipo!==type||prior.motivo!==motive||prior.usuario_id!==actor||prior.detalles.cantidad!==(b.cantidad??null))throw fail('El identificador ya corresponde a otro movimiento',409);return {producto:old,movimiento:prior};}
 if(type==='reposicion'&&old.stock===null)throw badRequest('Primero activá el control con un conteo inicial');
 if(type!=='reposicion'&&(!Object.hasOwn(b,'stock_esperado')||b.stock_esperado!==old.stock))throw fail('El stock cambió. Volvé a abrir el producto para contar de nuevo.',409);
 const next=type==='sin_control'?null:type==='reposicion'?old.stock+b.cantidad:b.cantidad;if(next!==null)integer(next,'Stock resultante',{min:-2147483648});
 await db.prepare('UPDATE productos SET stock=? WHERE id=?').run(next,p);await event(old,type,old.stock,next,motive,actor,b.solicitud_id,{cantidad:b.cantidad??null});return {producto:await getProducto(p)};});
}
export async function historialProducto(p,n){if(!await db.prepare('SELECT id FROM productos WHERE id=? AND negocio_id=?').get(p,n))throw fail('Producto no encontrado en este negocio',404);return db.prepare(`SELECT h.*,COALESCE(u.nombre,u.email,'Sistema') AS responsable FROM producto_historial h LEFT JOIN usuarios u ON u.id=h.usuario_id WHERE h.producto_id=? ORDER BY h.creado_at DESC,h.id DESC LIMIT 200`).all(p);}
