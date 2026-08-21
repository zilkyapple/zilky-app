import { Router } from 'express';
import { crearVenta } from '../services/ventasService.js';
export const ventasRouter = Router();
ventasRouter.post('/', async (req, res, next) => {
  try { res.status(201).json(await crearVenta(req.body)); } catch (err) { next(err); }
});
