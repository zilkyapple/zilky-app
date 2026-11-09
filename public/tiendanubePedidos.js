const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format(Number(value||0)/100);
const remoteId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const labels={pendiente:'Pendiente de entrega',revision:'Requiere revisión',cancelado:'Cancelado',entregada:'Entrega registrada'};
const nowAR=()=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
};
const plus30=date=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+30);return Number.isNaN(d.valueOf())?'':d.toISOString().slice(0,10);};
const cents=value=>{
  if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))throw Error('Ingresá el importe recibido con hasta dos decimales.');
  const [p,c='']=value.split('.'),n=Number(p)*100+Number(c.padEnd(2,'0'));
  if(!Number.isSafeInteger(n)||n>2147483647)throw Error('El importe recibido está fuera de rango.');
  return n;
};
const errors={
  ENTREGAS_TIENDANUBE_DESHABILITADAS:'La confirmación de entregas de Tiendanube todavía no está habilitada. No se registraron ventas ni cobros.',
  SINCRONIZACION_NO_LISTA_PARA_ENTREGA:'La sincronización necesita conciliación antes de confirmar esta entrega.',
  PEDIDO_NO_CONCILIADO_PARA_ENTREGA:'El pedido requiere revisión. No registres otra venta por separado.',
  EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION:'Hay una actualización del pedido pendiente de revisión.',
  COBRO_PASARELA_REQUIERE_CONCILIACION:'Este pedido tiene un cobro de pasarela. No lo registres como efectivo o transferencia manual.',
  ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION:'Hay un anticipo de otro día. Debe conciliarse conservando su fecha real.',
  ENVIO_IMPUESTOS_O_CARGOS_REQUIEREN_CONCILIACION:'El pedido incluye envío, impuestos o cargos que requieren conciliación.',
  COBRO_REMOTO_CONTRADICTORIO_REQUIERE_CONCILIACION:'El importe recibido no coincide con lo informado por Tiendanube. Revisá los registros.',
  COBRO_EXISTENTE_REQUIERE_CONCILIACION:'Ese dinero ya fue registrado. No lo vuelvas a cargar.',
  CONFIGURACION_ENTREGA_REQUIERE_REVISION:'La configuración de esta entrega necesita revisión del administrador.',
};

