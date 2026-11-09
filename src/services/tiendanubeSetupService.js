import { randomUUID } from 'node:crypto';
import { clienteTiendanube, descifrarToken, validarIdExterno } from '../lib/tiendanube.js';

// Solo eventos que el receptor de esta aplicación conoce. Los webhooks de
// privacidad se configuran por separado en Partners, no en esta colección.
export const TIENDANUBE_WEBHOOKS_OPERATIVOS = Object.freeze([
  'order/created','order/updated','order/paid','order/cancelled','order/edited',
  'order/fulfilled','order/pending','order/voided','product/updated','app/uninstalled',
]);
const fallo=(message,status=409,code='CONFIGURACION_WEBHOOKS_NO_VERIFICADA')=>Object.assign(new Error(message),{status,code});
const fecha=value=>value?new Date(value).toISOString():null;

export function destinoWebhookTiendanube(base){
  let url;
  try{url=new URL(base);}catch{throw fallo('Falta una APP_BASE_URL HTTPS válida',503);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)
    ||/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)
    ||/(^|\.)(tiendanube\.com|nuvemshop\.com\.br)$/i.test(url.hostname))throw fallo('APP_BASE_URL no es un destino de webhook permitido',503);
  return new URL('/api/tiendanube/webhook',url.origin).href;
}

function clasificar(hooks,url){
  const presentes=[],faltantes=[],duplicados=[],otrasUrls=[];
  for(const event of TIENDANUBE_WEBHOOKS_OPERATIVOS){
    const propios=hooks.filter(h=>h.event===event&&h.url===url);
    if(propios.length)presentes.push(event);else faltantes.push(event);
    if(propios.length>1)duplicados.push(event);
    if(hooks.some(h=>h.event===event&&h.url!==url))otrasUrls.push(event);
  }
  return {presentes,faltantes,duplicados,otras_urls:otrasUrls,completos:!faltantes.length&&!duplicados.length&&!otrasUrls.length};
}

