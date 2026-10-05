import { Router } from 'express';
import { verComprobantes,anularComprobante } from '../services/comprobantesService.js';
import {getComprobante} from '../repositories/comprobantes.js';
import {requirePermiso,exigirPermisoNegocio,negocioSolicitado,exigirCliente} from '../middleware/authorize.js';
export const comprobantesRouter=Router();
comprobantesRouter.get('/',async(req,res,next)=>{try{
  const n=negocioSolicitado(req);
  if(!n)return res.status(400).json({error:'negocio_id es requerido'});
  const clienteId=req.query.cliente_id;
  if(clienteId!==undefined && (typeof clienteId!=='string'||!clienteId.trim())) return res.status(400).json({error:'cliente_id inválido'});
  if(req.usuario.rol!=='administrador') {
    if(!clienteId)return res.status(403).json({error:'Seleccioná un cliente para consultar sus comprobantes'});
    exigirPermisoNegocio(req,n,'clientes.ver');
    await exigirCliente(req,clienteId,'clientes.ver');
  }
  res.json(await verComprobantes(n,clienteId||null));
}catch(e){next(e);}});
comprobantesRouter.get('/:id',async(req,res,next)=>{try{
  const c=await getComprobante(req.params.id);
  if(!c)return res.status(404).json({error:'Comprobante no encontrado'});
  exigirPermisoNegocio(req,c.negocio_id,'clientes.ver');
  // Vinculación explícita en el negocio del recurso, también sin query string.
  if(req.usuario.rol!=='administrador') {
    const scope=await exigirCliente(req,c.cliente_id,'clientes.ver');
    if(!scope.includes(c.negocio_id))return res.status(404).json({error:'Cliente no encontrado o sin acceso'});
  }
  res.json(c);
}catch(e){next(e);}});
comprobantesRouter.post('/:id/anular',requirePermiso('comprobantes.anular'),async(req,res,next)=>{try{const c=await getComprobante(req.params.id);if(!c)return res.status(404).json({error:'Comprobante no encontrado'});exigirPermisoNegocio(req,c.negocio_id,'comprobantes.anular');res.json(await anularComprobante(c.id,{motivo:req.body.motivo,usuarioId:req.usuarioId}));}catch(e){next(e);}});
