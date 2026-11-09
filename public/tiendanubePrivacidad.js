const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const tipos={'customer-data-request':'Informe de datos','customer-redact':'Redacción de cliente','store-redact':'Revisión de borrado de integración',uninstalled:'Revisión de desinstalación'};
const estados={pendiente_entrega:'Pendiente de recepción o entrega',pendiente_revision:'Pendiente de revisión',completada:'Procedimiento interno completado'};
const fecha=value=>value&&Number.isFinite(new Date(value).valueOf())?new Date(value).toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba'}):'Sin fecha';
const clavesEliminar={credenciales:'Conexión y credencial guardada',vinculos:'Vínculos de prendas',salidas_stock:'Salidas de stock ya conciliadas',notificaciones:'Notificaciones procesadas',resumenes_pedidos:'Resúmenes de pedidos',autorizaciones_pendientes:'Autorizaciones pendientes'};
const clavesConservar={ledger_stock:'Huellas de movimientos de stock',entregas_comerciales:'Vínculos de entregas comerciales',intentos_reserva:'Trazas de reservas',solicitudes_privacidad:'Solicitudes y constancias de privacidad'};
const counts=(values,labels)=>`<dl>${Object.entries(labels).map(([key,label])=>`<dt>${esc(label)}</dt><dd>${Number.isSafeInteger(values?.[key])&&values[key]>=0?values[key]:'Sin comprobar'}</dd>`).join('')}</dl>`;

