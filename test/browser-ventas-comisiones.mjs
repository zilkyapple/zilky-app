// End-to-end check against disposable local PostgreSQL only (setup-env enforces it).
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {app} from '../src/app.js';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearUsuario} from '../src/repositories/usuarios.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearProducto,getProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';
import {configurarComision,configurarProductoComision} from '../src/services/comisionesService.js';
import {configurarVisibilidad} from '../src/services/comisionReglasService.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const password='disposable-browser-test-123';
const admin=await crearUsuario({email:'owner@browser.invalid',nombre:'Dueño QA',password_hash:await bcrypt.hash(password,10)});
const lucas=await crearUsuario({email:'lucas@browser.invalid',nombre:'Lucas QA',rol:'empleado',password_hash:await bcrypt.hash(password,10)});
const n=await crearNegocio({nombre:'Tienda QA'}),c=await crearCliente({nombre:'Cliente',apellido:'Prueba',negocio_id:n.id});
await db.prepare('INSERT INTO usuario_negocio(usuario_id,negocio_id,permisos,activo) VALUES(?,?,?,1)').run(lucas.id,n.id,JSON.stringify({'ventas.crear':true,'clientes.ver':true,'productos.ver':true}));
const jean=await crearProducto({nombre:'Jean clásico',categoria:'Indumentaria',stock:20,precio_contado_centavos:4500000,precio_financiado_centavos:4800000,negocio_id:n.id});
const remera=await crearProducto({nombre:'Remera algodón',categoria:'Indumentaria',stock:40,precio_contado_centavos:1800000,precio_financiado_centavos:2100000,negocio_id:n.id});
await configurarComision(n.id,{activa:true,momento:'venta',visible_empleado:false},admin.id);
await configurarProductoComision(n.id,jean.id,{tipo:'fijo',valor:250000},admin.id);
await configurarProductoComision(n.id,remera.id,{tipo:'fijo',valor:150000},admin.id);
await configurarVisibilidad(n.id,lucas.id,{modo:'cierre',ver_total:true,ver_detalle:false,ver_historial:false,venta_manual:false},admin.id);
// A previous month operation for the month-end approval workflow.
await crearVenta({negocio_id:n.id,cliente_id:c.id,usuario_id:admin.id,comision_usuario_id:lucas.id,solicitud_id:randomUUID(),fecha:'2026-08-10',modalidad:'unico',monto_total_centavos:4500000,entrega_inicial_centavos:4500000,items:[{producto_id:jean.id,cantidad:1,precio_unitario_centavos:4500000}]});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-sales-browser';await fs.mkdir(output,{recursive:true});
const errors=[],results=[];
const page=await browser.newPage({viewport:{width:1440,height:1050},colorScheme:'dark'});
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
const login=async(p,email)=>{await p.goto(base);await p.locator('#authEmail').fill(email);await p.locator('#authPassword').fill(password);await p.locator('#authSubmit').click();await p.locator('#root').waitFor({state:'visible'});await p.locator('#negocioNombre').waitFor();await p.locator('.negocio-switch').click();await p.locator(`[data-action="elegir-negocio"][data-id="${n.id}"]`).click();await p.locator('#activeSheet').waitFor({state:'detached'});};
const route=async(p,hash,selector)=>{await p.evaluate(h=>{location.hash=h;},hash);await p.locator(selector).waitFor();};
const capture=async(name)=>{await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Horizontal overflow: '+name);};
try{
 await check('Administrator registers a multi-product cash sale in one screen',async()=>{
  await login(page,admin.email);await route(page,'#/ventas/nueva','#vAgregar');await page.locator('#vVendedor').selectOption(lucas.id);
  await page.locator('#vProducto').selectOption(jean.id);await page.locator('#vAgregar').click();await page.locator('#vProducto').selectOption(remera.id);await page.locator('#vCantidad').fill('2');await page.locator('#vAgregar').click();assert.equal(await page.locator('#vMontoTotal').inputValue(),'81000');
  await capture('venta-escritorio-oscuro');await page.setViewportSize({width:390,height:844});await capture('venta-movil-oscuro');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/ventas')&&r.request().method()==='POST');await page.locator('#btnCrearVenta').click();const r=await response;assert.equal(r.status(),201);const sale=await r.json();assert.equal(sale.cuotas.length,0);assert.equal((await getProducto(jean.id)).stock,18);assert.equal((await getProducto(remera.id)).stock,38);assert.equal((await db.prepare('SELECT total_centavos FROM comision_acuerdos WHERE venta_id=?').get(sale.venta.id)).total_centavos,550000);await page.locator('#saleList').waitFor();
 });
 await check('History records a controlled return without deleting the cash receipt',async()=>{
  await page.locator('[data-sale]').first().click();await page.locator('#saleReturn').waitFor();await page.locator('[data-return]').first().fill('1');await page.locator('#saleReturn textarea').fill('Prueba de devolución controlada');
  const response=page.waitForResponse(r=>r.url().includes('/devoluciones')&&r.request().method()==='POST');await page.locator('#saleReturn button[type=submit], #saleReturn button:not([type])').click();assert.equal((await response).status(),200);await page.locator('#saleDetail .cm-agreement').waitFor();assert.match(await page.locator('#saleDetail').innerText(),/Reintegro pendiente en esta venta/);await capture('historial-movil');
 });
 await check('Commission summaries and settings adapt to desktop, tablet, mobile and light mode',async()=>{
  await route(page,'#/comisiones','.commissions');await page.setViewportSize({width:1440,height:1050});await capture('comisiones-escritorio-oscuro');await page.setViewportSize({width:834,height:1112});await capture('comisiones-tablet-oscuro');await page.setViewportSize({width:390,height:844});await capture('comisiones-movil-oscuro');
  await page.emulateMedia({colorScheme:'light'});await capture('comisiones-movil-claro');assert.equal(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--surface').trim()),'#fff');
  await page.setViewportSize({width:1440,height:1050});await capture('comisiones-escritorio-claro');await page.locator('[data-tab="configuracion"]').click();await page.locator('#cmConfig').waitFor();await capture('configuracion-escritorio-claro');await page.setViewportSize({width:390,height:844});await capture('configuracion-movil-claro');
 });
 await check('Administrator reviews, approves, publishes and partially pays a monthly close',async()=>{
  await page.locator('[data-tab="cierres"]').click();await page.locator('#cmReview select').selectOption(lucas.id);await page.locator('#cmReview input').fill('2026-08');await page.locator('#cmReview button').click();await page.locator('#cmApprove').click();await page.locator('[data-publish]').waitFor();await page.locator('[data-publish]').click();await page.locator('.cm-close .badge-pagada').waitFor();
  await page.locator('[data-close-pay]').click();await page.locator('#cmPay [name=importe]').fill('1000');await page.locator('#cmPay form button').first().click();await page.locator('#cmPay form').waitFor({state:'detached'});await capture('liquidacion-movil-claro');
  const close=await db.prepare('SELECT * FROM comision_cierres WHERE usuario_id=?').get(lucas.id);assert.equal(close.estado,'publicada');assert.equal(Number((await db.prepare('SELECT sum(importe_centavos) amount FROM comision_liquidaciones WHERE cierre_id=?').get(close.id)).amount),100000);
 });
 await check('Employee sees only the published total and can still record sales',async()=>{
  const employee=await browser.newPage({viewport:{width:390,height:844},colorScheme:'dark'});employee.on('pageerror',e=>errors.push(e.message));
  await login(employee,lucas.email);await route(employee,'#/comisiones','.commissions');assert.equal(await employee.locator('.cm-kpis,#cmRange,[data-tab],#cmConfig').count(),0);assert.match(await employee.locator('.commissions').innerText(),/Liquidaciones publicadas/);assert.doesNotMatch(await employee.locator('.commissions').innerText(),/Jean clásico|Remera algodón|Generada en el período/);
  await employee.screenshot({path:path.join(output,'lucas-total-publicado.png'),fullPage:true});await route(employee,'#/ventas/nueva','#vAgregar');assert.equal(await employee.locator('.sale-manual,#vVendedor').count(),0);assert.doesNotMatch(await employee.locator('#vForm').innerText(),/comisión/i);await employee.close();
 });
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({results,javascriptErrors:errors},null,2));console.log(`${results.length} E2E checks passed`);
}catch(error){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true});await fs.writeFile(path.join(output,'fallo.html'),await page.content());throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await pool.end();}
