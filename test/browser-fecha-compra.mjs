// E2E de fechas y lectura de cuotas: sólo datos ficticios en PostgreSQL local.
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
import {crearProducto,getProducto} from '../src/repositories/productos.js';
import {registrarPago} from '../src/services/pagosService.js';
import {configurarComision,configurarProductoComision} from '../src/services/comisionesService.js';
import {todayAR,addDays,addMonths} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-fecha-compra-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[],measurements=[],saleRequests=[];
const startedAt=new Date().toISOString();
let server,browser,page,failed,sale;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
const fmt=value=>value.split('-').reverse().join('/');

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-local-fecha-compra-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-fecha-compra@browser.invalid',nombre:'Jefe ficticio QA',password_hash});
  const seller=await crearUsuario({email:'vendedor-fecha-compra@browser.invalid',nombre:'Vendedor ficticio QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares ficticios QA',mora_valor:0});
  await asignarNegocio(seller.id,store.id,{'clientes.ver':true,'ventas.crear':true});
  const client=await crearCliente({nombre:'Compra histórica',apellido:'Cliente ficticio QA',negocio_id:store.id});
  const product=await crearProducto({negocio_id:store.id,nombre:'iPhone ficticio QA',stock:8,precio_contado_centavos:78200000,precio_financiado_centavos:78200000});
  await configurarComision(store.id,{activa:true,momento:'venta',visible_empleado:false},admin.id);
  await configurarProductoComision(store.id,product.id,{tipo:'fijo',valor:300000},admin.id);
  const today=todayAR(),purchase=addMonths(`${today.slice(0,7)}-10`,-7),first=addMonths(purchase,1);
  assert.notEqual(purchase.slice(0,7),first.slice(0,7));
  assert.ok(addMonths(first,5)<today,'Las seis cuotas ficticias deben ser históricas');

  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'es-AR',timezoneId:'Pacific/Honolulu',colorScheme:'dark',serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin===base)return route.continue();externalRequestsBlocked.push(url);return route.abort('blockedbyclient');});
  context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
  page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/ventas')saleRequests.push(request.postDataJSON());});
  const capture=async(name,{fullPage=true}={})=>{
    await page.waitForFunction(()=>!document.querySelector('.toast'));
    await page.screenshot({path:path.join(output,name+'.png'),fullPage});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
  };
  const api=async path=>page.evaluate(async pathname=>{
    const response=await fetch('/api'+pathname,{headers:{Authorization:'Bearer '+localStorage.getItem('zilky_token')}});
    return {status:response.status,body:await response.json()};
  },path);

  await check('Nueva venta permite indicar una compra histórica y una primera cuota en otro mes de forma independiente',async()=>{
    await page.goto(base);await page.locator('#authEmail').fill(admin.email);await page.locator('#authPassword').fill(password);await page.locator('#authSubmit').click();
    await page.locator('#root').waitFor({state:'visible'});await page.locator('#btnNegocioSwitch').click();
    await page.locator(`[data-action="elegir-negocio"][data-id="${store.id}"]`).click();await page.locator('#activeSheet').waitFor({state:'detached'});
    await page.evaluate(()=>{location.hash='#/ventas/nueva';});await page.locator('#vForm').waitFor();
    assert.equal(await page.locator('#vFechaCompra').inputValue(),today);
    await page.locator('#vClienteBuscar').fill('Compra histórica');await page.locator(`[data-action="elegir-cliente-venta"][data-id="${client.id}"]`).click();
    await page.locator('#vVendedor').selectOption(seller.id);await page.locator('#vFechaCompra').fill(purchase);
    await page.locator('#vProducto').selectOption(product.id);await page.locator('#vAgregar').click();
    await page.locator('#vModalidad [data-val="cuotas"]').click();
    assert.equal(await page.locator('#vFechaCompra').inputValue(),purchase,'Cambiar de modalidad debe conservar la fecha de compra');
    await page.locator('#vEntrega').fill('200000');await page.locator('#vCantCuotas').fill('6');await page.locator('#vValorCuota').fill('97000');await page.locator('#vFechaPrimera').fill(first);
    assert.equal(await page.locator('#vFechaCompra').inputValue(),purchase);assert.equal(await page.locator('#vFechaPrimera').inputValue(),first);
    assert.equal(await page.locator('#vMontoTotal').inputValue(),'782000');
    await page.evaluate(()=>window.scrollTo(0,0));await capture('01-nueva-venta-fechas-escritorio');
    await page.setViewportSize({width:390,height:844});await capture('02-nueva-venta-fechas-movil');
    assert.equal(saleRequests.length,0);
  });

  await check('Confirmar envía ambas fechas y guarda compra, financiación, anticipo y vencimientos con sus fechas reales',async()=>{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/ventas'&&r.request().method()==='POST');
    await page.locator('#btnCrearVenta').click();const r=await response;assert.equal(r.status(),201,JSON.stringify(await r.json()));sale=await r.json();
    assert.equal(saleRequests.length,1);assert.equal(saleRequests[0].fecha,purchase);assert.equal(saleRequests[0].plan.fecha_primera_cuota,first);
    assert.equal(saleRequests[0].entrega_inicial_centavos,20000000);assert.equal(saleRequests[0].comision_usuario_id,seller.id);
    assert.equal(sale.venta.fecha,purchase);assert.equal(sale.credito.fecha_inicio,purchase);assert.equal(sale.cuotas.length,6);
    assert.deepEqual(sale.cuotas.map(q=>q.fecha_vencimiento),Array.from({length:6},(_,index)=>addMonths(first,index)));
    assert.equal(sale.entregaInicial.pago.fecha_hora.slice(0,10),purchase);assert.equal(sale.entregaInicial.pago.monto_centavos,20000000);
    assert.equal((await getProducto(product.id)).stock,7);
    const saved=await db.prepare('SELECT * FROM ventas WHERE id=?').get(sale.venta.id);assert.equal(saved.fecha,purchase);assert.equal(saved.vendedor_id,seller.id);
    await page.locator('.credito-card').waitFor();assert.match(await page.locator('.credito-card').innerText(),new RegExp('Compra: '+fmt(purchase)));
  });

  await check('La comisión de la venta corresponde al mes de compra y no al mes de la primera cuota',async()=>{
    const agreement=await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(sale.venta.id);
    assert.equal(agreement.usuario_id,seller.id);assert.equal(agreement.total_centavos,300000);assert.equal(agreement.momento,'venta');
    const generations=await db.prepare('SELECT * FROM comision_generaciones WHERE acuerdo_id=? ORDER BY id').all(agreement.id);
    const earned=await db.prepare('SELECT * FROM comision_eventos WHERE acuerdo_id=? ORDER BY id').all(agreement.id);
    assert.equal(generations.length,1);assert.equal(generations[0].fecha,purchase);assert.equal(generations[0].importe_centavos,300000);
    assert.equal(earned.length,1);assert.equal(earned[0].fecha,purchase);assert.equal(earned[0].fecha_origen,purchase);
    for(const [date,amount] of [[purchase,300000],[first,0]]){
      const desde=date.slice(0,7)+'-01',hasta=addDays(addMonths(desde,1),-1);
      const response=await api('/comisiones?'+new URLSearchParams({negocio_id:store.id,usuario_id:seller.id,desde,hasta}));
      assert.equal(response.status,200);assert.equal(response.body.totales.generada,amount);assert.equal(response.body.totales.liquidable,amount);
    }
  });

  // Estado ficticio que reproduce el caso de lectura informado: cuota 4 de
  // $97.000 con $88.000 de capital y $12.500 de mora; cuota 5 con $4.000 de mora.
  for(const quota of sale.cuotas.slice(0,3))await registrarPago({credito_id:sale.credito.id,cuota_id:quota.id,monto_centavos:9700000,
    fecha_hora:`${quota.fecha_vencimiento}T12:00:00-03:00`,usuario_id:admin.id});
  const q4=sale.cuotas[3],q5=sale.cuotas[4];
  await registrarPago({credito_id:sale.credito.id,cuota_id:q4.id,monto_centavos:900000,fecha_hora:`${q4.fecha_vencimiento}T12:00:00-03:00`,usuario_id:admin.id});
  await db.prepare('UPDATE cuotas SET mora_generada_centavos=? WHERE id=?').run(1250000,q4.id);
  await db.prepare('UPDATE cuotas SET mora_generada_centavos=? WHERE id=?').run(400000,q5.id);
  const snapshot=async()=>({cuotas:await db.prepare('SELECT * FROM cuotas ORDER BY id').all(),pagos:await db.prepare('SELECT * FROM pagos ORDER BY id').all(),
    aplicaciones:await db.prepare('SELECT * FROM pago_aplicaciones ORDER BY id').all(),comprobantes:await db.prepare('SELECT * FROM comprobantes ORDER BY id').all(),
    productos:await db.prepare('SELECT * FROM productos ORDER BY id').all(),stock:await db.prepare('SELECT * FROM producto_historial ORDER BY id').all(),
    generaciones:await db.prepare('SELECT * FROM comision_generaciones ORDER BY id').all(),eventos:await db.prepare('SELECT * FROM comision_eventos ORDER BY id').all()});
  const beforeLayout=await snapshot();

  await check('La ficha distingue el valor de cuota, el capital pendiente y la mora sin cambiar sus importes',async()=>{
    await page.reload();await page.locator('.credito-cuota').nth(3).waitFor();
    const fourth=page.locator('.credito-cuota').nth(3),fifth=page.locator('.credito-cuota').nth(4);
    assert.match(await fourth.innerText(),/Cuota 4\/6/);assert.match(await fourth.innerText(),/97\.000/);assert.match(await fourth.innerText(),/12\.500/);
    assert.match(await fourth.locator('.credito-cuota-importe').innerText(),/88\.000/);
    assert.match(await fifth.innerText(),/Cuota 5\/6/);assert.match(await fifth.innerText(),/4\.000/);
    assert.match(await fifth.locator('.credito-cuota-importe').innerText(),/97\.000/);
    for(const row of [fourth,fifth]){
      assert.equal(await row.locator('[data-action="corregir-financiacion"]').count(),1);
      assert.equal(await row.locator('[data-action="perdonar-mora"]').count(),1);
    }
  });

  await check('320, 390, 768 y 1440 px: importes y textos de botones en una línea, sin superposición ni desborde',async()=>{
    for(const viewport of [{width:320,height:780},{width:390,height:844},{width:768,height:1024},{width:1440,height:1050}]){
      await page.setViewportSize(viewport);
      const measured=await page.locator('.credito-cuota').evaluateAll(rows=>rows.map(row=>{
        const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
        const textRects=element=>{const range=document.createRange();range.selectNodeContents(element);return [...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));};
        return {row:rect(row),scrollWidth:row.scrollWidth,clientWidth:row.clientWidth,
          money:[...row.querySelectorAll('.credito-cuota-importe,.credito-cuota-dinero')].map(element=>({text:element.textContent,box:rect(element),lines:textRects(element),whiteSpace:getComputedStyle(element).whiteSpace})),
          buttons:[...row.querySelectorAll('.credito-cuota-acciones button')].map(element=>({text:element.textContent,box:rect(element),lines:textRects(element)}))};
      }));
      measurements.push({viewport,rows:measured});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Desborde de página a ${viewport.width}px`);
      for(const row of measured){
        assert.ok(row.scrollWidth<=row.clientWidth+1,`Desborde de cuota a ${viewport.width}px`);
        for(const amount of row.money){
          assert.equal(amount.whiteSpace,'nowrap',`Importe ${amount.text} debe conservarse unido`);assert.equal(amount.lines.length,1,`Importe dividido a ${viewport.width}px: ${amount.text}`);
          assert.ok(amount.box.left>=row.row.left-1&&amount.box.right<=row.row.right+1,`Importe fuera de la cuota a ${viewport.width}px: ${amount.text}`);
        }
        for(const button of row.buttons){
          assert.equal(button.lines.length,1,`Botón dividido a ${viewport.width}px: ${button.text}`);
          assert.ok(button.box.left>=row.row.left-1&&button.box.right<=row.row.right+1,`Botón fuera de cuota a ${viewport.width}px: ${button.text}`);
        }
        if(row.buttons.length===2){
          const [a,b]=row.buttons.map(button=>button.box);
          if(viewport.width>=390)assert.ok(Math.abs(a.top-b.top)<2,`Las acciones deben compartir fila cuando hay espacio a ${viewport.width}px`);
          assert.ok(a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1,'Los botones no deben superponerse');
        }
      }
      await page.locator('.credito-cuota').nth(3).evaluate(row=>window.scrollTo(0,scrollY+row.getBoundingClientRect().top-85));
      await capture(`03-cuotas-mora-${viewport.width}px`,{fullPage:false});
    }
  });

  await check('Consultar la ficha y cambiar el tamaño de pantalla conserva pagos, cuotas, comprobantes, stock y comisiones',async()=>{
    assert.deepEqual(await snapshot(),beforeLayout);assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  });
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
} catch(error) {
  failed=error;if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
} finally {
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,saleRequests,measurements,
    externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
