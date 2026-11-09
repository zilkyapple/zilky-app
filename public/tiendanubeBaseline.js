const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format(value/100):'Sin verificar';
const labels={
  CORTE_REMOTO_NO_VERIFICABLE:'Falta acreditar un corte exclusivo: podrían entrar o cambiar pedidos en Tiendanube mientras se consulta.',
  PAGINACION_SIN_METADATOS:'El cliente actual no entrega las cabeceras de paginación necesarias para demostrar una lista completa.',
  SIN_VARIANTES_VINCULADAS:'Todavía no hay variantes vinculadas por identificador.',
  VINCULOS_INCOMPLETOS_O_INVALIDOS:'La lista de vínculos superó el límite seguro o contiene una relación inválida.',
  VINCULO_DE_OTRA_TIENDA:'Hay una variante asociada a otra tienda.',
  SALIDAS_PENDIENTES_O_INCIERTAS:'Hay actualizaciones de stock pendientes o con resultado incierto.',
  EVENTOS_PENDIENTES_O_EN_REVISION:'Hay avisos de Tiendanube pendientes de conciliación.',
  RESERVAS_PREVIAS_REQUIEREN_CONCILIACION:'Existen reservas anteriores que deben conciliarse.',
  PEDIDOS_LOCALES_EN_REVISION:'Hay pedidos locales que requieren revisión.',
  PEDIDOS_EN_TRANSITO_O_SIN_CONCILIAR:'Hay pedidos posiblemente en tránsito o sin entrega/cobro conciliados.',
  PEDIDO_CON_VARIANTE_SIN_VINCULO_EXACTO:'Un pedido contiene una variante sin vínculo exacto.',
  PEDIDOS_OMITIDOS_POR_PRIVACIDAD:'Hay pedidos que no pueden mostrarse por una solicitud de privacidad.',
  PEDIDOS_LOCALES_FUERA_DE_LECTURA:'Hay pedidos locales fuera de la lectura remota obtenida.',
  LECTURA_LOCAL_LIMITADA:'Se alcanzó un límite de lectura local. La revisión no es completa.',
  LECTURA_PEDIDOS_LIMITADA:'Se alcanzó el límite de pedidos. No se verificó la lista completa.',
  VARIANTE_REMOTA_NO_COINCIDE:'La variante de Tiendanube no coincide con los identificadores vinculados.',
  STOCK_LOCAL_SIN_CONTROL:'El stock local no tiene una cantidad válida.',
  STOCK_REMOTO_SIN_CONTROL:'Tiendanube no informa stock controlado válido para esta variante.',
  MULTIPLES_UBICACIONES_NO_CONFIGURADAS:'La tienda usa ubicaciones de stock que esta integración no tiene configuradas.',
  DIFERENCIA_STOCK:'El stock local y el remoto son distintos.',
  PRECIOS_LOCALES_NO_CUMPLEN_REGLA:'Los precios locales no respetan la diferencia de $2.500 por prenda.',
  PRECIOS_LOCALES_SIN_REDONDEO:'Hay un precio local que no termina en múltiplos de $500.',
  DIFERENCIA_PRECIO_PUBLICADO:'El precio publicado no coincide con el precio local a 30 días.',
  PROMOCION_REMOTA_NO_CONCILIADA:'Tiendanube tiene un precio promocional pendiente de conciliación.',
  DIFERENCIA_SKU:'Los códigos SKU son distintos.',
  SKU_NO_INFORMADO:'Falta informar un SKU. El vínculo se identifica por sus IDs, no por el nombre.',
  TALLE_COLOR_NO_VERIFICABLES:'Faltan talle o color estructurados para comparar; no se infieren del nombre.',
  DIFERENCIA_TALLE:'Los talles son distintos.',
  DIFERENCIA_COLOR:'Los colores son distintos.',
};
const errors={
  BASELINE_REQUIERE_MOTORES_APAGADOS:'La preparación requiere sincronización y entregas deshabilitadas en el servidor.',
  BASELINE_REQUIERE_PAUSA:'La conexión debe estar pausada para esta revisión inicial.',
  BASELINE_OPERACION_PENDIENTE:'Hay una operación pendiente o incierta. Primero debe conciliarse.',
  BASELINE_EXISTENTE_REQUIERE_REVISION:'Existe una base anterior. Esta pantalla no la reemplaza.',
  BASELINE_SIN_PERMISO:'No tenés permiso para revisar este negocio.',
  BASELINE_CONEXION_NO_DISPONIBLE:'Primero conectá la tienda de Tiendanube.',
  BASELINE_CAMBIO_DESDE_PREVIEW:'Los datos cambiaron desde la vista anterior. Actualizá la revisión; no se ajustó ningún stock.',
  BASELINE_CAMBIO_DURANTE_LECTURA:'Los datos cambiaron durante la lectura. Actualizá la revisión; no se ajustó ningún stock.',
  BASELINE_VISTA_VENCIDA:'La vista venció. Actualizá la revisión.',
  BASELINE_PAGINACION_INESTABLE:'La paginación cambió o repitió pedidos. La lectura no pudo verificarse.',
  BASELINE_IDENTIFICADOR_INVALIDO:'La identidad del negocio o de la sesión no pudo verificarse.',
  BASELINE_CONEXION_CAMBIO:'La conexión de Tiendanube cambió durante la lectura. Volvé a revisar.',
  BASELINE_PERMISOS_REMOTOS_INSUFICIENTES:'Faltan permisos de lectura de pedidos o escritura de productos en Tiendanube.',
  BASELINE_ACCESO_REMOTO_REVOCADO:'Tiendanube rechazó el acceso de la aplicación. Revisá la autorización.',
  BASELINE_LECTURA_REMOTA_FALLIDA:'No se pudieron consultar los datos de Tiendanube. La conexión sigue pausada.',
  BASELINE_RESPUESTA_REMOTA_INVALIDA:'Tiendanube devolvió datos que no cumplen la validación segura.',
  BASELINE_PEDIDO_DE_OTRA_TIENDA:'Se detectó un pedido asociado a otra tienda. No se continuó.',
  BASELINE_LIMITE_LECTURA:'La consulta alcanzó su límite de tiempo o cantidad. No se modificó stock.',
  BASELINE_HUELLA_INVALIDA:'La referencia de la comparación no es válida. Actualizá la revisión.',
  BASELINE_CONSULTA_REMOTA_INVALIDA:'Tiendanube rechazó los parámetros de consulta (HTTP 400). No se modificó stock.',
  BASELINE_ACCESO_REMOTO_SUSPENDIDO:'Tiendanube informa que el acceso está suspendido (HTTP 402). Revisá el estado de la cuenta.',
  BASELINE_PEDIDOS_REMOTOS_NO_ENCONTRADOS:'Tiendanube respondió HTTP 404 al consultar pedidos. Todavía no se puede dar por verificado que no haya pedidos.',
  BASELINE_PRODUCTO_REMOTO_NO_ENCONTRADO:'Tiendanube no encontró un producto vinculado (HTTP 404). Revisá su vínculo.',
  BASELINE_CONSULTA_REMOTA_NO_PROCESABLE:'Tiendanube no pudo procesar la consulta (HTTP 422). No se modificó stock.',
  BASELINE_LIMITE_REMOTO:'Tiendanube limitó temporalmente las consultas (HTTP 429). Reintentá más tarde.',
  BASELINE_SERVICIO_REMOTO_NO_DISPONIBLE:'La consulta falló por un error de servicio de Tiendanube (HTTP 5xx). La conexión sigue pausada.',
  BASELINE_TIEMPO_REMOTO_AGOTADO:'Tiendanube no respondió dentro del tiempo permitido. No se modificó stock.',
  BASELINE_ESQUEMA_LOCAL_INCOMPLETO:'Falta una tabla o columna de la integración. La instalación del servidor requiere revisión.',
  BASELINE_CONSULTA_LOCAL_INVALIDA:'Falló la consulta local de inventarios. No se modificaron los datos.',
  BASELINE_DATOS_LOCALES_INVALIDOS:'Hay un dato local que la comparación no pudo interpretar. No se ajustó ningún inventario.',
};
const value=v=>v===null||v===undefined||v===''?'Sin dato':String(v);
const pair=(a,b)=>`${esc(value(a))}<br><small>Tiendanube: ${esc(value(b))}</small>`;

