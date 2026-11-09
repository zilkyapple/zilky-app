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
  BASELINE_CONSULTA_REMOTA_INVALIDA:'Tiendanube rechazó la consulta (HTTP 400). Hay que revisar sus parámetros; no se modificaron los inventarios.',
  BASELINE_ACCESO_REMOTO_SUSPENDIDO:'Tiendanube informó una restricción de la tienda o aplicación (HTTP 402). No se modificaron los inventarios.',
  BASELINE_PEDIDOS_REMOTOS_NO_ENCONTRADOS:'La consulta de pedidos devolvió HTTP 404. Eso no verifica que no haya pedidos; la revisión sigue pendiente.',
  BASELINE_PRODUCTO_REMOTO_NO_ENCONTRADO:'Tiendanube no encontró uno de los productos vinculados (HTTP 404). Revisá el vínculo; no se modificaron los inventarios.',
  BASELINE_CONSULTA_REMOTA_NO_PROCESABLE:'Tiendanube no pudo procesar la consulta (HTTP 422). Hay que revisar la integración; no se modificaron los inventarios.',
  BASELINE_LIMITE_REMOTO:'Tiendanube limitó temporalmente las consultas (HTTP 429). Esperá y volvé a consultar; la conexión sigue pausada.',
  BASELINE_SERVICIO_REMOTO_NO_DISPONIBLE:'Tiendanube devolvió un error de servidor (HTTP 5xx). No se pudo verificar la revisión y no se modificaron los inventarios.',
  BASELINE_TIEMPO_REMOTO_AGOTADO:'La lectura de Tiendanube superó el tiempo de espera. La revisión sigue pendiente y no se modificaron los inventarios.',
  BASELINE_ESQUEMA_LOCAL_INCOMPLETO:'La base local no tiene todas las tablas o columnas requeridas. Hay que revisar las migraciones; no se modificaron los inventarios.',
  BASELINE_CONSULTA_LOCAL_INVALIDA:'Una consulta local no es compatible con la base actual. Hay que corregir la integración; no se modificaron los inventarios.',
  BASELINE_DATOS_LOCALES_INVALIDOS:'La base local rechazó el formato o rango de un dato de la consulta. Hay que revisarlo; no se modificaron los inventarios.',
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
