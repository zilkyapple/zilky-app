// E2E con datos ficticios: setup-env rechaza toda base no local o sin sufijo _test.
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
import {crearProducto,getProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {guardarCaja,abrirCaja,cerrarCaja} from '../src/services/cajaService.js';
import {todayAR,addDays} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/workspace/zilky-browser-tools/node_modules/playwright-core/index.mjs');
const output=process.env.BROWSER_ARTIFACTS||'/workspace/zilky-venta-error-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[],postRequests=[];
const startedAt=new Date().toISOString();
let server,browser,page,failed;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-local-venta-error-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-venta-error@browser.invalid',nombre:'Jefe ficticio QA',password_hash});
  const employee=await crearUsuario({email:'empleado-venta-error@browser.invalid',nombre:'Empleado ficticio QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares ficticios QA',mora_valor:0});
  const otherStore=await crearNegocio({nombre:'Indumentaria ficticia QA',mora_valor:0});
  await asignarNegocio(employee.id,store.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true,'ventas.crear':true,'pagos.registrar':true,'comprobantes.anular':true});
  const client=await crearCliente({nombre:'Cliente ficticio',apellido:'Venta duplicada QA',negocio_id:store.id});
  const today=todayAR(),due=addDays(today,30);
  const product=await crearProducto({negocio_id:store.id,nombre:'iPhone ficticio QA',stock:8});
  const otherProduct=await crearProducto({negocio_id:otherStore.id,nombre:'Campera ficticia QA',stock:13});
  const cash=await guardarCaja(null,{nombre:'Caja ficticia QA',activa:true,arqueo:true,modalidad:'negocio',negocios:[store.id]},admin.id);
  const session=await abrirCaja(cash.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
  const baseSale={negocio_id:store.id,cliente_id:client.id,usuario_id:admin.id,fecha:today,modalidad:'unico',monto_total_centavos:10000000,medio_pago_entrega:'efectivo',
    items:[{producto_id:product.id,cantidad:1,precio_unitario_centavos:10000000}],plan:{fecha_limite:due}};
  assert.equal((await getProducto(product.id)).stock,8);
  const real=await crearVenta(baseSale);assert.equal((await getProducto(product.id)).stock,7);
  const duplicate=await crearVenta({...baseSale,entrega_inicial_centavos:2000000});
  await registrarPago({credito_id:duplicate.credito.id,monto_centavos:1000000,fecha_hora:`${today}T10:00:00-03:00`,usuario_id:admin.id});
  assert.equal((await getProducto(product.id)).stock,6);
  const other=await crearVenta({negocio_id:otherStore.id,cliente_id:client.id,usuario_id:admin.id,fecha:today,modalidad:'unico',monto_total_centavos:5000000,
    items:[{producto_id:otherProduct.id,cantidad:1,precio_unitario_centavos:5000000}],plan:{fecha_limite:due}});
  await registrarPago({credito_id:other.credito.id,monto_centavos:300000,fecha_hora:`${today}T10:00:00-03:00`,usuario_id:admin.id});
  await cerrarCaja(session.id,{contado:3000000,notas:'Cierre ficticio QA'},admin.id);
  const creditSnapshot=async sale=>({venta:await db.prepare('SELECT * FROM ventas WHERE id=?').get(sale.venta.id),
    credito:await db.prepare('SELECT * FROM creditos WHERE id=?').get(sale.credito.id),
    items:await db.prepare('SELECT * FROM venta_detalle WHERE venta_id=? ORDER BY id').all(sale.venta.id),
    cuotas:await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY id').all(sale.credito.id),
    pagos:await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(sale.credito.id),
    comprobantes:await db.prepare('SELECT * FROM comprobantes WHERE credito_id=? ORDER BY id').all(sale.credito.id),
    aplicaciones:await db.prepare('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(sale.credito.id),
    devoluciones:await db.prepare('SELECT * FROM venta_devoluciones WHERE venta_id=? ORDER BY id').all(sale.venta.id)});
  const realBefore=await creditSnapshot(real),duplicateBefore=await creditSnapshot(duplicate),otherBefore=await creditSnapshot(other);
  const otherProductBefore=await getProducto(otherProduct.id),walletsBefore=await db.prepare('SELECT * FROM saldo_favor ORDER BY cliente_id,negocio_id').all();
  const closedSessionBefore=await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(session.id);
  const cashRowsBefore=await db.prepare('SELECT * FROM caja_asientos ORDER BY id').all();
  assert.equal(duplicateBefore.pagos.length,2);assert.equal(cashRowsBefore.length,2);
  assert.equal(duplicateBefore.cuotas.reduce((sum,q)=>sum+q.saldo_pendiente_centavos,0),7000000);

  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'es-AR',timezoneId:'UTC',colorScheme:'dark',serviceWorkers:'block'});
  const restrict=async ctx=>{
    await ctx.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin===base)return route.continue();externalRequestsBlocked.push(url);return route.abort('blockedbyclient');});
    ctx.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
  };
  await restrict(context);page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/eliminar-error'))postRequests.push({url:request.url(),body:request.postDataJSON()});});
  const login=async(p,email)=>{
    await p.goto(base);await p.locator('#authEmail').fill(email);await p.locator('#authPassword').fill(password);await p.locator('#authSubmit').click();
    await p.locator('#root').waitFor({state:'visible'});
  };
  const clientPage=async p=>{await p.evaluate(id=>{location.hash=`#/clientes/${id}`;},client.id);await p.locator('.credito-card').first().waitFor();};
  const switchStore=async(id,nombre)=>{
    await page.locator('#btnNegocioSwitch').click();await page.locator(`[data-action="elegir-negocio"][data-id="${id||''}"]`).click();
    await page.locator('#activeSheet').waitFor({state:'detached'});await page.waitForFunction(text=>document.getElementById('negocioNombre').textContent===text,nombre);
    await page.waitForLoadState('networkidle');
  };
  const editor=p=>p.locator('section[data-sale-error]');
  const openClientEditor=async sale=>{
    await page.locator(`[data-action="eliminar-venta-error"][data-venta="${sale.venta.id}"]`).click();
    await editor(page).locator('[data-sale-error-confirm]').waitFor();
  };
  const capture=async(name,p=page)=>{
    await p.waitForFunction(()=>!document.querySelector('.toast'));
    await p.screenshot({path:path.join(output,name+'.png'),fullPage:!await p.locator('#activeSheet').count()});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
    if(await p.locator('#activeSheet').count())assert.equal(await p.locator('#activeSheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Desborde horizontal del editor');
  };

  await check('Desde Todos los negocios: la venta duplicada muestra stock 6 → 7 y los dos pagos que se anularían',async()=>{
    await login(page,admin.email);await clientPage(page);assert.equal(await page.locator('#negocioNombre').innerText(),'Todos los negocios');
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/ventas/${duplicate.venta.id}/eliminar-error`&&r.request().method()==='GET');
    await openClientEditor(duplicate);const r=await response;assert.equal(r.status(),200);const preview=await r.json();
    assert.equal(preview.permitido,true);assert.equal(preview.productos.length,1);
    assert.equal(preview.productos[0].cantidad_reponer,1);assert.equal(preview.productos[0].stock_actual,6);assert.equal(preview.productos[0].stock_despues,7);
    assert.equal(preview.pagos.length,2);assert.equal(preview.total_pagos_centavos,3000000);assert.equal(preview.capital_pendiente_centavos,7000000);
    assert.equal(await page.locator('#ventaErrorMotivo').inputValue(),'Venta cargada dos veces');
    assert.match(await editor(page).innerText(),/6 → 7/);assert.match(await editor(page).innerText(),/Entrega inicial/);assert.match(await editor(page).innerText(),/Pago de cuota/);
    assert.equal(await editor(page).locator('[data-sale-error-payments]').isChecked(),false);
    assert.equal(await page.locator('#activeSheet [data-action="cerrar-sheet"]').isVisible(),true,'Cancelar debe seguir disponible después de cargar la vista previa');
    assert.deepEqual(await creditSnapshot(duplicate),duplicateBefore);assert.equal((await getProducto(product.id)).stock,6);
    await capture('01-preview-desde-cliente-escritorio');
    await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
  });

  await check('El historial ofrece el acceso simple tanto en la lista de ventas como en el detalle',async()=>{
    await switchStore(store.id,store.nombre);await page.evaluate(()=>{location.hash='#/ventas/historial';});await page.locator('#saleList').waitFor();
    await page.locator(`#saleList button[data-sale-error="${duplicate.venta.id}"]`).click();await editor(page).locator('[data-sale-error-confirm]').waitFor();
    assert.equal(await editor(page).getAttribute('data-sale-error'),duplicate.venta.id);
    await page.locator('[data-sale-error-back]').click();await page.locator('#saleDetail .sale-detail h2').waitFor();
    await page.locator(`#saleDetail button[data-sale-error="${duplicate.venta.id}"]`).click();await editor(page).locator('[data-sale-error-confirm]').waitFor();
    assert.equal((await getProducto(product.id)).stock,6);assert.equal(postRequests.length,0);
    await capture('02-preview-desde-historial-escritorio');
    await switchStore(null,'Todos los negocios');await clientPage(page);
  });

  await check('Móvil: exige confirmar que los pagos también son errores, bloquea doble toque y conserva una solicitud si se pierde la respuesta',async()=>{
    await page.setViewportSize({width:390,height:844});await openClientEditor(duplicate);
    await editor(page).locator('[data-sale-error-confirm]').click();
    await page.waitForFunction(()=>document.querySelector('[data-sale-error-status]')?.textContent.includes('Confirmá que los pagos'));
    assert.equal(postRequests.length,0);assert.equal((await getProducto(product.id)).stock,6);
    await editor(page).locator('[data-sale-error-payments]').check();await capture('03-confirmacion-pagos-movil');
    let applied=false;
    const lostResponse=async route=>{
      if(route.request().method()!=='POST'||new URL(route.request().url()).pathname!==`/api/ventas/${duplicate.venta.id}/eliminar-error`)return route.fallback();
      const response=await route.fetch();assert.equal(response.status(),200);const result=await response.json();assert.equal(result.pagos_anulados,2);
      applied=true;await route.abort('connectionfailed');
    };
    await context.route('**/api/ventas/*/eliminar-error*',lostResponse);
    await editor(page).locator('[data-sale-error-confirm]').evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(()=>document.querySelector('[data-sale-error-confirm]')?.textContent==='Comprobar operación pendiente');
    await context.unroute('**/api/ventas/*/eliminar-error*',lostResponse);
    assert.equal(applied,true);assert.equal(postRequests.length,1);assert.equal((await getProducto(product.id)).stock,7);
    const pending=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`zilky-venta-error-pendiente:${admin.id}:${store.id}`);
    assert.equal(pending.ventaId,duplicate.venta.id);assert.equal(pending.body.confirmar_pagos_erroneos,true);
    assert.deepEqual(await creditSnapshot(real),realBefore);
    await capture('04-respuesta-perdida-movil');
  });

  await check('Recargar y abrir otra venta recupera la eliminación pendiente de la duplicada sin borrar la venta real',async()=>{
    await page.reload();await page.locator('.credito-card').first().waitFor();
    const cancelled=page.locator(`[data-venta-anulada="${duplicate.venta.id}"]`);await cancelled.waitFor();
    assert.equal(await cancelled.locator('[data-action="registrar-pago"],[data-action="eliminar-venta-error"]').count(),0);
    await page.locator(`[data-action="eliminar-venta-error"][data-venta="${real.venta.id}"]`).click();
    await page.locator('[data-sale-error-pending-open]').waitFor();assert.match(await editor(page).innerText(),/Hay otra venta pendiente/);
    await page.locator('[data-sale-error-pending-open]').click();await editor(page).locator('[data-sale-error-confirm]').waitFor();
    assert.equal(await editor(page).getAttribute('data-sale-error'),duplicate.venta.id);
    assert.equal(await editor(page).locator('[data-sale-error-payments]').isDisabled(),true);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/ventas/${duplicate.venta.id}/eliminar-error`&&r.request().method()==='POST');
    await editor(page).locator('[data-sale-error-confirm]').click();const r=await response;assert.equal(r.status(),200);assert.equal((await r.json()).reintentado,true);
    await page.locator('#activeSheet').waitFor({state:'detached'});await page.locator(`[data-venta-anulada="${duplicate.venta.id}"]`).waitFor();
    assert.equal(postRequests.length,2);assert.deepEqual(postRequests[1].body,postRequests[0].body);
    assert.equal((await getProducto(product.id)).stock,7);assert.deepEqual(await creditSnapshot(real),realBefore);
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`zilky-venta-error-pendiente:${admin.id}:${store.id}`),null);
    await page.reload();await page.locator(`[data-venta-anulada="${duplicate.venta.id}"]`).waitFor();
    assert.equal((await getProducto(product.id)).stock,7);await capture('05-venta-anulada-cliente-movil');
  });

  await check('La venta queda sin deuda ni cobros activos, se repone una sola unidad y los comprobantes originales se conservan anulados',async()=>{
    const current=await creditSnapshot(duplicate);assert.equal(current.venta.estado,'anulada');assert.equal(current.venta.devolucion_centavos,current.venta.monto_total_centavos);
    assert.equal(current.cuotas.every(q=>q.saldo_pendiente_centavos===0&&q.estado_manual==='anulada'),true);
    assert.equal(current.pagos.length,duplicateBefore.pagos.length);assert.equal(current.pagos.every(p=>p.anulado===1),true);
    assert.deepEqual(current.pagos.map(p=>[p.id,p.monto_centavos,p.fecha_hora]),duplicateBefore.pagos.map(p=>[p.id,p.monto_centavos,p.fecha_hora]));
    assert.equal(current.comprobantes.every(c=>c.estado==='anulado'),true);
    assert.deepEqual(current.comprobantes.map(c=>[c.id,c.numero,c.fecha_hora,c.monto_centavos]),duplicateBefore.comprobantes.map(c=>[c.id,c.numero,c.fecha_hora,c.monto_centavos]));
    const movements=await db.prepare('SELECT * FROM producto_historial WHERE producto_id=? ORDER BY stock_anterior DESC').all(product.id);
    assert.equal(movements.length,3);assert.equal(movements.filter(h=>h.tipo==='eliminar_error_carga').length,1);
    const restored=movements.find(h=>h.tipo==='eliminar_error_carga');assert.equal(restored.stock_anterior,6);assert.equal(restored.stock_nuevo,7);
    const token=await page.evaluate(()=>localStorage.getItem('zilky_token'));
    const replay=await page.request.post(base+`/api/ventas/${duplicate.venta.id}/eliminar-error?negocio_id=${store.id}`,{headers:{Authorization:'Bearer '+token},data:postRequests[0].body});
    assert.equal(replay.status(),200);assert.equal((await replay.json()).reintentado,true);assert.equal((await getProducto(product.id)).stock,7);
    assert.equal((await db.prepare("SELECT * FROM auditoria WHERE entidad='venta' AND entidad_id=? AND accion='eliminar_error_carga'").all(duplicate.venta.id)).length,1);
  });

  await check('El historial conserva la operación anulada y sólo ofrece eliminar la venta que sigue activa',async()=>{
    await switchStore(store.id,store.nombre);await page.evaluate(()=>{location.hash='#/ventas/historial';});await page.locator('#saleList').waitFor();
    assert.equal(await page.locator(`#saleList button[data-sale-error="${duplicate.venta.id}"]`).count(),0);
    assert.equal(await page.locator(`#saleList button[data-sale-error="${real.venta.id}"]`).count(),1);
    await page.locator(`[data-sale="${duplicate.venta.id}"]`).click();await page.locator('#saleDetail .sale-detail h2').waitFor();
    assert.equal(await page.locator('#saleDetail [data-sale-error],#saleDetail #saleReturn').count(),0);
    await capture('06-historial-anulado-movil');
  });

  await check('Empleado: no recibe acciones de eliminación y ambas rutas directas responden 403',async()=>{
    const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',timezoneId:'UTC',colorScheme:'dark',serviceWorkers:'block'});
    try {
      await restrict(ctx);const p=await ctx.newPage();await login(p,employee.email);await clientPage(p);
      assert.equal(await p.locator('[data-action="eliminar-venta-error"]').count(),0);
      const token=await p.evaluate(()=>localStorage.getItem('zilky_token'));
      const url=base+`/api/ventas/${real.venta.id}/eliminar-error?negocio_id=${store.id}`,headers={Authorization:'Bearer '+token};
      assert.equal((await p.request.get(url,{headers})).status(),403);
      assert.equal((await p.request.post(url,{headers,data:{...postRequests[0].body,solicitud_id:randomUUID()}})).status(),403);
      await p.screenshot({path:path.join(output,'07-cliente-empleado-movil.png'),fullPage:true});
    } finally {await ctx.close();}
  });

  await check('La venta real, la otra tienda, los saldos a favor y los períodos cerrados permanecen intactos',async()=>{
    assert.deepEqual(await creditSnapshot(real),realBefore);assert.deepEqual(await creditSnapshot(other),otherBefore);
    assert.deepEqual(await getProducto(otherProduct.id),otherProductBefore);
    assert.deepEqual(await db.prepare('SELECT * FROM saldo_favor ORDER BY cliente_id,negocio_id').all(),walletsBefore);
    assert.deepEqual(await db.prepare('SELECT * FROM caja_sesiones WHERE id=?').get(session.id),closedSessionBefore);
    const cashRowsAfter=await db.prepare('SELECT * FROM caja_asientos ORDER BY id').all();
    for(const row of cashRowsBefore)assert.deepEqual(cashRowsAfter.find(current=>current.id===row.id),row);
    const notices=cashRowsAfter.filter(row=>!cashRowsBefore.some(before=>before.id===row.id));assert.equal(notices.length,2);
    assert.equal(notices.every(row=>row.tipo==='correccion'&&row.sesion_id===null),true);
    assert.equal(notices.reduce((sum,row)=>sum+row.monto,0),-3000000);
    assert.equal((await getProducto(product.id)).stock,7);assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  });
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
} catch(error) {
  failed=error;if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
} finally {
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,postRequests,
    externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
