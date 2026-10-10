const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qty=v=>v===null?'Sin control':String(v);
const money=v=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format((v||0)/100);
const types={creacion:'Producto creado',edicion:'Datos editados',reposicion:'Reposición',conteo:'Ajuste por conteo',sin_control:'Control desactivado',venta:'Venta'};
const labels={nombre:'Nombre',categoria:'Categoría',variante:'Variante',sku:'Código / SKU',imei:'IMEI',estado:'Estado',costo_centavos:'Costo',precio_contado_centavos:'Precio contado',precio_financiado_centavos:'Precio financiado',stock_minimo:'Alerta de stock mínimo'};
async function thumbnail(file){
 if(file.size>10*1024*1024)throw Error('Elegí una foto de menos de 10 MB');
 const url=URL.createObjectURL(file);try{
 const img=new Image();img.src=url;await img.decode();
 const canvas=document.createElement('canvas');const ratio=Math.min(1,480/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
 for(const quality of [.8,.65,.5,.35,.2]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<=65000)return data;}
 throw Error('La foto tiene demasiado detalle. Probá otra imagen.');
 }finally{URL.revokeObjectURL(url);}
}
export async function productoEditor(ctx,productId=null){
 const {api,openSheet,closeSheet,toast,refresh}=ctx;
 try{
 const p=productId?await api('/productos/'+encodeURIComponent(productId)+'?negocio_id='+encodeURIComponent(ctx.negocio)):null;
 if(!ctx.valid())return;
 const field=(k,type='text',extra='')=>`<div class="field"><label for="pe-${k}">${e(labels[k])}${k==='nombre'?' *':''}</label><input id="pe-${k}" name="${k}" type="${type}" value="${e(p?.[k]?.toString()??'')}" ${extra}></div>`;
 openSheet(`<div class="sheet-handle"></div><div class="sheet-title">${p?'Editar producto':'Producto nuevo'}</div><form id="product-form" class="product-form">
 ${!p?`<div class="field"><label for="pe-business">Negocio</label><select id="pe-business" name="negocio_id">${ctx.negocios.map(n=>`<option value="${e(n.id)}" ${n.id===ctx.negocio?'selected':''}>${e(n.nombre)}</option>`).join('')}</select></div>`:''}
 <p class="muted">Solo el nombre es obligatorio. Completá los demás datos cuando los necesites.</p>
 ${field('nombre','text','required maxlength="180"')}
 <div class="product-fields">${field('categoria','text','maxlength="120"')}${field('variante','text','maxlength="200"')}${field('sku','text','maxlength="100"')}${field('imei','text','maxlength="100"')}${field('estado','text','maxlength="80"')}</div>
 <div class="product-fields">${['costo_centavos','precio_contado_centavos','precio_financiado_centavos'].map(k=>`<div class="field"><label for="pe-${k}">${e(labels[k])} ($)</label><input id="pe-${k}" name="${k}" type="number" min="0" step="0.01" max="21474836.47" value="${p?.[k]?p[k]/100:''}" placeholder="Opcional"></div>`).join('')}${field('stock_minimo','number','min="0" step="1" max="2147483647"')}</div>
 ${!p?'<div class="field"><label for="pe-stock">Stock inicial</label><input id="pe-stock" name="stock" type="number" min="0" max="2147483647" step="1" placeholder="Vacío: sin control de stock"></div>':`<p>Stock: <strong>${e(qty(p.stock))}</strong>. Usá Reponer o Ajustar para cambiarlo con historial.</p>`}
 <fieldset class="product-photo"><legend>Foto opcional</legend><img id="pe-preview" alt="Vista previa del producto" ${p?.foto_url?`src="${e(p.foto_url)}"`:'hidden'} referrerpolicy="no-referrer"><div class="field"><label for="pe-file">Elegir foto</label><input id="pe-file" type="file" accept="image/*"></div><div class="field"><label for="pe-url">O pegar un enlace HTTPS</label><input id="pe-url" type="url" placeholder="https://..." value="${e(p?.foto_url?.startsWith('https://')?p.foto_url:'')}" maxlength="2000"></div><button type="button" class="btn btn-secondary" id="pe-remove-photo">Quitar foto</button><p class="muted">La imagen se guarda reducida para que el catálogo cargue rápido.</p></fieldset>
 <div class="sheet-actions"><button type="button" class="btn btn-secondary" id="pe-cancel">Cancelar</button><button type="submit" class="btn btn-primary" id="pe-save">Guardar producto</button></div></form>`);
 const form=document.getElementById('product-form'),save=form.querySelector('#pe-save'),preview=form.querySelector('#pe-preview'),file=form.querySelector('#pe-file'),url=form.querySelector('#pe-url');let photo=p?.foto_url||null,loading=false,photoVersion=0;
 const showPhoto=()=>{preview.hidden=!photo;if(photo)preview.src=photo;else preview.removeAttribute('src');};
 form.querySelector('#pe-cancel').onclick=closeSheet;
 file.onchange=async()=>{const version=++photoVersion;if(!file.files[0])return;loading=true;save.disabled=true;try{const data=await thumbnail(file.files[0]);if(version!==photoVersion)return;photo=data;url.value='';showPhoto();}catch(err){toast(err.message||'No se pudo leer la foto. Probá JPG o PNG.',true);}finally{if(version===photoVersion){loading=false;save.disabled=false;}}};
 url.oninput=()=>{photoVersion++;loading=false;save.disabled=false;photo=url.value.trim()||null;file.value='';if(!photo||photo.startsWith('https://'))showPhoto();};
 form.querySelector('#pe-remove-photo').onclick=()=>{photoVersion++;loading=false;save.disabled=false;photo=null;url.value='';file.value='';showPhoto();};
 form.onsubmit=async ev=>{ev.preventDefault();if(loading||save.disabled||!ctx.valid())return;save.disabled=true;
 try{const data=Object.fromEntries(new FormData(form));for(const k of ['costo_centavos','precio_contado_centavos','precio_financiado_centavos'])data[k]=Math.round(Number(data[k]||0)*100);data.stock_minimo=Number(data.stock_minimo||0);data.foto_url=photo;data.negocio_id=p?p.negocio_id:data.negocio_id;
 if(p)data.revision=p.revision;else data.stock=data.stock===''?null:Number(data.stock);
 await api('/productos'+(p?'/'+encodeURIComponent(p.id):''),{method:p?'PUT':'POST',body:JSON.stringify(data)});if(!ctx.valid())return;closeSheet();toast(p?'Producto actualizado':'Producto creado');refresh();
 }catch(err){toast(err.message,true);save.disabled=false;}};
 }catch(err){toast(err.message,true);}
}
export async function productoStock(ctx,productId){
 const {api,openSheet,closeSheet,toast,refresh}=ctx;
 try{const p=await api('/productos/'+encodeURIComponent(productId)+'?negocio_id='+encodeURIComponent(ctx.negocio));if(!ctx.valid())return;
 openSheet(`<div class="sheet-handle"></div><div class="sheet-title">Stock · ${e(p.nombre)}</div><form id="stock-form" class="product-form"><p>Stock actual: <strong>${e(qty(p.stock))}</strong></p><div class="field"><label for="ps-type">Acción</label><select id="ps-type"><option value="reposicion" ${p.stock===null?'disabled':''}>Reponer: sumar unidades recibidas</option><option value="conteo" ${p.stock===null?'selected':''}>Ajustar: indicar cantidad contada</option><option value="sin_control">Desactivar control de stock</option></select></div><div class="field" id="ps-quantity"><label for="ps-amount" id="ps-label">Unidades recibidas</label><input id="ps-amount" type="number" required step="1" max="2147483647"></div><div class="field"><label for="ps-reason">Motivo *</label><textarea id="ps-reason" required maxlength="500" placeholder="Ej.: compra a proveedor, inventario, rotura…"></textarea></div><p id="ps-summary" role="status"></p><p class="muted">Quedarán registrados fecha, responsable y cantidades. Esto no modifica ventas, pagos ni comisiones anteriores.</p><div class="sheet-actions"><button class="btn btn-secondary" type="button" id="ps-cancel">Cancelar</button><button class="btn btn-primary" type="submit" id="ps-save">Confirmar movimiento</button></div></form>`);
 const form=document.getElementById('stock-form'),type=form.querySelector('#ps-type'),amount=form.querySelector('#ps-amount'),reason=form.querySelector('#ps-reason'),save=form.querySelector('#ps-save');let pending=null;
 const update=()=>{const off=type.value==='sin_control';amount.disabled=off;form.querySelector('#ps-quantity').hidden=off;amount.min=type.value==='reposicion'?'1':'0';form.querySelector('#ps-label').textContent=type.value==='reposicion'?'Unidades recibidas':'Cantidad total contada';form.querySelector('#ps-summary').textContent=off?'Las próximas ventas no descontarán stock hasta que vuelvas a activarlo con un conteo.':amount.value!==''?'Stock resultante: '+(type.value==='reposicion'?p.stock+Number(amount.value):amount.value):'Ingresá la cantidad para ver el resultado.';};
 type.onchange=update;amount.oninput=update;update();form.querySelector('#ps-cancel').onclick=closeSheet;
 form.onsubmit=async ev=>{ev.preventDefault();if(save.disabled||!ctx.valid())return;const body={negocio_id:p.negocio_id,tipo:type.value,cantidad:type.value==='sin_control'?null:Number(amount.value),stock_esperado:p.stock,motivo:reason.value.trim()};const signature=JSON.stringify(body);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};body.solicitud_id=pending.id;save.disabled=true;
 try{await api('/productos/'+encodeURIComponent(p.id)+'/stock',{method:'POST',body:JSON.stringify(body)});if(!ctx.valid())return;closeSheet();toast('Movimiento registrado');refresh();}catch(err){toast(err.message,true);save.disabled=false;}};
 }catch(err){toast(err.message,true);}
}
export async function productoHistorial(ctx,productId){
 try{const rows=await ctx.api('/productos/'+encodeURIComponent(productId)+'/historial?negocio_id='+encodeURIComponent(ctx.negocio));if(!ctx.valid())return;
 ctx.openSheet(`<div class="sheet-handle"></div><div class="sheet-title">Historial del producto</div><p class="muted">Últimos 200 registros. Los cambios anteriores a la incorporación de este historial no se reconstruyen.</p><div class="product-history">${rows.length?rows.map(h=>{const old=h.detalles?.anterior||{},next=h.detalles?.nuevo||{};const changes=Object.keys(labels).filter(k=>old[k]!==next[k]).map(k=>`${labels[k]}: ${k.endsWith('_centavos')?money(old[k]):old[k]??'—'} → ${k.endsWith('_centavos')?money(next[k]):next[k]??'—'}`);if(h.detalles?.foto_modificada)changes.push('Foto actualizada');return `<article><strong>${e(types[h.tipo]||h.tipo)}</strong><p>${e(new Date(h.creado_at).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'}))} · ${e(h.responsable)}</p>${h.tipo!=='edicion'?`<p>Stock: ${e(qty(h.stock_anterior))} → ${e(qty(h.stock_nuevo))}</p>`:''}<p>${e(h.motivo)}</p>${h.tipo==='edicion'?changes.map(c=>`<p>${e(c)}</p>`).join(''):''}${h.venta_id?`<small>Venta: ${e(h.venta_id)}</small>`:''}</article>`;}).join(''):'<p>Sin movimientos registrados.</p>'}</div><button class="btn btn-secondary" id="ph-close">Cerrar</button>`);document.getElementById('ph-close').onclick=ctx.closeSheet;
 }catch(err){ctx.toast(err.message,true);}
}