/** Preparación explícita: no publica, no modifica stock y nunca despausa. */
export function crearServicioSetupTiendanube({db,
  apiFactory=con=>clienteTiendanube({tiendaId:con.store_id,accessToken:descifrarToken(con.token_cifrado),contactEmail:'zilkyindumentaria@gmail.com'}),
  baseUrl=()=>process.env.APP_BASE_URL,now=()=>new Date(),uuid=randomUUID}={}){
  if(!db?.transaction||!db?.prepare||!db?.query)throw new Error('Falta adaptador PostgreSQL');
  const iso=()=>new Date(now()).toISOString();
  async function bloqueado(n,fn){
    return db.transaction(async()=>{
      const first=await db.prepare('SELECT store_id FROM tiendanube_conexiones WHERE negocio_id=?').get(n);
      if(!first)throw fallo('Primero conectá la tienda de Tiendanube');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube:privacidad:${first.store_id}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tiendanube-sync:${n}`]);
      const con=await db.prepare('SELECT * FROM tiendanube_conexiones WHERE negocio_id=? FOR UPDATE').get(n);
      if(!con||con.store_id!==first.store_id)throw fallo('La conexión cambió durante la configuración');
      return fn(con);
    });
  }
  async function listar(api){
    const result=[];const ids=new Set();
    for(let page=1;page<=10;page++){
      const rows=await api('GET',`/webhooks?page=${page}&per_page=100`);
      if(!Array.isArray(rows))throw fallo('La API devolvió una lista de webhooks inválida',502);
      for(const row of rows){
        if(!row||typeof row.event!=='string'||typeof row.url!=='string')throw fallo('La API devolvió un webhook inválido',502);
        const id=validarIdExterno(row.id);
        if(ids.has(id))throw fallo('La paginación de webhooks no pudo verificarse',502);
        ids.add(id);result.push({id,event:row.event,url:row.url});
      }
      if(rows.length<100)return result;
    }
    throw fallo('La lista de webhooks excede el límite de revisión',409);
  }
  async function estado(n){
    const con=await db.prepare(`SELECT store_id,pausada,setup_webhooks_url,setup_webhooks_registrados_at,
      setup_webhooks_error,sync_webhooks_at FROM tiendanube_conexiones WHERE negocio_id=?`).get(n);
    if(!con)return {conectada:false,registrados:false,recepcion_firmada_confirmada:false};
    return {conectada:true,store_id:con.store_id,pausada:con.pausada,
      url:con.setup_webhooks_url??null,registrados:!!con.setup_webhooks_registrados_at&&!con.setup_webhooks_error,
      registrados_at:fecha(con.setup_webhooks_registrados_at),
      recepcion_firmada_confirmada:!!con.sync_webhooks_at,recepcion_at:fecha(con.sync_webhooks_at),
      error:con.setup_webhooks_error??null};
  }
  async function preparar(n,{crear=false,autorizar=async()=>{}}={}){
    const url=destinoWebhookTiendanube(typeof baseUrl==='function'?baseUrl():baseUrl);
    const token=`setup-webhooks:${uuid()}`;
    const con=await bloqueado(n,async current=>{
      await autorizar();
      if(!current.pausada)throw fallo('Pausá la sincronización antes de configurar los webhooks');
      if(current.sync_lease_token||current.sync_reserva_token)throw fallo('Hay una operación en curso o pendiente de conciliación');
      const scopes=new Set(String(current.scopes).split(',').map(x=>x.trim()));
      if(!['write_products','read_orders'].every(s=>scopes.has(s)))throw fallo('La conexión no tiene los permisos requeridos',403);
      if(crear&&current.setup_webhooks_error==='REGISTRO_WEBHOOK_AMBIGUO')throw fallo('Hay un registro con resultado incierto: verificá primero, sin repetir la creación');
      await db.prepare(`UPDATE tiendanube_conexiones SET sync_lease_token=?,sync_lease_hasta=?,
        sync_webhooks_at=NULL WHERE negocio_id=?`).run(token,new Date(new Date(now()).valueOf()+900000).toISOString(),n);
      return {...current};
    });
    let codigoError=con.setup_webhooks_error==='REGISTRO_WEBHOOK_AMBIGUO'?'REGISTRO_WEBHOOK_AMBIGUO':'CONSULTA_WEBHOOKS_FALLIDA';
    try{
      const api=apiFactory(con);
      let hooks=await listar(api),revision=clasificar(hooks,url),creados=0;
      // Una URL previa o un duplicado se muestran para revisión. Nunca borramos
      // ni reemplazamos una suscripción que puede estar usada por otro despliegue.
      if(crear&&!revision.otras_urls.length&&!revision.duplicados.length){
        for(const event of revision.faltantes){
          await bloqueado(n,async current=>{
            await autorizar();
            if(current.store_id!==con.store_id||current.token_cifrado!==con.token_cifrado||current.sync_lease_token!==token||current.sync_reserva_token||!current.pausada)throw fallo('La conexión cambió antes de registrar el webhook');
          });
          let row;
          try{row=await api('POST','/webhooks',{event,url});}
          catch(err){
            codigoError=[400,401,403,404,422,429].includes(Number(err?.status))?'REGISTRO_WEBHOOK_RECHAZADO':'REGISTRO_WEBHOOK_AMBIGUO';
            throw fallo(codigoError==='REGISTRO_WEBHOOK_AMBIGUO'?'El registro tuvo un resultado incierto; no se repetirá automáticamente':'Tiendanube rechazó el registro de un webhook',502,codigoError);
          }
          if(!row||row.event!==event||row.url!==url){
            codigoError='REGISTRO_WEBHOOK_AMBIGUO';throw fallo('No se pudo verificar el resultado del registro',502,codigoError);
          }
          try{validarIdExterno(row.id);}catch{codigoError='REGISTRO_WEBHOOK_AMBIGUO';throw fallo('El registro devolvió un identificador inválido',502,codigoError);}
          creados++;
        }
        hooks=await listar(api);revision=clasificar(hooks,url);
      }
      return await bloqueado(n,async current=>{
        await autorizar();
        if(current.store_id!==con.store_id||current.token_cifrado!==con.token_cifrado||current.sync_lease_token!==token||current.sync_reserva_token||!current.pausada)throw fallo('La conexión cambió durante la verificación');
        const mismoRegistro=creados===0&&current.setup_webhooks_url===url&&current.setup_webhooks_registrados_at;
        const registradoAt=revision.completos?(mismoRegistro?fecha(current.setup_webhooks_registrados_at):iso()):null;
        // La API confirma el registro, no la recepción. Solo un evento que
        // realmente entró por el receptor HMAC después de ese registro sirve
        // como evidencia de alcance. No se fabrica un evento de prueba.
        const evidencia=registradoAt?await db.prepare(`SELECT MAX(hmac_validada_at) AS recibida_at FROM tiendanube_eventos
          WHERE store_id=? AND topic=ANY(?::text[]) AND hmac_validada_at>=?`).get(con.store_id,TIENDANUBE_WEBHOOKS_OPERATIVOS.filter(t=>t!=='app/uninstalled'),registradoAt):null;
        const recibidoAt=evidencia?.recibida_at?fecha(evidencia.recibida_at):null;
        const codigo=revision.completos?null:con.setup_webhooks_error==='REGISTRO_WEBHOOK_AMBIGUO'?'REGISTRO_WEBHOOK_AMBIGUO':
          revision.otras_urls.length?'REGISTRO_WEBHOOKS_OTRA_URL':revision.duplicados.length?'REGISTRO_WEBHOOKS_DUPLICADO':'REGISTRO_WEBHOOKS_INCOMPLETO';
        await db.prepare(`UPDATE tiendanube_conexiones SET setup_webhooks_url=?,setup_webhooks_registrados_at=?,
          setup_webhooks_error=?,sync_webhooks_at=?,sync_lease_token=NULL,sync_lease_hasta=NULL WHERE negocio_id=? AND sync_lease_token=?`)
          .run(url,registradoAt,codigo,recibidoAt,n,token);
        return {store_id:con.store_id,url,creados,registrados:revision.completos,registrados_at:registradoAt,
          recepcion_firmada_confirmada:!!recibidoAt,recepcion_at:recibidoAt,
          requeridos:[...TIENDANUBE_WEBHOOKS_OPERATIVOS],...revision,
          pausada:true,stock_actualizado:false,sincronizacion_activada:false};
      });
    }catch(err){
      // Guardar únicamente un código fijo. No copiar body, URLs ajenas, tokens
      // ni mensajes devueltos por la API. Un POST incierto queda enclavado.
      try{await bloqueado(n,async current=>{
        if(current.sync_lease_token===token)await db.prepare(`UPDATE tiendanube_conexiones SET
          setup_webhooks_error=?,sync_webhooks_at=NULL,sync_lease_token=NULL,sync_lease_hasta=NULL WHERE negocio_id=? AND sync_lease_token=?`)
          .run(codigoError,n,token);
      });}catch{/* Si cambió o desapareció la conexión, no tocar la instalación nueva. */}
      if(err?.code==='REGISTRO_WEBHOOK_AMBIGUO'||err?.code==='REGISTRO_WEBHOOK_RECHAZADO'||err?.status===409||err?.status===403||err?.status===404)throw err;
      throw fallo('No se pudo verificar la configuración de webhooks. La sincronización sigue pausada.',502,codigoError);
    }
  }
  return {estado,configurar:(n,options)=>preparar(n,{...options,crear:true}),verificar:(n,options)=>preparar(n,{...options,crear:false})};
}
