import { Router } from 'express';
import { crearProducto, listProductos, getProducto } from '../repositories/productos.js';

export const productosRouter = Router();

productosRouter.get('/', async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    res.json(await listProductos(negocio_id));
  } catch (err) { next(err); }
});

productosRouter.post('/', async (req, res, next) => {
  try {
    if (!req.body.negocio_id || !req.body.nombre) return res.status(400).json({ error: 'negocio_id y nombre son obligatorios' });
    res.status(201).json(await crearProducto(req.body));
  } catch (err) { next(err); }
});

productosRouter.get('/:id', async (req, res, next) => {
  try {
    const p = await getProducto(req.params.id);
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(p);
  } catch (err) { next(err); }
});
