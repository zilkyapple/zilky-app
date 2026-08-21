import { Router } from 'express';
import { registrarPago } from '../services/pagosService.js';
export const pagosRouter = Router();
pagosRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await registrarPago({ ...req.body, usuario_id: req.usuarioId }));
  } catch (err) { next(err); }
});
