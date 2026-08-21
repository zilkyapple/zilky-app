import { Router } from 'express';
import { resumenGeneral, listaCobranza, recordatoriosDeHoy, calendarioMes, calendarioDia } from '../services/dashboardService.js';

export const dashboardRouter = Router();

dashboardRouter.get('/resumen', async (req, res, next) => {
  try { res.json(await resumenGeneral(req.query.negocio_id || null)); } catch (err) { next(err); }
});

dashboardRouter.get('/cobranza', async (req, res, next) => {
  try {
    const ventana = req.query.ventana_dias ? Number(req.query.ventana_dias) : 7;
    res.json(await listaCobranza(req.query.negocio_id || null, { ventanaDias: ventana }));
  } catch (err) { next(err); }
});

dashboardRouter.get('/recordatorios', async (req, res, next) => {
  try { res.json(await recordatoriosDeHoy(req.query.negocio_id || null)); } catch (err) { next(err); }
});

dashboardRouter.get('/calendario', async (req, res, next) => {
  try {
    const { negocio_id, mes } = req.query;
    if (!negocio_id || !mes) return res.status(400).json({ error: 'negocio_id y mes (YYYY-MM) son requeridos' });
    res.json(await calendarioMes(negocio_id, mes));
  } catch (err) { next(err); }
});

dashboardRouter.get('/calendario/dia', async (req, res, next) => {
  try {
    const { negocio_id, fecha } = req.query;
    if (!negocio_id || !fecha) return res.status(400).json({ error: 'negocio_id y fecha (YYYY-MM-DD) son requeridos' });
    res.json(await calendarioDia(negocio_id, fecha));
  } catch (err) { next(err); }
});
