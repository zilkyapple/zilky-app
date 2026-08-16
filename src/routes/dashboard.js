import { Router } from 'express';
import { resumenGeneral, listaCobranza } from '../services/dashboardService.js';

export const dashboardRouter = Router();

dashboardRouter.get('/resumen', async (req, res, next) => {
  try { res.json(await resumenGeneral(req.query.negocio_id || null)); } catch (err) { next(err); }
});

dashboardRouter.get('/cobranza', async (req, res, next) => {
  try { res.json(await listaCobranza(req.query.negocio_id || null)); } catch (err) { next(err); }
});
