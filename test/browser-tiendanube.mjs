// Release pausado en navegador real. Solo PostgreSQL local descartable y API
// Tiendanube ficticia: nunca usa una sesión, credencial o inventario real.
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

process.env.TIENDANUBE_SYNC_ENABLED='false';
process.env.TIENDANUBE_ENTREGAS_ENABLED='false';
process.env.TIENDANUBE_RESERVAS_ENABLED='false';
process.env.TIENDANUBE_APP_SECRET='secreto-ficticio-browser-no-real';
process.env.TIENDANUBE_TOKEN_KEY='b'.repeat(64);
const nativeFetch=globalThis.fetch,remoteReads=[];
globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);
  assert.equal(u.origin,'https://api.tiendanube.com');
  assert.equal(options.method,'GET','El browser de release pausado no escribe en Tiendanube');
  assert.ok(['/2025-03/987654321/products','/2025-03/987654321/orders'].includes(u.pathname));
  remoteReads.push(u.pathname+u.search);
  if(u.pathname.endsWith('/orders'))return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify([{id:10,name:{es:'Remera rosa QA'},attributes:[{es:'Color'},{es:'Talle'}],
    variants:[{id:101,product_id:10,sku:'QA-ROSA-M',values:[{es:'Rosa'},{es:'M'}],stock:5}]}]),
    {status:200,headers:{'Content-Type':'application/json'}});
};
const {app}=await import('../src/app.js');
const {db,pool}=await import('../src/db/connection.js');
const {migrate}=await import('../src/db/migrate.js');
const {crearUsuario,asignarNegocio}=await import('../src/repositories/usuarios.js');
const {crearNegocio}=await import('../src/repositories/negocios.js');
const {crearProducto}=await import('../src/repositories/productos.js');
const {guardarConfigTienda,crearProductoTienda}=await import('../src/services/tiendasService.js');
const {cifrarToken}=await import('../src/lib/tiendanube.js');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.BROWSER_ARTIFACTS||'/tmp/zilky-tiendanube-browser';
await fs.mkdir(output,{recursive:true});
const results=[],errors=[],external=[],blockedAssets=[],writes=[],captures=[];
let browser,server,failure;
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(e){results.push({name,passed:false,error:e.message});throw e;}};
try{
  await migrate();
  await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
  const password='ficticia-tiendanube-browser-123',password_hash=await bcrypt.hash(password,10);
  const owner=await crearUsuario({email:'owner@tn-browser.invalid',nombre:'Dueño QA',password_hash});
  const staff=await crearUsuario({email:'staff@tn-browser.invalid',nombre:'Empleado QA',rol:'empleado',password_hash});
  const denied=await crearUsuario({email:'denied@tn-browser.invalid',nombre:'Sin permiso QA',rol:'empleado',password_hash});
  const store=await crearNegocio({nombre:'Ropa ficticia QA'});
  await db.prepare('INSERT INTO organizaciones(id,nombre) VALUES(?,?)').run('tn-browser-org','Organización QA');
  await db.prepare('UPDATE negocios SET organizacion_id=? WHERE id=?').run('tn-browser-org',store.id);
  await db.prepare('INSERT INTO usuario_organizacion(usuario_id,organizacion_id,rol,activo) VALUES(?,?,?,1)').run(owner.id,'tn-browser-org','administrador');
  await asignarNegocio(staff.id,store.id,{'tienda.pedidos':true,'ventas.crear':true,'productos.ver':true});
  await asignarNegocio(denied.id,store.id,{'productos.ver':true});
  const product=await crearProducto({negocio_id:store.id,nombre:'Remera rosa QA',variante:'Rosa · M',sku:'QA-ROSA-M',stock:5,precio_contado_centavos:4000000});
  await crearProductoTienda(store.id,{negocio_id:store.id,producto_id:product.id,publicado:true,precio_centavos:4000000,solicitud_id:randomUUID()},owner.id);
  await guardarConfigTienda(store.id,{negocio_id:store.id,habilitada:true,slug:'tn-preservar-original-qa',nombre:'Ropa ficticia QA',tipo:'ropa',secciones:[],solicitud_id:randomUUID()},owner.id);
  await db.prepare('INSERT INTO tiendanube_conexiones(negocio_id,store_id,app_id,token_cifrado,scopes,pausada) VALUES(?,?,?,?,?,TRUE)')
    .run(store.id,'987654321','51162',cifrarToken('TOKEN-FICTICIO-NO-REAL'),'write_products,read_orders');
  const unchanged=['productos','producto_historial','ventas','creditos','cuotas','pagos','pago_aplicaciones','comprobantes',
    'comision_acuerdos','comision_generaciones','comision_eventos','tiendas_config','tienda_productos',
    'tiendanube_conexiones','tiendanube_variantes','tiendanube_stock_outbox','tiendanube_eventos','tiendanube_pedidos',
    'tiendanube_pedido_stock','tiendanube_entregas','tiendanube_reserva_intentos','tiendanube_privacidad_solicitudes'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(unchanged.map(async table=>[table,(await db.query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.r)])));
  const before=await snapshot();
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  async function pageFor(user){
    const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'es-AR',timezoneId:'America/Argentina/Buenos_Aires',serviceWorkers:'block'});
    await ctx.route('**/*',route=>{
      const url=route.request().url(),parsed=new URL(url);
      if(parsed.origin===base)return route.continue();
      // La shell usa esta fuente externa. Simular su hoja vacía mantiene el
      // browser aislado sin confundir un asset conocido con una fuga de datos.
      if(parsed.origin==='https://fonts.googleapis.com'&&parsed.pathname==='/css2'){
        blockedAssets.push(parsed.origin+parsed.pathname);return route.fulfill({status:200,contentType:'text/css',body:''});
      }
      external.push(url);return route.abort('blockedbyclient');
    });
    const page=await ctx.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/api/tiendanube'))writes.push({method:r.method(),path:new URL(r.url()).pathname});});
    await page.goto(base);await page.locator('#authEmail').fill(user.email);await page.locator('#authPassword').fill(password);await page.locator('#authSubmit').click();await page.locator('#root').waitFor({state:'visible'});
    await page.locator('#btnNegocioSwitch').click();await page.locator(`[data-action="elegir-negocio"][data-id="${store.id}"]`).click();await page.locator('#activeSheet').waitFor({state:'detached'});
    return page;
  }
  const admin=await pageFor(owner),employee=await pageFor(staff),noAccess=await pageFor(denied);
  const go=async(page,hash)=>page.evaluate(hash=>{location.hash=hash;},hash);
  const waitText=async(page,selector,pattern)=>page.waitForFunction(({selector,pattern})=>new RegExp(pattern).test(document.querySelector(selector)?.textContent||''),{selector,pattern});
  await check('administrador ve conexión pausada, variantes y comprobaciones sin escrituras',async()=>{
    await go(admin,'#/tiendanube');await admin.locator('[data-tn-form]').waitFor();
    await waitText(admin,'[data-tn-diagnostic]','Apagado en el servidor');
    await admin.locator('[name="variante_remota"] option[value="10:101"]').waitFor({state:'attached'});
    assert.match(await admin.locator('#view').innerText(),/Conectada · sincronización pausada/);
    assert.equal(await admin.locator('[data-tn-link]').isDisabled(),true);
    assert.equal(writes.length,0);assert.ok(remoteReads.length>0);
  });
  await check('diseño pausado no desborda en celular, tablet ni escritorio',async()=>{
    for(const size of [{width:390,height:844},{width:768,height:1024},{width:1440,height:900}]){
      await admin.setViewportSize(size);await admin.evaluate(()=>document.fonts.ready);
      const layout=await admin.evaluate(()=>({inner:innerWidth,width:document.documentElement.scrollWidth}));
      assert.ok(layout.width<=layout.inner+1,JSON.stringify(layout));
      const name=`tiendanube-${size.width}.png`;await admin.screenshot({path:path.join(output,name),fullPage:true});captures.push(name);
    }
  });
  await check('empleado autorizado entra a pedidos pero no a conexión ni conciliación administrativa',async()=>{
    await go(employee,'#/tiendanube/pedidos');await waitText(employee,'[data-tn-message]','todavía no está habilitada');
    assert.equal(await employee.locator('[data-tn-confirm-delivery]').count(),0);
    for(const hash of ['#/tiendanube','#/tiendanube/privacidad','#/tiendanube/baseline']){
      await go(employee,hash);await waitText(employee,'#view','Requiere administrador');
    }
    await go(noAccess,'#/tiendanube/pedidos');await waitText(noAccess,'#view','permiso para gestionar pedidos y ventas');
  });
  await check('administrador accede a las revisiones separadas sin activar ni borrar nada',async()=>{
    await go(admin,'#/tiendanube/baseline');await admin.locator('[data-tn-baseline-refresh]').waitFor();
    await waitText(admin,'#view','no confirma|solo lectura|Solo lectura');
    await admin.locator('[data-tn-baseline-revalidate]:not([disabled])').waitFor();
    await go(admin,'#/tiendanube/privacidad');await waitText(admin,'#view','No hay solicitudes');
    await admin.locator('[data-privacy-refresh]:not([disabled])').waitFor();
    assert.equal(writes.length,0);
  });
  await check('la web original sigue accesible y conserva prendas y precio',async()=>{
    const customer=await browser.newPage();customer.on('pageerror',e=>errors.push(e.message));
    await customer.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    await customer.goto(base+'/tienda/tn-preservar-original-qa');await waitText(customer,'body','Remera rosa QA');
    assert.match(await customer.locator('body').innerText(),/40[.\s]000/);
    await customer.close();assert.deepEqual(await snapshot(),before);assert.equal(writes.length,0);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}catch(error){failure=error;console.error(error);}finally{
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,errors,external,blockedAssets,writes,remoteReads,captures},null,2));
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  globalThis.fetch=nativeFetch;await pool.end();
}
if(failure)process.exitCode=1;
