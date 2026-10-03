import { Router } from 'express';
import { verComprobantes,anularComprobante } from '../services/comprobantesService.js';
import {getComprobante} from '../repositories/comprobantes.js';
import {requirePermiso,exigirPermisoNegocio,negocioSolicitado} from '../middleware/authorize.js';
export const comprobantesRouter=Router();
comprobantesRouter.get('/',requirePermiso('comprobantes.ver'),async(req,res,next)=>{try{const n=negocioSolicitado(req);if(!n)return res.status(400).json({error:'negocio_id es requerido'});exigirPermisoNegocio(req,n,'comprobantes.ver');res.json(await verComprobantes(n,req.query.cliente_id||null));}catch(e){next(e);}});
comprobantesRouter.get('/:id',requirePermiso('comprobantes.ver'),async(req,res,next)=>{try{const c=await getComprobante(req.params.id);if(!c)return res.status(404).json({error:'Comprobante no encontrado'});exigirPermisoNegocio(req,c.negocio_id,'comprobantes.ver');res.json(c);}catch(e){next(e);}});
comprobantesRouter.post('/:id/anular',requirePermiso('comprobantes.anular'),async(req,res,next)=>{try{const c=await getComprobante(req.params.id);if(!c)return res.status(404).json({error:'Comprobante no encontrado'});exigirPermisoNegocio(req,c.negocio_id,'comprobantes.anular');res.json(await anularComprobante(c.id,{motivo:req.body.motivo,usuarioId:req.usuarioId}));}catch(e){next(e);}});
