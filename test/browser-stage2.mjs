// Verificación E2E adicional: PostgreSQL descartable y Playwright instalado por separado.
// PLAYWRIGHT_MODULE=/ruta/playwright/index.mjs TEST_DATABASE_URL=postgresql://.../zilky_browser_test node test/browser-stage2.mjs
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
await crearUsuario({email:'admin@browser.invalid',nombre:'Administrador de prueba',password_hash:await bcrypt.hash('test-password-123',10)});
const apple=await crearNegocio({nombre:'Apple'}), ropa=await crearNegocio({nombre:'Indumentaria'});
await crearNegocio({nombre:'Reparaciones'});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
const errors=[],results=[];
const capture=process.env.BROWSER_ARTIFACTS || '/tmp/zilky-stage2-browser';await fs.mkdir(capture,{recursive:true});
const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
let link,id,revocada;
try {
 await check('Login real de administrador y pantalla de empleados',async()=>{
  await page.goto(base);await page.locator('#authEmail').fill('admin@browser.invalid');await page.locator('#authPassword').fill('test-password-123');await page.locator('#authSubmit').click();await page.locator('#root').waitFor({state:'visible'});await page.locator('.kpi-grid').waitFor();await page.goto(base+'/#/empleados');await page.locator('#invEmail').waitFor();
 });
 await check('Invitar desde UI con dos negocios y permisos distintos',async()=>{
  await page.locator('#invEmail').fill('lucas@browser.invalid');await page.locator('#invNombreEmpleado').fill('Lucas');
  for(const n of [apple,ropa]){await page.locator(`.inv-negocio-check[data-id="${n.id}"]`).check();await page.locator(`.inv-permiso-check[data-negocio="${n.id}"][data-permiso="clientes.ver"]`).check();}
  await page.locator(`.inv-permiso-check[data-negocio="${apple.id}"][data-permiso="pagos.registrar"]`).check();
  await page.locator('[data-action="enviar-invitacion"]').click();await page.locator('#invLinkResultado').waitFor();link=await page.locator('#invLinkResultado').inputValue();assert.match(await page.locator('#activeSheet').innerText(),/no está configurado/);
  await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
  const inv=await db.prepare('SELECT * FROM invitaciones WHERE email=?').get('lucas@browser.invalid');id=inv.id;const a=JSON.parse(inv.negocios);assert.equal(a.length,2);assert.equal(a[0].permisos['pagos.registrar'],true);assert.equal(a[1].permisos['pagos.registrar'],false);
 });
 await check('Regeneración desde UI invalida enlace anterior',async()=>{
  const old=link;await page.locator(`[data-action="regenerar-invitacion"][data-id="${id}"]`).click();await page.locator('#invLinkResultado').waitFor();link=await page.locator('#invLinkResultado').inputValue();assert.notEqual(link,old);revocada=id;
  const res=await page.request.post(base+'/api/auth/invitacion/consultar',{data:{token:new URL(old).searchParams.get('token')}});assert.equal(res.status(),410);await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
 });
 const invited=await browser.newPage({viewport:{width:390,height:844}});invited.on('pageerror',e=>errors.push(e.message));
 await check('Aceptación móvil, contraseña y sesión con permisos asignados',async()=>{
  await invited.goto(link);await invited.waitForFunction(()=>!document.getElementById('btnAceptarInvitacion').disabled);assert.match(await invited.locator('#invitacionInfo').innerText(),/lucas@browser.invalid/);
  await invited.screenshot({path:path.join(capture,'invitacion-movil.png'),fullPage:true});
  await invited.locator('#invPassword').fill('employee-password-123');await invited.locator('#invPassword2').fill('employee-password-123');await invited.locator('#btnAceptarInvitacion').click();await invited.locator('#root').waitFor({state:'visible'});await invited.waitForURL('**/#/clientes');assert.ok(await invited.evaluate(()=>localStorage.getItem('zilky_token')));assert.ok(!invited.url().includes('token='));
  const u=await db.prepare('SELECT * FROM usuarios WHERE email=?').get('lucas@browser.invalid');id=u.id;assert.equal(u.rol,'empleado');assert.ok(await bcrypt.compare('employee-password-123',u.password_hash));
 });
 await check('Reutilizar enlace muestra error claro y formulario bloqueado',async()=>{
  const again=await browser.newPage();await again.goto(link);await again.waitForFunction(()=>document.getElementById('invitacionInfo').textContent.includes('utilizada'));assert.equal(await again.locator('#btnAceptarInvitacion').isDisabled(),true);await again.close();
 });
 await check('Editar asignaciones en UI revoca Apple y concede productos en Indumentaria',async()=>{
  await page.reload();await page.locator(`[data-action="editar-empleado"][data-id="${id}"]`).click();await page.locator('.edit-negocio-check').first().waitFor();await page.locator(`.edit-negocio-check[data-id="${apple.id}"]`).uncheck();await page.locator(`.edit-permiso-check[data-negocio="${ropa.id}"][data-permiso="productos.ver"]`).check();await page.locator('[data-action="guardar-empleado"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
  const rows=(await db.query('SELECT * FROM usuario_negocio WHERE usuario_id=$1',[id])).rows;assert.equal(rows.find(n=>n.negocio_id===apple.id).activo,0);assert.equal(JSON.parse(rows.find(n=>n.negocio_id===ropa.id).permisos)['productos.ver'],true);
 });
 await check('Desactivar y reactivar empleado desde UI; JWT pierde acceso al desactivar',async()=>{
  await page.locator(`[data-action="toggle-empleado"][data-id="${id}"]`).click();await page.locator(`[data-action="toggle-empleado"][data-id="${id}"][data-activo="1"]`).waitFor();const token=await invited.evaluate(()=>localStorage.getItem('zilky_token'));assert.equal((await invited.request.get(base+'/api/auth/yo',{headers:{Authorization:'Bearer '+token}})).status(),401);
  await page.locator(`[data-action="toggle-empleado"][data-id="${id}"]`).click();await page.locator(`[data-action="toggle-empleado"][data-id="${id}"][data-activo="0"]`).waitFor();
 });
 await check('Revocar desde UI y comprobar historial con los cuatro estados',async()=>{
  await page.locator('#invEmail').fill('pendiente@browser.invalid');await page.locator(`.inv-negocio-check[data-id="${apple.id}"]`).check();await page.locator('[data-action="enviar-invitacion"]').click();await page.locator('#invLinkResultado').waitFor();const revokeLink=await page.locator('#invLinkResultado').inputValue();await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
  const inv=await db.prepare('SELECT * FROM invitaciones WHERE email=?').get('pendiente@browser.invalid');await page.locator(`[data-action="revocar-invitacion"][data-id="${inv.id}"]`).click();await page.locator(`[data-action="revocar-invitacion"][data-id="${inv.id}"]`).waitFor({state:'detached'});assert.equal((await page.request.post(base+'/api/auth/invitacion/consultar',{data:{token:new URL(revokeLink).searchParams.get('token')}})).status(),410);
  // Fixtures para visualizar vencida y pendiente, sin reloj ni datos de producción.
  const {invitarEmpleado}=await import('../src/services/invitacionesService.js');
  const expired=await invitarEmpleado({email:'vencida@browser.invalid',negocios:[{negocio_id:apple.id,permisos:{'clientes.ver':true}}]});await db.prepare('UPDATE invitaciones SET expira_en=? WHERE id=?').run('2000-01-01',expired.invitacion.id);
  await invitarEmpleado({email:'otra@browser.invalid',negocios:[{negocio_id:ropa.id,permisos:{'clientes.ver':true}}]});await page.reload();
  for(const estado of ['pendiente','revocada','usada','vencida'])await page.locator(`[data-invitacion-estado="${estado}"]`).first().waitFor();
 });
 await check('Frontend escritorio y móvil sin desborde horizontal ni errores JavaScript',async()=>{
  await page.screenshot({path:path.join(capture,'empleados-escritorio.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(capture,'empleados-movil.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 });
 await fs.writeFile(path.join(capture,'resultado.json'),JSON.stringify({passed:results.length,failed:0,results,javascriptErrors:errors},null,2));
 console.log(`${results.length}/${results.length} verificaciones E2E aprobadas`);
} catch(error) { await page.screenshot({path:path.join(capture,'fallo.png'),fullPage:true}); await fs.writeFile(path.join(capture,'fallo.html'),await page.content()); throw error; } finally {await browser.close();await new Promise(resolve=>server.close(resolve));await pool.end();}
