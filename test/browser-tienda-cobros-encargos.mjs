// Navegador real y datos ficticios exclusivamente en PostgreSQL local descartable.
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
import {moverStock} from '../src/services/productosService.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {guardarConfigTienda,crearProductoTienda} from '../src/services/tiendasService.js';
import {guardarCaja,abrirCaja} from '../src/services/cajaService.js';
import {todayAR,addDays} from '../src/lib/dates.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-tienda-cobros-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],requests=[],publicRequests=[],rejectedResponses=[],measurements=[],captures=[],external=[];
let browser,server,owner,customer,staffPage,failed,createdOrder,transfer,cash;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
const unchangedTables=['ventas','creditos','cuotas','pago_aplicaciones','comision_acuerdos','comision_generaciones','comision_eventos'];
const financialSnapshot=async()=>Object.fromEntries(await Promise.all(unchangedTables.map(async table=>[table,await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));

try {
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='solo-qa-cobros-encargos-123',password_hash=await bcrypt.hash(password,10);
  const admin=await crearUsuario({email:'jefe@cobros-browser.invalid',nombre:'Jefe ficticio QA',password_hash});
  const staff=await crearUsuario({email:'pedidos@cobros-browser.invalid',nombre:'Empleado pedidos QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Tienda encargos ficticia QA',mora_valor:0}),other=await crearNegocio({nombre:'Otra tienda ficticia QA',mora_valor:0});
  await asignarNegocio(staff.id,store.id,{'tienda.pedidos':true});
  const available=await crearProducto({negocio_id:store.id,nombre:'Funda disponible QA',categoria:'Fundas',stock:3,precio_contado_centavos:3000000});
  const unavailable=await crearProducto({negocio_id:store.id,nombre:'Funda por encargo QA',categoria:'Fundas',stock:0,precio_contado_centavos:5000000});
  const unrelated=await crearProducto({negocio_id:store.id,nombre:'Venta anterior QA',stock:4,precio_contado_centavos:1000000});
  const foreign=await crearProducto({negocio_id:other.id,nombre:'Stock de otro negocio QA',stock:9,precio_contado_centavos:800000});
  const listing=async p=>crearProductoTienda(store.id,{negocio_id:store.id,producto_id:p.id,publicado:true,precio_centavos:p.precio_contado_centavos,modelos:['iPhone 13 Pro'],solicitud_id:randomUUID()},admin.id);
  const availableWeb=await listing(available),unavailableWeb=await listing(unavailable);
  await guardarConfigTienda(store.id,{negocio_id:store.id,habilitada:true,slug:'cobros-encargos-qa',nombre:store.nombre,tipo:'iphone',secciones:['Fundas'],solicitud_id:randomUUID()},admin.id);
  const caja=await guardarCaja(null,{nombre:'Caja cobros QA',activa:true,arqueo:true,modalidad:'negocio',negocios:[store.id]},admin.id);
  const session=await abrirCaja(caja.id,{inicial:0,solicitud_id:randomUUID()},admin.id);
  const oldClient=await crearCliente({nombre:'Cliente anterior',apellido:'Ficticio QA',negocio_id:store.id});
  const oldSale=await crearVenta({negocio_id:store.id,cliente_id:oldClient.id,usuario_id:admin.id,fecha:todayAR(),modalidad:'unico',monto_total_centavos:1000000,
    items:[{producto_id:unrelated.id,cantidad:1,precio_unitario_centavos:1000000}],plan:{fecha_limite:addDays(todayAR(),30)}});
  const oldPayment=await registrarPago({credito_id:oldSale.credito.id,monto_centavos:500000,medio_pago:'efectivo',usuario_id:admin.id});
  const before=await financialSnapshot(),oldPaymentRow=await db.prepare('SELECT * FROM pagos WHERE id=?').get(oldPayment.pago.id);
  const initialMoney=await db.prepare('SELECT count(*)::int cantidad FROM pagos').get();
  assert.equal(initialMoney.cantidad,1);
  server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  async function context(viewport={width:390,height:844}) {
    const ctx=await browser.newContext({viewport,locale:'es-AR',timezoneId:'America/Argentina/Buenos_Aires',serviceWorkers:'block'});
    await ctx.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin===base)return route.continue();external.push(url);return route.abort('blockedbyclient');});
    ctx.on('page',page=>{
      page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
      page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(request.method()!=='POST')return;if(pathname.startsWith('/api/tiendas/pedidos/'))requests.push({path:pathname,body:request.postDataJSON()});if(pathname==='/api/tienda-publica/cobros-encargos-qa/pedidos')publicRequests.push({path:pathname,body:request.postDataJSON()});});
      page.on('response',async response=>{if(response.status()>=400&&new URL(response.url()).origin===base)rejectedResponses.push({path:new URL(response.url()).pathname,status:response.status(),body:(await response.text().catch(()=>'' )).slice(0,1000)});});
    });
    return ctx;
  }
  const ownerContext=await context(),customerContext=await context(),staffContext=await context();
  owner=await ownerContext.newPage();customer=await customerContext.newPage();staffPage=await staffContext.newPage();
  async function login(page,user) {
    await page.goto(base);await page.locator('#authEmail').fill(user.email);await page.locator('#authPassword').fill(password);await page.locator('#authSubmit').click();await page.locator('#root').waitFor({state:'visible'});
  }
  async function selectStore(page) {
    await page.locator('#btnNegocioSwitch').click();await page.locator(`[data-action="elegir-negocio"][data-id="${store.id}"]`).click();await page.locator('#activeSheet').waitFor({state:'detached'});
    await page.evaluate(()=>{location.hash='#/tienda';});await page.locator('.tienda-admin h1').waitFor();
  }
  async function privateApi(page,pathname,method='GET',body) {
    return page.evaluate(async({pathname,method,body})=>{const response=await fetch('/api'+pathname,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('zilky_token')},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};},{pathname,method,body});
  }
  const detail=page=>privateApi(page,'/tiendas/pedidos/'+createdOrder.id+'?negocio_id='+store.id);
  async function openOrder(page,{tab='pedidos'}={}) {
    await page.locator(`[data-ta-tab="${tab}"]`).click();await page.locator(`[data-ta-order="${createdOrder.id}"]`).click();await page.locator('#ta-order-detail .ta-order-detail').waitFor();
  }
  async function capture(page,name) {
    await page.waitForFunction(()=>!document.querySelector('.toast'));
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
    const bounds=await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].map(element=>{const rect=element.getBoundingClientRect();return {selector:element.tagName.toLowerCase()+(element.id?'#'+element.id:''),text:(element.textContent||'').trim().slice(0,100),left:rect.left,right:rect.right,width:rect.width,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth};}).filter(e=>e.width>0&&(e.left<-1||e.right>innerWidth+1||e.scrollWidth>e.clientWidth+1)).slice(0,30)}));
    measurements.push({name,...bounds});assert.ok(bounds.documentWidth<=bounds.viewport,'Desborde horizontal en '+name+': '+JSON.stringify(bounds));captures.push(name);
    const heading=page.locator('#ta-order-detail .ta-order-detail h2');
    if(await heading.count()){const size=await heading.evaluate(e=>({right:e.getBoundingClientRect().right,viewport:innerWidth,client:e.clientWidth,scroll:e.scrollWidth}));assert.ok(size.right<=size.viewport&&size.scroll<=size.client+1,'Código de pedido fuera de su tarjeta: '+JSON.stringify(size));}
  }
  const webPayments=()=>db.prepare("SELECT * FROM pagos WHERE negocio_id=? AND tipo='pedido_web' ORDER BY id").all(store.id);
  const webStock=async()=>[(await getProducto(available.id)).stock,(await getProducto(unavailable.id)).stock];

  await check('Carrito mixto agrega un producto disponible y otro de stock cero con Pedir por encargo',async()=>{
    await customer.goto(base+'/tienda/cobros-encargos-qa');await customer.locator('#shopContent').waitFor({state:'visible'});
    await customer.locator('#modelFilter').selectOption('iPhone 13 Pro');
    const encargo=customer.locator(`[data-add="${unavailableWeb.id}"][data-encargo="true"]`);assert.match(await encargo.innerText(),/Pedir por encargo/i);assert.equal(await encargo.isEnabled(),true);
    await customer.setViewportSize({width:1440,height:1050});await capture(customer,'00-catalogo-encargos-escritorio');await customer.setViewportSize({width:390,height:844});
    await customer.locator(`[data-add="${availableWeb.id}"][data-encargo="false"]`).click();await encargo.click();
    assert.equal(await customer.locator('#cartCount').innerText(),'2');await customer.locator('#openCart').click();
    assert.equal(await customer.locator(`[data-cart-item="${unavailableWeb.id}"][data-encargo="true"] [data-cart-encargo]`).count(),1);
    assert.match(await customer.locator('#cartDialog').innerText(),/Para encargar|Por encargo/i);
    await customer.locator('#orderName').fill('Compradora ficticia');await customer.locator('#orderSurname').fill('Encargo QA');await customer.locator('#orderPhone').fill('11 2345 6789');await customer.locator('#orderEmail').fill('compradora@encargos.invalid');
    await customer.locator('#orderNote').fill('Solicitud ficticia para coordinar entrega QA.');await customer.locator('#orderConsent').check();await capture(customer,'01-carrito-mixto-encargo-movil');
    const pending=customer.waitForResponse(response=>new URL(response.url()).pathname==='/api/tienda-publica/cobros-encargos-qa/pedidos'&&response.request().method()==='POST');await customer.locator('#submitOrder').click();
    const response=await pending;assert.equal(response.status(),201);createdOrder=await response.json();await customer.locator('#orderSuccess').waitFor({state:'visible'});
    assert.equal(createdOrder.total_centavos,8000000);assert.equal(createdOrder.items.find(item=>item.producto_id===unavailableWeb.id).es_encargo,true);assert.equal(createdOrder.items.find(item=>item.producto_id===availableWeb.id).es_encargo,false);
    assert.equal(createdOrder.cobros,undefined);assert.equal(createdOrder.resumen_cobros,undefined);assert.equal(createdOrder.comprobante,undefined);assert.equal(createdOrder.contacto,undefined);
    assert.deepEqual(await webStock(),[3,0]);assert.deepEqual(await financialSnapshot(),before);assert.deepEqual(await webPayments(),[]);
    const item=await db.prepare('SELECT es_encargo,opciones FROM tienda_pedido_items WHERE pedido_id=? AND producto_web_id=?').get(createdOrder.id,unavailableWeb.id);
    assert.equal(item.es_encargo,true);assert.deepEqual(item.opciones.modelos,['iPhone 13 Pro']);await capture(customer,'02-encargo-recibido-movil');
  });

  await check('Encargos conserva los datos elegidos y bloquea confirmar hasta reponer el stock',async()=>{
    await db.prepare('UPDATE tienda_productos SET modelos=?::jsonb,nombre=? WHERE id=?').run(JSON.stringify(['iPhone 16 Pro']),'Nombre posterior del catálogo QA',unavailableWeb.id);
    await login(owner,admin);await selectStore(owner);await openOrder(owner,{tab:'encargos'});
    assert.match(await owner.locator('#ta-order-detail').innerText(),/Por encargo|Encargo|Para encargar/i);assert.match(await owner.locator('#ta-order-detail').innerText(),/iPhone 13 Pro/);assert.doesNotMatch(await owner.locator('#ta-order-detail').innerText(),/Nombre posterior del catálogo QA/);
    assert.equal(await owner.locator(`[data-ta-confirm="${createdOrder.id}"]`).isDisabled(),true);assert.equal(await owner.locator('#ta-payment-form').count(),0);
    const current=await detail(owner);assert.equal(current.status,200);assert.equal(current.body.has_encargos,true);assert.equal(current.body.resumen_cobros.estado,'sin_cobrar');
    const denied=await privateApi(owner,'/tiendas/pedidos/'+createdOrder.id+'/confirmar','POST',{negocio_id:store.id,solicitud_id:randomUUID(),version:current.body.version});assert.equal(denied.status,409);
    assert.deepEqual(await webStock(),[3,0]);assert.deepEqual(await webPayments(),[]);
    for(const width of [375,390]){await owner.setViewportSize({width,height:844});await capture(owner,'03-encargo-sin-stock-'+width+'px');}
    await moverStock(unavailable.id,store.id,{tipo:'reposicion',cantidad:1,motivo:'Reposición ficticia para entregar encargo QA',solicitud_id:randomUUID()},admin.id);
    await owner.locator(`#ta-order-detail [data-ta-order="${createdOrder.id}"]`).click();await owner.waitForFunction(id=>!document.querySelector(`[data-ta-confirm="${id}"]`)?.disabled,createdOrder.id);
    const confirmed=owner.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/'+createdOrder.id+'/confirmar')&&response.request().method()==='POST');
    await owner.locator(`[data-ta-confirm="${createdOrder.id}"]`).evaluate(button=>{button.click();button.click();});assert.equal((await confirmed).status(),200);await owner.locator('[data-ta-payment-summary][data-estado="sin_cobrar"]').waitFor();
    assert.deepEqual(await webStock(),[2,0]);assert.deepEqual(await webPayments(),[]);
    const movements=await db.prepare("SELECT producto_id,count(*)::int cantidad FROM producto_historial WHERE tipo='pedido_web' AND detalles->>'pedido_id'=? GROUP BY producto_id ORDER BY producto_id").all(createdOrder.id);assert.equal(movements.length,2);assert.ok(movements.every(m=>m.cantidad===1));
    const first=requests.find(r=>r.path.endsWith('/'+createdOrder.id+'/confirmar')&&r.body.solicitud_id!==undefined&&r.body.version!==current.body.version);
    assert.ok(first);assert.equal((await privateApi(owner,first.path.replace('/api',''),'POST',first.body)).status,200);assert.deepEqual(await webStock(),[2,0]);await capture(owner,'04-venta-confirmada-sin-cobrar-movil');
  });

  await check('Empleado con sólo pedidos consulta el resumen; al recibir permiso registra un cobro parcial por transferencia',async()=>{
    await login(staffPage,staff);await selectStore(staffPage);await openOrder(staffPage);
    assert.equal(await staffPage.locator('[data-ta-payment-summary][data-estado="sin_cobrar"]').count(),1);assert.equal(await staffPage.locator('#ta-payment-form').count(),0);
    const current=await detail(staffPage);const denied=await privateApi(staffPage,'/tiendas/pedidos/'+createdOrder.id+'/cobros','POST',{negocio_id:store.id,solicitud_id:randomUUID(),version:current.body.version,monto_centavos:1000000,medio_pago:'transferencia'});assert.equal(denied.status,403);
    assert.equal((await privateApi(staffPage,'/tiendas/pedidos?negocio_id='+other.id)).status,403);
    await capture(staffPage,'05-empleado-solo-pedidos-movil');
    await asignarNegocio(staff.id,store.id,{'tienda.pedidos':true,'pagos.registrar':true});await staffPage.reload();await staffPage.locator('#root').waitFor({state:'visible'});await selectStore(staffPage);await openOrder(staffPage);
    await staffPage.locator('#ta-payment-form [name="monto"]').fill('10000');await staffPage.locator('#ta-payment-form [name="medio_pago"]').selectOption('transferencia');await staffPage.locator('#ta-payment-form [name="nota"]').fill('Transferencia parcial ficticia QA');
    const paid=staffPage.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/'+createdOrder.id+'/cobros')&&response.request().method()==='POST');
    const requestCount=requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).length;
    await staffPage.locator('#ta-payment-form button[type="submit"]').evaluate(button=>{button.click();button.click();});const response=await paid;assert.equal(response.status(),201);
    const result=await response.json();assert.deepEqual(result.resumen_cobros,{cobrado_centavos:1000000,saldo_centavos:7000000,estado:'parcial'});transfer=result.cobros[0];assert.equal(transfer.usuario_id,staff.id);
    await staffPage.locator('[data-ta-payment-summary][data-estado="parcial"]').waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).length,requestCount+1);
    assert.equal(await staffPage.locator('[data-ta-payment-void]').count(),0);assert.deepEqual(await webStock(),[2,0]);assert.equal((await webPayments()).length,1);await capture(staffPage,'06-transferencia-parcial-empleado-movil');
  });

  await check('El saldo se cobra en efectivo y una respuesta perdida conserva la misma solicitud sin duplicar dinero ni stock',async()=>{
    await openOrder(owner);await owner.locator('#ta-payment-form').waitFor();assert.equal(Number(await owner.locator('#ta-payment-form [name="monto"]').inputValue()),70000);
    await owner.locator('#ta-payment-form [name="medio_pago"]').selectOption('efectivo');await owner.locator('#ta-payment-form [name="nota"]').fill('Saldo en efectivo ficticio QA');
    const paymentUrl='**/api/tiendas/pedidos/'+createdOrder.id+'/cobros';let lost=true,committedResponse;
    const intercept=async route=>{if(route.request().method()==='POST'&&lost){lost=false;const response=await route.fetch();assert.equal(response.status(),201);committedResponse=await response.json();await route.abort('connectionfailed');return;}await route.continue();};
    await owner.route(paymentUrl,intercept);
    const beforeCount=requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).length;
    await owner.locator('#ta-payment-form button[type="submit"]').evaluate(button=>{button.click();button.click();});await owner.locator('[data-ta-retry]:enabled').waitFor();
    assert.equal(requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).length,beforeCount+1);assert.equal((await webPayments()).length,2);assert.deepEqual(await webStock(),[2,0]);
    const original=requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).at(-1);assert.equal(original.body.monto_centavos,7000000);
    await capture(owner,'07-cobro-respuesta-perdida-movil');
    const retried=owner.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/'+createdOrder.id+'/cobros')&&response.request().method()==='POST');await owner.locator('[data-ta-retry]').click();assert.ok([200,201].includes((await retried).status()));
    await owner.locator('[data-ta-payment-summary][data-estado="cobrado"]').waitFor();assert.deepEqual(requests.filter(r=>r.path.endsWith('/'+createdOrder.id+'/cobros')).at(-1).body,original.body);
    assert.deepEqual(committedResponse.resumen_cobros,{cobrado_centavos:8000000,saldo_centavos:0,estado:'cobrado'});cash=committedResponse.cobros.find(c=>c.medio_pago==='efectivo');assert.ok(cash);
    assert.equal((await webPayments()).length,2);assert.deepEqual(await webStock(),[2,0]);await owner.unroute(paymentUrl,intercept);await capture(owner,'08-pedido-cobrado-completo-movil');
  });

  await check('Los cobros figuran una sola vez en pagos, comprobantes, Dashboard y caja junto con los pagos de cuotas',async()=>{
    const payments=await webPayments();assert.equal(payments.length,2);assert.equal(payments.reduce((s,p)=>s+p.monto_centavos,0),8000000);assert.ok(payments.every(p=>p.credito_id===null&&p.tipo==='pedido_web'&&p.anulado===0));
    for(const cobro of [transfer,cash]){
      const receipt=await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(cobro.comprobante_id);assert.equal(receipt.pago_id,cobro.pago_id);assert.equal(receipt.venta_id,null);assert.equal(receipt.credito_id,null);assert.equal(receipt.estado,'emitido');
      assert.equal((await privateApi(owner,'/comprobantes/'+receipt.id)).status,200);assert.equal((await fetch(base+'/api/comprobantes/'+receipt.id)).status,401);
    }
    const dashboard=await privateApi(owner,'/dashboard/resumen?negocio_id='+store.id);assert.equal(dashboard.status,200);assert.equal(dashboard.body.cobradoHoyCentavos,8500000);assert.equal(dashboard.body.cobradoMesCentavos,8500000);
    const cashbox=await privateApi(owner,'/cajas/'+caja.id);assert.equal(cashbox.status,200);
    const current=cashbox.body.sesiones.find(s=>s.id===session.id);assert.equal(current.medios.efectivo,7500000);assert.equal(current.medios.transferencia,1000000);assert.equal(current.efectivo_esperado,7500000);
    for(const pago of payments)assert.equal(cashbox.body.movimientos.filter(a=>a.pago_id===pago.id&&a.tipo==='cobro').length,1);
    assert.deepEqual(await financialSnapshot(),before);assert.deepEqual(await db.prepare('SELECT * FROM pagos WHERE id=?').get(oldPayment.pago.id),oldPaymentRow);
    assert.equal((await getProducto(unrelated.id)).stock,3);assert.equal((await getProducto(foreign.id)).stock,9);
    const publicRetry=await customer.evaluate(async body=>{const response=await fetch('/api/tienda-publica/cobros-encargos-qa/pedidos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};},publicRequests[0].body);
    assert.equal(publicRetry.status,201);for(const field of ['cobros','resumen_cobros','pagos','comprobante','cliente_id','contacto'])assert.equal(publicRetry.body[field],undefined,field);
  });

  await check('Cancelar una venta cobrada repone sus unidades una sola vez y conserva el dinero y los comprobantes',async()=>{
    const payments=await webPayments(),receipts=await db.prepare('SELECT * FROM comprobantes WHERE pago_id=ANY(?::text[]) ORDER BY id').all(payments.map(p=>p.id));
    await owner.locator('#ta-order-detail details.ta-cancel summary').click();await owner.locator('#ta-cancel-reason').fill('Cancelación ficticia posterior a cobros QA');
    const pending=owner.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/'+createdOrder.id+'/cancelar')&&response.request().method()==='POST');await owner.locator(`[data-ta-cancel="${createdOrder.id}"]`).click();assert.equal((await pending).status(),200);
    await owner.locator('#ta-order-detail .ta-tag').filter({hasText:'Cancelado'}).first().waitFor();assert.deepEqual(await webStock(),[3,1]);assert.deepEqual(await webPayments(),payments);
    assert.deepEqual(await db.prepare('SELECT * FROM comprobantes WHERE pago_id=ANY(?::text[]) ORDER BY id').all(payments.map(p=>p.id)),receipts);
    assert.equal(await owner.locator('[data-ta-payment-summary][data-estado="cobrado"]').count(),1);assert.equal(await owner.locator('#ta-payment-form').count(),0);
    const repeated=requests.find(r=>r.path.endsWith('/'+createdOrder.id+'/cancelar'));assert.equal((await privateApi(owner,repeated.path.replace('/api',''),'POST',repeated.body)).status,200);assert.deepEqual(await webStock(),[3,1]);
    await capture(owner,'09-cancelado-con-cobros-preservados-movil');
  });

  await check('Anular un cobro requiere permiso propio, conserva el original y actualiza el resumen sin mover stock ni simular reintegro',async()=>{
    const refreshed=await detail(staffPage);assert.equal((await privateApi(staffPage,'/tiendas/pedidos/'+createdOrder.id+'/cobros/'+transfer.id+'/anular','POST',{negocio_id:store.id,version:refreshed.body.version,solicitud_id:randomUUID(),motivo:'Intento sin permiso QA'})).status,403);
    await owner.locator(`[data-ta-payment-void="${transfer.id}"]`).click();await owner.locator('#ta-payment-void-form [name="motivo"]').fill('Corrección ficticia del registro de transferencia QA');
    const response=owner.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/cobros/'+transfer.id+'/anular')&&r.request().method()==='POST');await owner.locator('#ta-payment-void-form button[type="submit"]').click();assert.equal((await response).status(),200);
    await owner.locator('[data-ta-payment-summary][data-estado="parcial"]').waitFor();const current=await detail(owner);assert.deepEqual(current.body.resumen_cobros,{cobrado_centavos:7000000,saldo_centavos:1000000,estado:'parcial'});
    const original=await db.prepare('SELECT * FROM pagos WHERE id=?').get(transfer.pago_id);assert.equal(original.anulado,1);assert.equal(original.monto_centavos,1000000);assert.equal(original.medio_pago,'transferencia');
    const receipt=await db.prepare('SELECT * FROM comprobantes WHERE id=?').get(transfer.comprobante_id);assert.equal(receipt.estado,'anulado');assert.equal(receipt.monto_centavos,1000000);
    const asientos=await db.prepare('SELECT * FROM caja_asientos WHERE pago_id=? ORDER BY tipo').all(transfer.pago_id);assert.equal(asientos.length,2);assert.equal(asientos.find(a=>a.tipo==='cobro').monto,1000000);assert.equal(asientos.find(a=>a.tipo==='anulacion').monto,-1000000);assert.equal(asientos.find(a=>a.tipo==='anulacion').sesion_id,null);
    assert.equal((await webPayments()).length,2);assert.deepEqual(await webStock(),[3,1]);assert.equal((await privateApi(owner,'/dashboard/resumen?negocio_id='+store.id)).body.cobradoHoyCentavos,7500000);
    assert.equal((await db.prepare("SELECT count(*)::int cantidad FROM auditoria WHERE entidad_id=? AND accion='anular_pedido_web'").get(transfer.pago_id)).cantidad,1);
    assert.deepEqual(await financialSnapshot(),before);assert.deepEqual(await db.prepare('SELECT * FROM pagos WHERE id=?').get(oldPayment.pago.id),oldPaymentRow);await capture(owner,'10-cobro-anulado-con-historial-movil');
    await owner.setViewportSize({width:1440,height:1050});await capture(owner,'11-cobros-encargos-escritorio');
  });

  await check('Los flujos públicos y privados terminan sin errores JavaScript ni desbordes',async()=>{assert.deepEqual(errors,[]);});
  await Promise.all(['jefe','publica','empleado'].flatMap(name=>['png','html'].map(extension=>fs.rm(path.join(output,`fallo-${name}.${extension}`),{force:true}))));
  console.log(`${results.length} E2E checks passed`);
}catch(error){
  failed=error;
  for(const [name,page] of [['jefe',owner],['publica',customer],['empleado',staffPage]])if(page){await page.screenshot({path:path.join(output,'fallo-'+name+'.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'fallo-'+name+'.html'),await page.content()).catch(()=>{});}
}finally{
  await fs.writeFile(path.join(output,'resultado.json'),JSON.stringify({results,javascriptErrors:errors,captures,requests,publicRequests,rejectedResponses,measurements,externalRequestsBlocked:[...new Set(external)],...(failed?{error:failed.stack}:{})},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
}
if(failed)throw failed;
