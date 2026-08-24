import { Router } from 'express';
import { requireAdmin, requirePermiso } from '../middleware/authorize.js';
import { listarEmpleados, crearEmpleado, modificarEmpleado, obtenerEmpleado } from '../services/usuariosService.js';

export const usuariosRouter = Router();

usuariosRouter.get('/', requirePermiso('empleados.gestionar'), async (req, res, next) => {
  try { res.json(await listarEmpleados()); } catch (err) { next(err); }
});

usuariosRouter.post('/', requirePermiso('empleados.gestionar'), async (req, res, next) => {
  try { res.status(201).json(await crearEmpleado(req.body)); } catch (err) { next(err); }
});

usuariosRouter.get('/:id', requirePermiso('empleados.gestionar'), async (req, res, next) => {
  try {
    const u = await obtenerEmpleado(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(u);
  } catch (err) { next(err); }
});

usuariosRouter.patch('/:id', requirePermiso('empleados.gestionar'), async (req, res, next) => {
  try {
    const u = await modificarEmpleado(req.params.id, req.body);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(u);
  } catch (err) { next(err); }
});
