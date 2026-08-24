import { Router } from 'express';
import { registrarPago } from '../services/pagosService.js';
import { getCredito } from '../repositories/creditos.js';
import { requirePermiso, validarScopeNegocio } from '../middleware/authorize.js';
export const pagosRouter = Router();

pagosRouter.post('/', requirePermiso('pagos.registrar'), async (req, res, next) => {
  try {
    const { credito_id } = req.body;
    if (!credito_id) return res.status(400).json({ error: 'credito_id es obligatorio' });
    const credito = await getCredito(credito_id);
    if (!credito) return res.status(400).json({ error: 'Crédito no encontrado' });
    if (!validarScopeNegocio(req, credito.negocio_id)) {
      return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    }
    res.status(201).json(await registrarPago({ ...req.body, usuario_id: req.usuarioId }));
  } catch (err) { next(err); }
});
