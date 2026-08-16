import { Router } from 'express';
import { crearNegocio, listNegocios, getNegocio, actualizarNegocio } from '../repositories/negocios.js';

export const negociosRouter = Router();

negociosRouter.get('/', async (req, res, next) => {
  try { res.json(await listNegocios()); } catch (err) { next(err); }
});

negociosRouter.get('/:id', async (req, res, next) => {
  try {
    const n = await getNegocio(req.params.id);
    if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(n);
  } catch (err) { next(err); }
});

negociosRouter.post('/', async (req, res, next) => {
  try {
    if (!req.body.nombre) return res.status(400).json({ error: 'nombre es obligatorio' });
    res.status(201).json(await crearNegocio(req.body));
  } catch (err) { next(err); }
});

negociosRouter.patch('/:id', async (req, res, next) => {
  try {
    const n = await actualizarNegocio(req.params.id, req.body);
    if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(n);
  } catch (err) { next(err); }
});
