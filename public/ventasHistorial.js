import {pendingMutation} from './pendingMutation.js';
import {eliminarVentaPorError} from './ventaError.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format(Number(n||0)/100);
const activa=venta=>!['anulada','devuelta','eliminada_por_error'].includes(venta.estado);

export async function ventasHistorial(view,ctx){
  const {api,setHTML,negocio,admin,toast,usuarioId}=ctx;
  if(!negocio){setHTML(view,'<div class="empty-state">Elegí un negocio para ver sus ventas.</div>');return;}
  const token=localStorage.getItem('zilky_token'),root=document.createElement('section');root.className='sales-history';view.replaceChildren(root);
  const vigente=()=>root.isConnected&&view.contains(root)&&localStorage.getItem('zilky_token')===token&&(!ctx.isCurrent||ctx.isCurrent());
  const query='?negocio_id='+encodeURIComponent(negocio);
  let carga=0,detalle=0;
  const guardedApi=async(path,options)=>{if(!vigente())throw new Error('La pantalla cambió. Abrí nuevamente el historial.');return api(path,options);};
  const guard=pendingMutation({key:'zilky-devolucion-pendiente:'+usuarioId+':'+negocio,api:guardedApi,setHTML,
    toast:(...args)=>{if(vigente())toast(...args);},container:()=>vigente()?root.querySelector('#salesPending'):null,
    onSuccess:async()=>{if(vigente())await load();}});
  const error=err=>{if(vigente())toast(err.message,true);};
  const deleteButton=s=>admin&&activa(s)?`<button type="button" class="btn btn-danger" style="margin:0 0 14px" data-sale-error="${esc(s.id)}">Eliminar venta cargada por error</button>`:'';

  async function openError(id){
    if(!admin||!vigente())return;
    const current=++detalle,box=root.querySelector('#saleDetail');if(!box)return;
    setHTML(box,`<button type="button" class="btn btn-secondary" data-sale-error-back>Volver al detalle de la venta</button><div data-sale-error-panel></div>`);
    box.querySelector('[data-sale-error-back]').addEventListener('click',()=>{if(vigente()&&detalle===current)detail(id).catch(error);});
    const panel=box.querySelector('[data-sale-error-panel]');
    await eliminarVentaPorError(panel,{api,setHTML,negocio,ventaId:id,usuarioId,admin:true,toast,
      isCurrent:()=>vigente()&&detalle===current&&panel.isConnected&&box.contains(panel),
      onSuccess:async result=>{if(vigente()&&detalle===current){await load();if(vigente())await detail(result?.venta?.id||result?.id||id);}}});
    if(vigente()&&detalle===current)box.scrollIntoView?.({behavior:'smooth'});
  }
  async function load(){
    if(!vigente())return;const current=++carga;detalle++;
    const sales=await guardedApi('/ventas'+query);if(!vigente()||carga!==current)return;
    setHTML(root,`<header class="sales-heading"><div><h1>Ventas</h1><p>${admin?'Últimas operaciones del negocio':'Mis últimas ventas'}</p></div><a href="#/ventas/nueva" class="btn btn-primary">Nueva venta</a></header><div class="field"><label for="saleSearch">Buscar en las últimas 100 ventas</label><input id="saleSearch" placeholder="Cliente o vendedor"></div><div id="salesPending"></div><div id="saleList"></div><div id="saleDetail"></div>`);
    guard.show();
    const paint=q=>{
      if(!vigente()||carga!==current)return;
      const filtered=sales.filter(s=>[s.nombre,s.apellido,s.vendedor].join(' ').toLocaleLowerCase().includes(q));
      setHTML(root.querySelector('#saleList'),filtered.map(s=>`<article><button type="button" class="sale-history-row" data-sale="${esc(s.id)}"><div><strong>${s.consumidor_final_negocio?'Sin cliente identificado':esc([s.nombre,s.apellido].filter(Boolean).join(' '))}</strong><small>${esc(s.fecha)} · ${esc(s.vendedor||'Vendedor histórico')} · ${esc(String(s.estado||'').replaceAll('_',' '))}</small></div><div><strong>${esc(money(s.monto_total_centavos-s.devolucion_centavos))}</strong><small>${s.entrega_inicial_centavos===s.monto_total_centavos?'Contado':s.modalidad==='cuotas'?'En cuotas':'Saldo pendiente'}</small></div></button>${deleteButton(s)}</article>`).join('')||'<div class="cm-empty">No hay ventas con esa búsqueda.</div>');
      root.querySelectorAll('[data-sale]').forEach(b=>b.addEventListener('click',()=>{if(vigente()&&carga===current)detail(b.dataset.sale).catch(error);}));
      root.querySelectorAll('#saleList [data-sale-error]').forEach(b=>b.addEventListener('click',()=>{if(vigente()&&carga===current)openError(b.dataset.saleError).catch(error);}));
    };
    root.querySelector('#saleSearch').addEventListener('input',event=>paint(event.target.value.toLocaleLowerCase()));paint('');
  }
  async function detail(id){
    if(!vigente())return;const current=++detalle,loadId=carga;
    const d=await guardedApi('/ventas/'+encodeURIComponent(id)+query);
    if(!vigente()||detalle!==current||carga!==loadId)return;
    const box=root.querySelector('#saleDetail');if(!box)return;
    let request=crypto.randomUUID();
    setHTML(box,`<article class="card sale-detail"><h2>Venta del ${esc(d.venta.fecha)}</h2><p>Total original ${esc(money(d.venta.monto_total_centavos))} · Devuelto ${esc(money(d.venta.devolucion_centavos))}</p>
      ${deleteButton(d.venta)}
      ${(d.items||[]).map(it=>`<div class="cm-component"><div><strong>${esc(it.descripcion)}</strong><small>${esc(it.cantidad)} unidades · ${esc(money(it.precio_unitario_centavos))} por unidad${it.devuelto?' · '+esc(it.devuelto)+' devueltas':''}</small></div>${admin?`<label>Devolver<input type="number" min="0" max="${esc(it.cantidad-it.devuelto)}" step="1" value="0" data-return="${esc(it.id)}"></label>`:''}</div>`).join('')||'<p>Venta manual sin detalle de productos.</p>'}
      ${admin&&activa(d.venta)?`<details class="cm-settings"><summary>Devolución o anulación avanzada</summary><form id="saleReturn" class="cm-settings"><h3>Devolución o anulación</h3><label>Operación<select name="tipo"><option value="devolucion">Devolver las unidades indicadas</option><option value="anulacion">Anular todo lo que queda de la venta</option></select></label><label class="cm-check"><input name="reponer" type="checkbox" checked> Reponer las unidades en stock</label><label>Motivo<textarea name="motivo" maxlength="1000" required></textarea></label><p class="cm-hint">Primero se reduce el capital pendiente. El excedente queda como saldo a favor del cliente. En ventas sin cliente, queda como reintegro pendiente de esta operación. No se registra una devolución de dinero automáticamente. Si se devuelve o anula toda la venta, también se cancela la mora pendiente. Los pagos y comprobantes se conservan.</p><button class="btn btn-danger">Confirmar devolución / anulación</button></form></details>`:''}
      ${admin?`<h3>Historial de devoluciones</h3>${(d.devoluciones||[]).map(x=>`<div class="cm-agreement"><strong>${esc(x.tipo)} · ${esc(money(x.importe_centavos))}</strong><p>${esc(x.motivo)}</p><p class="cm-hint">Capital reducido: ${esc(money(x.capital_reducido_centavos))} · ${x.detalle?.destino_reintegro==='pendiente_en_esta_venta'?'Reintegro pendiente en esta venta':'Saldo a favor del cliente'}: ${esc(money(x.saldo_favor_centavos))}.</p></div>`).join('')||'<p class="cm-hint">Sin devoluciones.</p>'}`:''}</article>`);
    box.querySelector('[data-sale-error]')?.addEventListener('click',()=>{if(vigente()&&detalle===current)openError(id).catch(error);});
    const form=box.querySelector('#saleReturn');
    if(form){
      form.addEventListener('input',()=>{request=crypto.randomUUID();});
      form.addEventListener('submit',async event=>{
        event.preventDefault();const button=event.submitter||form.querySelector('button');
        if(button.disabled||!vigente()||detalle!==current||carga!==loadId)return;
        const f=new FormData(form),items=[...box.querySelectorAll('[data-return]')].map(x=>({id:x.dataset.return,cantidad:Number(x.value)})).filter(x=>x.cantidad>0);
        if(!confirm('¿Confirmás esta operación? Se ajustarán el stock, la deuda y la comisión, conservando el historial.'))return;
        button.disabled=true;
        try{
          await guard.run('/ventas/'+encodeURIComponent(id)+'/devoluciones',{negocio_id:negocio,solicitud_id:request,tipo:f.get('tipo'),reponer:f.has('reponer'),motivo:f.get('motivo'),items,version:d.version});
          if(!vigente()||detalle!==current)return;
          await load();if(vigente())await detail(id);if(vigente())toast('Operación registrada');
        }catch(err){if(vigente()&&detalle===current){button.disabled=false;toast(err.message,true);}}
      });
    }
    box.scrollIntoView?.({behavior:'smooth'});
  }
  await load();
}
