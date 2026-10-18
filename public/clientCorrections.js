import {pendingMutation} from './pendingMutation.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format(Number(value||0)/100);
const date=value=>value?String(value).slice(0,10).split('-').reverse().join('/'):'Sin fecha';
const datePart=value=>String(value||'').slice(0,10);
const recargo=mode=>mode==='sin_interes'?'Sin recargo por atraso':'Con las reglas del negocio';
const amount=value=>{const n=Math.round(Number(value)*100);if(value===''||!Number.isSafeInteger(n)||n<0)throw Error('Revisá los importes: deben ser números positivos o cero.');return n;};
const field=(id,label,html)=>`<div class="field"><label for="${id}">${label}</label>${html}</div>`;
const input=(id,type,value,extra='')=>`<input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>`;
const diff=(label,before,after)=>String(before??'')===String(after??'')?'':`<div class="cor-diff"><dt>${esc(label)}</dt><dd><span class="cor-before">Antes: ${esc(before||'—')}</span><strong>Ahora: ${esc(after||'—')}</strong></dd></div>`;
const notice=text=>`<p class="cor-notice">${esc(text)}</p>`;

function setup(ctx,title,key) {
  if(!ctx.admin||!ctx.valid())return null;
  ctx.openSheet(`<div class="sheet-handle"></div><section class="client-correction"><header class="cor-heading"><div><span class="cor-eyebrow">Corregir una carga</span><h2 class="sheet-title">${esc(title)}</h2></div><button type="button" class="btn btn-ghost" data-action="cerrar-sheet" aria-label="Cerrar corrección">Cerrar</button></header><div id="corPending"></div><p id="corError" role="alert" hidden></p><div id="corContent"><p>Cargando datos…</p></div></section>`);
  const sheet=document.getElementById('activeSheet');
  if(!sheet)return null;
  sheet.classList.add('correction-sheet');
  const valid=()=>ctx.valid()&&sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open');
  const pending=()=>!!sessionStorage.getItem(key);
  const error=message=>{if(!valid())return;const el=sheet.querySelector('#corError');el.hidden=!message;el.textContent=message;};
  const success=async()=>{if(valid()){ctx.closeSheet();ctx.toast('Corrección guardada. El historial se conserva.');await ctx.refresh();}};
  const guard=pendingMutation({key,api:(...args)=>{if(!valid())throw Error('La sesión o la ficha cambió. Volvé a abrir la corrección.');return ctx.api(...args);},setHTML:ctx.setHTML,toast:ctx.toast,container:()=>valid()?sheet.querySelector('#corPending'):null,onSuccess:success});
  guard.show();
  if(pending())ctx.setHTML(sheet.querySelector('#corContent'),notice('La corrección anterior todavía no está confirmada. Usá el botón de arriba para comprobarla sin cargar otra vez los datos.'));
  return {sheet,valid,pending,error,guard,success,content:sheet.querySelector('#corContent')};
}

function lock(form,disabled){for(const el of form.querySelectorAll('input,textarea,select,button')){if(disabled){el.dataset.corDisabled=el.disabled?'1':'0';el.disabled=true;}else if(el.dataset.corDisabled!==undefined){el.disabled=el.dataset.corDisabled==='1';delete el.dataset.corDisabled;}}}
function nextMonth(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return '';const [y,m,d]=value.split('-').map(Number);return new Date(Date.UTC(y,m,Math.min(d,new Date(Date.UTC(y,m+1,0)).getUTCDate()))).toISOString().slice(0,10);}
function centsInput(id,value,min=0){return input(id,'number',(value||0)/100,`min="${min}" step="0.01" inputmode="decimal" required`);}

