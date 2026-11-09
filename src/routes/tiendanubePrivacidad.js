import {Router} from 'express';
import {negocioSolicitado} from '../middleware/authorize.js';
import {tiendanubePrivacidadGestion} from '../services/tiendanubePrivacidadGestionService.js';

// Lista cerrada: nunca devolver errores PostgreSQL, payloads del proveedor ni
// credenciales en errores HTTP, incluidos errores de descifrado de tokens.
export const mensajesPrivacidadTiendanube={
  PRIVACIDAD_IDENTIFICADOR_INVALIDO:'La solicitud no tiene un identificador válido.',
  PRIVACIDAD_SOLO_ADMINISTRADOR:'Solo un administrador activo de la organización puede gestionar esta solicitud.',
  PRIVACIDAD_NO_ENCONTRADA:'No se encontró la solicitud en el negocio seleccionado.',
  PRIVACIDAD_SOLICITUD_CAMBIO:'La solicitud cambió. Actualizá la pantalla.',
  PRIVACIDAD_NO_ES_INFORME:'Esta solicitud no corresponde a un informe de datos.',
  PRIVACIDAD_INFORME_YA_REDACTADO:'Los datos de este informe ya fueron retirados. Se conserva su constancia, no una segunda copia.',
  PRIVACIDAD_CONFIRMACION_ENTREGA_REQUERIDA:'Confirmá explícitamente la recepción o entrega efectiva del informe exportado.',
  PRIVACIDAD_ENTREGA_YA_DECLARADA:'La entrega ya fue declarada con otros datos. Revisá la constancia existente.',
  PRIVACIDAD_ESTADO_NO_PERMITE_ENTREGA:'La solicitud ya no está pendiente de entrega.',
  PRIVACIDAD_INFORME_CAMBIO:'El informe cambió o la exportación no corresponde. Descargá y revisá el informe actual antes de declarar su entrega.',
  PRIVACIDAD_NO_ES_REVISION_PENDIENTE:'Esta solicitud ya no está pendiente de revisión de la instalación.',
  PRIVACIDAD_INSTALACION_SIN_EVIDENCIA:'La solicitud antigua no identifica con seguridad su instalación. No se permite borrar con esta evidencia.',
  PRIVACIDAD_INSTALACION_NO_PRESENTE:'No hay una instalación atribuible para borrar desde esta solicitud. Requiere revisión manual.',
  PRIVACIDAD_INSTALACION_DISTINTA:'Hay otra instalación o autorización más reciente. No se borrará la conexión actual.',
  PRIVACIDAD_REQUIERE_PAUSA:'Pausá la sincronización antes de preparar una eliminación.',
  PRIVACIDAD_OPERACION_EN_CURSO:'Hay una operación en curso o con resultado incierto. Debe conciliarse antes de borrar.',
  PRIVACIDAD_EVENTO_ANTERIOR:'El evento es anterior a la instalación conservada. No se permite eliminar esa instalación.',
  PRIVACIDAD_APP_DISTINTA:'La solicitud no corresponde a la aplicación instalada.',
  PRIVACIDAD_NOTIFICACIONES_PENDIENTES:'Hay notificaciones sin procesar o en revisión. No se eliminarán hasta conciliar sus efectos.',
  PRIVACIDAD_STOCK_PENDIENTE:'Hay movimientos de stock pendientes o inciertos. Requieren conciliación.',
  PRIVACIDAD_PEDIDOS_REVISION:'Hay pedidos que requieren revisión antes de retirar los datos de integración.',
  PRIVACIDAD_RESERVAS_SIN_ENTREGA:'Hay stock reservado sin una entrega comercial conciliada. No se borrará su integración.',
  PRIVACIDAD_RESERVAS_PENDIENTES:'Hay reservas con resultado pendiente o incierto.',
  PRIVACIDAD_INFORMES_PENDIENTES:'Primero completá la recepción o entrega de los informes pendientes.',
  PRIVACIDAD_DATOS_INCONSISTENTES:'Los vínculos no corresponden de forma exclusiva a esta instalación. Requieren revisión.',
  PRIVACIDAD_CREDENCIAL_VIGENTE:'Tiendanube todavía acepta la credencial de esta instalación. No se permite borrarla como si estuviera desinstalada.',
  PRIVACIDAD_REVOCACION_NO_VERIFICADA:'No se pudo comprobar la revocación de la credencial. No se borró nada.',
  PRIVACIDAD_CONFIRMACION_NO_DISPONIBLE:'No se pudo preparar una confirmación segura.',
  PRIVACIDAD_CONFIRMACION_BORRADO_REQUERIDA:'Revisá la vista previa y escribí exactamente la frase requerida para confirmar.',
  PRIVACIDAD_PREVIEW_REQUERIDO:'Falta una vista previa válida para este administrador y esta solicitud.',
  PRIVACIDAD_PREVIEW_VENCIDO:'La vista previa venció. Generá otra y revisala.',
  PRIVACIDAD_PREVIEW_CAMBIO:'Los datos cambiaron desde la vista previa. No se borró nada; generá otra vista previa.',
};

export function crearRouterPrivacidadTiendanube({gestion=tiendanubePrivacidadGestion}={}){
  const router=Router();
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(!req.usuario||!req.usuarioId)return res.status(401).json({error:'Falta iniciar sesión'});
    if(req.usuario.rol!=='administrador')return res.status(403).json({code:'PRIVACIDAD_SOLO_ADMINISTRADOR',error:mensajesPrivacidadTiendanube.PRIVACIDAD_SOLO_ADMINISTRADOR});
    next();
  });
  const handle=fn=>async(req,res)=>{
    try{
      const n=negocioSolicitado(req);if(!n)return res.status(400).json({error:'Seleccioná un negocio'});
      res.json(await fn(req,n));
    }catch(e){
      const code=Object.hasOwn(mensajesPrivacidadTiendanube,e?.code)?e.code:'PRIVACIDAD_OPERACION_NO_CONFIRMADA';
      const status=Number.isInteger(e?.status)&&e.status>=400&&e.status<600?e.status:500;
      res.status(status).json({code,error:mensajesPrivacidadTiendanube[code]||'No se pudo confirmar la operación de privacidad. Actualizá el estado antes de repetirla.'});
    }
  };
  router.get('/',handle((req,n)=>gestion.listar(n,req.usuarioId)));
  router.get('/:id',handle((req,n)=>gestion.detalle(n,req.params.id,req.usuarioId)));
  router.post('/:id/exportar',handle((req,n)=>gestion.exportar(n,req.params.id,req.usuarioId)));
  router.post('/:id/entrega',handle((req,n)=>gestion.confirmarEntrega(n,req.params.id,req.usuarioId,req.body)));
  router.post('/:id/borrado/preview',handle(async(req,n)=>{
    const result=await gestion.previewBorrado(n,req.params.id,req.usuarioId);
    return {...result,bloqueos_detalle:(result.bloqueos||[]).map(code=>({code,mensaje:mensajesPrivacidadTiendanube[code]||'Hay una comprobación pendiente.'}))};
  }));
  router.post('/:id/borrado/confirmar',handle((req,n)=>gestion.confirmarBorrado(n,req.params.id,req.usuarioId,req.body)));
  return router;
}

export const tiendanubePrivacidadRouter=crearRouterPrivacidadTiendanube();
