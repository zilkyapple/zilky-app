import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {auditar} from '../lib/audit.js';
import {normalizeDocument,pageSettings} from '../../public/contratoDocumento.js';
const error=(s,status=400)=>Object.assign(new Error(s),{status});
const title=v=>{if(typeof v!=='string'||!v.trim()||v.length>150)throw error('Indicá un título de hasta 150 caracteres');return v.trim();};
function payload(body){try{return {documento:normalizeDocument(body.documento),pagina:pageSettings(body.pagina)};}catch(e){throw error(e.message);}}
async function negocio(n){if(typeof n!=='string'||!await db.prepare('SELECT id FROM negocios WHERE id=?').get(n))throw error('Elegí un negocio');}
export async function listarContratos(n){await negocio(n);return {modelos:await db.prepare('SELECT * FROM contrato_modelos WHERE negocio_id=? ORDER BY nombre').all(n),contratos:await db.prepare(`SELECT c.id,c.cliente_id,c.credito_id,c.revision,c.estado,v.titulo,cl.nombre,cl.apellido FROM contratos c JOIN clientes cl ON cl.id=c.cliente_id LEFT JOIN contrato_versiones v ON v.contrato_id=c.id AND v.revision=c.revision WHERE c.negocio_id=? ORDER BY c.created_at DESC`).all(n)};}
export async function guardarModelo(body,actor){return db.transaction(async()=>{
 await negocio(body.negocio_id);const p=payload(body),nombre=title(body.nombre),mid=body.id||id();
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['modelo:'+mid]);
 const old=await db.prepare('SELECT * FROM contrato_modelos WHERE id=?').get(mid);
 if(old&&(old.negocio_id!==body.negocio_id||old.version!==body.version))throw error('El modelo cambió; volvé a abrirlo',409);
 if(body.id&&!old)throw error('Modelo no encontrado',404);
 if(old)await db.prepare('UPDATE contrato_modelos SET nombre=?,documento=?::jsonb,pagina=?::jsonb,version=version+1,actualizado_por=?,actualizado_at=now() WHERE id=?').run(nombre,JSON.stringify(p.documento),JSON.stringify(p.pagina),actor,mid);
 else await db.prepare('INSERT INTO contrato_modelos(id,negocio_id,nombre,documento,pagina,actualizado_por) VALUES(?,?,?,?::jsonb,?::jsonb,?)').run(mid,body.negocio_id,nombre,JSON.stringify(p.documento),JSON.stringify(p.pagina),actor);
 await auditar('contrato_modelo',mid,'guardar',old,{nombre,...p},actor);return db.prepare('SELECT * FROM contrato_modelos WHERE id=?').get(mid);
});}
export async function fuentesContrato(n,client){await negocio(n);const c=await db.prepare('SELECT c.* FROM clientes c JOIN cliente_negocio cn ON cn.cliente_id=c.id WHERE c.id=? AND cn.negocio_id=?').get(client,n);if(!c)throw error('Cliente no pertenece al negocio',404);
 const creditos=await db.prepare('SELECT * FROM creditos WHERE cliente_id=? AND negocio_id=? ORDER BY fecha_inicio DESC').all(client,n);
 for(const cr of creditos)cr.cuotas=await db.prepare('SELECT numero,monto_centavos,fecha_vencimiento FROM cuotas WHERE credito_id=? ORDER BY numero').all(cr.id);
 return {cliente:c,creditos};}
export async function obtenerContrato(cid){const c=await db.prepare('SELECT * FROM contratos WHERE id=?').get(cid);if(!c)throw error('Contrato no encontrado',404);return {...c,versiones:await db.prepare('SELECT * FROM contrato_versiones WHERE contrato_id=? ORDER BY revision DESC').all(cid)};}
export async function guardarContrato(body,actor){return db.transaction(async()=>{
 await negocio(body.negocio_id);const p=payload(body),titulo=title(body.titulo);
 if(!['borrador','emitido'].includes(body.estado))throw error('Estado inválido');
 if(body.estado==='emitido'&&!p.documento.some(function hasText(n){return typeof n==='string'?!!n.trim():n.children.some(hasText);}))throw error('El documento está vacío');
 if(typeof body.solicitud_id!=='string'||! /^[a-f\d-]{36}$/i.test(body.solicitud_id))throw error('Solicitud inválida');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['contrato-solicitud:'+body.solicitud_id]);
 const retry=await db.prepare('SELECT v.*,c.negocio_id,c.cliente_id,c.credito_id FROM contrato_versiones v JOIN contratos c ON c.id=v.contrato_id WHERE v.id=?').get(body.solicitud_id);
 if(retry){if(retry.autor!==actor||retry.negocio_id!==body.negocio_id||retry.cliente_id!==body.cliente_id||retry.credito_id!==(body.credito_id||null)||retry.titulo!==titulo||retry.estado!==body.estado||JSON.stringify(normalizeDocument(retry.documento))!==JSON.stringify(p.documento)||JSON.stringify(pageSettings(retry.pagina))!==JSON.stringify(p.pagina)||(body.id&&retry.contrato_id!==body.id))throw error('Solicitud reutilizada con otro contenido',409);return obtenerContrato(retry.contrato_id);}
 await db.lockClienteNegocio(body.cliente_id,body.negocio_id);
 const f=await fuentesContrato(body.negocio_id,body.cliente_id);const cr=body.credito_id?f.creditos.find(c=>c.id===body.credito_id):null;if(body.credito_id&&!cr)throw error('Financiación no pertenece al cliente');
 let old=null;const cid=body.id||id();
 if(body.id){old=await db.prepare('SELECT * FROM contratos WHERE id=? FOR UPDATE').get(cid);if(!old)throw error('Contrato no encontrado',404);if(old.negocio_id!==body.negocio_id||old.cliente_id!==body.cliente_id||old.credito_id!==(body.credito_id||null))throw error('No se puede cambiar el cliente o negocio de un contrato');if(old.revision!==body.revision)throw error('El contrato cambió; volvé a abrirlo',409);}
 const rev=(old?.revision||0)+1;
 if(!old)await db.prepare('INSERT INTO contratos(id,negocio_id,cliente_id,credito_id,venta_id,estado,revision) VALUES(?,?,?,?,?,?,?)').run(cid,body.negocio_id,body.cliente_id,cr?.id||null,cr?.venta_id||null,body.estado,rev);
 else await db.prepare('UPDATE contratos SET estado=?,revision=? WHERE id=?').run(body.estado,rev,cid);
 await db.prepare('INSERT INTO contrato_versiones(id,contrato_id,revision,titulo,documento,pagina,estado,autor) VALUES(?,?,?,?,?::jsonb,?::jsonb,?,?)').run(body.solicitud_id,cid,rev,titulo,JSON.stringify(p.documento),JSON.stringify(p.pagina),body.estado,actor);
 await auditar('contrato',cid,'version',{revision:old?.revision||0},{revision:rev,estado:body.estado},actor);return obtenerContrato(cid);
});}
