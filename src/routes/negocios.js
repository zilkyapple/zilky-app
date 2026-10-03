import { Router } from 'express';
import { crearNegocio,listNegocios,getNegocio,actualizarNegocio } from '../repositories/negocios.js';
import {requireAdmin,scopeNegocios,validarScopeNegocio} from '../middleware/authorize.js';
export const negociosRouter=Router();
negociosRouter.get('/',async(req,res,next)=>{try{const scope=scopeNegocios(req);res.json((await listNegocios()).filter(n=>scope===null||scope.includes(n.id)));}catch(e){next(e);}});
negociosRouter.get('/:id',async(req,res,next)=>{try{if(!validarScopeNegocio(req,req.params.id))return res.status(403).json({error:'Sin acceso al negocio'});const n=await getNegocio(req.params.id);if(!n)return res.status(404).json({error:'Negocio no encontrado'});res.json(n);}catch(e){next(e);}});
negociosRouter.post('/',requireAdmin,async(req,res,next)=>{try{if(!req.body.nombre)return res.status(400).json({error:'nombre es obligatorio'});res.status(201).json(await crearNegocio(req.body));}catch(e){next(e);}});
negociosRouter.patch('/:id',requireAdmin,async(req,res,next)=>{try{const n=await actualizarNegocio(req.params.id,req.body);if(!n)return res.status(404).json({error:'Negocio no encontrado'});res.json(n);}catch(e){next(e);}});
