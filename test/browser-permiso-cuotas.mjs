// E2E de permisos por negocio; setup-env exige PostgreSQL local descartable.
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {app} from '../src/app.js';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearUsuario,asignarNegocio} from '../src/repositories/usuarios.js';
import {crearNegocio} from '../src/repositories/negocios.js';
import {crearCliente} from '../src/repositories/clientes.js';
import {crearProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {todayAR,addDays,addMonths} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-permiso-cuotas-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[],correctionRequests=[];
const startedAt=new Date().toISOString();
let server,browser,adminPage,employeePage,failed,approvedPayload;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
const fmt=value=>value.split('-').reverse().join('/');

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-local-permiso-cuotas-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-permiso-cuotas@browser.invalid',nombre:'Jefe ficticio QA',password_hash});
  const employee=await crearUsuario({email:'empleado-permiso-cuotas@browser.invalid',nombre:'Empleado ficticio QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares ficticios QA',mora_valor:0});
  const otherStore=await crearNegocio({nombre:'Indumentaria ficticia QA',mora_valor:0});
  const permissions={'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true,'ventas.crear':true,'pagos.registrar':true};
  await asignarNegocio(employee.id,store.id,permissions);await asignarNegocio(employee.id,otherStore.id,permissions);
  const client=await crearCliente({nombre:'Cliente ficticio',apellido:'Permisos de cuotas QA',negocio_id:store.id});
  const today=todayAR(),current=today.slice(0,7)+'-16',newDue=addMonths(current,1),firstDue=addMonths(current,-1),purchase=addDays(today,-90);
  const product=await crearProducto({negocio_id:store.id,nombre:'iPhone ficticio QA',stock:8});
  const otherProduct=await crearProducto({negocio_id:otherStore.id,nombre:'Campera ficticia QA',stock:11});
  const sale=await crearVenta({negocio_id:store.id,cliente_id:client.id,usuario_id:admin.id,fecha:purchase,modalidad:'cuotas',
    monto_total_centavos:35000000,entrega_inicial_centavos:5000000,
    items:[{producto_id:product.id,cantidad:1,precio_unitario_centavos:35000000}],
    plan:{cantidad_cuotas:3,valor_cuota_centavos:10000000,fecha_primera_cuota:firstDue}});
  const [settled,partial,pending]=sale.cuotas;
  await db.prepare('UPDATE cuotas SET fecha_vencimiento=? WHERE id=?').run(addMonths(current,2),pending.id);
  await registrarPago({credito_id:sale.credito.id,cuota_id:settled.id,monto_centavos:10000000,fecha_hora:`${addDays(today,-45)}T12:00:00-03:00`,usuario_id:admin.id});
  await registrarPago({credito_id:sale.credito.id,cuota_id:partial.id,monto_centavos:2000000,fecha_hora:`${addDays(today,-5)}T12:00:00-03:00`,usuario_id:admin.id});
  const other=await crearVenta({negocio_id:otherStore.id,cliente_id:client.id,usuario_id:admin.id,fecha:purchase,modalidad:'cuotas',monto_total_centavos:30000000,
    items:[{producto_id:otherProduct.id,cantidad:1,precio_unitario_centavos:30000000}],
    plan:{cantidad_cuotas:3,valor_cuota_centavos:10000000,fecha_primera_cuota:firstDue}});
  const creditRows=(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE credito_id=? ORDER BY id`).all(id);
  const finances=async()=>({pagos:await db.prepare('SELECT * FROM pagos ORDER BY id').all(),comprobantes:await db.prepare('SELECT * FROM comprobantes ORDER BY id').all(),
    aplicaciones:await db.prepare('SELECT * FROM pago_aplicaciones ORDER BY id').all(),productos:await db.prepare('SELECT * FROM productos ORDER BY id').all(),
    stock:await db.prepare('SELECT * FROM producto_historial ORDER BY id').all(),saldoFavor:await db.prepare('SELECT * FROM saldo_favor ORDER BY cliente_id,negocio_id').all()});
  const otherSnapshot=async()=>({venta:await db.prepare('SELECT * FROM ventas WHERE id=?').get(other.venta.id),credito:await db.prepare('SELECT * FROM creditos WHERE id=?').get(other.credito.id),cuotas:await creditRows('cuotas',other.credito.id)});
  const originalFinance=await finances(),originalOther=await otherSnapshot();
  const originalSettled=await db.prepare('SELECT * FROM cuotas WHERE id=?').get(settled.id);
  const originalCredit=await db.prepare('SELECT * FROM creditos WHERE id=?').get(sale.credito.id);

  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const restrict=async context=>{
    await context.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin===base)return route.continue();externalRequestsBlocked.push(url);return route.abort('blockedbyclient');});
    context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  };
  const adminContext=await browser.newContext({viewport:{width:1440,height:1050},locale:'es-AR',colorScheme:'dark',serviceWorkers:'block'});
  const employeeContext=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',colorScheme:'dark',serviceWorkers:'block'});
  await restrict(adminContext);await restrict(employeeContext);
  adminPage=await adminContext.newPage();employeePage=await employeeContext.newPage();
  for(const page of [adminPage,employeePage])page.setDefaultTimeout(15000);
  employeePage.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname.endsWith('/correccion'))correctionRequests.push(request.postDataJSON());});
  const login=async(page,email)=>{
    await page.goto(base);await page.locator('#authEmail').fill(email);await page.locator('#authPassword').fill(password);await page.locator('#authSubmit').click();await page.locator('#root').waitFor({state:'visible'});
  };
  const clientPage=async page=>{await page.evaluate(id=>{location.hash=`#/clientes/${id}`;},client.id);await page.locator('.credito-card').first().waitFor();};
  const chooseStore=async(page,id)=>{
    await page.locator('#btnNegocioSwitch').click();await page.locator(`[data-action="elegir-negocio"][data-id="${id||''}"]`).click();await page.locator('#activeSheet').waitFor({state:'detached'});await page.waitForLoadState('networkidle');
  };
  const row=id=>employeePage.locator(`#corCuotas > [data-id="${id}"]`);
  const editQuota=()=>employeePage.locator(`[data-action="corregir-financiacion"][data-cuota="${partial.id}"]`);
  const targetCard=()=>employeePage.locator('.credito-card').filter({has:employeePage.locator(`[data-credito="${sale.credito.id}"]`)});
  const capture=async(name,page=employeePage)=>{
    await page.waitForFunction(()=>!document.querySelector('.toast'));
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:!await page.locator('#activeSheet').count()});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
    if(await page.locator('#activeSheet').count())assert.equal(await page.locator('#activeSheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Desborde del modal: '+name);
  };
  const direct=async(page,credit,negocio,method='GET',body)=>page.evaluate(async input=>{
    const response=await fetch(`/api/ventas/creditos/${encodeURIComponent(input.credit)}/correccion?negocio_id=${encodeURIComponent(input.negocio)}`,{method:input.method,
      headers:{Authorization:'Bearer '+localStorage.getItem('zilky_token'),'Content-Type':'application/json'},...(input.body?{body:JSON.stringify(input.body)}:{})});
    return {status:response.status,body:await response.json()};
  },{credit,negocio,method,body});
  const permissionCheckbox=()=>adminPage.locator(`.edit-permiso-check[data-negocio="${store.id}"][data-permiso="cuotas.editar"]`);
  const changePermission=async enabled=>{
    await adminPage.locator(`[data-action="editar-empleado"][data-id="${employee.id}"]`).click();await permissionCheckbox().waitFor();
    assert.equal(await adminPage.locator(`.edit-permiso-check[data-negocio="${store.id}"][data-permiso="clientes.ver"]`).isChecked(),true);
    await permissionCheckbox().setChecked(enabled);
    const response=adminPage.waitForResponse(r=>new URL(r.url()).pathname===`/api/usuarios/${employee.id}`&&r.request().method()==='PATCH');
    await adminPage.locator('[data-action="guardar-empleado"]').click();const r=await response;assert.equal(r.status(),200,JSON.stringify(await r.json()));await adminPage.locator('#activeSheet').waitFor({state:'detached'});
  };

  await check('Antes de otorgar el permiso, editar clientes o vender no habilita editar cuotas',async()=>{
    await login(employeePage,employee.email);await clientPage(employeePage);
    assert.equal(await employeePage.locator('[data-action="corregir-financiacion"]').count(),0);
    assert.equal((await direct(employeePage,sale.credito.id,store.id)).status,403);
    await login(adminPage,admin.email);await adminPage.locator('.nav-item[data-route="mas"]').click();await adminPage.locator('#view a[href="#/empleados"]').click();
    await adminPage.locator(`[data-action="editar-empleado"][data-id="${employee.id}"]`).waitFor();
  });

  await check('Más → Empleados: el jefe puede otorgar Editar cuotas únicamente para un negocio',async()=>{
    await adminPage.locator(`[data-action="editar-empleado"][data-id="${employee.id}"]`).click();await permissionCheckbox().waitFor();
    assert.match(await permissionCheckbox().locator('xpath=parent::label').innerText(),/Editar cuotas/);
    assert.equal(await permissionCheckbox().isChecked(),false);
    assert.equal(await adminPage.locator(`.edit-permiso-check[data-negocio="${otherStore.id}"][data-permiso="cuotas.editar"]`).isChecked(),false);
    await permissionCheckbox().check();await capture('01-permiso-cuotas-jefe-escritorio',adminPage);
    await adminPage.locator('#activeSheet [data-action="cerrar-sheet"]').click();await changePermission(true);
    const assignments=await db.prepare('SELECT * FROM usuario_negocio WHERE usuario_id=?').all(employee.id);
    assert.equal(JSON.parse(assignments.find(a=>a.negocio_id===store.id).permisos)['cuotas.editar'],true);
    assert.equal(JSON.parse(assignments.find(a=>a.negocio_id===otherStore.id).permisos)['cuotas.editar'],false);
  });

  await check('Empleado recarga: editor limitado a cuotas existentes, con cuota saldada protegida y sin campos de compra o eliminación',async()=>{
    await employeePage.reload();await editQuota().waitFor();await editQuota().click();await employeePage.locator('#corCuotas').waitFor();
    assert.equal(await employeePage.locator('#activeSheet .sheet-title').innerText(),'Editar cuotas');
    assert.equal(await employeePage.locator('#corTotal,#corEntrega,#corFecha,#corFechaEntrega,#corProducto,#corCondiciones,#corAgregar,.corQuitar').count(),0);
    assert.equal(await employeePage.locator('#corCuotas > [data-id]').count(),3);
    assert.equal(await row(settled.id).locator('.corMonto').isDisabled(),true);assert.equal(await row(settled.id).locator('.corVence').isDisabled(),true);
    assert.equal(await row(partial.id).locator('.corMonto').isEnabled(),true);assert.equal(await row(partial.id).locator('.corVence').isEnabled(),true);
    assert.equal(await row(partial.id).locator('.corVence').inputValue(),current);
    assert.equal(await employeePage.locator('[data-action="perdonar-mora"],[data-action="eliminar-venta-error"]').count(),0);
    await capture('02-editor-empleado-limitado-movil');
  });

  await check('Empleado cambia 16 de este mes → 16 del siguiente y redistribuye importes conservando lo ya cobrado',async()=>{
    await row(partial.id).locator('.corVence').fill(newDue);await row(partial.id).locator('.corMonto').fill('110000');await row(pending.id).locator('.corMonto').fill('90000');
    await employeePage.locator('#corMotivo').fill('QA: corregir vencimiento e importes cargados por error');await employeePage.locator('#corConfirmar').check();
    const response=employeePage.waitForResponse(r=>new URL(r.url()).pathname===`/api/ventas/creditos/${sale.credito.id}/correccion`&&r.request().method()==='PATCH');
    await employeePage.locator('#corGuardar').click();const r=await response;assert.equal(r.status(),200,JSON.stringify(await r.json()));
    await employeePage.locator('#activeSheet').waitFor({state:'detached'});assert.equal(correctionRequests.length,1);approvedPayload=correctionRequests[0];
    assert.deepEqual(Object.keys(approvedPayload.datos),['cuotas'],'El empleado sólo debe enviar cambios del plan');
    await employeePage.reload();await editQuota().waitFor();await editQuota().click();await employeePage.locator('#corCuotas').waitFor();
    assert.equal(await row(partial.id).locator('.corVence').inputValue(),newDue);assert.equal(await row(partial.id).locator('.corMonto').inputValue(),'110000');
    assert.equal(await row(pending.id).locator('.corMonto').inputValue(),'90000');
    const saved=await db.prepare('SELECT * FROM cuotas WHERE id=?').get(partial.id);assert.equal(saved.fecha_vencimiento,newDue);assert.equal(saved.monto_centavos,11000000);assert.equal(saved.saldo_pendiente_centavos,9000000);
    const logs=await db.prepare("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion'").all(sale.credito.id);
    assert.equal(logs.length,1);assert.equal(logs[0].empleado,employee.id);assert.equal(logs[0].motivo,approvedPayload.motivo);
    await employeePage.setViewportSize({width:1440,height:1050});await capture('03-editor-corregido-empleado-escritorio');
    await employeePage.locator('#activeSheet [data-action="cerrar-sheet"]').click();await employeePage.setViewportSize({width:390,height:844});
  });

  await check('El permiso de una tienda no habilita controles ni API de corrección de la otra',async()=>{
    await chooseStore(employeePage,otherStore.id);await clientPage(employeePage);
    assert.equal(await employeePage.locator('.credito-card').count(),1);assert.equal(await employeePage.locator('[data-action="corregir-financiacion"]').count(),0);
    assert.equal((await direct(employeePage,other.credito.id,otherStore.id)).status,403);
    assert.equal((await direct(employeePage,other.credito.id,otherStore.id,'PATCH',{...approvedPayload,negocio_id:otherStore.id})).status,403);
    await capture('04-otra-tienda-sin-permiso-movil');
    await chooseStore(employeePage,store.id);await clientPage(employeePage);await editQuota().click();await employeePage.locator('#corCuotas').waitFor();
  });

  await check('Revocar impide guardar incluso con el editor abierto; tras recargar desaparecen los controles y API devuelve 403',async()=>{
    await changePermission(false);
    await row(partial.id).locator('.corVence').fill(addDays(newDue,1));await employeePage.locator('#corMotivo').fill('QA: intento con permiso revocado');await employeePage.locator('#corConfirmar').check();
    const response=employeePage.waitForResponse(r=>new URL(r.url()).pathname===`/api/ventas/creditos/${sale.credito.id}/correccion`&&r.request().method()==='PATCH');
    await employeePage.locator('#corGuardar').click();assert.equal((await response).status(),403);
    assert.equal((await db.prepare('SELECT * FROM cuotas WHERE id=?').get(partial.id)).fecha_vencimiento,newDue);
    await employeePage.reload();await employeePage.locator('.credito-card').first().waitFor();
    assert.equal(await employeePage.locator('[data-action="corregir-financiacion"]').count(),0);
    assert.equal((await direct(employeePage,sale.credito.id,store.id)).status,403);
    assert.equal((await direct(employeePage,sale.credito.id,store.id,'PATCH',approvedPayload)).status,403);
    assert.match(await targetCard().innerText(),new RegExp(fmt(newDue)));
    await capture('05-permiso-revocado-empleado-movil');
  });

  await check('Pagos, comprobantes, stock, cuota saldada, venta original y otra tienda conservan sus datos',async()=>{
    assert.deepEqual(await finances(),originalFinance);assert.deepEqual(await otherSnapshot(),originalOther);
    assert.deepEqual(await db.prepare('SELECT * FROM cuotas WHERE id=?').get(settled.id),originalSettled);
    const credit=await db.prepare('SELECT * FROM creditos WHERE id=?').get(sale.credito.id);
    for(const key of ['monto_total_centavos','entrega_inicial_centavos','saldo_financiado_centavos','fecha_inicio','fecha_entrega_producto','producto_descripcion','condiciones'])assert.equal(credit[key],originalCredit[key],key);
    assert.equal((await db.prepare("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion'").all(sale.credito.id)).length,1);
    assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  });
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
} catch(error) {
  failed=error;const page=employeePage||adminPage;if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
} finally {
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,correctionRequests,
    externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
