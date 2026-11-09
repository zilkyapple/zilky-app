import { Router } from 'express';
import { negocioSolicitado } from '../middleware/authorize.js';
import { baselineTiendanube } from '../services/tiendanubeBaselineService.js';

const mensajes={
  BASELINE_SIN_PERMISO:'Esta revisión corresponde al administrador del negocio seleccionado.',
  BASELINE_IDENTIFICADOR_INVALIDO:'El negocio o la identidad de la sesión no son válidos.',
  BASELINE_CONEXION_NO_DISPONIBLE:'Primero conectá la tienda de Tiendanube.',
  BASELINE_REQUIERE_MOTORES_APAGADOS:'La revisión inicial requiere que sincronización y entregas estén deshabilitadas en el servidor.',
  BASELINE_REQUIERE_PAUSA:'La conexión debe estar pausada antes de preparar la revisión inicial.',
  BASELINE_OPERACION_PENDIENTE:'Hay una operación en curso o de resultado incierto. Debe conciliarse antes de continuar.',
  BASELINE_EXISTENTE_REQUIERE_REVISION:'Ya existe un corte o una base anterior. Esta pantalla no los reemplaza.',
  BASELINE_CONEXION_CAMBIO:'La conexión cambió durante la lectura. Volvé a consultar.',
  BASELINE_PERMISOS_REMOTOS_INSUFICIENTES:'La autorización de Tiendanube no incluye los permisos requeridos.',
  BASELINE_ACCESO_REMOTO_REVOCADO:'Tiendanube rechazó el acceso. No se modificaron los inventarios.',
  BASELINE_LECTURA_REMOTA_FALLIDA:'No se pudo completar la lectura de Tiendanube. La conexión sigue pausada.',
  BASELINE_RESPUESTA_REMOTA_INVALIDA:'La respuesta de Tiendanube no pudo verificarse. No se confirmó ninguna base inicial.',
  BASELINE_PEDIDO_DE_OTRA_TIENDA:'La respuesta no coincide con la tienda vinculada. No se confirmó ninguna base inicial.',
  BASELINE_PAGINACION_INESTABLE:'La paginación cambió o repitió pedidos. Esta lectura no es completa.',
  BASELINE_LIMITE_LECTURA:'La revisión alcanzó su límite seguro de lectura. No se confirmó una base inicial.',
  BASELINE_HUELLA_INVALIDA:'La referencia de la vista no es válida. Volvé a consultar.',
  BASELINE_VISTA_VENCIDA:'La vista venció. Consultá nuevamente los datos actuales.',
  BASELINE_CAMBIO_DESDE_PREVIEW:'Los datos cambiaron desde la vista anterior. Volvé a consultar; no se guardó ni corrigió ningún stock.',
  BASELINE_CAMBIO_DURANTE_LECTURA:'Los datos cambiaron durante la lectura. Volvé a consultar; no se guardó ni corrigió ningún stock.',
};

// Mount after cargarUsuario, alongside the administrator integration router.
// No /confirmar, /activar, stock-write, queue-ack or baseline-commit endpoint.
export function crearRouterBaselineTiendanube({servicio=baselineTiendanube}={}){
  const router=Router();
  router.use('/baseline',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(!req.usuario||!req.usuarioId)return res.status(401).json({error:'Falta iniciar sesión'});
    if(req.usuario.rol!=='administrador')return res.status(403).json({code:'BASELINE_SIN_PERMISO',error:mensajes.BASELINE_SIN_PERMISO});
    next();
  });
  const handle=fn=>async(req,res)=>{
    try{
      const n=negocioSolicitado(req);
      if(!n)return res.status(400).json({error:'Seleccioná un negocio'});
      res.json(await fn(req,n));
    }catch(e){
      const code=Object.hasOwn(mensajes,e?.code)?e.code:'BASELINE_NO_VERIFICADA';
      const status=Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:500;
      res.status(status).json({code,error:mensajes[code]||'No se pudo verificar la revisión inicial. No se modificaron los inventarios.'});
    }
  };
  router.get('/baseline/preview',handle((req,n)=>servicio.preview(n,req.usuarioId)));
  router.post('/baseline/revalidar',handle((req,n)=>servicio.revalidar(n,req.body,req.usuarioId)));
  return router;
}

export const tiendanubeBaselineRouter=crearRouterBaselineTiendanube();
