import { Router } from 'express';
import { crearVenta } from '../services/ventasService.js';
import { requirePermiso, exigirPermisoNegocio, exigirCliente } from '../middleware/authorize.js';
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
