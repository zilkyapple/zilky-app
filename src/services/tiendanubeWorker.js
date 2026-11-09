import { crearServicioTiendanubeSync } from './tiendanubeSyncService.js';

// Solo se inicia con habilitación explícita. No mantiene despierto al servidor
// gratuito de Render ni ofrece sincronización instantánea mientras esté dormido.
export function iniciarTiendanubeWorker({db,service,enabled=()=>process.env.TIENDANUBE_SYNC_ENABLED==='true',intervalMs=5000,onError=()=>{}}){
  const allowed=()=>typeof enabled==='function'?enabled():enabled===true;
  if(!allowed())return {activo:false,tick:async()=>({estado:'deshabilitado'}),stop(){}};
  const sync=service||crearServicioTiendanubeSync({db,enabled});
  let busy=false,stopped=false;
  const tick=async()=>{
    if(busy||stopped||!allowed())return {estado:'omitido'};
    busy=true;
    try{
      const conexiones=await db.prepare('SELECT negocio_id FROM tiendanube_conexiones WHERE pausada=FALSE ORDER BY negocio_id').all();
      let errores=0;
      for(const con of conexiones){
        if(stopped||!allowed())break;
        try{
          for(let i=0;i<20&&!stopped;i++){
            const result=await sync.procesarEntrada(con.negocio_id);
            if(!['procesado','ignorado','historico_ignorado','redactado_ignorado','cancelado_sin_reserva'].includes(result.estado))break;
          }
          for(let i=0;i<10&&!stopped;i++){
            const result=await sync.procesarSalida(con.negocio_id);
            if(result.estado!=='sincronizado')break;
          }
        }catch{
          // Un negocio averiado no bloquea el procesamiento de los demás.
          errores++;onError('TIENDANUBE_WORKER_ERROR');
        }
      }
      return {estado:errores?'ejecutado_con_errores':'ejecutado'};
    }catch{
      // No copiar mensajes de fetch/DB que podrían incluir información privada.
      onError('TIENDANUBE_WORKER_ERROR');return {estado:'error'};
    }finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();
  return {activo:true,tick,stop(){stopped=true;clearInterval(timer);}};
}