export async function financiacionCorreccion(ctx,creditoId,negocioId) {
  const ui=setup(ctx,'Corregir fechas y cuotas',`zilky-correccion-financiacion:${ctx.usuarioId}:${negocioId}:${creditoId}`);
  if(!ui||ui.pending())return;
  const {sheet,valid,content,error}=ui;
  const path=`/ventas/creditos/${encodeURIComponent(creditoId)}/correccion`;
  try {
    const v=await ctx.api(`${path}?negocio_id=${encodeURIComponent(negocioId)}`);if(!valid())return;
    const cr=v.credito,oldDate=v.fecha_entrega_inicial||datePart((v.pagos||[]).find(p=>p.tipo==='entrega_inicial'&&!p.anulado)?.fecha_hora),oldMode=cr.mora_modo||'negocio';
    const mora=v.mora_pendiente_centavos??v.interes?.pendiente_centavos??0;
    ctx.setHTML(content,`<p class="sheet-sub">Corregí datos de compras anteriores, incluso si ya tienen pagos. Revisarás los cambios antes de guardarlos.</p><form id="corForm"><fieldset class="cor-section"><legend>Compra y entrega inicial</legend>
      ${field('corProducto','Producto o equipo',input('corProducto','text',cr.producto_descripcion||'','maxlength="4000" placeholder="Ej.: celular, remera…"'))}
      <div class="cor-grid">${field('corFecha','Fecha en que retiró el producto',input('corFecha','date',datePart(cr.fecha_inicio),'required'))}${field('corTotal','Importe de la operación ($)',centsInput('corTotal',cr.monto_total_centavos,0.01))}${field('corEntrega','Entrega inicial ($)',centsInput('corEntrega',cr.entrega_inicial_centavos))}${field('corEntregaFecha','Fecha de la entrega de dinero',input('corEntregaFecha','date',oldDate||datePart(cr.fecha_inicio),'required'))}</div>
      <p class="field-hint">La fecha del dinero puede ser distinta a la fecha en que retiró el producto. Si no hubo entrega inicial, dejá el importe en cero.</p></fieldset>
      <fieldset class="cor-section"><legend>Cuotas y vencimientos</legend><p class="field-hint">Podés corregir cuotas pagadas o pendientes. El importe de una cuota no puede ser menor al capital que ya se cobró.</p><div id="corCuotas" class="cor-installments"></div><button type="button" id="corAgregar" class="btn btn-secondary">Agregar cuota</button><p id="corSuma" class="field-hint" aria-live="polite"></p></fieldset>
      <fieldset class="cor-section"><legend>Interés y condiciones</legend>${field('corMora','Interés por atraso',`<select id="corMora"><option value="negocio" ${oldMode==='negocio'?'selected':''}>Con recargo · reglas del negocio</option><option value="sin_interes" ${oldMode==='sin_interes'?'selected':''}>Sin recargo por atraso</option></select>`)}
      <p class="field-hint">El precio financiado se corrige en los importes de arriba. Esta opción controla solamente el recargo por atraso.</p><div id="corInteresAviso"></div>${field('corCondiciones','Condiciones u observaciones',`<textarea id="corCondiciones" maxlength="4000" rows="3">${esc(cr.condiciones||'')}</textarea>`)}</fieldset>
      <fieldset class="cor-section"><legend>Motivo</legend>${field('corMotivo','¿Qué dato estaba mal?',`<textarea id="corMotivo" maxlength="2000" rows="2" required placeholder="Ej.: estaba pasando el cuaderno y cargué mal la fecha de retiro"></textarea>`)}<p class="field-hint">Se guarda quién hizo el cambio, cuándo y cómo estaban los datos antes.</p></fieldset><div class="cor-actions"><button type="button" class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button id="corRevisar" class="btn btn-primary">Revisar cambios</button></div></form><div id="corReview" hidden></div>`);
    const form=sheet.querySelector('#corForm'),list=sheet.querySelector('#corCuotas'),review=sheet.querySelector('#corReview');
    let busy=false,sequence=0;
    const update=()=>{
      const entrega=sheet.querySelector('#corEntregaFecha');entrega.disabled=Number(sheet.querySelector('#corEntrega').value)===0;entrega.required=!entrega.disabled;
      const sin=sheet.querySelector('#corMora').value==='sin_interes';
      ctx.setHTML(sheet.querySelector('#corInteresAviso'),sin?notice(mora>0?`Al elegir sin recargo se perdonarán ${money(mora)} de mora pendiente. Los intereses ya cobrados se conservan.`:'Esta operación no generará nuevos recargos por atraso. Los intereses ya cobrados se conservan.'):notice('Se aplican las reglas de atraso del negocio. Corregir una fecha conserva los recargos ya registrados.'));
      [...list.children].forEach((r,i)=>{r.querySelector('.cor-quota-name').textContent=`Cuota ${i+1}`;});
      const total=[...list.querySelectorAll('.corMonto')].reduce((s,el)=>s+(Number(el.value)||0),0);sheet.querySelector('#corSuma').textContent=`Total de cuotas: ${money(Math.round(total*100))}. Revisá que coincida con lo acordado con el cliente.`;
    };
    function add(q={}){
      const n=++sequence,row=document.createElement('div');row.className='cor-installment';row.dataset.id=q.id||'';
      const collected=Number.isFinite(q.saldo_pendiente_centavos)?Math.max(0,q.monto_centavos-q.saldo_pendiente_centavos):0;
      const hasHistory=collected>0||q.fecha_saldada||(v.aplicaciones||[]).some(a=>a.cuota_id===q.id)||q.mora_generada_centavos>0;
      const last=list.lastElementChild?.querySelector('.corVence')?.value||cr.fecha_inicio;
      ctx.setHTML(row,`<div class="cor-quota-head"><strong class="cor-quota-name"></strong>${q.fecha_saldada?'<span class="badge badge-pagada">Pagada</span>':collected>0?'<span class="badge badge-proxima">Pago parcial</span>':''}</div><div class="cor-grid">${field('corMonto'+n,'Importe ($)',input('corMonto'+n,'number',q.monto_centavos===undefined?'':q.monto_centavos/100,`class="corMonto" min="${Math.max(1,collected)/100}" step="0.01" inputmode="decimal" required`))}${field('corVence'+n,'Vencimiento',input('corVence'+n,'date',q.fecha_vencimiento||nextMonth(last),'class="corVence" required'))}</div>${collected>0?`<p class="field-hint">Capital ya cobrado: ${esc(money(collected))}. Si aumentás el importe, quedará una diferencia pendiente.</p>`:''}<button type="button" class="btn btn-ghost corQuitar" ${hasHistory?'disabled':''}>Quitar cuota</button>${hasHistory?'<span class="field-hint">Se conserva porque tiene historial.</span>':''}`);
      row.querySelector('.corQuitar').onclick=()=>{if(valid()&&!busy&&!hasHistory){row.remove();update();}};list.appendChild(row);update();
    }
    v.cuotas.forEach(add);update();form.addEventListener('input',update);form.addEventListener('change',update);
    sheet.querySelector('#corAgregar').onclick=()=>{if(valid()&&!busy)add();};
    form.onsubmit=e=>{
      e.preventDefault();if(busy||!valid()||ui.pending())return;error('');
      try{
        if(!form.reportValidity())return;
        const read=id=>sheet.querySelector('#'+id).value;
        const datos={monto_total_centavos:amount(read('corTotal')),entrega_inicial_centavos:amount(read('corEntrega')),fecha_inicio:read('corFecha'),fecha_entrega_inicial:Number(read('corEntrega'))>0?read('corEntregaFecha'):null,producto_descripcion:read('corProducto'),condiciones:read('corCondiciones'),mora_modo:read('corMora'),cuotas:[...list.children].map(row=>({...(row.dataset.id?{id:row.dataset.id}:{}),monto_centavos:amount(row.querySelector('.corMonto').value),fecha_vencimiento:row.querySelector('.corVence').value}))};
        const motivo=read('corMotivo').trim();if(!motivo)throw Error('Indicá el motivo de la corrección.');
        if(datos.entrega_inicial_centavos>datos.monto_total_centavos)throw Error('La entrega inicial no puede superar el importe de la operación.');
        let differences=diff('Fecha de retiro del producto',date(cr.fecha_inicio),date(datos.fecha_inicio))+diff('Importe de la operación',money(cr.monto_total_centavos),money(datos.monto_total_centavos))+diff('Entrega inicial',money(cr.entrega_inicial_centavos),money(datos.entrega_inicial_centavos))+diff('Fecha de entrega del dinero',date(oldDate),date(datos.fecha_entrega_inicial))+diff('Producto o equipo',cr.producto_descripcion,datos.producto_descripcion)+diff('Condiciones',cr.condiciones,datos.condiciones)+diff('Interés por atraso',recargo(oldMode),recargo(datos.mora_modo));
        datos.cuotas.forEach((q,i)=>{const old=v.cuotas.find(x=>x.id===q.id);differences+=old?diff(`Cuota ${i+1} · importe`,money(old.monto_centavos),money(q.monto_centavos))+diff(`Cuota ${i+1} · vencimiento`,date(old.fecha_vencimiento),date(q.fecha_vencimiento)):diff(`Nueva cuota ${i+1}`,'',`${money(q.monto_centavos)} · ${date(q.fecha_vencimiento)}`);});
        v.cuotas.filter(q=>!datos.cuotas.some(x=>x.id===q.id)).forEach(q=>differences+=diff(`Cuota ${q.numero||v.cuotas.indexOf(q)+1} quitada`,`${money(q.monto_centavos)} · ${date(q.fecha_vencimiento)}`,'Se quita del plan'));
        if(datos.mora_modo==='sin_interes'&&mora>0)differences+=diff('Recargos pendientes',money(mora),money(0));
        if(!differences)throw Error('No hay cambios para guardar.');
        const waiver=datos.mora_modo==='sin_interes'&&mora>0;
        form.hidden=true;
        ctx.setHTML(review,`<h3>Revisá la corrección</h3><dl class="cor-differences">${differences}</dl><p><strong>Motivo:</strong> ${esc(motivo)}</p>${notice('Los pagos de cuotas se conservan. Al corregir una entrega inicial, se conserva el comprobante anterior anulado y se emite el corregido. Esta carga no registra un nuevo ingreso de dinero.')}${(v.pagos||[]).length?'<label class="cor-check"><input id="corConfirmar" type="checkbox"> Revisé los pagos existentes y los cambios de esta operación.</label>':''}${waiver?`<label class="cor-check"><input id="corConfirmarInteres" type="checkbox"> Confirmo perdonar ${esc(money(mora))} de recargos pendientes.</label>`:''}<div class="cor-actions"><button type="button" id="corVolver" class="btn btn-secondary">Volver a editar</button><button type="button" id="corGuardar" class="btn btn-primary">Guardar corrección</button></div>`);review.hidden=false;review.scrollIntoView?.({block:'start',behavior:'smooth'});
        const volver=()=>{if(busy||!valid()||ui.pending())return;review.hidden=true;form.hidden=false;error('');};sheet.querySelector('#corVolver').onclick=volver;
        sheet.querySelector('#corGuardar').onclick=async()=>{
          if(busy||!valid()||ui.pending())return;
          if((v.pagos||[]).length&&!sheet.querySelector('#corConfirmar').checked)return error('Marcá que revisaste los pagos existentes.');
          if(waiver&&!sheet.querySelector('#corConfirmarInteres').checked)return error('Confirmá el importe de recargos que se perdonará.');
          const body={negocio_id:negocioId,version:v.version,datos,motivo,solicitud_id:crypto.randomUUID(),confirmar_correccion_pagos:true,confirmar_sin_interes:waiver};
          busy=true;error('');lock(review,true);lock(form,true);
          try{await ui.guard.run(path,body,'PATCH');await ui.success();}
          catch(err){if(valid()){error(err.message);if(!ui.pending()){lock(review,false);lock(form,false);if(err.status===409){ctx.setHTML(review,`<p>Los datos cambiaron o requieren revisión. Abrí nuevamente la corrección para trabajar con la información actual.</p><button type="button" id="corRecargar" class="btn btn-secondary">Volver a cargar datos</button>`);sheet.querySelector('#corRecargar').onclick=()=>{if(valid())financiacionCorreccion(ctx,creditoId,negocioId);};}}}}
          finally{busy=false;}
        };
      }catch(err){error(err.message);}
    };
  }catch(err){if(valid()){ctx.setHTML(content,'');error(err.message);}}
}

