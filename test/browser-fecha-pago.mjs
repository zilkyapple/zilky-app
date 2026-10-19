// E2E con datos ficticios. setup-env rechaza toda URL no local o sin sufijo _test.
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
import {crearProducto} from '../src/repositories/productos.js';
import {crearPago,crearAplicacion} from '../src/repositories/pagos.js';
import {crearComprobante} from '../src/repositories/comprobantes.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {guardarCaja,abrirCaja,cerrarCaja} from '../src/services/cajaService.js';
import {todayAR,addDays,addMonths} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/workspace/zilky-browser-tools/node_modules/playwright-core/index.mjs');
const output=process.env.BROWSER_ARTIFACTS||'/workspace/zilky-pagos-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[];
const startedAt=new Date().toISOString();
let server,browser,page,failed;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
const fmt=fecha=>fecha.split('-').reverse().join('/');

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-local-pagos-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-pagos@browser.invalid',nombre:'Administración QA',password_hash});
  const employee=await crearUsuario({email:'empleado-pagos@browser.invalid',nombre:'Empleado QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares ficticios QA',mora_valor:0});
  const otherStore=await crearNegocio({nombre:'Indumentaria ficticia QA',mora_valor:0});
  await asignarNegocio(employee.id,store.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true,'pagos.registrar':true});
  const client=await crearCliente({nombre:'Cliente ficticio',apellido:'Fecha de pago QA',negocio_id:store.id});
  const today=todayAR(),first=addDays(today,-90),second=addMonths(first,1),third=addMonths(first,2),purchase=addDays(first,-27);
  assert.ok(third<today,'Las fechas ficticias deben ser históricas');
  const product=await crearProducto({negocio_id:store.id,nombre:'iPhone ficticio QA',stock:8});
  const cash=await guardarCaja(null,{nombre:'Caja ficticia QA',activa:true,arqueo:true,modalidad:'negocio',negocios:[store.id]},admin.id);
  const session=await abrirCaja(cash.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
  const sale=await crearVenta({
    negocio_id:store.id,cliente_id:client.id,usuario_id:admin.id,fecha:purchase,modalidad:'cuotas',
    monto_total_centavos:111000000,entrega_inicial_centavos:18000000,
    items:[{producto_id:product.id,cantidad:1,precio_unitario_centavos:111000000}],
    plan:{cantidad_cuotas:6,valor_cuota_centavos:15500000,fecha_primera_cuota:first},
  });
  // Estado legado ficticio: 3 entregas de $155.000 pagaron $23.000 de mora
  // congelada durante una carga tardía. No depende del comportamiento de altas nuevas.
  const [q1,q2,q3]=sale.cuotas;
  const legacyPayment=async(fecha,hora,anterior,posterior,aplicaciones)=>{
    const pago=await crearPago({negocio_id:store.id,cliente_id:client.id,credito_id:sale.credito.id,
      fecha_hora:`${fecha}T${hora}-03:00`,monto_centavos:15500000,medio_pago:'efectivo',usuario_id:admin.id,
      saldo_anterior_centavos:anterior,saldo_posterior_centavos:posterior,tipo:'cuota',objetivo_registrado:false});
    await db.prepare('UPDATE pagos SET objetivo_registrado=FALSE,cuota_objetivo_id=NULL WHERE id=?').run(pago.id);
    for(const [cuotaId,capital,mora] of aplicaciones)await crearAplicacion(pago.id,{cuotaId,capital,mora});
    await crearComprobante({pago_id:pago.id,negocio_id:store.id,cliente_id:client.id,credito_id:sale.credito.id,venta_id:sale.venta.id,
      fecha_hora:pago.fecha_hora,monto_centavos:pago.monto_centavos,medio_pago:'efectivo',saldo_restante_centavos:posterior,usuario_id:admin.id});
    return pago;
  };
  const p1=await legacyPayment(first,'11:42:00',93000000,79100000,[[q1.id,13900000,1600000]]);
  const p2=await legacyPayment(first,'11:43:00',79100000,64300000,[[q1.id,1600000,0],[q2.id,13200000,700000]]);
  const p3=await legacyPayment(second,'11:43:00',64300000,48800000,[[q2.id,2300000,0],[q3.id,13200000,0]]);
  await db.prepare('UPDATE cuotas SET saldo_pendiente_centavos=0,mora_generada_centavos=1600000,mora_pagada_centavos=1600000,fecha_saldada=?,dias_atraso_al_pagar=0 WHERE id=?').run(first,q1.id);
  await db.prepare('UPDATE cuotas SET saldo_pendiente_centavos=0,mora_generada_centavos=700000,mora_pagada_centavos=700000,fecha_saldada=?,dias_atraso_al_pagar=0 WHERE id=?').run(second,q2.id);
  await db.prepare('UPDATE cuotas SET saldo_pendiente_centavos=2300000 WHERE id=?').run(q3.id);
  const other=await crearVenta({negocio_id:otherStore.id,cliente_id:client.id,usuario_id:admin.id,fecha:purchase,modalidad:'unico',monto_total_centavos:500000,plan:{fecha_limite:addDays(today,30)}});
  await registrarPago({credito_id:other.credito.id,monto_centavos:10000,fecha_hora:`${first}T12:00:00-03:00`,usuario_id:admin.id});
  const cashClient=await crearCliente({nombre:'Caja ficticia',apellido:'Período cerrado QA',negocio_id:store.id});
  const cashSale=await crearVenta({negocio_id:store.id,cliente_id:cashClient.id,usuario_id:admin.id,fecha:today,modalidad:'unico',monto_total_centavos:10000,plan:{fecha_limite:today}});
  await registrarPago({credito_id:cashSale.credito.id,monto_centavos:1000,fecha_hora:`${today}T10:00:00-03:00`,usuario_id:admin.id});
  await cerrarCaja(session.id,{contado:1000,notas:'Cierre ficticio QA'},admin.id);
  const rows=table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const creditRows=(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE credito_id=? ORDER BY id`).all(id);
  const otherSnapshot=async()=>({credito:await db.prepare('SELECT * FROM creditos WHERE id=?').get(other.credito.id),
    cuotas:await creditRows('cuotas',other.credito.id),pagos:await creditRows('pagos',other.credito.id),comprobantes:await creditRows('comprobantes',other.credito.id),
    aplicaciones:await db.prepare('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(other.credito.id)});
  const invariantSnapshot=async()=>({productos:await rows('productos'),stock:await rows('producto_historial'),sesiones:await rows('caja_sesiones'),caja:await rows('caja_asientos'),otra:await otherSnapshot()});
  const originalInvariant=await invariantSnapshot(),originalPayments=await creditRows('pagos',sale.credito.id),originalReceipts=await creditRows('comprobantes',sale.credito.id);
  const remaining=async()=>(await creditRows('cuotas',sale.credito.id)).reduce((sum,q)=>sum+q.saldo_pendiente_centavos,0);
  assert.equal(await remaining(),48800000);

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
  const login=async(p,email)=>{
    await p.goto(base);await p.locator('#authEmail').fill(email);await p.locator('#authPassword').fill(password);await p.locator('#authSubmit').click();
    await p.locator('#root').waitFor({state:'visible'});
    await p.evaluate(id=>{location.hash=`#/clientes/${id}`;},client.id);
    await p.locator('.credito-card').first().waitFor();
  };
  const paymentRow=(p,id)=>p.locator(`[data-action="corregir-fecha-pago"][data-id="${id}"]`).locator('xpath=ancestor::div[contains(@class,"hist-row")][1]');
  const history=p=>p.locator('.client-section').filter({has:p.locator('summary').filter({hasText:/^Historial de pagos/})});
  const showHistory=async p=>{await history(p).evaluate(el=>{el.open=true;});};
  const capture=async(name,p=page)=>{
    await p.waitForFunction(()=>!document.querySelector('.toast'));
    await p.screenshot({path:path.join(output,name+'.png'),fullPage:!(await p.locator('#activeSheet').count())});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
    if(await p.locator('#activeSheet').count())assert.equal(await p.locator('#activeSheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Desborde horizontal del editor: '+name);
  };
  const preview=async()=>{
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/correccion-fecha/previsualizar')&&r.request().method()==='POST');
    await page.locator('#pagoCorRevisar').click();const r=await pending;assert.equal(r.status(),200,JSON.stringify(await r.json()));
    await page.locator('#pagoCorConfirmar').waitFor({state:'visible'});return r.json();
  };
  const confirm=async()=>{
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/correccion-fecha')&&r.request().method()==='PATCH');
    await page.locator('#pagoCorConfirmar').click();const r=await pending;assert.equal(r.status(),200,JSON.stringify(await r.json()));
    await page.locator('#activeSheet').waitFor({state:'detached'});await page.waitForLoadState('networkidle');
  };

  await check('Escritorio: desde Todos los negocios el historial explica los $23.000 de mora y ofrece corregir cada pago',async()=>{
    await login(page,admin.email);assert.equal(await page.locator('#negocioNombre').innerText(),'Todos los negocios');
    await showHistory(page);assert.equal(await history(page).locator('[data-action="corregir-fecha-pago"]').count(),5);
    const texto=(await paymentRow(page,p1.id).innerText())+' '+(await paymentRow(page,p2.id).innerText());
    assert.match(texto,/A mora:.*16\.000/);assert.match(texto,/A mora:.*7\.000/);
    await paymentRow(page,p2.id).scrollIntoViewIfNeeded();await capture('01-historial-mora-escritorio');
  });

  await check('Escritorio: anticipo permite corregir su fecha real y hora de Argentina sin aplicar dinero otra vez',async()=>{
    await page.locator(`[data-action="corregir-fecha-pago"][data-id="${sale.entregaInicial.pago.id}"]`).click();
    await page.locator('#pagoCorFecha').waitFor();assert.equal(await page.locator('#pagoCorRecalcular').count(),0);
    await page.locator('#pagoCorFecha').fill(addDays(purchase,1));await page.locator('#pagoCorHora').fill('23:35:00');
    await page.locator('#pagoCorMotivo').fill('QA: fecha real del anticipo mal cargada');
    const result=await preview();assert.equal(result.recalcular,false);assert.deepEqual(result.antes,result.despues);
    await capture('02-anticipo-preview-escritorio');await confirm();
    await page.reload();await page.locator('.credito-card').first().waitFor();await showHistory(page);
    assert.match(await paymentRow(page,sale.entregaInicial.pago.id).innerText(),new RegExp(`${fmt(addDays(purchase,1))} 23:35`));
    assert.equal((await db.prepare('SELECT * FROM pagos WHERE id=?').get(sale.entregaInicial.pago.id)).fecha_hora,`${addDays(purchase,1)}T23:35:00-03:00`);
    assert.equal(await remaining(),48800000);
  });

  await check('Móvil: vista previa redistribuye los $23.000 y muestra saldo $488.000 → $465.000 sin modificar datos',async()=>{
    await page.setViewportSize({width:390,height:844});await page.locator(`[data-action="corregir-fecha-pago"][data-id="${p2.id}"]`).click();
    await page.locator('#pagoCorFecha').waitFor();assert.equal(await page.locator('#pagoCorRecalcular').isChecked(),true);
    assert.equal(await page.locator('#pagoCorFecha').inputValue(),first);
    await page.locator('#pagoCorFecha').fill(third);await page.locator('#pagoCorHora').fill('19:10:00');
    await page.locator('#pagoCorMotivo').fill('QA: cuota registrada dos veces en el mismo mes');
    const before=await creditRows('pagos',sale.credito.id),result=await preview();
    assert.equal(result.antes.capital_pendiente_centavos,48800000);assert.equal(result.despues.capital_pendiente_centavos,46500000);
    assert.equal(result.despues.mora_pendiente_centavos,0);assert.equal(result.despues.saldo_favor_centavos,0);
    assert.equal(await remaining(),48800000);assert.deepEqual(await creditRows('pagos',sale.credito.id),before);
    assert.match(await page.locator('#pagoCorPreview').innerText(),/488\.000.*465\.000/s);
    await page.locator('#pagoCorPreview').scrollIntoViewIfNeeded();await capture('03-preview-pago-movil');
    await confirm();assert.equal(await remaining(),46500000);
  });

  await check('Móvil: al recargar persisten fecha y hora reales, tres cuotas saldadas y desglose sin mora errónea',async()=>{
    await page.reload();await page.locator('.credito-card').first().waitFor();await showHistory(page);
    const row=paymentRow(page,p2.id);assert.match(await row.innerText(),new RegExp(`${fmt(third)} 19:10`));
    assert.match(await row.innerText(),/Aplicado a capital:.*155\.000.*A mora:.*0/s);
    assert.match(await row.innerText(),/Correcciones de fecha/);
    const cuotas=await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY numero').all(sale.credito.id);
    assert.deepEqual(cuotas.map(q=>q.saldo_pendiente_centavos),[0,0,0,15500000,15500000,15500000]);
    assert.equal(cuotas.reduce((sum,q)=>sum+q.mora_pagada_centavos+q.mora_generada_centavos,0),0);
    await row.scrollIntoViewIfNeeded();await capture('04-pago-corregido-movil');
    await row.locator('[data-action="corregir-fecha-pago"]').click();await page.locator('#pagoCorFecha').waitFor();
    assert.equal(await page.locator('#pagoCorFecha').inputValue(),third);assert.equal(await page.locator('#pagoCorHora').inputValue(),'19:10:00');
    await page.locator('#activeSheet [data-action="cerrar-sheet"]').click();await page.locator('#activeSheet').waitFor({state:'detached'});
  });

  await check('La corrección conserva montos, stock, otra tienda y caja cerrada; comprobantes originales quedan vinculados',async()=>{
    assert.deepEqual(await invariantSnapshot(),originalInvariant);
    const current=await creditRows('pagos',sale.credito.id);
    assert.deepEqual(current.map(p=>[p.id,p.monto_centavos,p.anulado]),originalPayments.map(p=>[p.id,p.monto_centavos,p.anulado]));
    assert.equal(current.find(p=>p.id===p1.id).fecha_hora,p1.fecha_hora);assert.equal(current.find(p=>p.id===p3.id).fecha_hora,p3.fecha_hora);
    const receipts=await creditRows('comprobantes',sale.credito.id);
    for(const original of originalReceipts){
      const preserved=receipts.find(c=>c.id===original.id);assert.ok(preserved);
      assert.deepEqual([preserved.fecha_hora,preserved.monto_centavos,preserved.numero],[original.fecha_hora,original.monto_centavos,original.numero]);
      assert.equal(preserved.estado,'anulado');
      assert.ok(receipts.some(c=>c.comprobante_original_id===original.id));
    }
    const audit=await db.prepare("SELECT * FROM auditoria WHERE entidad='pago' AND accion='corregir_fecha_pago' ORDER BY fecha_hora,id").all();
    assert.equal(audit.length,2);assert.equal(audit.every(a=>a.empleado===admin.id&&a.motivo.startsWith('QA:')),true);
    assert.equal(errors.length,0);
  });

  await check('Empleado puede ver el historial pero no recibe el editor ni obtiene permiso por acceso directo',async()=>{
    const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',timezoneId:'UTC',colorScheme:'dark',serviceWorkers:'block'});
    try {
      await restrict(ctx);const p=await ctx.newPage();await login(p,employee.email);await showHistory(p);
      assert.equal(await p.locator('[data-action="corregir-fecha-pago"]').count(),0);
      const status=await p.evaluate(async id=>{const r=await fetch(`/api/pagos/${id.pago}/correccion-fecha?negocio_id=${id.negocio}`,{headers:{Authorization:`Bearer ${localStorage.getItem('zilky_token')}`}});return r.status;},{pago:p2.id,negocio:store.id});
      assert.equal(status,403);await history(p).scrollIntoViewIfNeeded();await capture('05-historial-empleado-movil',p);
    }finally{await ctx.close();}
  });
  assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
}catch(error){
  failed=error;if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
}finally{
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
