import { badRequest } from '../lib/validation.js';
import { Router } from 'express';
import { requireAdmin } from '../middleware/authorize.js';
import { invitarEmpleado, listarInvitaciones, revocarInvitacionService, regenerarInvitacion } from '../services/invitacionesService.js';

export const invitacionesRouter = Router();
invitacionesRouter.get('/', requireAdmin, async (req, res, next) => { try { res.json(await listarInvitaciones()); } catch (e) { next(e); } });
invitacionesRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    if (Object.keys(req.body).some(k=>!['email','nombre','negocios'].includes(k))) throw badRequest('Campo no permitido');
    const { email, nombre, negocios } = req.body;
    res.status(201).json(await invitarEmpleado({ email, nombre, negocios, organizacion_id: req.usuario?.organizacion_id || null, creado_por: req.usuarioId }));
  } catch (e) { next(e); }
});
invitacionesRouter.post('/:id/revocar', requireAdmin, async (req, res, next) => { try { res.json(await revocarInvitacionService(req.params.id, req.usuarioId)); } catch (e) { next(e); } });
invitacionesRouter.post('/:id/regenerar', requireAdmin, async (req, res, next) => { try { res.json(await regenerarInvitacion(req.params.id, req.usuarioId)); } catch (e) { next(e); } });
