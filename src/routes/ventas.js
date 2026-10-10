import {db} from '../db/connection.js';
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
    let beneficiario=req.usuarioId;
    if(req.usuario.rol==='administrador'&&req.body.comision_usuario_id){
      const u=await db.prepare("SELECT u.id FROM usuarios u WHERE u.id=? AND u.activo=1 AND (u.rol='administrador' OR EXISTS(SELECT 1 FROM usuario_negocio un WHERE un.usuario_id=u.id AND un.negocio_id=? AND un.activo=1))").get(req.body.comision_usuario_id,negocio_id);
      if(!u)return res.status(400).json({error:'Vendedor sin acceso al negocio'});beneficiario=u.id;
    }
    res.status(201).json(await crearVenta({...req.body, usuario_id:req.usuarioId,comision_usuario_id:beneficiario}));
  } catch (err) { next(err); }
});

ventasRouter.get('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(v);}catch(e){next(e);}
});
ventasRouter.patch('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(await corregirFinanciacion(req.params.id,req.body,req.usuarioId));}catch(e){next(e);}
});
