import {vistaFinanciacion,corregirFinanciacion} from '../services/financiacionService.js';
import { Router } from 'express';
import { crearVenta } from '../services/ventasService.js';
import { requirePermiso, exigirPermisoNegocio, exigirCliente, requireAdmin } from '../middleware/authorize.js';
export const ventasRouter = Router();

ventasRouter.post('/', requirePermiso('ventas.crear'), async (req, res, next) => {
  try {
    const { negocio_id } = req.body;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es obligatorio' });
    exigirPermisoNegocio(req, negocio_id, 'ventas.crear');
    if(req.usuario.rol!=='administrador') await exigirCliente(req,req.body.cliente_id,'clientes.ver');
    res.status(201).json(await crearVenta({...req.body, usuario_id:req.usuarioId}));
  } catch (err) { next(err); }
});

ventasRouter.get('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(v);}catch(e){next(e);}
});
ventasRouter.patch('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(await corregirFinanciacion(req.params.id,req.body,req.usuarioId));}catch(e){next(e);}
});
