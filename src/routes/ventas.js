import { Router } from 'express';
import { crearVenta } from '../services/ventasService.js';
import { requirePermiso, validarScopeNegocio } from '../middleware/authorize.js';
export const ventasRouter = Router();

ventasRouter.post('/', requirePermiso('ventas.crear'), async (req, res, next) => {
  try {
    const { negocio_id } = req.body;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es obligatorio' });
    if (!validarScopeNegocio(req, negocio_id)) {
      return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    }
    res.status(201).json(await crearVenta(req.body));
  } catch (err) { next(err); }
});
