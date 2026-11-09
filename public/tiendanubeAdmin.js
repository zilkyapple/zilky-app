const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const remoteId=value=>/^[1-9]\d{0,19}$/.test(String(value??''));
const remoteKey=item=>`${item.product_id}:${item.variant_id}`;
const stockLabel=value=>value===null?'Sin control de stock':Number.isSafeInteger(value)?value<=0?'Agotado':`${value} unidad${value===1?'':'es'}`:'Sin dato';
const translated=value=>typeof value==='string'?value:value&&typeof value==='object'?[value.es,value.pt,value.en,value.value].find(v=>typeof v==='string')||'':'';
const variantLabel=values=>Array.isArray(values)?values.map(translated).filter(Boolean).join(' · '):translated(values);
const blockingLabels={
  FEATURE_FLAG_APAGADA:'El motor de sincronización está apagado en la configuración del servidor.',
  SIN_CONEXION:'Falta autorizar la cuenta de Tiendanube.',
  CONEXION_PAUSADA:'La sincronización está pausada para este negocio.',
  SIN_FECHA_DE_CORTE:'Falta definir desde qué fecha se procesarán los pedidos.',
  BASELINE_PENDIENTE:'Falta conciliar el stock inicial de las variantes.',
  WEBHOOKS_NO_VERIFICADOS:'Falta comprobar las notificaciones de ventas de Tiendanube.',
  SIN_VARIANTES_VINCULADAS:'No hay variantes vinculadas.',
  REVISIONES_PENDIENTES:'Hay movimientos que necesitan revisión manual.',
};

