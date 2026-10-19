const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value||0)/100);
const fecha=value=>{const parts=String(value||'').slice(0,10).split('-');return parts.length===3?parts.reverse().join('/'):'Sin fecha';};
const stock=value=>value===null||value===undefined?'Sin control de stock':String(value);
const cerrado=()=>Object.assign(new Error('La pantalla cambió. Abrí nuevamente la venta.'),{status:409});

// La pantalla recibe una previsualización y confirma una sola solicitud estable.
// El contexto pertenece a una sesión, negocio y panel capturados por quien la abre.
export async function eliminarVentaPorError(view,ctx) {
  if(typeof ctx.isCurrent!=='function'||!ctx.isCurrent())return;
  if(ctx.admin!==true){
    if(view.isConnected)ctx.setHTML(view,'<p>Requiere administrador.</p>');return;
  }
  const {api,setHTML,negocio,ventaId,usuarioId,toast=()=>{},onSuccess=()=>{}}=ctx;
  if(!negocio||!ventaId||!usuarioId){setHTML(view,'<p>Faltan los datos de esta venta. Cerrá y abrí nuevamente.</p>');return;}
  const token=localStorage.getItem('zilky_token'),root=document.createElement('section');
  root.className='sale-detail sale-error';root.dataset.saleError=ventaId;
  view.replaceChildren(root);
  const vigente=()=>root.isConnected&&view.contains(root)&&ctx.admin===true&&ctx.isCurrent()&&localStorage.getItem('zilky_token')===token;
  const path=id=>'/ventas/'+encodeURIComponent(id)+'/eliminar-error?negocio_id='+encodeURIComponent(negocio);
  const key='zilky-venta-error-pendiente:'+usuarioId+':'+negocio;
  const read=()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');return saved&&saved.usuarioId===usuarioId&&saved.negocio===negocio&&saved.ventaId&&saved.body?.negocio_id===negocio?saved:null;}catch{return null;}};
  const clear=()=>{try{sessionStorage.removeItem(key);}catch{/* Si no se puede borrar, el reintento seguirá siendo idempotente. */}};
  const guardar=pending=>{
    try{sessionStorage.setItem(key,JSON.stringify(pending));if(!sessionStorage.getItem(key))throw Error();}
    catch{throw new Error('No se pudo guardar la solicitud en este navegador. No se envió la eliminación. Habilitá el almacenamiento y volvé a intentar.');}
  };
  let busy=false,pending=read();
  const aviso=message=>{const target=root.querySelector('[data-sale-error-status]');if(vigente()&&target)target.textContent=message;};
  const recuperar=()=>{
    if(!vigente())return;
    setHTML(root,`<h2>La venta cambió</h2><p>Volvé a revisar los pagos, las cuotas y el stock antes de confirmar.</p><button type="button" class="btn btn-secondary" data-sale-error-reload>Volver a revisar</button>`);
    root.querySelector('[data-sale-error-reload]').addEventListener('click',()=>{if(vigente())eliminarVentaPorError(view,ctx);});
  };
  const renderPreview=(v,recuperada=false)=>{
    if(!vigente())return;
    const pagos=Array.isArray(v.pagos)?v.pagos:[],productos=Array.isArray(v.productos)?v.productos:[];
    setHTML(root,`<h2>Eliminar venta cargada por error</h2><p>Venta del ${esc(fecha(v.venta?.fecha))} · Total ${esc(money(v.venta?.monto_total_centavos))}</p>
      <p>La venta y sus cuotas quedan anuladas; los productos vuelven al stock automáticamente. El historial se conserva.</p>
      ${recuperada?'<p><strong>Hay una eliminación pendiente de confirmar.</strong> Se comprobará la misma solicitud que enviaste antes, sin volver a sumar productos.</p>':''}
      <h3>Productos que vuelven al stock</h3>
      ${productos.length?productos.map(p=>`<div class="cm-agreement"><strong>${esc(p.nombre)}</strong><p>Se repone ${esc(p.cantidad_reponer)} ${p.cantidad_reponer===1?'unidad':'unidades'}.</p><p>Stock: <strong>${esc(stock(p.stock_actual))} → ${esc(stock(p.stock_despues))}</strong></p></div>`).join(''):'<p>Esta venta no tiene productos con stock para reponer.</p>'}
      <p>Capital pendiente que se anula: <strong>${esc(money(v.capital_pendiente_centavos))}</strong>.</p>
      ${pagos.length?`<h3>Pagos registrados en esta venta</h3><ul>${pagos.map(p=>`<li>${esc(p.tipo==='entrega_inicial'?'Entrega inicial':'Pago de cuota')} · ${esc(fecha(p.fecha_hora))} · <strong>${esc(money(p.monto_centavos))}</strong></li>`).join('')}</ul><p>Total registrado: <strong>${esc(money(v.total_pagos_centavos))}</strong>.</p><p>Estos pagos también quedarán anulados como errores de carga. No se devuelve dinero ni se crea saldo a favor. Si el cliente realmente pagó, usá Devolución o anulación en el historial de ventas.</p>`:''}
      ${(v.advertencias||[]).map(a=>`<p class="cm-hint">${esc(a)}</p>`).join('')}
      ${v.permitido!==true?`<p role="alert"><strong>No se puede eliminar esta venta.</strong> ${esc(v.motivo_bloqueo||'Revisá la operación desde el historial de ventas.')}</p>`:`<form data-sale-error-form><div class="field"><label for="ventaErrorMotivo">Motivo</label><textarea id="ventaErrorMotivo" maxlength="1000" required ${recuperada?'disabled':''}>${esc(recuperada?pending.body.motivo:'Venta cargada dos veces')}</textarea></div>
        ${pagos.length?`<label class="cm-check" style="display:flex;flex-direction:row;align-items:start;gap:8px"><input type="checkbox" data-sale-error-payments ${recuperada?'checked disabled':''}> Confirmo que estos pagos también se cargaron por error y no hubo un cobro real.</label>`:''}
        <p role="status" data-sale-error-status></p><button type="submit" class="btn btn-danger" data-sale-error-confirm>${recuperada?'Comprobar operación pendiente':'Eliminar venta cargada por error'}</button></form>`}`);
    const form=root.querySelector('[data-sale-error-form]');
    if(!form)return;
    const button=form.querySelector('[data-sale-error-confirm]');
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||button.disabled||!vigente())return;
      if(!pending){
        const motivo=form.querySelector('#ventaErrorMotivo').value.trim();
        if(!motivo)return aviso('Indicá el motivo de la eliminación.');
        if(pagos.length&&!form.querySelector('[data-sale-error-payments]').checked)return aviso('Confirmá que los pagos también se cargaron por error. Si hubo un cobro real, usá Devolución o anulación.');
        const body={negocio_id:negocio,version:v.version,solicitud_id:crypto.randomUUID(),motivo,confirmar:true,...(pagos.length?{confirmar_pagos_erroneos:true}:{})};
        const nuevo={usuarioId,negocio,ventaId,body,preview:v};
        try{guardar(nuevo);}catch(error){aviso(error.message);return;}
        pending=nuevo;
      }
      if(pending.ventaId!==ventaId)return aviso('Primero comprobá la eliminación pendiente de la otra venta.');
      busy=true;button.disabled=true;form.querySelectorAll('input,textarea').forEach(input=>input.disabled=true);aviso('Comprobando la eliminación…');
      try{
        if(!vigente())throw cerrado();
        const result=await api(path(pending.ventaId),{method:'POST',body:JSON.stringify(pending.body)});
        clear();
        if(!vigente())return;
        setHTML(root,'<p role="status">Venta anulada. Los productos volvieron al stock y el historial se conservó.</p>');
        toast('Venta cargada por error eliminada; stock actualizado');
        try{await onSuccess(result);}catch(error){if(vigente())toast(error.message,true);}
      }catch(error){
        if(error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){clear();pending=null;}
        if(!vigente())return;
        if(error.status===409)return recuperar();
        if(error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){
          form.querySelectorAll('input,textarea').forEach(input=>input.disabled=false);button.disabled=false;button.textContent='Eliminar venta cargada por error';aviso(error.message);return;
        }
        button.disabled=false;button.textContent='Comprobar operación pendiente';
        aviso((error.message||'No se pudo confirmar la respuesta.')+' Comprobá la misma operación antes de registrar otra; los datos quedan guardados para reintentar sin duplicarla.');
      }finally{busy=false;}
    });
  };
  if(pending&&pending.ventaId!==ventaId){
    setHTML(root,`<h2>Hay otra venta pendiente de confirmar</h2><p>Corresponde a la venta del ${esc(fecha(pending.preview?.venta?.fecha))}. Comprobá primero esa operación para no eliminar otra venta por error.</p><button type="button" class="btn btn-secondary" data-sale-error-pending-open>Revisar venta pendiente</button>`);
    root.querySelector('[data-sale-error-pending-open]').addEventListener('click',()=>{if(vigente())eliminarVentaPorError(view,{...ctx,ventaId:pending.ventaId});});return;
  }
  if(pending?.preview){renderPreview(pending.preview,true);return;}
  setHTML(root,'<h2>Eliminar venta cargada por error</h2><p>Cargando los productos, las cuotas y los pagos…</p>');
  try{
    const v=await api(path(ventaId));if(!vigente())return;
    if(v.venta?.id&&v.venta.id!==ventaId)throw new Error('La vista previa pertenece a otra venta. Cerrá y abrí nuevamente.');
    renderPreview(v);
  }catch(error){if(vigente()){setHTML(root,`<p role="alert">${esc(error.message)}</p><button type="button" class="btn btn-secondary" data-sale-error-reload>Volver a revisar</button>`);root.querySelector('[data-sale-error-reload]').addEventListener('click',()=>{if(vigente())eliminarVentaPorError(view,ctx);});}}
}