function localPaymentTime(value){
  if(!value)return '';
  const d=new Date(value);if(Number.isNaN(d.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).reduce((s,p)=>({...s,[p.type]:p.value}),{});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function paymentDate(value){const local=localPaymentTime(value);return local?`${date(local)} ${local.slice(11,19)}`:'Sin fecha';}

export async function pagoCorreccion(ctx,pagoId,negocioId) {
  const ui=setup(ctx,'Corregir pago',`zilky-correccion-pago:${ctx.usuarioId}:${negocioId}:${pagoId}`);
  if(!ui||ui.pending())return;
  const {sheet,valid,content,error}=ui,path=`/pagos/${encodeURIComponent(pagoId)}/correccion`;
  try{
    const v=await ctx.api(`${path}?negocio_id=${encodeURIComponent(negocioId)}`);if(!valid())return;
    const p=v.pago,initial=p.tipo==='entrega_inicial',methods={efectivo:'Efectivo',transferencia:'Transferencia',tarjeta:'Tarjeta',otro:'Otro',no_especificado:'No especificado'};
    if(p.medio_pago&&!methods[p.medio_pago])methods[p.medio_pago]=p.medio_pago;
    ctx.setHTML(content,`<p class="sheet-sub">${initial?'Entrega inicial':'Pago de cuota'} · ${esc(paymentDate(p.fecha_hora))} · ${esc(money(p.monto_centavos))}</p><form id="corPagoForm"><fieldset class="cor-section"><legend>Datos correctos del pago</legend><div class="cor-grid">${field('corPagoFecha','Fecha y hora del dinero recibido',input('corPagoFecha','datetime-local',localPaymentTime(p.fecha_hora),'step="1" required'))}${field('corPagoMonto','Importe recibido ($)',input('corPagoMonto','number',p.monto_centavos/100,`min="0.01" step="0.01" inputmode="decimal" required ${initial?'readonly':''}`))}</div><p class="field-hint">Fecha y hora de Argentina. Puede ser anterior al retiro del producto.</p>${initial?notice('Para cambiar el importe de la entrega inicial, abrí “Corregir fechas y cuotas” en esta compra. Acá podés corregir su fecha, medio y nota.'):''}${field('corPagoMedio','Medio de pago',`<select id="corPagoMedio">${Object.entries(methods).map(([key,label])=>`<option value="${esc(key)}" ${key===p.medio_pago?'selected':''}>${esc(label)}</option>`).join('')}</select>`)}${field('corPagoNota','Nota del pago (opcional)',`<textarea id="corPagoNota" maxlength="4000" rows="2">${esc(p.nota||'')}</textarea>`)}</fieldset><fieldset class="cor-section"><legend>Motivo</legend>${field('corPagoMotivo','¿Qué dato estaba mal?',`<textarea id="corPagoMotivo" maxlength="2000" rows="2" required placeholder="Ej.: el cliente entregó el dinero el día anterior"></textarea>`)}</fieldset><div class="cor-actions"><button type="button" class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button id="corPagoRevisar" class="btn btn-primary">Revisar cambios</button></div></form><div id="corPagoReview" hidden></div>`);
    const form=sheet.querySelector('#corPagoForm'),review=sheet.querySelector('#corPagoReview');let busy=false;
    form.onsubmit=async e=>{
      e.preventDefault();if(busy||!valid()||ui.pending())return;error('');
      if(!form.reportValidity())return;
      try{
        const get=id=>sheet.querySelector('#'+id).value;
        const raw=get('corPagoFecha'),fecha=raw.length===16?raw+':00':raw;
        const datos={fecha_hora:new Date(`${fecha}-03:00`).getTime()===new Date(`${localPaymentTime(p.fecha_hora)}-03:00`).getTime()?p.fecha_hora:`${fecha}-03:00`,monto_centavos:amount(get('corPagoMonto')),medio_pago:get('corPagoMedio'),nota:get('corPagoNota')};
        const motivo=get('corPagoMotivo').trim();if(!motivo)throw Error('Indicá el motivo de la corrección.');
        if(new Date(datos.fecha_hora).getTime()===new Date(p.fecha_hora).getTime()&&datos.monto_centavos===p.monto_centavos&&datos.medio_pago===p.medio_pago&&datos.nota===(p.nota||''))throw Error('No hay cambios para guardar.');
        busy=true;lock(form,true);
        const result=await ctx.api(`${path}/vista`,{method:'POST',body:JSON.stringify({negocio_id:negocioId,version:v.version,datos})});if(!valid())return;
        const r=result.resumen;
        const diffs=diff('Fecha del pago',paymentDate(p.fecha_hora),paymentDate(datos.fecha_hora))+diff('Importe recibido',money(p.monto_centavos),money(datos.monto_centavos))+diff('Medio',methods[p.medio_pago],methods[datos.medio_pago])+diff('Nota',p.nota,datos.nota);
        form.hidden=true;
        ctx.setHTML(review,`<h3>Revisá la corrección</h3><dl class="cor-differences">${diffs}</dl><div class="cor-totals"><div><span>Capital pendiente antes</span><strong>${esc(money(r.saldo_anterior_centavos))}</strong></div><div><span>Capital pendiente después</span><strong>${esc(money(r.saldo_posterior_centavos))}</strong></div></div>${r.saldo_favor_anterior_centavos||r.saldo_favor_posterior_centavos?`<dl class="cor-differences">${diff('Saldo a favor',money(r.saldo_favor_anterior_centavos),money(r.saldo_favor_posterior_centavos))||`<div class="cor-diff"><dt>Saldo a favor conservado</dt><dd>${esc(money(r.saldo_favor_posterior_centavos))}</dd></div>`}</dl>`:''}${(r.aplicaciones||[]).some(a=>a.capital_anterior_centavos!==a.capital_nuevo_centavos||a.mora_anterior_centavos!==a.mora_nueva_centavos)?`<details class="cor-section"><summary>Cómo queda aplicado a las cuotas</summary><dl class="cor-differences">${r.aplicaciones.map(a=>diff(`Cuota ${a.numero} · capital`,money(a.capital_anterior_centavos),money(a.capital_nuevo_centavos))+diff(`Cuota ${a.numero} · mora`,money(a.mora_anterior_centavos),money(a.mora_nueva_centavos))).join('')}</dl></details>`:''}<p><strong>Motivo:</strong> ${esc(motivo)}</p>${notice(r.aviso||'El pago original y su comprobante se conservan anulados, junto a la corrección. No se registra una nueva entrega física de dinero.')}<label class="cor-check"><input id="corPagoConfirmar" type="checkbox"> Revisé la fecha, el importe y el capital pendiente que quedará.</label><div class="cor-actions"><button type="button" id="corPagoVolver" class="btn btn-secondary">Volver a editar</button><button type="button" id="corPagoGuardar" class="btn btn-primary">Guardar corrección</button></div>`);review.hidden=false;review.scrollIntoView?.({block:'start',behavior:'smooth'});
        sheet.querySelector('#corPagoVolver').onclick=()=>{if(!busy&&valid()&&!ui.pending()){review.hidden=true;form.hidden=false;error('');}};
        sheet.querySelector('#corPagoGuardar').onclick=async()=>{
          if(busy||!valid()||ui.pending())return;
          if(!sheet.querySelector('#corPagoConfirmar').checked)return error('Marcá que revisaste el pago y el saldo.');
          const body={negocio_id:negocioId,version:result.version||v.version,datos,motivo,solicitud_id:crypto.randomUUID()};
          busy=true;error('');lock(review,true);lock(form,true);
          try{await ui.guard.run(path,body,'PATCH');await ui.success();}
          catch(err){if(valid()){error(err.message);if(!ui.pending()){lock(review,false);lock(form,false);if(err.status===409){ctx.setHTML(review,'<p>El pago o sus cuotas cambiaron. Volvé a cargar los datos antes de corregir.</p><button type="button" id="corRecargar" class="btn btn-secondary">Volver a cargar datos</button>');sheet.querySelector('#corRecargar').onclick=()=>{if(valid())pagoCorreccion(ctx,pagoId,negocioId);};}}}}
          finally{busy=false;}
        };
      }catch(err){error(err.message);}
      finally{busy=false;if(valid()&&!ui.pending())lock(form,false);}
    };
  }catch(err){if(valid()){ctx.setHTML(content,'');error(err.message);}}
}