export function validarAutorizacionTiendanube(value){
  if(typeof value!=='string'||value.length>2048)throw Error('URL de autorización inválida');
  const url=new URL(value);
  if(url.protocol!=='https:'||!['tiendanube.com','www.tiendanube.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash||!/^\/apps\/[1-9]\d{0,19}\/authorize\/?$/.test(url.pathname)||[...url.searchParams.keys()].length!==1||!/^[0-9a-f]{64}$/i.test(url.searchParams.get('state')||''))throw Error('URL de autorización inválida');
  return url.href;
}

// La autorización de las rutas es responsabilidad del servidor. El gate de
// administrador y ctx.valid impiden además reutilizar una pantalla vieja.
export async function tiendanubeAdminView(view,ctx){
  const {api,setHTML,negocio}=ctx;
  const toast=typeof ctx.toast==='function'?ctx.toast:()=>{};
  if(ctx.admin!==true){setHTML(view,'<div class="empty-state"><p>Solo el administrador puede gestionar la integración con Tiendanube.</p></div>');return;}
  if(!negocio){setHTML(view,'<div class="empty-state"><p>Elegí un negocio para conectar su catálogo con Tiendanube.</p></div>');return;}
  const root=document.createElement('section');root.className='tienda-admin';view.replaceChildren(root);
  const query='?negocio_id='+encodeURIComponent(negocio);
  const valid=()=>root.isConnected&&view.contains(root)&&ctx.admin===true&&ctx.negocio===negocio&&(!ctx.valid||ctx.valid());
  let estado=null,diagnostico=null,locales=[],remotos=[],loading=false,busy=false,loadId=0,needsRefresh=false,catalogError=false,diagnosticError=false,pauseConfirm=false,notice='';
  const linkedLocal=()=>new Set((estado?.links||[]).map(item=>String(item.producto_id)));
  const linkedRemote=()=>new Set((estado?.links||[]).map(remoteKey));
  const paused=()=>estado?.conexion?.pausada===true&&diagnostico?.conexion?.pausada===true;
  const canLink=()=>Boolean(estado?.conexion&&paused()&&estado.configuracion_servidor&&!loading&&!busy&&!needsRefresh&&!catalogError&&!diagnosticError);
  const canPause=()=>Boolean(estado?.conexion&&!paused()&&!loading&&!busy);
  const call=(path,options)=>{if(!valid())throw Error('Pantalla vencida');return api(path,options);};
  const localText=item=>[item.nombre,item.variante,item.sku?`SKU ${item.sku}`:'',stockLabel(item.stock)].filter(Boolean).join(' · ');
  const remoteText=item=>[item.nombre,variantLabel(item.valores),item.sku?`SKU ${item.sku}`:'',stockLabel(item.stock)].filter(Boolean).join(' · ');

  function message(text,isError=false){
    if(!valid())return;
    notice=text;
    const status=root.querySelector('[data-tn-status]');if(status)status.textContent=text;
    if(isError)toast(text,true);
  }

  function currentSelection(){
    const localId=root.querySelector('[name="producto_id"]')?.value||'';
    const remoteValue=root.querySelector('[name="variante_remota"]')?.value||'';
    return {local:locales.find(item=>String(item.id)===localId),remote:remotos.find(item=>remoteKey(item)===remoteValue)};
  }

  function updateSelection(){
    if(!valid())return;
    const {local,remote}=currentSelection();
    const preview=root.querySelector('[data-tn-preview]');
    const alreadyLinked=(local&&linkedLocal().has(String(local.id)))||(remote&&linkedRemote().has(remoteKey(remote)));
    const complete=Boolean(local&&remote&&!alreadyLinked);
    if(preview)setHTML(preview,complete?`<div class="ta-notice"><p><strong>Inventario Zilky:</strong> ${esc(localText(local))}</p><p><strong>Variante Tiendanube:</strong> ${esc(remoteText(remote))}</p><p>Comprobá talle y color. No se elige una coincidencia automáticamente por el nombre.</p></div>`:'<p class="field-hint">Elegí una prenda de Zilky y su variante exacta en Tiendanube.</p>');
    const confirm=root.querySelector('[name="confirmar_variante"]');
    if(confirm)confirm.disabled=!canLink()||!complete;
    const submit=root.querySelector('[data-tn-link]');
    if(submit)submit.disabled=!canLink()||!complete||!confirm?.checked;
  }

  function render(){
    if(!valid())return;
    const connected=Boolean(estado?.conexion),configured=estado?.configuracion_servidor===true;
    const blocks=new Set(diagnostico?.bloqueos||[]);
    const prerequisitesComplete=diagnostico?.listo===true&&diagnostico.bloqueos.length===0&&configured&&connected;
    const connectionLabel=!connected?'No conectada':!diagnostico||diagnosticError?'Conectada · estado del motor sin comprobar':paused()?'Conectada · sincronización pausada':blocks.has('FEATURE_FLAG_APAGADA')?'Conectada · motor deshabilitado':prerequisitesComplete?'Conectada · requisitos del motor completos':'Conectada · preparación incompleta';
    const localLinked=linkedLocal(),remoteLinked=linkedRemote();
    setHTML(root,`<header class="ta-heading"><div><h1>Conexión con Tiendanube</h1><p>Vinculá las variantes existentes sin duplicar el inventario.</p></div><button type="button" class="btn btn-secondary" data-tn-refresh ${busy||loading?'disabled':''}>Actualizar estado</button></header>
      <p data-tn-status role="status" aria-live="polite">${esc(loading?'Cargando conexión…':notice)}</p>
      <section class="card ta-form"><h2>Estado de la conexión</h2><p><strong>${esc(connectionLabel)}</strong></p>
      ${!configured?'<p class="ta-notice">Falta completar la configuración privada del servidor. No ingreses claves o contraseñas en esta pantalla.</p>':''}
      <p class="field-hint">Autorizar la cuenta o vincular una variante no activa la sincronización. La activación requiere revisar el stock y las pruebas. Esta pantalla no certifica una venta de punta a punta.</p>
      <p class="field-hint">La web original de Zilky se conserva. Esta pantalla no elimina productos, no registra pagos ni modifica comisiones.</p>
      <div class="ta-actions"><button type="button" class="btn btn-primary" data-tn-connect ${!configured||loading||busy?'disabled':''}>${connected?'Volver a autorizar Tiendanube':'Conectar Tiendanube'}</button>${connected?`<button type="button" class="btn btn-secondary" data-tn-pause ${!canPause()?'disabled':''}>${paused()?'Sincronización pausada':'Pausar sincronización'}</button>`:''}</div>
      ${pauseConfirm?'<div class="ta-notice" data-tn-pause-confirm><h3>Confirmar pausa</h3><p>Se detendrán las nuevas sincronizaciones de este negocio. Una operación ya en curso puede terminar. No se borrarán prendas, ventas ni la web original.</p><p>Mientras esté pausada, las ventas de ambos sitios deberán revisarse por separado.</p><div class="ta-actions"><button type="button" class="btn btn-primary" data-tn-pause-confirm-action>Confirmar pausa</button><button type="button" class="btn btn-secondary" data-tn-pause-cancel>Cancelar</button></div></div>':''}</section>
      <section class="card ta-form" data-tn-diagnostic><h2>Comprobaciones del motor</h2>${diagnosticError?'<p class="ta-notice">No se pudo obtener el diagnóstico. El estado de sincronización es desconocido; no se habilitan nuevos vínculos hasta actualizarlo.</p>':!diagnostico?'<p>Pendiente de comprobar.</p>':`<dl><dt>Cuenta de Tiendanube</dt><dd>${connected?'Autorización registrada':'Pendiente de autorizar'}</dd><dt>Configuración privada del servidor</dt><dd>${configured?'Completa':'Incompleta'}</dd><dt>Motor automático</dt><dd>${blocks.has('FEATURE_FLAG_APAGADA')?'Apagado en el servidor':'Habilitado por configuración; sujeto a las demás comprobaciones'}</dd><dt>Stock inicial</dt><dd>${!connected||blocks.has('BASELINE_PENDIENTE')?'Pendiente de conciliación':'Conciliado'}${diagnostico.sin_baseline?` · ${esc(diagnostico.sin_baseline)} variante(s) pendiente(s)`:''}</dd><dt>Notificaciones de Tiendanube</dt><dd>${!connected||blocks.has('WEBHOOKS_NO_VERIFICADOS')?'Sin verificar':'Verificadas'}</dd><dt>Fecha inicial de pedidos</dt><dd>${!connected||blocks.has('SIN_FECHA_DE_CORTE')?'Sin definir':'Definida'}</dd><dt>Ejecución de este negocio</dt><dd>${paused()?'Pausada':'No confirmada como pausada; depende de todas las verificaciones'}</dd><dt>Variantes vinculadas</dt><dd>${esc(diagnostico.variantes)}</dd><dt>Revisiones pendientes</dt><dd>${esc(diagnostico.revision)}</dd></dl>${diagnostico.bloqueos.length?`<ul>${diagnostico.bloqueos.map(code=>`<li>${esc(blockingLabels[code]||'Hay una comprobación adicional pendiente en el servidor.')}</li>`).join('')}</ul>`:prerequisitesComplete?'<p>Las comprobaciones previas están completas. Esto no reemplaza la prueba de una venta y su actualización de stock en ambos sistemas.</p>':'<p>La preparación todavía no está completa. Actualizá el diagnóstico antes de continuar.</p>'}`}</section>
      <section class="card ta-form"><h2>Variantes vinculadas</h2>${(estado?.links||[]).length?`<div class="table-responsive"><table><thead><tr><th>Prenda de Zilky</th><th>Stock local</th><th>Producto / variante Tiendanube</th><th>Estado</th></tr></thead><tbody>${estado.links.map(item=>`<tr><td>${esc(item.nombre||item.producto_id)}</td><td>${esc(stockLabel(item.stock))}</td><td>${esc(item.product_id)} / ${esc(item.variant_id)}</td><td>${esc(item.sincronizacion||'Pendiente de revisión')}</td></tr>`).join('')}</tbody></table></div>`:'<p>Todavía no hay variantes vinculadas para este negocio.</p>'}</section>
      ${connected?`<form class="card ta-form" data-tn-form><h2>Vincular una variante existente</h2><p class="field-hint">Este paso asocia dos fichas existentes. No publica nuevas prendas ni habilita la sincronización.</p>
      ${catalogError?'<p class="ta-notice">No se pudo leer el catálogo de Tiendanube. Actualizá el estado para volver a intentar.</p>':''}
      ${needsRefresh?'<p class="ta-notice">No se confirmó el resultado anterior. Actualizá el estado antes de intentar otra vinculación.</p>':''}
      <div class="ta-grid"><label>Prenda del inventario Zilky<select name="producto_id" ${!canLink()?'disabled':''}><option value="">Elegí una prenda</option>${locales.map(item=>`<option value="${esc(item.id)}" ${localLinked.has(String(item.id))?'disabled':''}>${esc(localText(item))}${localLinked.has(String(item.id))?' · Ya vinculada':''}</option>`).join('')}</select></label>
      <label>Variante de Tiendanube<select name="variante_remota" ${!canLink()?'disabled':''}><option value="">Elegí talle y color</option>${remotos.map(item=>`<option value="${esc(remoteKey(item))}" ${remoteLinked.has(remoteKey(item))?'disabled':''}>${esc(remoteText(item))}${remoteLinked.has(remoteKey(item))?' · Ya vinculada':''}</option>`).join('')}</select></label></div>
      <div data-tn-preview></div><label class="ta-check"><input type="checkbox" name="confirmar_variante" disabled> Confirmo que el talle y el color corresponden a la misma prenda.</label>
      <button type="submit" class="btn btn-primary" data-tn-link disabled>Guardar vínculo</button></form>`:''}`);
    updateSelection();
  }

  async function load(){
    if(!valid()||busy)return;
    const sequence=++loadId;loading=true;notice='';catalogError=false;diagnosticError=false;diagnostico=null;pauseConfirm=false;render();
    try{
      const response=await call('/tiendanube/estado'+query);
      if(!valid()||sequence!==loadId)return;
      estado={conexion:response?.conexion||null,links:(Array.isArray(response?.links)?response.links:[]).filter(item=>item&&typeof item==='object'),configuracion_servidor:response?.configuracion_servidor===true};
      try{
        const ready=await call('/tiendanube/diagnostico'+query);
        if(!valid()||sequence!==loadId)return;
        if(typeof ready?.listo!=='boolean'||!Array.isArray(ready?.bloqueos))throw Error('Diagnóstico inválido');
        const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
        diagnostico={conexion:ready.conexion||null,listo:ready.listo,bloqueos:ready.bloqueos.filter(value=>typeof value==='string'),variantes:count(ready.variantes),sin_baseline:count(ready.sin_baseline),revision:count(ready.revision)};
      }catch{if(!valid()||sequence!==loadId)return;diagnosticError=true;}
      locales=[];remotos=[];
      if(estado.conexion&&estado.configuracion_servidor){
        try{
          const catalogo=await call('/tiendanube/catalogo'+query);
          if(!valid()||sequence!==loadId)return;
          locales=(Array.isArray(catalogo?.locales)?catalogo.locales:[]).filter(item=>item&&typeof item.id==='string'&&item.id);
          remotos=(Array.isArray(catalogo?.remotos)?catalogo.remotos:[]).filter(item=>item&&remoteId(item.product_id)&&remoteId(item.variant_id));
        }catch{if(!valid()||sequence!==loadId)return;catalogError=true;}
      }
      needsRefresh=false;
    }catch{
      if(!valid()||sequence!==loadId)return;
      estado=null;diagnostico=null;locales=[];remotos=[];notice='No se pudo comprobar la conexión. Actualizá el estado para volver a intentar.';
    }finally{
      if(valid()&&sequence===loadId){loading=false;render();}
    }
  }

  async function connect(){
    if(!valid()||busy||loading||estado?.configuracion_servidor!==true)return;
    busy=true;render();
    try{
      const response=await call('/tiendanube/iniciar',{method:'POST',body:JSON.stringify({negocio_id:negocio})});
      if(!valid())return;
      const url=validarAutorizacionTiendanube(response?.url);
      if(typeof ctx.navigate==='function')ctx.navigate(url);else location.assign(url);
    }catch{message('No se pudo iniciar la autorización segura. No se cambió el stock.',true);}
    finally{if(valid()){busy=false;render();}}
  }

  async function link(){
    if(!valid()||!canLink())return;
    const {local,remote}=currentSelection();
    if(!local||!remote||linkedLocal().has(String(local.id))||linkedRemote().has(remoteKey(remote))||!root.querySelector('[name="confirmar_variante"]')?.checked)return;
    const body={negocio_id:negocio,producto_id:local.id,product_id:String(remote.product_id),variant_id:String(remote.variant_id)};
    busy=true;render();
    try{
      const result=await call('/tiendanube/vinculos',{method:'POST',body:JSON.stringify(body)});
      if(!valid())return;
      toast(result?.sincronizacion==='pausada'?'Vínculo guardado. La sincronización sigue pausada.':'Vínculo guardado. Revisá el estado antes de continuar.');
      busy=false;await load();
    }catch{
      if(valid()){needsRefresh=true;message('No se pudo confirmar la vinculación. Actualizá el estado antes de volver a intentar.',true);}
    }finally{if(valid()){busy=false;render();}}
  }

  async function pause(){
    if(!valid()||!canPause()||!pauseConfirm)return;
    busy=true;pauseConfirm=false;render();
    try{
      const result=await call('/tiendanube/pausar',{method:'POST',body:JSON.stringify({negocio_id:negocio})});
      if(!valid())return;
      if(result?.pausada!==true)throw Error('Pausa sin confirmar');
      toast('Pausa guardada. Se está comprobando el estado actualizado.');
      busy=false;await load();
    }catch{if(valid()){needsRefresh=true;message('No se pudo confirmar la pausa. Actualizá el estado antes de darla por aplicada.',true);}}
    finally{if(valid()){busy=false;render();}}
  }

  root.addEventListener('click',event=>{
    const button=event.target.closest?.('button');if(!button||!root.contains(button)||button.disabled||!valid())return;
    if(button.hasAttribute('data-tn-refresh'))void load();
    if(button.hasAttribute('data-tn-connect'))void connect();
    if(button.hasAttribute('data-tn-pause')&&canPause()){pauseConfirm=true;render();}
    if(button.hasAttribute('data-tn-pause-cancel')){pauseConfirm=false;render();}
    if(button.hasAttribute('data-tn-pause-confirm-action'))void pause();
  });
  root.addEventListener('change',event=>{
    if(!valid())return;
    if(['producto_id','variante_remota'].includes(event.target.name)){
      const confirm=root.querySelector('[name="confirmar_variante"]');if(confirm)confirm.checked=false;
    }
    updateSelection();
  });
  root.addEventListener('submit',event=>{if(event.target.matches('[data-tn-form]')){event.preventDefault();void link();}});
  await load();
}