export async function tiendanubePedidosView(view,ctx){
  const {negocio,usuarioId,setHTML}=ctx;
  const allowed=()=>ctx.admin===true||(ctx.puede?.('tienda.pedidos',negocio)===true&&ctx.puede?.('ventas.crear',negocio)===true);
  if(!negocio||!usuarioId){setHTML(view,'<div class="empty-state"><p>Elegí un negocio para gestionar sus pedidos de Tiendanube.</p></div>');return;}
  if(!allowed()){setHTML(view,'<div class="empty-state"><p>No tenés permiso para gestionar estas entregas.</p></div>');return;}
  const root=document.createElement('section');root.className='tienda-admin';view.replaceChildren(root);
  const valid=()=>root.isConnected&&view.contains(root)&&ctx.negocio===negocio&&ctx.usuarioId===usuarioId&&allowed()&&(!ctx.valid||ctx.valid());
  const call=async(path,opts)=>{if(!valid())throw Error('Pantalla vencida');const r=await ctx.api(path,opts);if(!valid())throw Error('Pantalla vencida');return r;};
  const query='?negocio_id='+encodeURIComponent(negocio),key='zilky-tn-entrega:'+usuarioId+':'+negocio;
  let pedidos=[],caps={},opciones={clientes:[],vendedores:[]},selected=null,detail=null,loading=false,busy=false,notice='',sequence=0,pending=null;
  const initial=()=>{const time=nowAR();return {condicion:'30_dias',fecha:time.slice(0,10),limite:plus30(time.slice(0,10)),monto:'0',medio:'efectivo',hora:time,cliente:'',vendedor:usuarioId,entregado:false,cobrado:false};};
  let draft=initial();
  try{
    const stored=JSON.parse(sessionStorage.getItem(key)||'null');
    if(stored&&remoteId(stored.orderId)&&stored.body?.negocio_id===negocio&&typeof stored.body.solicitud_id==='string')pending=stored;
  }catch{}
  const persist=value=>{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);pending=value;};
  const mode=()=>detail?.condiciones?.find(m=>m.condicion_precio===draft.condicion);
  const canPay=()=>caps.puede_cobrar===true&&(ctx.admin===true||ctx.puede?.('pagos.registrar',negocio)===true);
  const canClient=()=>caps.puede_elegir_cliente===true&&(ctx.admin===true||ctx.puede?.('clientes.ver',negocio)===true);
  const canSeller=()=>ctx.admin===true&&caps.elegir_vendedor===true;
  const amount=()=>{try{return cents(draft.monto);}catch{return null;}};
  const showError=e=>{if(valid()){notice=errors[e?.code]||'No se pudo completar la operación. Actualizá el pedido y revisá su estado antes de confirmar.';render();}};

  function syncDraft(){
    const f=root.querySelector('[data-tn-delivery-form]');if(!f)return;
    const field=name=>f.elements.namedItem(name);
    for(const name of ['condicion','fecha','limite','monto','medio','hora','cliente','vendedor'])if(field(name))draft[name]=field(name).value;
    draft.entregado=field('entregado')?.checked===true;draft.cobrado=field('cobrado')?.checked===true;
  }
  function updateSummary(){
    if(!valid())return;
    const total=mode()?.total_centavos??0,received=amount(),balance=received===null?null:total-received;
    const summary=root.querySelector('[data-tn-balance]');
    if(summary)summary.textContent=balance===null||balance<0?'Revisá el importe recibido.':`Saldo pendiente: ${money(balance)}${balance>0?' · Un único saldo con vencimiento '+draft.limite:''}`;
    const payFields=root.querySelector('[data-tn-receipt-fields]');if(payFields)payFields.hidden=!(received>0);
    const due=root.querySelector('[data-tn-due]');if(due)due.hidden=balance===0;
    const submit=root.querySelector('[data-tn-confirm-delivery]');
    if(submit)submit.disabled=busy||loading||!!pending||!detail||!mode()||received===null||received<0||balance<0||!draft.entregado
      ||(received>0&&(!canPay()||!draft.cobrado))||(balance>0&&(!canClient()||!draft.cliente))||(draft.condicion==='contado'&&balance!==0);
  }
  function render(){
    if(!valid())return;
    const activeMode=mode(),received=amount(),locked=loading||busy||!!pending;
    let body='';
    if(detail?.entrega){
      const e=detail.entrega;
      body=`<article class="card ta-form"><h2>Pedido ${esc(selected)} · Entrega registrada</h2><p>Venta local: ${esc(e.venta_id)}</p><p>Total: ${esc(money(e.total_centavos))} · Recibido al entregar: ${esc(money(e.entrega_inicial_centavos))}</p><p>Saldo inicial: ${esc(money(e.saldo_inicial_centavos))}${e.fecha_limite?' · Vencimiento '+esc(e.fecha_limite):''}</p><p>Para nuevos pagos, usá la ficha del cliente o cobranzas. No registres nuevamente la venta ni el anticipo.</p></article>`;
    }else if(selected&&detail&&activeMode){
      body=`<form class="card ta-form" data-tn-delivery-form><h2>Confirmar entrega del pedido ${esc(selected)}</h2>
        <p class="ta-hint">Confirmá solamente cuando la prenda se entregue al cliente. La reserva ya descontó stock: este paso no vuelve a descontarlo.</p>
        ${detail.cobro_informado_por_tiendanube?'<p class="ta-notice">Tiendanube informa un pago. Eso no acredita un cobro local: verificá el dinero realmente recibido y que no esté registrado en Zilky.</p>':''}
        <fieldset ${locked?'disabled':''} style="border:0;padding:0;margin:0"><div class="ta-grid">
        <label>Modalidad<select name="condicion">${detail.condiciones.map(m=>`<option value="${esc(m.condicion_precio)}" ${m.condicion_precio===draft.condicion?'selected':''}>${m.condicion_precio==='contado'?'Contado · efectivo o transferencia':'A 30 días · dos pagos'}</option>`).join('')}</select></label>
        <label>Fecha real de entrega<input type="date" name="fecha" value="${esc(draft.fecha)}" max="${esc(nowAR().slice(0,10))}" required></label></div>
        <div>${activeMode.lineas.map(l=>`<p>${esc(l.nombre)} ${esc(l.variante||'')} · ${esc(l.cantidad)} × ${esc(money(l.precio_unitario_centavos))}</p>`).join('')}</div>
        <p>Precio publicado: ${esc(money(activeMode.precio_publicado_centavos))}${activeMode.descuento_centavos>0?' · Descuento contado: '+esc(money(activeMode.descuento_centavos)):''}</p><p><strong>Total de la venta: ${esc(money(activeMode.total_centavos))}</strong></p>
        <div class="ta-grid"><label>Dinero realmente recibido ahora ($)<input type="number" name="monto" min="0" step="0.01" max="${esc(activeMode.total_centavos/100)}" value="${esc(draft.monto)}" ${!canPay()?'disabled':''} required></label>
        ${canSeller()?`<label>Vendedor<select name="vendedor">${opciones.vendedores.map(v=>`<option value="${esc(v.id)}" ${v.id===draft.vendedor?'selected':''}>${esc(v.nombre||v.id)}</option>`).join('')}</select></label>`:''}</div>
        ${!canPay()?'<p class="ta-notice">No tenés permiso para registrar cobros. Solo podés confirmar una entrega sin dinero recibido si tenés permiso para el cliente.</p>':''}
        <div data-tn-receipt-fields ${received>0?'':'hidden'}><div class="ta-grid"><label>Medio de pago<select name="medio"><option value="efectivo" ${draft.medio==='efectivo'?'selected':''}>Efectivo</option><option value="transferencia" ${draft.medio==='transferencia'?'selected':''}>Transferencia</option></select></label><label>Fecha y hora reales del cobro<input type="datetime-local" name="hora" step="1" value="${esc(draft.hora)}"></label></div>
        <label class="ta-check"><input type="checkbox" name="cobrado" ${draft.cobrado?'checked':''}> Recibí este dinero y todavía no está registrado en Zilky.</label></div>
        <p class="ta-hint">Si no recibió dinero, dejá $0: quedará un único saldo por el total, no dos cuotas de la mitad. Anticipos anteriores, pagos de pasarela, envíos y promociones requieren conciliación.</p>
        <div class="ta-grid"><label>Cliente de Zilky<select name="cliente" ${!canClient()?'disabled':''}><option value="">${canClient()?'Elegí cliente si queda saldo':'Sin permiso para clientes'}</option>${opciones.clientes.map(c=>`<option value="${esc(c.id)}" ${c.id===draft.cliente?'selected':''}>${esc([c.nombre,c.apellido].filter(Boolean).join(' '))}</option>`).join('')}</select></label>
        <label data-tn-due>Fecha acordada para cancelar<input type="date" name="limite" min="${esc(draft.fecha)}" value="${esc(draft.limite)}"></label></div>
        ${canClient()?'<div class="ta-actions"><label>Buscar cliente<input type="search" name="buscar_cliente" maxlength="120"></label><button type="button" class="btn btn-secondary" data-tn-search-client>Buscar</button></div>':''}
        <p data-tn-balance role="status"></p><label class="ta-check"><input type="checkbox" name="entregado" ${draft.entregado?'checked':''}> Confirmo que el cliente recibió las prendas.</label>
        <button type="submit" class="btn btn-primary" data-tn-confirm-delivery disabled>Registrar entrega, venta y saldo</button></fieldset></form>`;
    }
    setHTML(root,`<header class="ta-heading"><div><h1>Pedidos Tiendanube</h1><p>Entrega de prendas y cobros reales del pedido seleccionado.</p></div><button type="button" class="btn btn-secondary" data-tn-orders-refresh ${busy||loading?'disabled':''}>Actualizar</button></header>
      <p class="ta-notice">Esta pantalla no marca pagos ni envíos en Tiendanube. No vuelvas a cargar estos pedidos como una venta manual.</p>
      <p role="status" aria-live="polite" data-tn-message>${esc(loading?'Comprobando pedidos…':notice)}</p>
      ${pending?`<section class="card ta-form"><h2>Confirmación pendiente de comprobar</h2><p>Pedido ${esc(pending.orderId)}. Se conserva la misma solicitud para evitar registros duplicados. No cargues otra venta.</p><button type="button" class="btn btn-primary" data-tn-retry ${busy||loading?'disabled':''}>Comprobar y reintentar la misma solicitud</button></section>`:''}
      <div class="ta-orders">${pedidos.map(p=>`<button type="button" class="ta-order-row" data-tn-order="${esc(p.order_id)}" ${busy||loading||pending?'disabled':''}><span>Pedido ${esc(p.order_id)}</span><span>${esc(labels[p.estado]||'Requiere revisión')}</span></button>`).join('')||(!loading?'<p>No hay pedidos disponibles en esta vista.</p>':'')}</div>${body}`);
    updateSummary();
  }
  const sanitizeCaps=v=>({puede_cobrar:v?.puede_cobrar===true,puede_elegir_cliente:v?.puede_elegir_cliente===true,elegir_vendedor:v?.elegir_vendedor===true});
  async function loadOptions(search=''){
    const r=await call('/tiendanube/pedidos/opciones'+query+'&buscar='+encodeURIComponent(search));
    opciones={clientes:(Array.isArray(r.clientes)?r.clientes:[]).filter(c=>typeof c.id==='string'),vendedores:(Array.isArray(r.vendedores)?r.vendedores:[]).filter(v=>typeof v.id==='string')};
  }
  async function load(){
    if(!valid()||busy||loading)return;
    const current=++sequence;loading=true;notice='';render();
    try{
      const r=await call('/tiendanube/pedidos'+query);if(!valid()||current!==sequence)return;
      pedidos=(Array.isArray(r.pedidos)?r.pedidos:[]).filter(p=>remoteId(p.order_id)).map(p=>({order_id:p.order_id,estado:p.estado}));caps=sanitizeCaps(r.capacidades);
      await loadOptions();if(!valid()||current!==sequence)return;
      if(r.sincronizacion_pausada)notice='La sincronización está pausada. No se pueden confirmar nuevas entregas.';
    }catch(e){if(valid()&&current===sequence){pedidos=[];detail=null;showError(e);}}
    finally{if(valid()&&current===sequence){loading=false;render();}}
  }
  async function openOrder(id,{preserve=false}={}){
    if(!valid()||busy||loading||pending||!remoteId(id))return;
    const current=++sequence;selected=id;detail=null;if(!preserve)draft=initial();loading=true;notice='';render();
    try{
      const r=await call('/tiendanube/pedidos/'+encodeURIComponent(id)+'/entrega'+query+'&fecha_entrega='+encodeURIComponent(draft.fecha));
      if(!valid()||current!==sequence)return;
      detail=r;caps=sanitizeCaps(r.capacidades);
      if(!r.entrega){
        detail.condiciones=(Array.isArray(r.condiciones)?r.condiciones:[]).filter(m=>['contado','30_dias'].includes(m.condicion_precio)&&Number.isSafeInteger(m.total_centavos)&&m.total_centavos>0&&Array.isArray(m.lineas));
        if(!detail.condiciones.some(m=>m.condicion_precio===draft.condicion))draft.condicion=detail.condiciones[0]?.condicion_precio||'30_dias';
      }
    }catch(e){if(valid()&&current===sequence)showError(e);}
    finally{if(valid()&&current===sequence){loading=false;render();}}
  }
  async function checkPending(){
    if(!pending)return false;
    const r=await call('/tiendanube/pedidos/'+encodeURIComponent(pending.orderId)+'/entrega'+query+'&fecha_entrega='+encodeURIComponent(pending.body.fecha_entrega));
    if(r?.entrega){selected=pending.orderId;detail=r;persist(null);notice='El pedido ya tiene una entrega registrada. Revisá los datos que aparecen abajo.';return true;}
    return false;
  }
  async function sendPending(){
    if(!valid()||!pending||busy||loading)return;
    busy=true;render();
    try{
      if(await checkPending())return;
      const r=await call('/tiendanube/pedidos/'+encodeURIComponent(pending.orderId)+'/entrega',{method:'POST',body:JSON.stringify(pending.body)});
      if(r?.estado!=='entregada'||typeof r.venta_id!=='string')throw Error('Respuesta sin confirmar');
      selected=pending.orderId;detail={entrega:r};persist(null);notice='Entrega y venta registradas. No se volvió a descontar el stock reservado.';
      pedidos=pedidos.map(p=>p.order_id===selected?{...p,estado:'entregada'}:p);
    }catch(e){
      if(valid()){
        showError(e);
        try{
          const delivered=await checkPending();
          // A definite validation/permission rejection plus a fresh read that
          // confirms no delivery permits editing. Ambiguous network/server
          // errors keep the exact request for a safe idempotent retry.
          if(!delivered&&pending&&e.status>=400&&e.status<500)persist(null);
        }catch{}
      }
    }finally{if(valid()){busy=false;render();}}
  }
  async function submit(){
    if(!valid()||busy||loading||pending||!mode())return;
    syncDraft();updateSummary();if(root.querySelector('[data-tn-confirm-delivery]')?.disabled)return;
    try{
      const received=cents(draft.monto),total=mode().total_centavos;
      if(draft.limite<draft.fecha&&received<total)throw Error('Revisá el vencimiento.');
      const body={negocio_id:negocio,solicitud_id:crypto.randomUUID(),fecha_entrega:draft.fecha,condicion_precio:draft.condicion,
        entrega_inicial_centavos:received,total_esperado_centavos:total,cliente_id:draft.cliente||null,confirmar_entrega:true};
      if(received<total)body.fecha_limite=draft.limite;
      if(canSeller())body.comision_usuario_id=draft.vendedor;
      if(received>0){body.medio_pago_entrega=draft.medio;body.fecha_hora_cobro=draft.hora+(draft.hora.length===16?':00':'')+'-03:00';body.confirmar_cobro=true;body.cobro_ya_registrado=false;}
      persist({orderId:selected,body});await sendPending();
    }catch(e){if(valid()){notice=e.message==='Revisá el vencimiento.'?e.message:'No se pudo preparar una confirmación segura. Revisá los datos.';render();}}
  }
  root.addEventListener('submit',event=>{if(event.target.matches('[data-tn-delivery-form]')){event.preventDefault();void submit();}});
  root.addEventListener('input',event=>{if(!valid()||pending)return;if(event.target.closest('[data-tn-delivery-form]')){syncDraft();updateSummary();}});
  root.addEventListener('change',event=>{
    if(!valid()||pending)return;
    const previousDate=detail?.fecha_entrega||draft.fecha;syncDraft();
    if(event.target.name==='fecha'){
      if(draft.limite===plus30(previousDate))draft.limite=plus30(draft.fecha);
      draft.entregado=false;draft.cobrado=false;void openOrder(selected,{preserve:true});return;
    }
    if(event.target.name==='condicion'){draft.entregado=false;draft.cobrado=false;render();}else updateSummary();
  });
  root.addEventListener('click',event=>{
    const b=event.target.closest?.('button');if(!b||!root.contains(b)||b.disabled||!valid())return;
    if(b.hasAttribute('data-tn-orders-refresh')){syncDraft();void load();}
    if(b.dataset.tnOrder)void openOrder(b.dataset.tnOrder);
    if(b.hasAttribute('data-tn-retry'))void sendPending();
    if(b.hasAttribute('data-tn-search-client')&&!busy&&!loading&&!pending){
      syncDraft();const term=root.querySelector('[name="buscar_cliente"]')?.value||'';busy=true;render();
      void loadOptions(term).catch(showError).finally(()=>{if(valid()){busy=false;render();}});
    }
  });
  await load();
}
