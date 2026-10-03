import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario, asignarNegocio, getUsuarioNegocios } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { firmarToken } from '../src/lib/auth.js';
import { hashToken } from '../src/repositories/invitaciones.js';
import { PERMISOS } from '../src/middleware/authorize.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearVenta } from '../src/services/ventasService.js';
import { crearServicioEmail } from '../src/services/emailService.js';
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const apple=await crearNegocio({nombre:'Apple'}), ropa=await crearNegocio({nombre:'Indumentaria'}), reparaciones=await crearNegocio({nombre:'Reparaciones'});
const admin=await crearUsuario({email:'admin@stage2.invalid',password_hash:'unused'});
const manager=await crearUsuario({email:'manager@stage2.invalid',password_hash:'unused',rol:'empleado'});
const soloApple=await crearUsuario({email:'apple@stage2.invalid',password_hash:'unused',rol:'empleado'});
await asignarNegocio(manager.id,apple.id,{'empleados.gestionar':true,'clientes.ver':true});
await asignarNegocio(soloApple.id,apple.id,{'clientes.ver':true});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}/api`;
async function api(path,user=admin,method='GET',body){
 const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+(typeof user==='string'?user:firmarToken(user))}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 return {status:response.status,body:await response.json()};
}
let counter=0;
const asignaciones=()=>[{negocio_id:apple.id,permisos:{'clientes.ver':true,'ventas.crear':true,'pagos.registrar':true}},{negocio_id:ropa.id,permisos:{'clientes.ver':true,'ventas.crear':true,'pagos.registrar':false}}];
async function invitar(extra={}){const r=await api('/invitaciones',admin,'POST',{email:`invitado${++counter}@stage2.invalid`,nombre:'Invitado',negocios:asignaciones(),...extra});assert.equal(r.status,201,JSON.stringify(r));return r.body;}
const aceptar=(token,extra={})=>api('/auth/invitacion/aceptar',null,'POST',{token,password:'segura-prueba-123',...extra});
const consultar=token=>api('/auth/invitacion/consultar',null,'POST',{token});
async function snapshot(){return (await db.query(`SELECT (SELECT jsonb_agg(x ORDER BY id) FROM usuarios x) usuarios,(SELECT jsonb_agg(x ORDER BY usuario_id,negocio_id) FROM usuario_negocio x) asignaciones,(SELECT jsonb_agg(x ORDER BY id) FROM invitaciones x) invitaciones`)).rows[0];}
async function falloTrigger(table,body,fn){
 await db.query(`CREATE FUNCTION stage2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER stage2_fail BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION stage2_fail()`);
 try { await fn(); } finally { await db.query(`DROP TRIGGER stage2_fail ON ${table}; DROP FUNCTION stage2_fail()`); }
}
test('Etapa2: admin invita a tres negocios con permisos independientes y token solo hasheado',async()=>{
 const r=await invitar({negocios:[...asignaciones(),{negocio_id:reparaciones.id,permisos:{'productos.ver':true}}]});
 const row=await db.prepare('SELECT * FROM invitaciones WHERE id=?').get(r.invitacion.id);
 assert.equal(row.token_hash,hashToken(r.token));assert.ok(!row.token);assert.equal(r.invitacion.token_hash,undefined);assert.equal(r.invitacion.token,undefined);
 const n=JSON.parse(row.negocios);assert.equal(n.length,3);assert.equal(n[0].permisos['pagos.registrar'],true);assert.equal(n[1].permisos['pagos.registrar'],false);
 assert.ok(Date.parse(row.expira_en)>Date.now()+6*86400000);assert.equal(r.emailEnviado,false);assert.match(r.emailError,/configurado/);
});
test('Etapa2: consulta pública identifica invitación sin devolver secretos',async()=>{const r=await invitar();const c=await consultar(r.token);assert.equal(c.status,200);assert.equal(c.body.email,r.invitacion.email);assert.deepEqual(c.body.negocios.map(n=>n.nombre),['Apple','Indumentaria']);assert.equal(c.body.token_hash,undefined);assert.equal(c.body.token,undefined);});
test('Etapa2: aceptar crea empleado, bcrypt, asignaciones y sesión; no permite reutilizar enlace',async()=>{
 const inv=await invitar(), r=await aceptar(inv.token,{nombre:'Lucas'});assert.equal(r.status,201);assert.equal(r.body.usuario.rol,'empleado');assert.equal(r.body.usuario.nombre,'Lucas');assert.equal(r.body.usuario.password_hash,undefined);
 const u=await db.prepare('SELECT * FROM usuarios WHERE id=?').get(r.body.usuario.id);assert.notEqual(u.password_hash,'segura-prueba-123');assert.ok(await bcrypt.compare('segura-prueba-123',u.password_hash));
 assert.equal((await getUsuarioNegocios(u.id)).length,2);assert.equal((await api('/auth/yo',r.body.token)).status,200);
 const before=await snapshot();assert.equal((await aceptar(inv.token)).status,410);assert.equal((await consultar(inv.token)).status,410);assert.deepEqual(await snapshot(),before);
});
for(const estado of ['vencida','revocada','usada'])test(`Etapa2: invitación ${estado} rechaza consulta y aceptación sin cambios`,async()=>{
 const inv=await invitar();if(estado==='vencida')await db.prepare('UPDATE invitaciones SET expira_en=? WHERE id=?').run('2000-01-01',inv.invitacion.id);else await db.prepare('UPDATE invitaciones SET estado=? WHERE id=?').run(estado,inv.invitacion.id);
 const before=await snapshot();assert.equal((await consultar(inv.token)).status,410);assert.equal((await aceptar(inv.token)).status,410);assert.deepEqual(await snapshot(),before);
});
test('Etapa2: enlace inválido y token malformado no crean cuentas',async()=>{const before=await snapshot();assert.equal((await aceptar('no-existe')).status,404);for(const token of [null,{},[],123,''])assert.equal((await aceptar(token)).status,400);assert.deepEqual(await snapshot(),before);});
test('Etapa2: revocar invalida enlace y no permite revocarlo dos veces',async()=>{const inv=await invitar();assert.equal((await api(`/invitaciones/${inv.invitacion.id}/revocar`,admin,'POST')).status,200);assert.equal((await aceptar(inv.token)).status,410);assert.equal((await api(`/invitaciones/${inv.invitacion.id}/revocar`,admin,'POST')).status,400);});
test('Etapa2: regenerar revoca todos los enlaces anteriores y nuevo enlace funciona',async()=>{const inv=await invitar();const r=await api(`/invitaciones/${inv.invitacion.id}/regenerar`,admin,'POST');assert.equal(r.status,200);assert.notEqual(r.body.token,inv.token);assert.equal((await aceptar(inv.token)).status,410);assert.equal((await aceptar(r.body.token)).status,201);assert.equal((await api(`/invitaciones/${r.body.invitacion.id}/regenerar`,admin,'POST')).status,400);});
test('Etapa2: regenerar una invitación vencida o revocada crea nuevo enlace',async()=>{for(const estado of ['vencida','revocada']){const inv=await invitar();await db.prepare('UPDATE invitaciones SET estado=? WHERE id=?').run(estado,inv.invitacion.id);const r=await api(`/invitaciones/${inv.invitacion.id}/regenerar`,admin,'POST');assert.equal(r.status,200);assert.equal((await consultar(r.body.token)).status,200);}});
test('Etapa2: dos aceptaciones simultáneas crean exactamente un usuario',async()=>{const inv=await invitar();const results=await Promise.all([aceptar(inv.token),aceptar(inv.token)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,410]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM usuarios WHERE email=?').get(inv.invitacion.email)).n,1);});
test('Etapa2: invitaciones simultáneas dejan un solo enlace vigente para el mismo email',async()=>{const email=`concurrente${++counter}@stage2.invalid`;const results=await Promise.all([invitar({email}),invitar({email})]);const consults=await Promise.all(results.map(r=>consultar(r.token)));assert.deepEqual(consults.map(r=>r.status).sort(),[200,410]);});
test('Etapa2: aceptar y regenerar concurrentemente no dejan invitación utilizable para una cuenta creada',async()=>{const inv=await invitar();const [a,r]=await Promise.all([aceptar(inv.token),api(`/invitaciones/${inv.invitacion.id}/regenerar`,admin,'POST')]);if(a.status===201){assert.ok([400,409].includes(r.status));}else{assert.equal(a.status,410);assert.equal(r.status,200);assert.equal((await aceptar(r.body.token)).status,201);}assert.equal((await db.prepare("SELECT COUNT(*) n FROM invitaciones WHERE email=? AND estado='pendiente'").get(inv.invitacion.email)).n,0);});
test('Etapa2: email existente normalizado no se puede invitar ni crear de nuevo',async()=>{for(const path of ['/invitaciones','/usuarios']){const before=await snapshot();const r=await api(path,admin,'POST',{email:' ADMIN@STAGE2.INVALID ',password:'password-test',negocios:asignaciones()});assert.equal(r.status,path==='/invitaciones'?400:409);assert.deepEqual(await snapshot(),before);}assert.equal((await api('/invitaciones',admin,'POST',{email:' ADMIN@STAGE2.INVALID ',negocios:asignaciones()})).status,409);});
test('Etapa2: email ocupado después de invitar rechaza aceptación sin consumir enlace',async()=>{const inv=await invitar();await crearUsuario({email:inv.invitacion.email,password_hash:'unused',rol:'empleado'});const before=await snapshot();assert.equal((await aceptar(inv.token)).status,409);assert.deepEqual(await snapshot(),before);});
const invalidas=[['negocio inexistente',[{negocio_id:'inexistente',permisos:{}}]],['negocio duplicado',[asignaciones()[0],asignaciones()[0]]],['permiso desconocido',[{negocio_id:apple.id,permisos:{admin:true}}]],['permiso no booleano',[{negocio_id:apple.id,permisos:{'clientes.ver':'true'}}]],['propiedad arbitraria',[{negocio_id:apple.id,permisos:{},rol:'administrador'}]],['permisos array',[{negocio_id:apple.id,permisos:[]}]]];
for(const [label,negocios] of invalidas)test('Etapa2: rechaza '+label+' al invitar, crear y editar, sin cambios',async()=>{for(const path of ['/invitaciones','/usuarios',`/usuarios/${soloApple.id}`]){const before=await snapshot();const r=await api(path,admin,path.endsWith(soloApple.id)?'PATCH':'POST',path.endsWith(soloApple.id)?{negocios}:{email:`invalid${++counter}@stage2.invalid`,...(path==='/usuarios'?{password:'password-test'}:{}),negocios});assert.equal(r.status,400,JSON.stringify(r));assert.deepEqual(await snapshot(),before);}});
for(const [label,negocios] of invalidas)test('Etapa2: revalida '+label+' al aceptar',async()=>{const inv=await invitar();await db.prepare('UPDATE invitaciones SET negocios=? WHERE id=?').run(JSON.stringify(negocios),inv.invitacion.id);const before=await snapshot();assert.equal((await aceptar(inv.token)).status,400);assert.deepEqual(await snapshot(),before);});
test('Etapa2: aceptación rechaza asignaciones vacías o JSON roto',async()=>{for(const contenido of ['[]','{roto']){const inv=await invitar();await db.prepare('UPDATE invitaciones SET negocios=? WHERE id=?').run(contenido,inv.invitacion.id);const before=await snapshot();assert.equal((await aceptar(inv.token)).status,400);assert.deepEqual(await snapshot(),before);}});
test('Etapa2: aceptación con error en segunda asignación revierte usuario y primera asignación',async()=>{const inv=await invitar();const before=await snapshot();await falloTrigger('usuario_negocio',`IF NEW.negocio_id='${ropa.id}' THEN RAISE EXCEPTION 'Fallo controlado'; END IF;`,async()=>assert.equal((await aceptar(inv.token)).status,500));assert.deepEqual(await snapshot(),before);assert.equal((await aceptar(inv.token)).status,201);});
test('Etapa2: error al marcar invitación usada revierte usuario y todas las asignaciones',async()=>{const inv=await invitar();const before=await snapshot();await falloTrigger('invitaciones',"IF NEW.estado='usada' THEN RAISE EXCEPTION 'Fallo controlado'; END IF;",async()=>assert.equal((await aceptar(inv.token)).status,500));assert.deepEqual(await snapshot(),before);});
test('Etapa2: modificación de nombre y varias asignaciones revierte totalmente si falla una',async()=>{const before=await snapshot();await falloTrigger('usuario_negocio',`IF NEW.negocio_id='${ropa.id}' THEN RAISE EXCEPTION 'Fallo controlado'; END IF;`,async()=>assert.equal((await api(`/usuarios/${soloApple.id}`,admin,'PATCH',{nombre:'No persistir',negocios:asignaciones()})).status,500));assert.deepEqual(await snapshot(),before);});
test('Etapa2: crear empleado y asignaciones es atómico',async()=>{const before=await snapshot();await falloTrigger('usuario_negocio',`IF NEW.negocio_id='${ropa.id}' THEN RAISE EXCEPTION 'Fallo controlado'; END IF;`,async()=>assert.equal((await api('/usuarios',admin,'POST',{email:'fail@stage2.invalid',password:'password-test',negocios:asignaciones()})).status,500));assert.deepEqual(await snapshot(),before);});
test('Etapa2: fallo al invalidar enlace anterior revierte regeneración y mantiene enlace original',async()=>{const inv=await invitar();const before=await snapshot();await falloTrigger('invitaciones',"IF NEW.estado='revocada' THEN RAISE EXCEPTION 'Fallo controlado'; END IF;",async()=>assert.equal((await api(`/invitaciones/${inv.invitacion.id}/regenerar`,admin,'POST')).status,500));assert.deepEqual(await snapshot(),before);assert.equal((await consultar(inv.token)).status,200);});
test('Etapa2: listado presenta los cuatro estados sin hashes ni tokens legacy',async()=>{const r=await api('/invitaciones');assert.equal(r.status,200);for(const estado of ['pendiente','usada','revocada','vencida'])assert.ok(r.body.some(i=>i.estado===estado));assert.ok(r.body.every(i=>!('token' in i)&&!('token_hash' in i)));});
for(const [label,target,data] of [['modificar admin',admin,{nombre:'No'}],['desactivar admin',admin,{activo:0}],['cambiar privilegios admin',admin,{negocios:[]}],['elevar su rol',manager,{rol:'administrador'}],['aumentar permisos propios',manager,{negocios:asignaciones()}],['asignarse otro negocio',manager,{negocios:[{negocio_id:reparaciones.id,permisos:{'clientes.ver':true}}]}]])test('Etapa2: empleados.gestionar no permite '+label,async()=>{const before=await snapshot();assert.equal((await api(`/usuarios/${target.id}`,manager,'PATCH',data)).status,403);assert.deepEqual(await snapshot(),before);});
test('Etapa2: manager no puede delegar permisos que no posee ni negocios fuera de scope',async()=>{for(const negocios of [asignaciones(),[{negocio_id:apple.id,permisos:{'pagos.registrar':true}}]]){const before=await snapshot();assert.equal((await api(`/usuarios/${soloApple.id}`,manager,'PATCH',{negocios})).status,403);assert.deepEqual(await snapshot(),before);}});
test('Etapa2: manager puede gestionar empleado bajo su scope sin administrar otros',async()=>{assert.equal((await api(`/usuarios/${soloApple.id}`,manager,'PATCH',{nombre:'Gestionado',negocios:[{negocio_id:apple.id,permisos:{'clientes.ver':true}}]})).status,200);const listed=(await api('/usuarios',manager)).body;assert.ok(listed.some(u=>u.id===soloApple.id));assert.ok(!listed.some(u=>[manager.id,admin.id].includes(u.id)));assert.equal((await api('/invitaciones',manager,'POST',{email:'no@stage2.invalid',negocios:asignaciones()})).status,403);assert.equal((await api('/auth/registro',manager,'POST',{email:'no@stage2.invalid',password:'password-test'})).status,403);});
test('Etapa2: empleado sin gestión no lista ni modifica empleados o invitaciones',async()=>{for(const path of ['/usuarios','/invitaciones',`/usuarios/${admin.id}`])assert.equal((await api(path,soloApple)).status,403);});
test('Etapa2: credenciales de Apple no habilitan pagos en Indumentaria ni acceso a Reparaciones',async()=>{
 const inv=await invitar(), r=await aceptar(inv.token), token=r.body.token;assert.equal(r.status,201);
 assert.deepEqual((await api('/negocios',token)).body.map(n=>n.id).sort(),[apple.id,ropa.id].sort());
 assert.equal((await api(`/clientes?negocio_id=${ropa.id}`,token)).status,200);
 assert.equal((await api(`/clientes?negocio_id=${reparaciones.id}`,token)).status,403);
 for(const n of [apple,ropa]) {
  const cliente=await crearCliente({nombre:'Prueba',apellido:n.nombre,negocio_id:n.id});
  const venta=await crearVenta({negocio_id:n.id,cliente_id:cliente.id,modalidad:'unico',monto_total_centavos:10000,plan:{fecha_limite:'2099-01-01'}});
  const pago=await api(`/pagos?negocio_id=${n.id}`,token,'POST',{credito_id:venta.credito.id,monto_centavos:100});
  assert.equal(pago.status,n.id===apple.id?201:403);
  if(n.id===ropa.id)assert.equal((await api(`/pagos?negocio_id=${apple.id}`,token,'POST',{credito_id:venta.credito.id,monto_centavos:100})).status,403);
 }
});
test('Etapa2: editar asignaciones surte efecto en JWT existente y desactivar quita acceso',async()=>{const inv=await invitar(),r=await aceptar(inv.token),id=r.body.usuario.id,token=r.body.token;
 assert.equal((await api(`/usuarios/${id}`,admin,'PATCH',{negocios:[{negocio_id:ropa.id,permisos:{'productos.ver':true}}]})).status,200);
 assert.equal((await api(`/clientes?negocio_id=${apple.id}`,token)).status,403);assert.equal((await api(`/productos?negocio_id=${ropa.id}`,token)).status,200);
 assert.equal((await api(`/usuarios/${id}`,admin,'PATCH',{activo:0})).status,200);assert.equal((await api('/auth/yo',token)).status,401);assert.equal((await api('/auth/login',null,'POST',{email:inv.invitacion.email,password:'segura-prueba-123'})).status,403);
 assert.equal((await api(`/usuarios/${id}`,admin,'PATCH',{activo:1})).status,200);assert.equal((await api('/auth/yo',token)).status,200);
});
test('Etapa2: admin conserva todos los negocios y permisos sin asignaciones',async()=>{assert.equal((await api('/negocios')).body.length,3);for(const n of [apple,ropa,reparaciones]){assert.equal((await api(`/dashboard/resumen?negocio_id=${n.id}`)).status,200);assert.equal((await api(`/usuarios/${soloApple.id}`,admin,'PATCH',{negocios:[{negocio_id:n.id,permisos:Object.fromEntries(PERMISOS.map(p=>[p,true]))}]})).status,200);}});
test('Etapa2: no se acepta rol ni privilegios en aceptación pública',async()=>{const inv=await invitar();const before=await snapshot();assert.equal((await aceptar(inv.token,{rol:'administrador'})).status,400);assert.equal((await aceptar(inv.token,{negocios:asignaciones()})).status,400);assert.deepEqual(await snapshot(),before);});
test('Etapa2: validación de email, nombre y contraseña falla sin mutaciones',async()=>{for(const email of ['no-email',{},'a b@c.test'])assert.equal((await api('/invitaciones',admin,'POST',{email,negocios:asignaciones()})).status,400);const inv=await invitar();const before=await snapshot();for(const password of ['123',{},'a'.repeat(73)])assert.equal((await aceptar(inv.token,{password})).status,400);assert.equal((await aceptar(inv.token,{nombre:{}})).status,400);assert.deepEqual(await snapshot(),before);});
test('Etapa2 email: transporte Resend recibe destinatario, enlace codificado, texto y HTML escapado',async()=>{let sent;const s=crearServicioEmail({client:{emails:{send:async data=>{sent=data;return {data:{id:'mock-id'}};}}},baseURL:'https://zilky.example/app/',from:'Zilky <equipo@example.com>'});assert.equal(s.isEmailConfigured(),true);assert.deepEqual(await s.enviarInvitacionEmail({email:'empleado@example.com',nombre:'<img src=x onerror=evil()>',token:'token&secreto'}),{messageId:'mock-id'});assert.equal(sent.to,'empleado@example.com');assert.match(sent.html,/&lt;img/);assert.ok(!sent.html.includes('<img'));assert.match(sent.text,/https:\/\/zilky.example\/app\/\?token=token%26secreto/);assert.match(sent.text,/7 días/);});
test('Etapa2 email: error del proveedor no revela su contenido',async()=>{for(const send of [async()=>({error:{message:'RESEND_API_KEY=secreto'}}),async()=>{throw new Error('RESEND_API_KEY=secreto');}]){const s=crearServicioEmail({client:{emails:{send}},baseURL:'https://zilky.example'});await assert.rejects(()=>s.enviarInvitacionEmail({email:'a@b.test',token:'secret-token'}),e=>e.message==='No se pudo enviar el email de invitación');}});
test('Etapa2 email: sin credenciales o URL segura no intenta enviar',async()=>{for(const baseURL of ['', 'javascript:alert(1)','https://user:pass@example.com']){const s=crearServicioEmail({client:{emails:{send:()=>assert.fail('No enviar')}},baseURL});assert.equal(s.isEmailConfigured(),false);await assert.rejects(()=>s.enviarInvitacionEmail({}));}assert.equal(crearServicioEmail({baseURL:'https://zilky.example'}).isEmailConfigured(),false);});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();});

test('Etapa2: empleado con gestión tampoco lista, revoca ni regenera invitaciones',async()=>{
 const inv=await invitar();const before=await snapshot();
 for(const [path,method] of [['/invitaciones','GET'],[`/invitaciones/${inv.invitacion.id}/revocar`,'POST'],[`/invitaciones/${inv.invitacion.id}/regenerar`,'POST']]) assert.equal((await api(path,manager,method)).status,403);
 assert.deepEqual(await snapshot(),before);
});
test('Etapa2: fallo de validación al regenerar no cambia ni reemplaza invitación',async()=>{
 const inv=await invitar();await db.prepare('UPDATE invitaciones SET negocios=? WHERE id=?').run(JSON.stringify([{negocio_id:'inexistente',permisos:{}}]),inv.invitacion.id);
 const before=await snapshot();assert.equal((await api(`/invitaciones/${inv.invitacion.id}/regenerar`,admin,'POST')).status,400);assert.deepEqual(await snapshot(),before);
});