// Separate, administrator-only view. It deliberately offers no stock edit,
// confirmation, activation, order adoption or storefront-disable control.
export async function tiendanubeBaselineView(view,ctx){
  const {negocio,setHTML}=ctx;
  if(ctx.admin!==true){setHTML(view,'<div class="empty-state"><p>Esta revisión es exclusiva del administrador.</p></div>');return;}
  if(!negocio){setHTML(view,'<div class="empty-state"><p>Elegí el negocio que querés revisar.</p></div>');return;}
  const root=document.createElement('section');root.className='tienda-admin';view.replaceChildren(root);
  const valid=()=>root.isConnected&&view.contains(root)&&ctx.admin===true&&ctx.negocio===negocio&&(!ctx.valid||ctx.valid());
  let report=null,busy=false,message='';
  const call=async(path,opts)=>{
    if(!valid())throw Error('Pantalla vencida');
    const response=await ctx.api(path,opts);
    if(!valid()||response?.negocio_id!==negocio)throw Error('Pantalla vencida');
    return response;
  };
  const safeReport=r=>{
    if(r?.modo!=='solo_lectura'||r.baseline_confirmable!==false||r.baseline_guardado!==false||r.sincronizacion_activada!==false||r.stock_modificado!==false
      ||!Array.isArray(r.variantes)||!Array.isArray(r.pedidos)||!Array.isArray(r.bloqueos)||!/^[a-f0-9]{64}$/.test(r.huella||''))throw Error('Respuesta inválida');
    return r;
  };
  function render(){
    if(!valid())return;
    const rows=(report?.variantes||[]).map(v=>`<tr><td>${esc(v.nombre)}<br><small>Zilky: ${esc(v.producto_id)} · Tiendanube: ${esc(v.product_id)} / ${esc(v.variant_id)}</small></td>
      <td>${pair(v.sku_local,v.sku_remoto)}</td><td>${pair(v.talle_local,v.talle_remoto)}</td><td>${pair(v.color_local,v.color_remoto)}</td>
      <td>${pair(v.stock_local,v.stock_remoto)}</td><td>${pair(money(v.precio_30_dias_local_centavos),money(v.precio_publicado_remoto_centavos))}</td>
      <td>${esc(money(v.precio_contado_local_centavos))}<br><small>Referencia publicada − $2.500: ${esc(money(v.precio_contado_segun_regla_centavos))}</small></td>
      <td>${v.coincide===true?'Datos comparados iguales; no habilita sincronización':(v.bloqueos||[]).map(c=>esc(labels[c]||'Requiere revisión')).join('<br>')}
      ${(v.advertencias||[]).map(c=>'<br><small>'+esc(labels[c]||'Dato sin verificar')+'</small>').join('')}</td></tr>`).join('');
    const orders=(report?.pedidos||[]).map(o=>`<tr><td>${esc(o.order_id)}</td><td>${esc(o.estado)}</td><td>${esc(o.pago_estado)}</td><td>${esc(o.envio_estado)}</td>
      <td>${o.entrega_local_registrada?'Registrada':'Sin entrega local comprobada'}</td><td>${o.requiere_revision?'Posible tránsito / revisar':'Consultar historial'}<br>
      <small>${(o.items||[]).map(i=>`${esc(i.variant_id)} × ${esc(i.cantidad)}${i.producto_id?' · Zilky '+esc(i.producto_id):' · Sin vínculo exacto'}`).join('<br>')}</small></td></tr>`).join('');
    setHTML(root,`<header class="ta-heading"><div><h1>Revisión inicial de inventarios</h1><p>Preparación de Tiendanube · solo lectura</p></div>
      <button type="button" class="btn btn-secondary" data-tn-baseline-refresh ${busy?'disabled':''}>Actualizar revisión</button></header>
      <p class="ta-notice">La sincronización continúa pausada. Esta pantalla no modifica stock, no publica productos, no registra ventas ni elimina la web original de Zilky.</p>
      <p role="status" aria-live="polite">${esc(busy?'Leyendo datos para comparar…':message)}</p>
      ${report?`<section class="card ta-form"><h2>Falta conciliar antes de activar</h2>
        <p>Fecha límite de la consulta: ${esc(report.corte_consulta_at)}. Es un filtro de lectura, no un corte exclusivo confirmado.</p>
        <ul>${report.bloqueos.map(c=>`<li>${esc(labels[c]||'Hay un dato pendiente de revisión.')}</li>`).join('')}</ul>
        <p>${esc(report.paginacion_pedidos?.paginas_recorridas||0)} páginas consultadas. ${report.paginacion_pedidos?.fin_observado?'Se observó una última página; eso no demuestra que la captura sea completa ni atómica.':'La lista de pedidos no llegó a un final verificable.'}</p>
        <button type="button" class="btn btn-secondary" data-tn-baseline-revalidate ${busy?'disabled':''}>Volver a comparar esta misma vista</button>
        <p class="ta-hint">Una coincidencia de datos no guarda una base inicial ni activa la conexión. No hay un botón de activación en esta etapa.</p></section>
        <section class="card ta-form"><h2>Variantes vinculadas (${report.variantes.length})</h2><p>La relación usa identificadores exactos. El nombre es solo una referencia visual.</p>
        <div style="overflow-x:auto"><table><thead><tr><th>Prenda / IDs</th><th>SKU local / remoto</th><th>Talle</th><th>Color</th><th>Stock</th><th>Precio a 30 días</th><th>Precio contado</th><th>Revisión</th></tr></thead><tbody>${rows||'<tr><td colspan="8">No hay variantes disponibles para comparar.</td></tr>'}</tbody></table></div>
        <p class="ta-hint">El contado de referencia es el precio publicado menos $2.500 por prenda. Esta lectura no confirma que el checkout aplique ese descuento.</p></section>
        <section class="card ta-form"><h2>Pedidos observados al límite de consulta (${report.pedidos.length})</h2>
        <p>Un pedido pagado o enviado no demuestra por sí solo una entrega y un cobro conciliados en Zilky.</p>
        <div style="overflow-x:auto"><table><thead><tr><th>Pedido</th><th>Estado</th><th>Pago</th><th>Envío</th><th>Entrega en Zilky</th><th>Revisión / variantes</th></tr></thead><tbody>${orders||'<tr><td colspan="6">No se observaron pedidos en esta lectura; eso no confirma que no existan otros.</td></tr>'}</tbody></table></div>
        ${report.pedidos_omitidos_por_privacidad?'<p>Se omitieron pedidos por privacidad.</p>':''}</section>`:''}`);
  }
  async function load(revalidate=false){
    if(!valid()||busy||revalidate&&!report)return;
    const old=report;busy=true;message='';render();
    try{
      const r=await call(revalidate?'/tiendanube/baseline/revalidar':'/tiendanube/baseline/preview?negocio_id='+encodeURIComponent(negocio),
        revalidate?{method:'POST',body:JSON.stringify({negocio_id:negocio,huella:old.huella,corte_consulta_at:old.corte_consulta_at})}:undefined);
      report=safeReport(r);
      if(revalidate)message='La nueva lectura coincide con esta vista. La base inicial no se guardó y la conexión sigue pausada.';
    }catch(e){if(valid()){report=null;message=errors[e?.code]||'No se pudo verificar la lectura. No se modificaron los inventarios.';}}
    finally{if(valid()){busy=false;render();}}
  }
  root.addEventListener('click',e=>{
    if(e.target.closest('[data-tn-baseline-refresh]'))void load();
    if(e.target.closest('[data-tn-baseline-revalidate]'))void load(true);
  });
  await load();
}
