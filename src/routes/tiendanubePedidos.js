import { Router } from 'express';
import { negocioSolicitado } from '../middleware/authorize.js';
import { confirmarEntregaTiendanube } from '../services/tiendanubeEntregasService.js';
import { consultasPedidosTiendanube } from '../services/tiendanubePedidosConsultaService.js';

const mensajes={
  ENTREGAS_TIENDANUBE_DESHABILITADAS:'La confirmación de entregas de Tiendanube todavía no está habilitada.',
  CONEXION_NO_DISPONIBLE:'Este negocio todavía no tiene una conexión con Tiendanube.',
  SIN_PERMISO_ENTREGA_EN_NEGOCIO:'No tenés permiso para gestionar estas entregas en este negocio.',
  ADMINISTRADOR_DE_OTRA_ORGANIZACION:'No tenés acceso a este negocio.',
  PEDIDO_NO_ENCONTRADO:'No se encontró este pedido en el negocio seleccionado.',
  PEDIDO_REDACTADO:'Este pedido ya no está disponible por una solicitud de privacidad.',
  SINCRONIZACION_NO_LISTA_PARA_ENTREGA:'La sincronización debe estar conciliada y sin operaciones pendientes antes de confirmar la entrega.',
  PEDIDO_NO_CONCILIADO_PARA_ENTREGA:'El pedido requiere revisión antes de confirmar la entrega.',
  EVENTO_PENDIENTE_O_EDICION_REQUIERE_CONCILIACION:'Hay una actualización del pedido pendiente de conciliación. No se registró una entrega nueva.',
  NO_SE_PUDO_VERIFICAR_PEDIDO_REMOTO:'No se pudo verificar el pedido actual en Tiendanube. No confirmes otra venta por separado.',
  PRECIO_CAMBIO_REVISAR_ANTES_DE_ENTREGAR:'El precio cambió. Actualizá el pedido y revisalo antes de confirmar.',
  PEDIDO_YA_ENTREGADO_CON_OTROS_DATOS:'La entrega ya fue registrada con otros datos. Revisá la venta existente; no la cargues nuevamente.',
  COBRO_EXISTENTE_REQUIERE_CONCILIACION:'Ese cobro ya fue registrado. Debe conciliarse antes de confirmar para no duplicarlo.',
  COBRO_PASARELA_REQUIERE_CONCILIACION:'Este pedido tiene un cobro de una pasarela. Requiere conciliación; no lo cargues como efectivo o transferencia manual.',
  COBRO_REMOTO_CONTRADICTORIO_REQUIERE_CONCILIACION:'El importe recibido no coincide con el cobro informado por Tiendanube. Revisá los registros antes de continuar.',
  ANTICIPO_OTRO_DIA_REQUIERE_CONCILIACION:'El anticipo corresponde a otro día. Requiere conciliación para conservar la fecha real del cobro.',
  ENVIO_IMPUESTOS_O_CARGOS_REQUIEREN_CONCILIACION:'El pedido incluye envío, impuestos o cargos que requieren conciliación.',
  CUPON_REQUIERE_CONCILIACION:'El pedido tiene un cupón que requiere conciliación.',
  PROMOCION_REQUIERE_CONCILIACION:'El pedido tiene una promoción que requiere conciliación.',
  DESCUENTO_O_TOTAL_REMOTO_REQUIERE_CONCILIACION:'El descuento o el total del pedido requieren revisión.',
  SIN_PERMISO_REGISTRAR_COBRO:'No tenés permiso para registrar dinero recibido en este negocio.',
  SIN_PERMISO_CLIENTE:'No tenés permiso para elegir un cliente en este negocio.',
  CLIENTE_REQUERIDO_PARA_SALDO:'Elegí un cliente para registrar el saldo pendiente.',
  CONTADO_REQUIERE_COBRO_COMPLETO:'Al contado se debe registrar el importe completo realmente recibido.',
};

export function crearRouterPedidosTiendanube({consultas=consultasPedidosTiendanube,confirmarEntrega=confirmarEntregaTiendanube,
  enabled=()=>process.env.TIENDANUBE_ENTREGAS_ENABLED==='true'}={}){
  const router=Router();
  const handle=fn=>async(req,res)=>{
    if(!req.usuario||!req.usuarioId)return res.status(401).json({error:'Falta iniciar sesión'});
    if(!(typeof enabled==='function'?enabled():enabled===true))return res.status(409).json({code:'ENTREGAS_TIENDANUBE_DESHABILITADAS',error:mensajes.ENTREGAS_TIENDANUBE_DESHABILITADAS});
    try{
      const n=negocioSolicitado(req);
      if(!n)return res.status(400).json({error:'Seleccioná un negocio'});
      res.json(await fn(req,n));
    }catch(e){
      // Provider/database errors are never returned to a browser, and employee
      // responses must not reveal commission configuration or secret values.
      const privateCode=typeof e.code==='string'&&/^COMISION_|^MES_COMISION_/.test(e.code);
      const code=Object.hasOwn(mensajes,e.code)?e.code:'PEDIDO_REQUIERE_REVISION';
      const status=Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:500;
      res.status(status).json({code:privateCode?'CONFIGURACION_ENTREGA_REQUIERE_REVISION':code,
        error:privateCode?'La configuración de esta entrega necesita revisión del administrador.':mensajes[code]||'No se pudo completar la operación. Revisá el pedido antes de volver a confirmar.'});
    }
  };
  router.get('/pedidos',handle((req,n)=>consultas.listar(n,req.usuarioId)));
  router.get('/pedidos/opciones',handle((req,n)=>consultas.opciones(n,req.usuarioId,req.query.buscar||'')));
  router.get('/pedidos/:id/entrega',handle((req,n)=>consultas.detalle(n,req.params.id,req.usuarioId,{fecha_entrega:req.query.fecha_entrega})));
  router.post('/pedidos/:id/entrega',handle((req,n)=>confirmarEntrega(n,req.params.id,req.body,req.usuarioId)));
  return router;
}

export const tiendanubePedidosRouter=crearRouterPedidosTiendanube();
