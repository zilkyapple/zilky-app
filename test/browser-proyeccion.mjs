// E2E exclusivamente local: setup-env exige una base descartable con sufijo _test.
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
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {todayAR,addDays,addMonths} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/workspace/zilky-browser-tools/node_modules/playwright-core/index.mjs');
const output=process.env.BROWSER_ARTIFACTS||'/workspace/zilky-dashboard-visible-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],externalRequestsBlocked=[];
const loadedAssets=[];
const firstViewport=[];
const startedAt=new Date().toISOString();
let server,browser,page,failed;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
const money=cents=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(cents/100);
const normalize=value=>value.replace(/\s/g,' ');

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-local-proyeccion-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'admin-proyeccion@browser.invalid',nombre:'Jefe ficticio QA',password_hash});
  const employee=await crearUsuario({email:'empleado-proyeccion@browser.invalid',nombre:'Empleado ficticio QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Celulares ficticios QA',mora_valor:0});
  const otherStore=await crearNegocio({nombre:'Indumentaria ficticia QA',mora_valor:0});
  const emptyStore=await crearNegocio({nombre:'Negocio sin ventas QA',mora_valor:0});
  // El permiso financiero legado no debe habilitar esta información al empleado.
  await asignarNegocio(employee.id,store.id,{'clientes.ver':true,'cobranzas.ver':true,'dashboard_financiero.ver':true});
  const client=await crearCliente({nombre:'Cliente ficticio',apellido:'Proyección QA',negocio_id:store.id});
  const today=todayAR(),currentMonth=today.slice(0,7),monthDate=offset=>addMonths(`${currentMonth}-01`,offset);
  const nextMonth=monthDate(1).slice(0,7),farMonth=monthDate(15).slice(0,7),emptyMonth=monthDate(5).slice(0,7);
  const fixtures=[];
  const sale=async(negocio,fecha,monto,{pagado=0,manual=false,mora=0,anticipo=0}={})=>{
    const created=await crearVenta({negocio_id:negocio.id,cliente_id:client.id,usuario_id:admin.id,
      fecha:addDays(today,-100),modalidad:'unico',monto_total_centavos:monto+anticipo,entrega_inicial_centavos:anticipo,
      plan:{fecha_limite:fecha}});
    if(pagado)await registrarPago({credito_id:created.credito.id,cuota_id:created.cuotas[0].id,monto_centavos:pagado,
      fecha_hora:`${today}T10:00:00-03:00`,usuario_id:admin.id});
    if(manual)await db.prepare("UPDATE cuotas SET estado_manual='anulada' WHERE id=?").run(created.cuotas[0].id);
    if(mora)await db.prepare('UPDATE cuotas SET mora_generada_centavos=? WHERE id=?').run(mora,created.cuotas[0].id);
    fixtures.push({negocio:negocio.id,fecha,pendiente:manual?0:monto-pagado});
    return created;
  };
  const parcial=await sale(store,today,10000000,{pagado:4000000,anticipo:18000000});
  await sale(store,addDays(today,6),7000000,{pagado:2000000});
  await sale(store,addDays(today,7),8000000);
  await sale(store,addDays(today,13),9000000);
  await sale(store,addDays(today,14),10000000);
  await sale(store,`${nextMonth}-15`,15500000,{pagado:15500000});
  await sale(store,`${nextMonth}-20`,20000000,{pagado:5000000});
  await sale(store,`${monthDate(2).slice(0,7)}-18`,22200000,{pagado:2200000});
  await sale(store,`${monthDate(3).slice(0,7)}-22`,33300000);
  await sale(store,`${farMonth}-25`,32100000);
  await sale(store,addDays(today,-1),1100000);
  await sale(store,addDays(`${currentMonth}-01`,-1),2200000);
  await sale(store,addDays(today,1),99900000,{manual:true});
  await sale(store,addDays(today,2),10000,{pagado:10000,mora:12345});
  await sale(otherStore,today,3300000);
  await sale(otherStore,addDays(today,10),4400000);
  await sale(otherStore,`${nextMonth}-27`,5500000);
  const expected=(negocio=null)=>{
    const rows=fixtures.filter(f=>(!negocio||f.negocio===negocio)&&f.pendiente>0);
    const sum=predicate=>rows.filter(predicate).reduce((acc,f)=>acc+f.pendiente,0);
    return {mesActual:sum(f=>f.fecha.startsWith(currentMonth)),mesSiguiente:sum(f=>f.fecha.startsWith(nextMonth)),
      proximos7Dias:sum(f=>f.fecha>=today&&f.fecha<=addDays(today,6)),
      proximos14Dias:sum(f=>f.fecha>=today&&f.fecha<=addDays(today,13)),
      vencidoTotal:sum(f=>f.fecha<today),month:mes=>sum(f=>f.fecha.startsWith(mes))};
  };
  // La visita al dashboard sólo consulta: no debe modificar cuotas, pagos ni auditoría.
  const snapshot=async()=>{
    const out={};for(const table of ['cuotas','pagos','pago_aplicaciones','comprobantes','auditoria'])out[table]=await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    return out;
  };
  const initialSnapshot=await snapshot();

  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'es-AR',timezoneId:'Pacific/Honolulu',colorScheme:'dark',serviceWorkers:'block'});
  const restrict=async ctx=>{
    await ctx.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin===base)return route.continue();externalRequestsBlocked.push(url);return route.abort('blockedbyclient');});
    ctx.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
  };
  await restrict(context);page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('response',response=>{
    const url=new URL(response.url());
    if(url.origin===base&&['/app.js','/styles.css'].includes(url.pathname))loadedAssets.push({url:response.url(),status:response.status(),cache:response.headers()['cache-control']});
  });
  const login=async(p,email)=>{
    const response=await p.goto(base);assert.match(response.headers()['cache-control']||'',/no-cache/,'El HTML debe revalidarse al abrir la app');
    await p.locator('#authEmail').fill(email);await p.locator('#authPassword').fill(password);await p.locator('#authSubmit').click();
    await p.locator('#root').waitFor({state:'visible'});
  };
  const projection=p=>p.locator('[data-cash-projection]');
  const fetchSummary=async(p,negocio=null)=>p.evaluate(async scope=>{
    const r=await fetch('/api/dashboard/resumen'+(scope?'?negocio_id='+encodeURIComponent(scope):''),{headers:{Authorization:'Bearer '+localStorage.getItem('zilky_token')}});
    return {status:r.status,body:await r.json()};
  },negocio);
  const expectMetrics=async(p,negocio=null)=>{
    const values=expected(negocio),response=await fetchSummary(p,negocio);assert.equal(response.status,200);
    const data=response.body.proyeccionCobros;assert.ok(data);assert.equal(data.fechaCorte,today);
    for(const key of ['mesActual','mesSiguiente','proximos7Dias','proximos14Dias']){
      assert.equal(data[key].pendienteCentavos,values[key],key+' API');
      assert.equal(normalize(await projection(p).locator(`[data-projection-metric="${key}"] .projection-amount`).innerText()),normalize(money(values[key])),key+' UI');
    }
    assert.equal(data.proximos7Dias.desde,today);assert.equal(data.proximos7Dias.hasta,addDays(today,6));
    assert.equal(data.proximos14Dias.desde,today);assert.equal(data.proximos14Dias.hasta,addDays(today,13));
    assert.equal(data.vencidoTotalCentavos,values.vencidoTotal);
    assert.match(normalize(await projection(p).locator('.projection-overdue').innerText()),new RegExp(normalize(money(values.vencidoTotal)).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    return data;
  };
  const switchStore=async(id,nombre)=>{
    await page.locator('#btnNegocioSwitch').click();
    await page.locator(`[data-action="elegir-negocio"][data-id="${id||''}"]`).click();
    await page.locator('#activeSheet').waitFor({state:'detached'});
    await page.waitForFunction(text=>document.getElementById('negocioNombre').textContent===text,nombre);
    await projection(page).waitFor();
    await page.waitForLoadState('networkidle');
  };
  const capture=async(name,p=page)=>{
    await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:path.join(output,name+'.png'),fullPage:true});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde horizontal: '+name);
  };
  const openMonthDetail=async()=>{
    const detail=projection(page).locator('[data-projection-detail]');
    if(!await detail.evaluate(el=>el.open))await detail.locator('summary').click();
  };
  const selectMonth=async mes=>{
    await page.locator('#proyeccionMes').fill(mes);await page.locator('#proyeccionMes').dispatchEvent('change');
    assert.equal(await page.locator('#proyeccionMes').inputValue(),mes,'Se debe conservar el mes exacto elegido');
    assert.equal(normalize(await projection(page).locator('[data-projection-selected] .projection-selected-amount').innerText()),normalize(money(expected().month(mes))));
  };

  await check('Jefe: el dashboard global muestra cobros pendientes por mes y ventanas inclusivas de 7/14 días',async()=>{
    await login(page,admin.email);await projection(page).waitFor();
    for(const pathname of ['/app.js','/styles.css']){
      const asset=loadedAssets.find(item=>new URL(item.url).pathname===pathname);assert.ok(asset,pathname+' debe cargarse');
      assert.equal(asset.status,200);assert.match(new URL(asset.url).searchParams.get('v')||'',/^[\w-]+$/,'Los recursos deben llevar una versión para renovar la caché');
      assert.match(asset.cache||'',/no-cache/,pathname+' debe revalidarse');
    }
    assert.equal(await page.locator('#negocioNombre').innerText(),'Todos los negocios');
    assert.match(await projection(page).innerText(),/Cobros previstos/);await expectMetrics(page);
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-cash-projection]').compareDocumentPosition(document.querySelector('.kpi-grid'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'La proyección debe estar antes de Vendido y los indicadores anteriores');
    assert.equal(await projection(page).locator('[data-projection-detail]').evaluate(el=>el.open),false,'El detalle largo de meses debe iniciar cerrado');
    const row=await db.prepare('SELECT saldo_pendiente_centavos FROM cuotas WHERE id=?').get(parcial.cuotas[0].id);assert.equal(row.saldo_pendiente_centavos,6000000);
    assert.equal(await projection(page).locator('[data-projection-month]').count(),12);
    assert.equal(await projection(page).locator('[data-projection-prev]').isDisabled(),true);
    await capture('01-proyeccion-global-escritorio');
  });

  await check('Primer pantallazo móvil: los cuatro importes se ven sin bajar en 390×844 y 375×667',async()=>{
    for(const viewport of [{width:390,height:844},{width:375,height:667}]){
      await page.setViewportSize(viewport);await page.evaluate(()=>window.scrollTo(0,0));
      const amounts=projection(page).locator('[data-projection-metric] .projection-amount');assert.equal(await amounts.count(),4);
      const boxes=await amounts.evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};}));
      const chrome=await page.evaluate(()=>{
        const fab=document.querySelector('#fabButton').getBoundingClientRect();
        return {height:innerHeight,width:innerWidth,header:document.querySelector('.topbar')?.getBoundingClientRect().bottom||0,
          nav:document.querySelector('.bottomnav').getBoundingClientRect().top,fab:{top:fab.top,bottom:fab.bottom,left:fab.left,right:fab.right}};
      });
      firstViewport.push({viewport,amounts:boxes,chrome});
      for(const box of boxes){
        assert.ok(box.top>=chrome.header,`Importe tapado por la cabecera: ${JSON.stringify(box)}`);
        assert.ok(box.bottom<=Math.min(550,chrome.nav),`Importe fuera del primer pantallazo ${viewport.width}×${viewport.height}: ${JSON.stringify(box)}`);
        assert.ok(box.left>=0&&box.right<=chrome.width,'Importe fuera del ancho del celular');
        const fabOverlaps=box.left<chrome.fab.right&&box.right>chrome.fab.left&&box.top<chrome.fab.bottom&&box.bottom>chrome.fab.top;
        assert.equal(fabOverlaps,false,'El botón flotante no debe tapar ningún importe');
      }
      // Las cuatro tarjetas forman dos filas de dos para que el total se pueda leer al entrar.
      const cardTops=await projection(page).locator('[data-projection-metric]').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top));
      assert.ok(Math.abs(cardTops[0]-cardTops[1])<3);assert.ok(Math.abs(cardTops[2]-cardTops[3])<3);
      assert.ok(cardTops[2]>cardTops[0]);assert.equal(await page.evaluate(()=>scrollY),0);
      await page.screenshot({path:path.join(output,`02-primer-pantallazo-${viewport.width}x${viewport.height}.png`),fullPage:false});
    }
    await page.setViewportSize({width:1440,height:1050});
  });

  await check('Próximo mes, en dos y en tres meses muestran el importe específico y conservan el mes exacto elegido',async()=>{
    for(const offset of [1,2,3]){
      const mes=monthDate(offset).slice(0,7);await projection(page).locator(`[data-projection-offset="${offset}"]`).click();
      assert.equal(await page.locator('#proyeccionMes').inputValue(),mes);
      assert.equal(normalize(await projection(page).locator('[data-projection-selected] .projection-selected-amount').innerText()),normalize(money(expected().month(mes))));
      assert.equal(await projection(page).locator(`[data-projection-month="${mes}"]`).getAttribute('aria-current'),'date');
    }
    await selectMonth(currentMonth);
  });

  await check('Meses vacíos se muestran en cero y una cuota a 15 meses es alcanzable por paginación y selector',async()=>{
    await openMonthDetail();
    const zeroRow=projection(page).locator(`[data-projection-month="${emptyMonth}"]`);
    assert.match(normalize(await zeroRow.innerText()),/\$ ?0/);
    assert.equal(await projection(page).locator('[data-projection-next]').isDisabled(),false);
    await projection(page).locator('[data-projection-next]').click();
    await projection(page).locator(`[data-projection-month="${farMonth}"]`).waitFor();
    assert.match(normalize(await projection(page).locator(`[data-projection-month="${farMonth}"]`).innerText()),/321\.000/);
    await capture('02-proyeccion-mes-lejano-escritorio');
    await projection(page).locator('[data-projection-prev]').click();
    await projection(page).locator(`[data-projection-month="${currentMonth}"]`).waitFor();
    await selectMonth(farMonth);
    await projection(page).locator(`[data-projection-month="${farMonth}"]`).waitFor();
    assert.equal(await projection(page).locator('[data-projection-detail]').evaluate(el=>el.open),true,'Navegar debe conservar el detalle abierto');
  });

  await check('Cambiar de negocio actualiza proyección y capital parcial sin contar entregas, mora ni cuotas pagadas/anuladas',async()=>{
    await switchStore(store.id,store.nombre);await expectMetrics(page,store.id);
    assert.equal(await page.locator('#proyeccionMes').inputValue(),currentMonth);
    await switchStore(otherStore.id,otherStore.nombre);await expectMetrics(page,otherStore.id);
    assert.equal(expected(otherStore.id).proximos7Dias,3300000);
    assert.equal(expected(otherStore.id).proximos14Dias,7700000);
    await capture('03-proyeccion-otro-negocio-escritorio');
  });

  await check('Negocio vacío: los cuatro indicadores y los doce meses iniciales quedan en cero',async()=>{
    await switchStore(emptyStore.id,emptyStore.nombre);await expectMetrics(page,emptyStore.id);
    await openMonthDetail();
    assert.equal(await projection(page).locator('[data-projection-month]').count(),12);
    assert.equal(await projection(page).locator('[data-projection-next]').isDisabled(),true);
    for(const row of await projection(page).locator('[data-projection-month]').all())assert.match(normalize(await row.innerText()),/\$ ?0/);
    await capture('04-proyeccion-vacia-escritorio');
  });

  await check('Móvil 390px: importes y navegación de meses se leen sin desborde aun con zona horaria distinta',async()=>{
    await page.setViewportSize({width:390,height:844});await switchStore(null,'Todos los negocios');await expectMetrics(page);
    await capture('05-proyeccion-global-movil');
    await selectMonth(farMonth);await openMonthDetail();
    await projection(page).locator(`[data-projection-month="${farMonth}"]`).waitFor();
    await capture('06-proyeccion-mes-lejano-movil');
  });

  await check('Actualizar consulta los importes otra vez y una versión sin proyección muestra un aviso recuperable',async()=>{
    const refresh=page.locator('[data-dashboard-refresh]').first();
    const next=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/dashboard/resumen'&&r.request().method()==='GET');
    await refresh.click();assert.equal((await next).status(),200);await projection(page).waitFor();
    await expectMetrics(page);
    const handler=async route=>{
      const response=await route.fetch(),body=await response.json();delete body.proyeccionCobros;
      await route.fulfill({response,json:body});
    };
    await context.route('**/api/dashboard/resumen',handler);
    await page.locator('[data-dashboard-refresh]').first().click();await page.locator('[data-projection-unavailable]').waitFor();
    assert.equal(await projection(page).count(),0);
    await context.unroute('**/api/dashboard/resumen',handler);
    await page.locator('[data-projection-unavailable] [data-dashboard-refresh]').click();await projection(page).waitFor();await expectMetrics(page);
    assert.equal(await page.locator('[data-projection-unavailable]').count(),0);
  });

  await check('Empleado: no ve la proyección y recibe 403 por API directa aunque conserve permiso financiero legado',async()=>{
    const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',timezoneId:'UTC',colorScheme:'dark',serviceWorkers:'block'});
    try {
      await restrict(ctx);const p=await ctx.newPage();await login(p,employee.email);
      await p.goto(base+'/#/inicio');await p.locator('#view').waitFor();await p.waitForLoadState('networkidle');
      assert.equal(await projection(p).count(),0);assert.doesNotMatch(await p.locator('#view').innerText(),/Cobros previstos/);
      for(const negocio of [null,store.id,otherStore.id]){
        const response=await fetchSummary(p,negocio);assert.equal(response.status,403);assert.equal(response.body.proyeccionCobros,undefined);
      }
      await p.screenshot({path:path.join(output,'07-dashboard-empleado-movil.png'),fullPage:true});
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    } finally {await ctx.close();}
  });

  await check('Consultar la proyección no modifica pagos, cuotas, comprobantes ni auditoría',async()=>{
    assert.deepEqual(await snapshot(),initialSnapshot);assert.deepEqual(errors,[],'Errores JavaScript del navegador');
  });
  await Promise.all(['fallo.png','fallo.html'].map(name=>fs.rm(path.join(output,name),{force:true})));
  console.log(`${results.length} E2E checks passed`);
} catch(error) {
  failed=error;if(page){await page.screenshot({path:path.join(output,'fallo.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo.html'),await page.content()).catch(()=>{});}
} finally {
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),results,javascriptErrors:errors,
    loadedAssets,firstViewport,externalRequestsBlocked:[...new Set(externalRequestsBlocked)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