// Pantalla exclusiva de administradores. El servidor vuelve a comprobar la
// organización en cada acción; el gate local no sustituye esa autorización.
export async function tiendanubePrivacidadView(view,ctx){
  const {api,setHTML,negocio}=ctx;
  if(ctx.admin!==true||!negocio){setHTML(view,'<div class="empty-state"><p>Elegí un negocio como administrador para gestionar su privacidad.</p></div>');return;}
  const root=document.createElement('section');root.className='tienda-admin';view.replaceChildren(root);
  const valid=()=>root.isConnected&&view.contains(root)&&ctx.admin===true&&ctx.negocio===negocio&&(!ctx.valid||ctx.valid());
  const base='/tiendanube/privacidad-gestion',query='?negocio_id='+encodeURIComponent(negocio);
  const call=(path,options)=>{if(!valid())throw Error('Pantalla vencida');return api(path,options);};
  const toast=typeof ctx.toast==='function'?ctx.toast:()=>{};
  let solicitudes=[],detail=null,exported=null,preview=null,busy=false,loading=false,sequence=0,notice='',needsRefresh=false,hayMas=false;
  const selected=()=>detail?.solicitud;
  const canExport=()=>valid()&&!busy&&!loading&&!needsRefresh&&selected()?.tipo==='customer-data-request'&&detail?.informe_disponible!==false;
  const canDeliver=()=>canExport()&&selected()?.estado==='pendiente_entrega'&&exported&&hash(exported.informe_hash);
  const canPreview=()=>valid()&&!busy&&!loading&&!needsRefresh&&['store-redact','uninstalled'].includes(selected()?.tipo)&&selected()?.estado==='pendiente_revision';
  function canDelete(){return canPreview()&&preview?.puede_confirmar===true&&hash(preview.confirmacion_token)&&Date.parse(preview.vence_at)>Date.now();}
  function showError(){notice='No se confirmó la operación. Actualizá el estado antes de repetirla; no se asume que hubo un envío ni un borrado.';needsRefresh=true;exported=null;preview=null;toast(notice,true);}
  function buttons(){
    if(!valid())return;
    const receipt=root.querySelector('[data-privacy-deliver]');
    if(receipt)receipt.disabled=!canDeliver()||!root.querySelector('[name="confirmar_entrega"]')?.checked||!['recepcion_administrador','entrega_externa_declarada'].includes(root.querySelector('[name="canal"]')?.value);
    const deletion=root.querySelector('[data-privacy-delete]');
    if(deletion)deletion.disabled=!canDelete()||!root.querySelector('[name="confirmar_borrado"]')?.checked||root.querySelector('[name="frase"]')?.value!==preview.frase_requerida;
  }
  function details(){
    const s=selected();if(!s)return '<p>Seleccioná una solicitud para revisar sus acciones.</p>';
    const receipt=detail.entrega;
    const exportUi=s.tipo==='customer-data-request'?`<p>El archivo contiene solo los resúmenes operativos de esta integración, no los datos comerciales independientes de Zilky. Puede requerirse otra revisión fuera de esta pantalla.</p>
      <p><strong>Descargar no equivale a entregar.</strong> No se envía un correo desde aquí.</p>
      <button type="button" class="btn btn-secondary" data-privacy-export ${!canExport()?'disabled':''}>Descargar informe actual</button>
      ${receipt?`<div class="ta-notice"><p>Recepción o entrega declarada por un administrador el ${esc(fecha(receipt.declarada_at))}.</p><p>Canal: ${receipt.canal==='recepcion_administrador'?'Recepción del administrador':'Entrega fuera del sistema declarada'}.</p><p>No fue un envío automático ni una verificación de recepción externa.</p></div>`:''}
      ${exported&&s.estado==='pendiente_entrega'?`<div class="ta-notice" data-privacy-delivery-form><p>Se generó una exportación. El informe sigue pendiente hasta que confirmes su recepción o entrega efectiva.</p><label>Qué ocurrió<select name="canal"><option value="">Elegí la constancia real</option><option value="recepcion_administrador">Yo recibí el informe como administrador del negocio</option><option value="entrega_externa_declarada">Ya entregué el informe fuera de Zilky</option></select></label><label class="ta-check"><input type="checkbox" name="confirmar_entrega"> Confirmo que la recepción o entrega ocurrió; no solamente que se generó el archivo.</label><button type="button" class="btn btn-primary" data-privacy-deliver disabled>Registrar mi declaración</button></div>`:''}`:'';
    const cleanup=['store-redact','uninstalled'].includes(s.tipo)?`<p>La revisión no borra nada. Primero se comprueba que la solicitud corresponde a esta instalación, que Tiendanube rechazó su credencial como revocada y que no hay efectos comerciales pendientes.</p><button type="button" class="btn btn-secondary" data-privacy-preview ${!canPreview()?'disabled':''}>Revisar y preparar vista previa</button>
      ${preview?`<div class="ta-notice" data-privacy-plan><h3>Vista previa · tienda ${esc(s.store_id)}</h3><p>Se retirarían únicamente estos datos operativos de integración:</p>${counts(preview.eliminar,clavesEliminar)}<p>Se conservan estas trazas:</p>${counts(preview.conservar,clavesConservar)}<p>También se conservan todas las prendas, cantidades de stock, clientes, ventas, créditos, pagos, comisiones y la web original de Zilky. Los informes ya entregados conservan su huella y constancia, no otra copia de sus resúmenes.</p>
        ${preview.puede_confirmar===true?`<p>Credencial rechazada por Tiendanube. Vista previa válida hasta ${esc(fecha(preview.vence_at))}.</p><p>Esta eliminación de datos operativos no tiene deshacer desde el panel.</p><label>Escribí ${esc(preview.frase_requerida)}<input name="frase" autocomplete="off"></label><label class="ta-check"><input type="checkbox" name="confirmar_borrado"> Revisé qué se elimina y qué se conserva. Confirmo eliminar solo estos datos de integración.</label><button type="button" class="btn btn-danger" data-privacy-delete disabled>Eliminar datos de esta integración</button>`:`<p><strong>No se permite borrar.</strong></p><ul>${(preview.bloqueos_detalle||[]).map(b=>`<li>${esc(b.mensaje||'Hay una comprobación pendiente.')}</li>`).join('')}</ul>`}</div>`:''}
      ${detail.cierre?'<p>La limpieza operativa quedó registrada. Los datos comerciales locales y sus trazas se conservan. Esto no certifica otras obligaciones externas.</p>':''}`:'';
    return `<h2>${esc(tipos[s.tipo]||'Solicitud de privacidad')}</h2><p>Tienda ${esc(s.store_id)} · ${esc(estados[s.estado]||'Estado sin comprobar')}</p><p>Recibida: ${esc(fecha(s.creada_at))}.</p>${exportUi}${cleanup}${s.tipo==='customer-redact'?'<p>La integración registró la redacción de los resúmenes solicitados. No se borraron registros comerciales de Zilky desde este procedimiento.</p>':''}`;
  }
  function render(){
    if(!valid())return;
    setHTML(root,`<header class="ta-heading"><div><h1>Privacidad de Tiendanube</h1><p>Procedimientos operativos con constancia y confirmación.</p></div><button type="button" class="btn btn-secondary" data-privacy-refresh ${busy||loading?'disabled':''}>Actualizar estado</button></header>
      <p role="status" aria-live="polite" data-privacy-status>${esc(loading?'Consultando solicitudes…':notice)}</p>
      <p class="ta-notice">El panel no certifica cumplimiento legal ni envía informes automáticamente. La web original de Zilky y los registros comerciales se conservan.</p>
      <section class="card ta-form"><h2>Solicitudes del negocio</h2>${!solicitudes.length?'<p>No hay solicitudes en esta página.</p>':`<ul>${solicitudes.map(s=>`<li>${esc(tipos[s.tipo]||'Solicitud')} · ${esc(estados[s.estado]||'Estado sin comprobar')} · ${esc(fecha(s.creada_at))} <button type="button" class="btn btn-secondary" data-privacy-open="${esc(s.id)}" ${busy||loading?'disabled':''}>Revisar</button></li>`).join('')}</ul>`}${hayMas?'<p>Hay más solicitudes. Las pendientes se muestran primero.</p>':''}</section>
      <section class="card ta-form" data-privacy-detail>${details()}</section>`);
    buttons();
  }
  async function load(id=selected()?.id){
    if(!valid()||busy)return;
    const current=++sequence;loading=true;detail=null;exported=null;preview=null;notice='';render();
    try{
      const response=await call(base+query);if(!valid()||current!==sequence)return;
      if(!Array.isArray(response?.solicitudes))throw Error('Respuesta inválida');
      solicitudes=response.solicitudes.filter(s=>s&&localId(s.id)&&s.negocio_id===negocio);hayMas=response.hay_mas===true;
      if(id){
        const result=await call(base+'/'+encodeURIComponent(id)+query);if(!valid()||current!==sequence)return;
        if(result?.solicitud?.id!==id||result.solicitud.negocio_id!==negocio)throw Error('Solicitud ajena');
        detail=result;
      }
      needsRefresh=false;
    }catch{if(valid()&&current===sequence){detail=null;needsRefresh=true;notice='No se pudo verificar el estado. Actualizá antes de realizar una acción.';}}
    finally{if(valid()&&current===sequence){loading=false;render();}}
  }
  async function post(suffix,body={}){
    return call(base+'/'+encodeURIComponent(selected().id)+suffix,{method:'POST',body:JSON.stringify({negocio_id:negocio,...body})});
  }
  async function exportReport(){
    if(!canExport())return;
    busy=true;exported=null;preview=null;render();
    try{
      const s=selected(),result=await post('/exportar');if(!valid())return;
      if(!localId(result?.exportacion_id)||!hash(result.informe_hash)||result.informe?.solicitud_id!==s.id||result.informe.store_id!==s.store_id||result.enviado_por_sistema!==false)throw Error('Exportación no confirmada');
      const content=JSON.stringify(result.informe,null,2),filename=`tiendanube-informe-${s.id}.json`;
      if(typeof ctx.descargar==='function')await ctx.descargar(content,filename);
      else{
        const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));
        const a=document.createElement('a');a.href=url;a.download=filename;a.hidden=true;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
      if(!valid())return;
      exported={exportacion_id:result.exportacion_id,informe_hash:result.informe_hash};
      notice='Exportación generada. No se registró una entrega ni se envió un correo.';
    }catch{if(valid())showError();}finally{if(valid()){busy=false;render();}}
  }
  async function deliver(){
    const canal=root.querySelector('[name="canal"]')?.value;
    if(!canDeliver()||!root.querySelector('[name="confirmar_entrega"]')?.checked||!['recepcion_administrador','entrega_externa_declarada'].includes(canal))return;
    const payload={...exported,canal,confirmar_entrega:true},id=selected().id;busy=true;render();
    try{
      const result=await post('/entrega',payload);if(!valid())return;
      if(result?.estado!=='completada'||result.entrega?.enviado_por_sistema!==false)throw Error('Declaración no confirmada');
      toast('Se registró tu declaración de recepción o entrega. No se envió un correo desde Zilky.');
      busy=false;await load(id);
    }catch{if(valid())showError();}finally{if(valid()){busy=false;render();}}
  }
  async function prepareDelete(){
    if(!canPreview())return;busy=true;preview=null;exported=null;render();
    try{
      const result=await post('/borrado/preview');if(!valid())return;
      if(result?.solicitud?.id!==selected().id||result.solicitud.negocio_id!==negocio||!Array.isArray(result.bloqueos)||typeof result.puede_confirmar!=='boolean'||result.datos_locales_zilky_modificados!==false)throw Error('Vista previa inválida');
      if(result.puede_confirmar&&(!hash(result.confirmacion_token)||result.revocacion_verificada!==true||result.bloqueos.length||result.frase_requerida!==`BORRAR INTEGRACION ${selected().store_id}`||!Number.isFinite(Date.parse(result.vence_at))))throw Error('Confirmación inválida');
      preview=result;notice=result.puede_confirmar?'Revisá la vista previa; todavía no se eliminó nada.':'La revisión detectó bloqueos. No se eliminó nada.';
    }catch{if(valid())showError();}finally{if(valid()){busy=false;render();}}
  }
  async function deleteIntegration(){
    const frase=root.querySelector('[name="frase"]')?.value;
    if(!canDelete()||frase!==preview.frase_requerida||!root.querySelector('[name="confirmar_borrado"]')?.checked)return;
    const payload={confirmacion_token:preview.confirmacion_token,confirmar_borrado:true,frase},id=selected().id;busy=true;render();
    try{
      const result=await post('/borrado/confirmar',payload);if(!valid())return;
      if(result?.estado!=='completada'||result.solicitud_id!==id||result.datos_locales_zilky_modificados!==false||result.accion!=='datos_operativos_de_integracion_eliminados')throw Error('Borrado no confirmado');
      toast('Se retiraron los datos operativos indicados. El inventario, las ventas, los cobros y la web original se conservaron.');
      busy=false;await load(id);
    }catch{if(valid())showError();}finally{if(valid()){busy=false;preview=null;render();}}
  }
  root.addEventListener('click',event=>{
    if(!valid()||busy||loading)return;
    const target=event.target.closest('button');if(!target||target.disabled)return;
    if(target.hasAttribute('data-privacy-refresh'))void load();
    else if(target.hasAttribute('data-privacy-open'))void load(target.dataset.privacyOpen);
    else if(target.hasAttribute('data-privacy-export'))void exportReport();
    else if(target.hasAttribute('data-privacy-deliver'))void deliver();
    else if(target.hasAttribute('data-privacy-preview'))void prepareDelete();
    else if(target.hasAttribute('data-privacy-delete'))void deleteIntegration();
  });
  root.addEventListener('change',buttons);root.addEventListener('input',buttons);
  await load();
}
