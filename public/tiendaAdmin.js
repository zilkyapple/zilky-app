const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format(Number(value||0)/100);
const lines=value=>[...new Set(String(value||'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean))];
const sections={iphone:['Fundas','Accesorios','Auriculares'],ropa:['Short','Jean','Jogging','Remeras','Zapas','Medias','Deportivo','Oldmoney','Oversize','Sastre'],general:['Novedades','Productos']};
const models=['iPhone SE','iPhone 11','iPhone 11 Pro','iPhone 11 Pro Max','iPhone 12 mini','iPhone 12','iPhone 12 Pro','iPhone 12 Pro Max','iPhone 13 mini','iPhone 13','iPhone 13 Pro','iPhone 13 Pro Max','iPhone 14','iPhone 14 Plus','iPhone 14 Pro','iPhone 14 Pro Max','iPhone 15','iPhone 15 Plus','iPhone 15 Pro','iPhone 15 Pro Max','iPhone 16','iPhone 16 Plus','iPhone 16 Pro','iPhone 16 Pro Max','iPhone 16e','iPhone 17','iPhone 17 Pro','iPhone 17 Pro Max','iPhone Air'];
const mediaTypes=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime']);
const orderLabels={pendiente:'Pendiente',confirmado:'Confirmado',cancelado:'Cancelado'};

export async function optimizarFoto(file,valid=()=>true){
  if(!valid()||!['image/jpeg','image/png','image/webp'].includes(file.type))return file;
  let bitmap=null,url=null;
  try{
    let image;
    if(typeof createImageBitmap==='function'){bitmap=await createImageBitmap(file);image=bitmap;}
    else{
      image=new Image();url=URL.createObjectURL(file);
      if(image.decode){image.src=url;await image.decode();}
      else await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    }
    if(!valid())return file;
    const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
    if(!width||!height||(width<=1600&&height<=1600&&file.size<=500*1024))return file;
    const ratio=Math.min(1,1600/Math.max(width,height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
    const context=canvas.getContext('2d');if(!context||!canvas.toBlob)return file;
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,file.type,file.type==='image/png'?undefined:0.82));
    if(!valid()||!blob||blob.type!==file.type)return file;
    if(blob.size>=file.size&&!(ratio<=0.5&&blob.size<=file.size*1.15))return file;
    return new File([blob],file.name,{type:blob.type,lastModified:file.lastModified});
  }catch{return file;}
  finally{bitmap?.close?.();if(url)URL.revokeObjectURL(url);}
}

export async function tiendaAdminView(view,ctx){
  const {api,setHTML,toast,negocio}=ctx;
  const canEdit=()=>ctx.admin===true||ctx.puede?.('tienda.editar',negocio)===true;
  const canOrders=()=>ctx.admin===true||ctx.puede?.('tienda.pedidos',negocio)===true;
  if(!negocio){setHTML(view,'<div class="empty-state"><p>Elegí un negocio para administrar su tienda.</p></div>');return;}
  if(!canEdit()&&!canOrders()){setHTML(view,'<div class="empty-state"><p>No tenés permiso para administrar la tienda de este negocio.</p></div>');return;}
  const root=document.createElement('section');root.className='tienda-admin';view.replaceChildren(root);
  const getToken=()=>{try{return ctx.getToken?ctx.getToken():localStorage.getItem('zilky_token');}catch{return null;}};
  const token=getToken(),userId=ctx.usuario?.id||ctx.usuarioId||'sin-usuario';
  const key='zilky-tienda-pendiente:'+userId+':'+negocio,uploadKey=key+':archivo';
  const query='?negocio_id='+encodeURIComponent(negocio);
  const valid=()=>root.isConnected&&view.contains(root)&&getToken()===token&&(!ctx.valid||ctx.valid());
  const allowed=kind=>kind==='config'?ctx.admin===true:kind==='pedido'?canOrders():canEdit();
  const call=(path,opts)=>{if(!valid())throw Error('La pantalla cambió. Abrí nuevamente la tienda.');return api(path,opts);};
  let config=null,products=[],catalog=[],orders=[],selectedOrder=null,editing=null,productMode='nuevo';
  let tab=canEdit()?'catalogo':'pedidos',busy=false,loading=false,loadId=0,detailId=0,mediaId=0,screenId=0;
  let media=[],mediaVersion='',mediaLimits={imagen_bytes:8388608,video_bytes:31457280,max_archivos_producto:12},mediaBytes=0,uploadFiles=new Map();
  const previewErrors=new Set();
  const previewLoading=new Map();
  const previews=new Map();
  const revokePreviews=()=>{for(const url of previews.values())URL.revokeObjectURL(url);previews.clear();};
  const observer=new MutationObserver(()=>{if(!root.isConnected){mediaId++;revokePreviews();uploadFiles.clear();observer.disconnect();}});
  observer.observe(view.parentNode||view,{childList:true,subtree:true});
  const readStored=k=>{try{return JSON.parse(sessionStorage.getItem(k)||'null');}catch{return null;}};
  const removeStored=k=>{try{sessionStorage.removeItem(k);}catch{}}
  const saveStored=(k,value)=>{try{sessionStorage.setItem(k,JSON.stringify(value));}catch{throw Error('No se pudo conservar el reintento en este navegador. Volvé a intentarlo antes de guardar.');}};
  const fail=error=>{if(valid()){toast(error.message||'No se pudo completar la operación',true);const status=root.querySelector('#ta-status');if(status)status.textContent=error.message||'No se pudo completar la operación';}};
  const stamp=value=>{if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'});};
  const stockLabel=value=>value===null||value===undefined?'Sin control de stock':`${value} disponible${Number(value)===1?'':'s'}`;
  const currentProduct=id=>products.find(p=>p.id===id);

  function pendingUI(){
    if(!valid())return;
    const box=root.querySelector('#ta-pending');if(!box)return;
    const pending=readStored(key),upload=readStored(uploadKey);
    setHTML(box,pending?`<div class="ta-notice"><strong>Hay un cambio pendiente de confirmar</strong><p>Comprobá el resultado antes de guardar otro cambio. Se reenviará la misma solicitud.</p><button type="button" class="btn btn-primary" data-ta-retry ${busy||!allowed(pending.kind)?'disabled':''}>Comprobar cambio pendiente</button></div>`:upload?`<div class="ta-notice"><strong>Hay un archivo pendiente de confirmar</strong><p>Revisá si terminó de subirse antes de cargarlo otra vez.</p><button type="button" class="btn btn-primary" data-ta-upload-check ${busy||!canEdit()?'disabled':''}>Comprobar archivo pendiente</button></div>`:'');
    root.querySelectorAll('[data-ta-mutation]').forEach(button=>{button.disabled=busy||Boolean(pending)||Boolean(upload)||button.dataset.taLocked==='true';});
    const file=root.querySelector('#ta-media-files');if(file)file.disabled=busy||!canEdit();
  }

  function header(){
    const link=config?.habilitada&&config?.slug?new URL('/tienda/'+encodeURIComponent(config.slug),location.origin).href:'';
    return `<header class="ta-heading"><div><h1>Tienda web</h1><p>${esc(config?.nombre||'Catálogo y pedidos del negocio')}</p></div>${canEdit()?'<button type="button" class="btn btn-primary" data-ta-new>Agregar producto</button>':''}</header>
      ${link?`<div class="ta-share"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver tienda ↗</a><input aria-label="Enlace público de la tienda" readonly value="${esc(link)}"><button type="button" class="btn btn-secondary" data-ta-copy>Copiar enlace</button></div>`:ctx.admin?'<p class="ta-hint">Configurá y publicá la tienda para compartir su enlace.</p>':''}
      <nav class="ta-tabs" aria-label="Administración de tienda">${canEdit()?`<button type="button" class="btn btn-secondary" data-ta-tab="catalogo" aria-pressed="${tab==='catalogo'}">Catálogo</button>`:''}${ctx.admin?`<button type="button" class="btn btn-secondary" data-ta-tab="tienda" aria-pressed="${tab==='tienda'}">Configurar tienda</button>`:''}${canOrders()?`<button type="button" class="btn btn-secondary" data-ta-tab="pedidos" aria-pressed="${tab==='pedidos'}">Pedidos</button>`:''}</nav><div id="ta-pending"></div><p id="ta-status" class="ta-status" role="status" aria-live="polite"></p>`;
  }

  function configHTML(){
    const c=config||{nombre:'',slug:'',descripcion:'',tipo:'general',whatsapp:'',secciones:[],habilitada:false};
    return `<form id="ta-config" class="card ta-form"><h2>Datos de la tienda</h2>
      <label class="ta-check"><input name="habilitada" type="checkbox" ${c.habilitada?'checked':''}> Publicar tienda</label>
      <p class="ta-hint">Al publicarla, los productos que marcaste como publicados estarán disponibles en el enlace.</p>
      <div class="ta-grid"><label>Nombre de la tienda<input name="nombre" required maxlength="180" value="${esc(c.nombre)}"></label><label>Enlace de la tienda<input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" minlength="3" maxlength="80" value="${esc(c.slug)}" placeholder="mi-tienda"><small>Solo letras minúsculas, números y guiones.</small></label></div>
      <label>Descripción<textarea name="descripcion" maxlength="4000" rows="3">${esc(c.descripcion)}</textarea></label>
      <div class="ta-grid"><label>Tipo de tienda<select name="tipo">${[['iphone','iPhone y accesorios'],['ropa','Ropa'],['general','General']].map(([v,l])=>`<option value="${v}" ${c.tipo===v?'selected':''}>${l}</option>`).join('')}</select></label><label>WhatsApp del negocio<input name="whatsapp" type="tel" maxlength="40" value="${esc(c.whatsapp)}" placeholder="+54 9 11 1234 5678"><small>Incluí el código de país.</small></label></div>
      <label>Secciones del catálogo<textarea name="secciones" rows="5" maxlength="4000" placeholder="Una sección por línea">${esc((c.secciones||[]).join('\n'))}</textarea></label>
      <div class="ta-actions"><button type="button" class="btn btn-secondary" data-ta-sections>Usar secciones sugeridas</button><button type="submit" class="btn btn-primary" data-ta-mutation>Guardar tienda</button></div></form>`;
  }

  function productHTML(){
    if(!editing)return '';
    const p=editing,existing=Boolean(p.id),linked=existing||productMode==='existente';
    const categories=[...new Set([...(config?.secciones||[]),...(sections[config?.tipo]||sections.general),...products.map(item=>item.categoria).filter(Boolean)])];
    return `<form id="ta-product-form" class="card ta-form"><div class="ta-heading"><h2>${existing?'Editar producto':'Agregar producto'}</h2><button type="button" class="btn btn-secondary" data-ta-product-close>Cerrar editor</button></div>
      ${!existing?`<label>Producto<select name="origen"><option value="nuevo" ${!linked?'selected':''}>Crear un producto nuevo</option><option value="existente" ${linked?'selected':''}>Elegir del inventario del negocio</option></select></label>${linked?`<label>Producto del inventario<select name="producto_id" required><option value="">Elegí un producto</option>${catalog.map(item=>`<option value="${esc(item.id)}" ${p.producto_id===item.id?'selected':''}>${esc(item.nombre)}${item.variante?' · '+esc(item.variante):''} · ${esc(stockLabel(item.stock))}</option>`).join('')}</select></label>`:''}`:`<p class="ta-hint">Inventario vinculado · ${esc(stockLabel(p.stock))}. El stock se administra desde Productos.</p>`}
      <div class="ta-grid"><label>Nombre<input name="nombre" required maxlength="180" value="${esc(p.nombre)}"></label><label>Sección<input name="categoria" list="ta-categorias" maxlength="120" value="${esc(p.categoria)}" placeholder="${config?.tipo==='iphone'?'Fundas, Accesorios, Auriculares':'Elegí o escribí una sección'}"></label></div><datalist id="ta-categorias">${categories.map(value=>`<option value="${esc(value)}"></option>`).join('')}</datalist>
      <label>Descripción<textarea name="descripcion" maxlength="4000" rows="3">${esc(p.descripcion)}</textarea></label>
      <div class="ta-grid"><label>Precio de contado ($)<input name="precio" type="number" min="0" step="0.01" max="21474836.47" required value="${esc(Number(p.precio_centavos||0)/100)}"></label><label>Orden en el catálogo<input name="orden" type="number" min="0" max="100000" step="1" value="${esc(p.orden||0)}"></label></div>
      ${!existing&&!linked?'<label>Stock inicial<input name="stock" type="number" min="0" step="1" max="2147483647" placeholder="Vacío: stock 0"><small>Unidades disponibles del producto nuevo. Para cambiar el stock de productos existentes usá el inventario.</small></label>':''}
      ${config?.tipo==='iphone'||(p.modelos||[]).length?`<details class="ta-variants" open><summary>Modelos de iPhone compatibles</summary><p class="ta-hint">Podés elegir varios modelos y agregar otros por escrito.</p><div class="ta-models">${models.map(model=>`<label class="ta-check"><input type="checkbox" data-ta-model="${esc(model)}" ${(p.modelos||[]).includes(model)?'checked':''}>${esc(model)}</label>`).join('')}</div><label>Otros modelos<textarea name="modelos" rows="2" maxlength="2000" placeholder="Separados por coma o por línea">${esc((p.modelos||[]).filter(model=>!models.includes(model)).join('\n'))}</textarea></label></details>`:''}
      <div class="ta-grid"><label>Talle<input name="talle" maxlength="80" value="${esc(p.talle)}" placeholder="Opcional"></label><label>Color<input name="color" maxlength="80" value="${esc(p.color)}" placeholder="Opcional"></label></div>
      <label class="ta-check"><input name="publicado" type="checkbox" ${p.publicado?'checked':''}> Publicar este producto</label>
      <p class="ta-hint">Guardalo como borrador para cargar sus fotos y videos antes de publicarlo.</p><div class="ta-actions"><button type="submit" class="btn btn-primary" data-ta-mutation>${existing?'Guardar producto':'Guardar producto y cargar fotos'}</button></div>
      ${existing?'<div id="ta-media"></div>':'<p class="ta-hint">Después de guardar el producto podés agregar varias fotos y videos.</p>'}</form>`;
  }

  function catalogHTML(){
    return `${productHTML()}<div class="ta-list-heading"><h2>Productos <span>${products.length}</span></h2><label>Buscar<input id="ta-search" type="search" placeholder="Nombre, sección o modelo"></label></div><div id="ta-products" class="ta-products"></div>`;
  }

  function paintProducts(search=''){
    const box=root.querySelector('#ta-products');if(!box)return;
    const filtered=products.filter(p=>[p.nombre,p.categoria,...p.modelos||[],p.talle,p.color].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    setHTML(box,filtered.length?filtered.map(p=>`<article class="ta-product"><div><span class="ta-tag ${p.publicado?'ta-tag-live':''}">${p.publicado?'Publicado':'Borrador'}</span><h3>${esc(p.nombre)}</h3><p>${esc(p.categoria||'Sin sección')}${p.talle?' · '+esc(p.talle):''}${p.color?' · '+esc(p.color):''}</p>${(p.modelos||[]).length?`<p class="ta-hint">${esc(p.modelos.join(' · '))}</p>`:''}<p class="ta-price">${esc(money(p.precio_centavos))}</p><p class="ta-hint">${esc(stockLabel(p.stock))} · ${(p.media||[]).length} archivo(s)</p></div><button type="button" class="btn btn-secondary" data-ta-edit="${esc(p.id)}">Editar</button></article>`).join(''):'<div class="ta-empty"><h3>No hay productos para mostrar</h3><p>Agregá un producto del inventario o creá uno nuevo para preparar el catálogo.</p></div>');
  }

  function orderHTML(){
    const d=selectedOrder,p=d?.pedido;
    return `<div class="ta-list-heading"><h2>Pedidos</h2><div class="ta-actions"><button type="button" class="btn btn-secondary" data-ta-orders-refresh>Actualizar</button><button type="button" class="btn btn-secondary" data-ta-csv>Descargar contactos CSV</button></div></div><p class="ta-hint">Los pedidos pendientes todavía no descuentan stock. El cobro se gestiona por separado.</p>
      <div id="ta-orders" class="ta-orders">${orders.length?orders.map(o=>`<button type="button" class="ta-order-row" data-ta-order="${esc(o.id)}"><span><strong>Pedido ${esc(o.codigo||o.id.slice(0,8))}</strong><small>${esc([o.contacto?.nombre,o.contacto?.apellido].filter(Boolean).join(' ')||'Cliente')} · ${esc(stamp(o.created_at))}</small></span><span><strong>${esc(money(o.total_centavos))}</strong><small>${esc(orderLabels[o.estado]||o.estado)}</small></span></button>`).join(''):'<div class="ta-empty"><p>Todavía no hay pedidos.</p></div>'}</div>
      <div id="ta-order-detail">${p?`<article class="card ta-order-detail"><div class="ta-heading"><h2>Pedido ${esc(p.codigo||p.id.slice(0,8))}</h2><span class="ta-tag">${esc(orderLabels[p.estado]||p.estado)}</span></div><p>${esc(stamp(p.created_at))}</p>
      <dl class="ta-contact"><div><dt>Cliente</dt><dd>${esc([p.contacto?.nombre,p.contacto?.apellido].filter(Boolean).join(' ')||'—')}</dd></div><div><dt>Teléfono</dt><dd>${esc(p.contacto?.telefono||'—')}</dd></div><div><dt>Email</dt><dd>${esc(p.contacto?.email||'—')}</dd></div></dl>${p.nota?`<p>Nota: ${esc(p.nota)}</p>`:''}
      <div class="ta-order-items">${(d.items||[]).map(item=>`<div><span>${esc(item.nombre)}<small>${esc(item.cantidad)} × ${esc(money(item.precio_unitario_centavos))}</small></span><strong>${esc(money(item.subtotal_centavos??item.cantidad*item.precio_unitario_centavos))}</strong></div>`).join('')}</div><p class="ta-order-total">Total del pedido <strong>${esc(money(p.total_centavos))}</strong></p>
      ${(d.stock||[]).length?`<h3>${p.estado==='confirmado'?'Stock a restituir si cancelás':'Stock del inventario'}</h3><ul class="ta-stock-list">${d.stock.map(s=>`<li>${esc(s.nombre)} · ${esc(s.cantidad)} unidad(es)${s.controlado===false?' · Sin control de stock':` · Disponible: ${esc(s.stock_actual)}${s.insuficiente?' · Stock insuficiente':''}`}</li>`).join('')}</ul>`:''}
      ${p.estado==='pendiente'?`<button type="button" class="btn btn-primary" data-ta-confirm="${esc(p.id)}" data-ta-mutation ${(d.stock||[]).some(s=>s.insuficiente)?'disabled data-ta-locked="true"':''}>Confirmar pedido y descontar stock</button>`:''}
      ${['pendiente','confirmado'].includes(p.estado)?`<details class="ta-cancel"><summary>Cancelar pedido</summary><p class="ta-hint">${p.estado==='confirmado'?'Se restituyen las unidades que descontó este pedido.':'El pedido pendiente se cierra sin modificar stock.'}</p><label>Motivo de la cancelación<textarea id="ta-cancel-reason" maxlength="1000" rows="2"></textarea></label><button type="button" class="btn btn-danger" data-ta-cancel="${esc(p.id)}" data-ta-mutation>Confirmar cancelación</button></details>`:p.motivo_cancelacion?`<p>Motivo: ${esc(p.motivo_cancelacion)}</p>`:''}</article>`:''}</div>`;
  }

  function render(){
    if(!valid())return;
    setHTML(root,header()+`<div id="ta-content">${tab==='tienda'&&ctx.admin?configHTML():tab==='pedidos'&&canOrders()?orderHTML():canEdit()?catalogHTML():'<p>No tenés permiso para ver esta sección.</p>'}</div>`);
    if(tab==='catalogo'){paintProducts();if(editing?.id)paintMedia();}
    pendingUI();
  }

  async function load(){
    const id=++loadId;loading=true;
    if(valid()&&!config)setHTML(root,'<p class="ta-loading">Cargando tienda…</p>');
    try{
      const [settings,list,existing]=await Promise.all([call('/tiendas'+query),canEdit()?call('/tiendas/productos'+query):[],canEdit()?call('/tiendas/catalogo'+query):[]]);
      if(!valid()||id!==loadId)return;
      config=settings.config||settings;products=Array.isArray(list)?list:list.productos||[];catalog=Array.isArray(existing)?existing:existing.productos||[];
      if(tab==='pedidos')await loadOrders(false);if(valid()&&id===loadId)render();
    }catch(error){if(valid()&&id===loadId){setHTML(root,'<div class="ta-empty"><p>No se pudo cargar la tienda.</p><button type="button" class="btn btn-secondary" data-ta-load>Volver a intentar</button><p id="ta-status" role="status"></p></div>');fail(error);}}
    finally{loading=false;}
  }

  async function loadOrders(paint=true){
    if(!valid()||!canOrders())return;
    const list=await call('/tiendas/pedidos'+query);if(!valid()||!canOrders())return;
    orders=Array.isArray(list)?list:list.pedidos||[];if(paint&&tab==='pedidos')render();
  }

  async function openOrder(id){
    if(!valid()||!canOrders())return;const current=++detailId;screenId++;
    const data=await call('/tiendas/pedidos/'+encodeURIComponent(id)+query);
    if(!valid()||current!==detailId||tab!=='pedidos'||!canOrders())return;
    selectedOrder=data;render();root.querySelector('#ta-order-detail')?.scrollIntoView?.({behavior:'smooth',block:'start'});
  }

  async function complete(pending,result,screen){
    if(!valid())return;
    if(screen!==screenId){
      if(pending.kind==='producto'){const saved=result?.producto||result;if(saved?.id)products=products.some(p=>p.id===saved.id)?products.map(p=>p.id===saved.id?saved:p):[...products,saved];}
      else if(pending.kind==='config')config=result?.config||result;
      return;
    }
    if(pending.kind==='pedido'){
      selectedOrder=result?.pedido?result:null;await loadOrders(false);if(!valid()||screen!==screenId)return;render();toast(pending.path.endsWith('/cancelar')?'Pedido cancelado':'Pedido confirmado. El cobro se gestiona por separado.');
    }else if(pending.kind==='producto'){
      const id=result?.producto?.id||result?.id||pending.entity;
      const saved=result?.producto||result;
      if(saved?.id){editing=saved;products=products.some(p=>p.id===saved.id)?products.map(p=>p.id===saved.id?saved:p):[...products,saved];tab='catalogo';render();}
      try{
        const list=await call('/tiendas/productos'+query);if(!valid()||screen!==screenId)return;products=Array.isArray(list)?list:list.productos||[];
        editing=currentProduct(id)||saved;tab='catalogo';render();if(editing?.id)await loadMedia(editing.id);
      }catch(error){fail(error);}
      if(valid())toast('Producto guardado');
    }else if(pending.kind==='config'){config=result?.config||result;render();toast('Tienda guardada');}
    else if(pending.kind==='media'){if(editing?.id)await loadMedia(editing.id);toast('Galería actualizada');}
  }

  async function sendStored(){
    const pending=readStored(key);if(!pending||busy||!valid()||!allowed(pending.kind))return;
    if(pending.body?.negocio_id!==negocio||!pending.path?.startsWith('/tiendas/'))throw Error('El cambio pendiente no corresponde a este negocio.');
    const screen=screenId;busy=true;pendingUI();
    try{
      const result=await call(pending.path,{method:pending.method,body:JSON.stringify(pending.body)});
      removeStored(key);if(valid())await complete(pending,result,screen);
    }catch(error){
      if(error.status>=400&&error.status<500&&![401,408,429].includes(error.status))removeStored(key);
      throw error;
    }finally{busy=false;if(valid())pendingUI();}
  }

  async function mutate(kind,path,method,body,entity){
    if(!valid()||!allowed(kind)||busy)return;
    if(readStored(key)||readStored(uploadKey))throw Error('Primero comprobá el cambio pendiente con el botón de arriba.');
    saveStored(key,{kind,path,method,entity,body:{...body,negocio_id:negocio,solicitud_id:crypto.randomUUID()}});
    return sendStored();
  }

  function preserveProduct(){
    const form=root.querySelector('#ta-product-form');if(!form||!editing)return;
    const values=new FormData(form);editing={...editing,nombre:String(values.get('nombre')||''),descripcion:String(values.get('descripcion')||''),categoria:String(values.get('categoria')||''),precio_centavos:Math.round(Number(values.get('precio')||0)*100),orden:Number(values.get('orden')||0),modelos:[...new Set([...form.querySelectorAll('[data-ta-model]:checked')].map(input=>input.dataset.taModel).concat(lines(values.get('modelos'))))],talle:String(values.get('talle')||''),color:String(values.get('color')||''),publicado:values.has('publicado')};
  }

  async function openProduct(product){
    if(!valid()||!canEdit())return;
    mediaId++;revokePreviews();previewErrors.clear();media=[];mediaVersion='';editing=product?{...product,modelos:[...product.modelos||[]]}:{nombre:'',descripcion:'',categoria:'',precio_centavos:0,orden:products.length,modelos:[],talle:'',color:'',publicado:false};
    productMode='nuevo';tab='catalogo';screenId++;render();root.querySelector('#ta-product-form')?.scrollIntoView?.({behavior:'smooth',block:'start'});
    if(editing.id)await loadMedia(editing.id);
  }

  function paintMedia(){
    const box=root.querySelector('#ta-media');if(!box||!editing?.id)return;
    setHTML(box,`<div class="ta-gallery-heading"><h3>Fotos y videos</h3><span>${media.length}/${mediaLimits.max_archivos_producto} archivos</span><button type="button" class="btn btn-secondary" data-ta-gallery-refresh>Actualizar archivos</button></div><p class="ta-hint">JPG, PNG o WebP hasta 8 MB. Videos MP4, WebM o MOV hasta 30 MB. Hasta 12 archivos por producto. Optimizamos fotos grandes para cargar más rápido. Los videos se reproducen al tocarlos.</p>
      <label class="ta-upload">Agregar fotos o videos<input id="ta-media-files" type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" ${busy?'disabled':''}></label>
      ${mediaBytes?`<p class="ta-hint">Archivos del negocio: ${(mediaBytes/1048576).toFixed(1)} MB de 200 MB.</p>`:''}<div class="ta-gallery">${media.map((item,index)=>`<figure><div class="ta-media-preview">${previews.has(item.id)?item.tipo==='video'?`<video data-ta-preview="${esc(item.id)}" controls preload="none" playsinline></video>`:`<img data-ta-preview="${esc(item.id)}" alt="${esc(item.nombre||'Foto del producto')}" loading="lazy">`:item.tipo==='video'?`<button type="button" class="btn btn-secondary" data-ta-video-load="${esc(item.id)}" ${previewLoading.has(item.id)?'disabled':''}>${previewLoading.has(item.id)?'Cargando video…':'Cargar video'}</button>`:`<span>${previewErrors.has(item.id)?'Vista previa no disponible. Actualizá los archivos para reintentar.':'Preparando vista previa…'}</span>`}</div><figcaption>${esc(item.nombre||item.tipo)}<small>${(Number(item.bytes||0)/1048576).toFixed(1)} MB</small></figcaption><div class="ta-media-actions"><button type="button" class="btn btn-secondary" data-ta-media-move="${esc(item.id)}" data-ta-direction="-1" data-ta-mutation ${index===0?'disabled data-ta-locked="true"':''} aria-label="Mover archivo hacia adelante">←</button><button type="button" class="btn btn-secondary" data-ta-media-move="${esc(item.id)}" data-ta-direction="1" data-ta-mutation ${index===media.length-1?'disabled data-ta-locked="true"':''} aria-label="Mover archivo hacia atrás">→</button><button type="button" class="btn btn-danger" data-ta-media-remove="${esc(item.id)}" data-ta-mutation>Quitar</button></div></figure>`).join('')}</div>`);
    box.querySelectorAll('[data-ta-preview]').forEach(element=>{const url=previews.get(element.dataset.taPreview);if(url?.startsWith('blob:'))element.src=url;});
    pendingUI();
  }

  async function loadMedia(productId){
    if(!valid()||!canEdit())return;const sequence=++mediaId;
    const result=await call('/tiendas/productos/'+encodeURIComponent(productId)+'/media'+query);
    if(!valid()||sequence!==mediaId||editing?.id!==productId)return;
    const next=result.media||[];for(const [id,url]of previews)if(!next.some(item=>item.id===id)){URL.revokeObjectURL(url);previews.delete(id);}
    media=next;editing={...editing,media:next};products=products.map(item=>item.id===productId?{...item,media:next}:item);
    mediaVersion=result.version;mediaLimits={...mediaLimits,...result.limites};mediaBytes=result.usados_bytes||0;paintMedia();paintProducts(root.querySelector('#ta-search')?.value||'');
    if(!ctx.mediaPreview)return;
    await Promise.allSettled(media.filter(item=>item.tipo!=='video'&&!previews.has(item.id)).map(item=>loadPreview(item,productId,sequence)));
  }

  async function loadPreview(item,productId,sequence){
    if(!ctx.mediaPreview||!item||previewLoading.get(item.id)===sequence||!valid()||!canEdit())return;
    previewLoading.set(item.id,sequence);paintMedia();
    try{
      const value=await ctx.mediaPreview('/tiendas/media/'+encodeURIComponent(item.id)+query);
      const url=typeof value==='string'?value:URL.createObjectURL(value);
      if(!valid()||sequence!==mediaId||editing?.id!==productId){URL.revokeObjectURL(url);return;}
      if(!url.startsWith('blob:'))throw Error('No se pudo preparar la vista previa');
      previewErrors.delete(item.id);previews.set(item.id,url);
    }catch{if(valid()&&sequence===mediaId&&editing?.id===productId)previewErrors.add(item.id);}
    finally{if(previewLoading.get(item.id)===sequence)previewLoading.delete(item.id);if(valid()&&sequence===mediaId&&editing?.id===productId)paintMedia();}
  }

  async function checkUpload(){
    const pending=readStored(uploadKey);if(!pending||!valid()||!canEdit()||busy)return;
    const result=await call('/tiendas/productos/'+encodeURIComponent(pending.productId)+'/media'+query);if(!valid())return;
    if((result.media||[]).some(item=>item.solicitud_id===pending.solicitudId)){
      removeStored(uploadKey);uploadFiles.delete(pending.solicitudId);if(editing?.id===pending.productId)await loadMedia(pending.productId);pendingUI();toast('Archivo guardado');return;
    }
    if(editing?.id!==pending.productId)await openProduct(currentProduct(pending.productId));
    const file=uploadFiles.get(pending.solicitudId);
    if(!file){throw Error('El archivo todavía no figura. Volvé a elegir el mismo archivo para reintentar la carga pendiente.');}
    return uploadOne(file,pending);
  }

  async function uploadOne(file,pending=null,original=null){
    if(!valid()||!canEdit()||!editing?.id||!ctx.upload)return;
    const productId=editing.id;let request=pending;busy=true;pendingUI();
    try{
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!valid()||!canEdit()||editing?.id!==productId)return;
      if(pending?.hash&&pending.hash!==hash)throw Error('El contenido del archivo cambió. Elegí el archivo original de la carga pendiente.');
      request=pending||{productId,solicitudId:crypto.randomUUID(),nombre:file.name,bytes:file.size,tipo:file.type,hash,origen:original||{nombre:file.name,bytes:file.size,tipo:file.type}};
      saveStored(uploadKey,request);uploadFiles.set(request.solicitudId,file);
      const result=await ctx.upload('/tiendas/productos/'+encodeURIComponent(request.productId)+'/media'+query,file,{solicitudId:request.solicitudId});
      removeStored(uploadKey);uploadFiles.delete(request.solicitudId);if(valid()&&editing?.id===request.productId){
        preserveProduct();
        if(result?.media&&!result.eliminado){media=media.some(item=>item.id===result.media.id)?media:media.concat(result.media);mediaVersion=result.version||mediaVersion;paintMedia();}
        try{await loadMedia(request.productId);}catch(error){fail(error);}
      }
      if(valid())toast(result?.eliminado?'La carga anterior ya había sido eliminada.':'Archivo guardado');
    }catch(error){if(request&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){removeStored(uploadKey);uploadFiles.delete(request.solicitudId);}throw error;}
    finally{busy=false;if(valid()){paintMedia();pendingUI();}}
  }

  root.addEventListener('submit',async event=>{
    const form=event.target;if(!['ta-config','ta-product-form'].includes(form.id))return;event.preventDefault();
    if(!valid()||busy)return;
    try{
      const values=new FormData(form);
      if(form.id==='ta-config'){
        if(!ctx.admin)return;
        await mutate('config','/tiendas/config','PUT',{habilitada:values.has('habilitada'),slug:String(values.get('slug')||'').trim(),nombre:String(values.get('nombre')||'').trim(),descripcion:String(values.get('descripcion')||'').trim(),tipo:values.get('tipo'),whatsapp:String(values.get('whatsapp')||'').trim(),secciones:lines(values.get('secciones'))});
      }else{
        if(!canEdit())return;preserveProduct();
        const body={nombre:editing.nombre,descripcion:editing.descripcion,categoria:editing.categoria,modelos:editing.modelos,talle:editing.talle,color:editing.color,publicado:editing.publicado,precio_centavos:editing.precio_centavos,orden:editing.orden};
        if(editing.id)body.version=editing.version;else if(productMode==='existente'){body.producto_id=String(values.get('producto_id')||'');if(!body.producto_id)throw Error('Elegí un producto del inventario.');}
        else body.stock=Number(values.get('stock')||0);
        await mutate('producto','/tiendas/productos'+(editing.id?'/'+encodeURIComponent(editing.id):''),editing.id?'PUT':'POST',body,editing.id);
      }
    }catch(error){fail(error);}
  });

  root.addEventListener('input',event=>{if(event.target.id==='ta-search')paintProducts(event.target.value);});
  root.addEventListener('change',async event=>{
    if(!valid())return;
    if(event.target.name==='origen'&&canEdit()){
      preserveProduct();productMode=event.target.value;render();
    }else if(event.target.name==='producto_id'&&canEdit()){
      preserveProduct();const source=catalog.find(item=>item.id===event.target.value);if(source){editing={...editing,producto_id:source.id,nombre:source.nombre,descripcion:source.descripcion||'',categoria:source.categoria||'',precio_centavos:source.precio_contado_centavos||0};render();}
    }else if(event.target.id==='ta-media-files'&&canEdit()){
      const files=[...event.target.files||[]];event.target.value='';
      try{
        if(!ctx.upload)throw Error('La carga de archivos no está disponible en esta pantalla.');
        const pending=readStored(uploadKey);
        if(readStored(key)||busy)throw Error('Primero comprobá la operación pendiente.');
        if(pending){
          const original=pending.origen||{nombre:pending.nombre,bytes:pending.bytes,tipo:pending.tipo};
          if(files.length!==1||files[0].name!==original.nombre||files[0].size!==original.bytes||files[0].type!==original.tipo)throw Error('Elegí el mismo archivo de la carga pendiente.');
          busy=true;pendingUI();let prepared;try{prepared=await optimizarFoto(files[0],valid);}finally{busy=false;pendingUI();}
          if(valid())await uploadOne(prepared,pending);return;
        }
        if(media.length+files.length>mediaLimits.max_archivos_producto)throw Error('Podés cargar hasta 12 archivos por producto.');
        const productId=editing?.id;
        for(const file of files)if(!mediaTypes.has(file.type))throw Error('Usá fotos JPG, PNG o WebP, o videos MP4, WebM o MOV.');
        const prepared=[];busy=true;pendingUI();
        try{
          for(const file of files){
            const optimized=await optimizarFoto(file,()=>valid()&&canEdit()&&editing?.id===productId);
            if(!valid()||editing?.id!==productId||!canEdit())return;
            if(optimized.size>(optimized.type.startsWith('image/')?mediaLimits.imagen_bytes:mediaLimits.video_bytes))throw Error(optimized.type.startsWith('image/')?'La foto supera los 8 MB.':'El video supera los 30 MB.');
            prepared.push({file:optimized,original:{nombre:file.name,bytes:file.size,tipo:file.type}});
          }
        }finally{busy=false;pendingUI();}
        for(const item of prepared){if(!valid()||editing?.id!==productId||!canEdit())break;await uploadOne(item.file,null,item.original);}
      }catch(error){fail(error);}
    }
  });

  root.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!root.contains(button)||!valid())return;
    try{
      if(button.hasAttribute('data-ta-load'))return await load();
      if(button.dataset.taTab){const next=button.dataset.taTab;if(next==='tienda'&&!ctx.admin||next==='catalogo'&&!canEdit()||next==='pedidos'&&!canOrders())return;preserveProduct();tab=next;detailId++;screenId++;render();if(tab==='pedidos')await loadOrders();return;}
      if(button.hasAttribute('data-ta-new'))return await openProduct(null);
      if(button.dataset.taEdit)return await openProduct(currentProduct(button.dataset.taEdit));
      if(button.hasAttribute('data-ta-product-close')){editing=null;screenId++;mediaId++;revokePreviews();render();return;}
      if(button.hasAttribute('data-ta-sections')&&ctx.admin){const form=root.querySelector('#ta-config');form.elements.secciones.value=(sections[form.elements.tipo.value]||sections.general).join('\n');return;}
      if(button.hasAttribute('data-ta-copy')){
        const input=root.querySelector('.ta-share input');if(!input)return;
        if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(input.value);if(valid())toast('Enlace copiado');}
        else{input.focus();input.select();if(document.execCommand?.('copy'))toast('Enlace copiado');else toast('Seleccioná y copiá el enlace de la tienda.');}return;
      }
      if(button.hasAttribute('data-ta-retry'))return await sendStored();
      if(button.hasAttribute('data-ta-upload-check'))return await checkUpload();
      if(button.hasAttribute('data-ta-gallery-refresh')&&canEdit()&&editing?.id)return await loadMedia(editing.id);
      if(button.dataset.taVideoLoad&&canEdit()&&editing?.id)return await loadPreview(media.find(item=>item.id===button.dataset.taVideoLoad),editing.id,mediaId);
      if(button.hasAttribute('data-ta-orders-refresh'))return await loadOrders();
      if(button.hasAttribute('data-ta-csv')&&canOrders()){if(!ctx.download)throw Error('La descarga de contactos no está disponible.');await ctx.download('/tiendas/contactos.csv'+query,'contactos-tienda.csv');return;}
      if(button.dataset.taOrder)return await openOrder(button.dataset.taOrder);
      if(button.dataset.taConfirm&&canOrders()&&selectedOrder?.pedido?.id===button.dataset.taConfirm)return await mutate('pedido','/tiendas/pedidos/'+encodeURIComponent(button.dataset.taConfirm)+'/confirmar','POST',{version:selectedOrder.version},button.dataset.taConfirm);
      if(button.dataset.taCancel&&canOrders()&&selectedOrder?.pedido?.id===button.dataset.taCancel){const motivo=root.querySelector('#ta-cancel-reason')?.value.trim();if(!motivo)throw Error('Indicá el motivo de la cancelación.');return await mutate('pedido','/tiendas/pedidos/'+encodeURIComponent(button.dataset.taCancel)+'/cancelar','POST',{version:selectedOrder.version,motivo},button.dataset.taCancel);}
      if(button.dataset.taMediaRemove&&canEdit()&&editing?.id)return await mutate('media','/tiendas/productos/'+encodeURIComponent(editing.id)+'/media/'+encodeURIComponent(button.dataset.taMediaRemove)+query,'DELETE',{version:mediaVersion},editing.id);
      if(button.dataset.taMediaMove&&canEdit()&&editing?.id){const ids=media.map(item=>item.id),from=ids.indexOf(button.dataset.taMediaMove),to=from+Number(button.dataset.taDirection);if(from<0||to<0||to>=ids.length)return;[ids[from],ids[to]]=[ids[to],ids[from]];return await mutate('media','/tiendas/productos/'+encodeURIComponent(editing.id)+'/media/orden','PUT',{ids,version:mediaVersion},editing.id);}
    }catch(error){fail(error);}
  });

  await load();
}
