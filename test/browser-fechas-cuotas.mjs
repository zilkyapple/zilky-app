// E2E real de las correcciones, exclusivamente sobre PostgreSQL local descartable.
// setup-env rechaza URLs no locales o nombres sin el sufijo _test antes de migrar.
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {app} from '../src/app.js';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearUsuario,asignarNegocio} from '../src/repositories/usuarios.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {agregarIncidencia} from '../src/services/incidenciasService.js';
import {todayAR,addDays} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-fechas-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[];
let server,browser,context,page,failed;
const startedAt=new Date().toISOString();
const check=async(name,fn)=>{
  try {await fn();results.push({name,passed:true});console.log('PASS '+name);}
  catch(error){results.push({name,passed:false,error:error.message});throw error;}
};
const fmt=fecha=>fecha.split('-').reverse().join('/');

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='qa-local-disposable-123';
  const password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-fechas@browser.invalid',nombre:'Administración QA',password_hash});
  const employee=await crearUsuario({email:'empleado-fechas@browser.invalid',nombre:'Empleado QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares QA',mora_valor:0});
  const otherStore=await crearNegocio({nombre:'Ropa QA',mora_valor:0});
  await asignarNegocio(employee.id,store.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true,'ventas.crear':true});
  const client=await crearCliente({nombre:'Cliente ficticio',apellido:'Correcciones QA',negocio_id:store.id});
  const today=todayAR();
  const originalPurchase=addDays(today,-60),purchase=addDays(today,-61),delivery=addDays(today,-30);
  const due=addDays(today,45),eventDate=addDays(today,-20),correctedEventDate=addDays(today,-19);
  const operation=await crearVenta({
    negocio_id:store.id,cliente_id:client.id,usuario_id:admin.id,fecha:originalPurchase,
    modalidad:'cuotas',monto_total_centavos:300000,
    plan:{cantidad_cuotas:3,valor_cuota_centavos:100000,fecha_primera_cuota:addDays(today,15)},
  });
  const other=await crearVenta({
    negocio_id:otherStore.id,cliente_id:client.id,usuario_id:admin.id,fecha:originalPurchase,
    modalidad:'cuotas',monto_total_centavos:200000,
    plan:{cantidad_cuotas:2,valor_cuota_centavos:100000,fecha_primera_cuota:addDays(today,15)},
  });
  const [settled,partial,pending]=operation.cuotas;
  await registrarPago({credito_id:operation.credito.id,cuota_id:settled.id,monto_centavos:100000,fecha_hora:`${addDays(today,-10)}T12:00:00-03:00`,usuario_id:admin.id});
  await registrarPago({credito_id:operation.credito.id,cuota_id:partial.id,monto_centavos:20000,fecha_hora:`${addDays(today,-5)}T12:00:00-03:00`,usuario_id:admin.id});
  await registrarPago({credito_id:other.credito.id,monto_centavos:7000,fecha_hora:`${today}T12:00:00-03:00`,usuario_id:admin.id});
  const event=await agregarIncidencia({creditoId:operation.credito.id,tipo:'equipo_entregado',fecha:eventDate,clave:`equipo:${randomUUID()}`,motivo:'Entrega voluntaria ficticia QA',usuarioId:admin.id});
  const creditId=operation.credito.id;
  const creditRows=async(table,id=creditId)=>db.prepare(`SELECT * FROM ${table} WHERE credito_id=? ORDER BY id`).all(id);
  const paymentSnapshot=async(id=creditId)=>({
    pagos:await creditRows('pagos',id),
    comprobantes:await creditRows('comprobantes',id),
    aplicaciones:await db.prepare('SELECT pa.* FROM pago_aplicaciones pa JOIN pagos p ON p.id=pa.pago_id WHERE p.credito_id=? ORDER BY pa.id').all(id),
  });
  const otherSnapshot=async()=>({
    venta:await db.prepare('SELECT * FROM ventas WHERE id=?').get(other.venta.id),
    credito:await db.prepare('SELECT * FROM creditos WHERE id=?').get(other.credito.id),
    cuotas:await creditRows('cuotas',other.credito.id),
    incidencias:await creditRows('credito_incidencias',other.credito.id),
    ...await paymentSnapshot(other.credito.id),
  });
  const originalPayments=await paymentSnapshot(),originalOther=await otherSnapshot();
  const originalSettled=await db.prepare('SELECT * FROM cuotas WHERE id=?').get(settled.id);

  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({
    headless:true,
    executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  context=await browser.newContext({viewport:{width:1440,height:1050},locale:'es-AR',colorScheme:'dark',serviceWorkers:'block'});
  // El HTML incluye Google Fonts: se bloquea todo recurso fuera de este servidor.
  await context.route('**/*',route=>{
    const url=route.request().url();
    if(new URL(url).origin===base)return route.continue();
    externalRequestsBlocked.push(url);return route.abort('blockedbyclient');
  });
  context.on('page',p=>{p.on('pageerror',error=>errors.push(error.message));});
  page=await context.newPage();
  page.setDefaultTimeout(15000);
  const card=p=>p.locator('.credito-card').filter({has:p.locator(`[data-credito="${creditId}"]`)});
  const editButton=p=>p.locator(`[data-action="corregir-financiacion"][data-credito="${creditId}"]:not([data-cuota])`);
  const row=(p,id)=>p.locator(`#corCuotas > [data-id="${id}"]`);
  const chooseStore=async(p,id)=>{
    await p.locator('.negocio-switch').click();
    await p.locator(`[data-action="elegir-negocio"][data-id="${id}"]`).click();
    await p.locator('#activeSheet').waitFor({state:'detached'});
    await p.waitForLoadState('networkidle');
  };
  const login=async(p,email)=>{
    await p.goto(base);
    await p.locator('#authEmail').fill(email);
    await p.locator('#authPassword').fill(password);
    await p.locator('#authSubmit').click();
    await p.locator('#root').waitFor({state:'visible'});
    await p.locator('#negocioNombre').waitFor();
    await chooseStore(p,store.id);
  };
  const clientRoute=async p=>{
    await p.evaluate(id=>{location.hash=`#/clientes/${id}`;},client.id);
    await p.locator('.credito-card').first().waitFor();
  };
  const capture=async(name,p=page)=>{
    await p.waitForFunction(()=>!document.querySelector('.toast'));
    await p.screenshot({path:path.join(output,name+'.png'),fullPage:!(await p.locator('#activeSheet').count())});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
    if(await p.locator('#activeSheet').count())assert.equal(await p.locator('#activeSheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Desborde horizontal del editor: '+name);
  };
  const saveCorrection=async()=>{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/ventas/creditos/${creditId}/correccion`&&r.request().method()==='PATCH');
    await page.locator('#corGuardar').click();
    const r=await response;
    assert.equal(r.status(),200,JSON.stringify(await r.json()));
    await page.locator('#activeSheet').waitFor({state:'detached'});
    await editButton(page).waitFor();
  };

  await check('Escritorio: administrador corrige compra y entrega física desde la ficha',async()=>{
    await login(page,admin.email);await clientRoute(page);
    assert.equal(await page.locator('.credito-card').count(),1);
    assert.match(await card(page).innerText(),/Sin fecha registrada/);
    await editButton(page).click();await page.locator('#corFechaEntrega').waitFor();
    assert.equal(await page.locator('#corFecha').inputValue(),originalPurchase);
    await page.locator('#corFecha').fill(purchase);
    await page.locator('#corFechaEntrega').fill(delivery);
    await page.locator('#corMotivo').fill('QA: corregir fecha de compra y retiro del celular');
    await page.locator('#corConfirmar').check();
    await page.locator('#activeSheet').evaluate(el=>{el.scrollTop=0;});
    await capture('01-editor-fechas-escritorio');
    await saveCorrection();
    await page.reload();await editButton(page).waitFor();await chooseStore(page,store.id);
    assert.match(await card(page).innerText(),new RegExp(`Compra: ${fmt(purchase)}`));
    assert.match(await card(page).innerText(),new RegExp(`Entrega / retiro del producto por el cliente: ${fmt(delivery)}`));
    await capture('02-ficha-fechas-escritorio');
  });

  await check('Cuota saldada bloqueada y cuota parcialmente pagada conserva su historial',async()=>{
    await editButton(page).click();await page.locator('#corCuotas').waitFor();
    assert.equal(await row(page,settled.id).locator('.corMonto').isDisabled(),true);
    assert.equal(await row(page,settled.id).locator('.corVence').isDisabled(),true);
    assert.equal(await row(page,settled.id).locator('.corQuitar').isDisabled(),true);
    assert.match(await row(page,settled.id).innerText(),/Saldada/);
    assert.equal(await row(page,partial.id).locator('.corMonto').isEnabled(),true);
    assert.equal(await row(page,partial.id).locator('.corVence').isEnabled(),true);
    assert.equal(await row(page,partial.id).locator('.corQuitar').isDisabled(),true);
    assert.match(await row(page,partial.id).innerText(),/Capital pagado:.*200/);
    await row(page,settled.id).scrollIntoViewIfNeeded();await capture('03-cuota-saldada-protegida-escritorio');
    await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();
    await page.locator('#activeSheet').waitFor({state:'detached'});
  });

  await check('Móvil: atajo Editar cuota corrige importes y vencimiento, y persiste al recargar',async()=>{
    await page.setViewportSize({width:390,height:844});
    await page.locator(`[data-action="corregir-financiacion"][data-cuota="${partial.id}"]`).click();
    await page.locator('#corCuotas').waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.closest('[data-id]')?.dataset.id),partial.id);
    await row(page,partial.id).locator('.corMonto').fill('1100');
    await row(page,partial.id).locator('.corVence').fill(due);
    await row(page,pending.id).locator('.corMonto').fill('900');
    await row(page,partial.id).scrollIntoViewIfNeeded();await capture('04-editor-cuotas-movil');
    await page.locator('#corMotivo').fill('QA: corregir importe y vencimiento mal cargados');
    await page.locator('#corConfirmar').check();await saveCorrection();
    await page.reload();await editButton(page).waitFor();await chooseStore(page,store.id);
    await editButton(page).click();await page.locator('#corCuotas').waitFor();
    assert.equal(await page.locator('#corFecha').inputValue(),purchase);
    assert.equal(await page.locator('#corFechaEntrega').inputValue(),delivery);
    assert.equal(await row(page,partial.id).locator('.corMonto').inputValue(),'1100');
    assert.equal(await row(page,partial.id).locator('.corVence').inputValue(),due);
    assert.equal(await row(page,pending.id).locator('.corMonto').inputValue(),'900');
    assert.equal(await row(page,settled.id).locator('.corMonto').isDisabled(),true);
    await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();
    await page.locator('#activeSheet').waitFor({state:'detached'});
    await card(page).scrollIntoViewIfNeeded();await capture('05-ficha-corregida-movil');
    const changed=await db.prepare('SELECT * FROM cuotas WHERE id=?').get(partial.id);
    assert.equal(changed.monto_centavos,110000);
    assert.equal(changed.saldo_pendiente_centavos,90000);
    assert.equal(changed.fecha_vencimiento,due);
  });

  await check('Móvil: corrección de fecha de entrega de equipo conserva el hecho original',async()=>{
    const button=page.locator(`[data-action="corregir-fecha-incidencia"][data-incidencia="${event.id}"]`);
    await button.locator('xpath=ancestor::details[1]').evaluate(el=>{el.open=true;});
    await button.click();await page.locator('#incCorFecha').waitFor();
    assert.equal(await page.locator('#incCorFecha').inputValue(),eventDate);
    assert.match(await page.locator('#activeSheet').innerText(),/Entrega voluntaria ficticia QA/);
    await page.locator('#incCorFecha').fill(correctedEventDate);
    await page.locator('#incCorMotivo').fill('QA: corregir fecha de entrega voluntaria');
    await capture('06-correccion-incidencia-movil');
    const response=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith(`/incidencias/${event.id}`)&&r.request().method()==='PATCH');
    await page.locator('#incCorGuardar').click();const r=await response;
    assert.equal(r.status(),200,JSON.stringify(await r.json()));
    await page.locator('#activeSheet').waitFor({state:'detached'});
    await page.reload();await editButton(page).waitFor();await chooseStore(page,store.id);
    await button.locator('xpath=ancestor::details[1]').evaluate(el=>{el.open=true;});
    const item=button.locator('xpath=parent::li');
    assert.match(await item.innerText(),new RegExp(fmt(correctedEventDate)));
    assert.match(await item.innerText(),/Entrega voluntaria ficticia QA/);
    const saved=await db.prepare('SELECT * FROM credito_incidencias WHERE id=?').get(event.id);
    assert.deepEqual(saved,{...event,fecha:correctedEventDate});
    await item.scrollIntoViewIfNeeded();await capture('07-incidencia-corregida-movil');
  });

  await check('Pagos, comprobantes, aplicaciones y cuota saldada intactos; otra tienda aislada',async()=>{
    assert.deepEqual(await paymentSnapshot(),originalPayments);
    assert.deepEqual(await db.prepare('SELECT * FROM cuotas WHERE id=?').get(settled.id),originalSettled);
    assert.deepEqual(await otherSnapshot(),originalOther);
    const financingLogs=await db.prepare("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion' ORDER BY fecha_hora").all(creditId);
    assert.equal(financingLogs.length,2);
    assert.equal(financingLogs.every(log=>log.empleado===admin.id&&log.motivo.startsWith('QA:')),true);
    const eventLogs=await db.prepare("SELECT * FROM auditoria WHERE entidad='credito_incidencia' AND entidad_id=? AND accion='corregir_fecha_incidencia'").all(event.id);
    assert.equal(eventLogs.length,1);assert.equal(eventLogs[0].empleado,admin.id);
    await chooseStore(page,otherStore.id);await clientRoute(page);
    assert.equal(await page.locator('.credito-card').count(),1);
    assert.match(await page.locator('.credito-card').innerText(),new RegExp(fmt(originalPurchase)));
    assert.match(await page.locator('.credito-card').innerText(),/Sin fecha registrada/);
    await capture('08-otra-tienda-intacta-movil');
  });

  await check('Empleado autorizado a ver y editar cliente no recibe botones de corrección financiera',async()=>{
    const employeeContext=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',colorScheme:'dark',serviceWorkers:'block'});
    try {
      await employeeContext.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort('blockedbyclient'));
      const employeePage=await employeeContext.newPage();employeePage.on('pageerror',error=>errors.push(error.message));
      await login(employeePage,employee.email);await clientRoute(employeePage);
      assert.equal(await employeePage.locator('.credito-card').count(),1);
      assert.equal(await employeePage.locator('[data-action="corregir-financiacion"], [data-action="corregir-fecha-incidencia"]').count(),0);
      assert.match(await employeePage.locator('.credito-card').innerText(),new RegExp(fmt(delivery)));
      await employeePage.locator('.credito-card').scrollIntoViewIfNeeded();await capture('09-ficha-empleado-movil',employeePage);
    } finally {await employeeContext.close();}
  });
  assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
} catch(error) {
  failed=error;
  if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
} finally {
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  await pool.end();
}
if(failed)throw failed;
