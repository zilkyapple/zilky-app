import { Router } from 'express';
import { resumenGeneral, listaCobranza, recordatoriosDeHoy, calendarioMes, calendarioDia } from '../services/dashboardService.js';
import { requirePermiso, validarScopeNegocio, scopeNegocios } from '../middleware/authorize.js';

export const dashboardRouter = Router();

dashboardRouter.get('/resumen', requirePermiso('dashboard_financiero.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    const scope = scopeNegocios(req);
    if (negocio_id) {
      if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
      res.json(await resumenGeneral(negocio_id));
    } else {
      if (scope === null) {
        res.json(await resumenGeneral(null));
      } else if (scope.length === 0) {
        res.json({
          vendidoTotalCentavos: 0, cobradoHoyCentavos: 0, cobradoMesCentavos: 0,
          porCobrarHoyCentavos: 0, porIngresarMesCentavos: 0, saldoPendienteTotalCentavos: 0,
          saldoVencidoCentavos: 0, montoEnRiesgoCentavos: 0,
          clientesEnMora: 0, clientesVencidos: 0, clientesConDeuda: 0,
          clientesTotales: 0, capitalColocadoCentavos: 0,
          ventasActivas: 0, ventasFinalizadas: 0, cuotasPendientes: 0,
          porNegocio: [],
        });
      } else {
        res.json(await resumenGeneral(scope));
      }
    }
  } catch (err) { next(err); }
});

dashboardRouter.get('/cobranza', requirePermiso('cobranzas.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    const scope = scopeNegocios(req);
    const ventana = req.query.ventana_dias ? Number(req.query.ventana_dias) : 7;
    if (negocio_id) {
      if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
      res.json(await listaCobranza(negocio_id, { ventanaDias: ventana }));
    } else {
      if (scope === null) {
        res.json(await listaCobranza(null, { ventanaDias: ventana }));
      } else if (scope.length === 0) {
        res.json({ hoy: [], proximas: [], vencidas: [], todas: [], ventanaDias: ventana });
      } else {
        res.json(await listaCobranza(scope, { ventanaDias: ventana }));
      }
    }
  } catch (err) { next(err); }
});

dashboardRouter.get('/recordatorios', requirePermiso('cobranzas.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    const scope = scopeNegocios(req);
    if (negocio_id) {
      if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
      res.json(await recordatoriosDeHoy(negocio_id));
    } else {
      if (scope === null) {
        res.json(await recordatoriosDeHoy(null));
      } else if (scope.length === 0) {
        res.json([]);
      } else {
        res.json(await recordatoriosDeHoy(scope));
      }
    }
  } catch (err) { next(err); }
});

dashboardRouter.get('/calendario', requirePermiso('cobranzas.ver'), async (req, res, next) => {
  try {
    const { negocio_id, mes } = req.query;
    if (!negocio_id || !mes) return res.status(400).json({ error: 'negocio_id y mes (YYYY-MM) son requeridos' });
    if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    res.json(await calendarioMes(negocio_id, mes));
  } catch (err) { next(err); }
});

dashboardRouter.get('/calendario/dia', requirePermiso('cobranzas.ver'), async (req, res, next) => {
  try {
    const { negocio_id, fecha } = req.query;
    if (!negocio_id || !fecha) return res.status(400).json({ error: 'negocio_id y fecha (YYYY-MM-DD) son requeridos' });
    if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    res.json(await calendarioDia(negocio_id, fecha));
  } catch (err) { next(err); }
});
