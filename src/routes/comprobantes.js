import { Router } from 'express';
import { verComprobantes, anularComprobante } from '../services/comprobantesService.js';

export const comprobantesRouter = Router();

comprobantesRouter.get('/', async (req, res, next) => {
  try {
    const { negocio_id, cliente_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    res.json(await verComprobantes(negocio_id, cliente_id || null));
  } catch (err) { next(err); }
});

comprobantesRouter.post('/:id/anular', async (req, res, next) => {
  try {
    const comprobante = await anularComprobante(req.params.id, { motivo: req.body.motivo, usuarioId: req.usuarioId });
    res.json(comprobante);
  } catch (err) { next(err); }
});
