import { Router } from 'express';
import { crearProducto, listProductos, getProducto } from '../repositories/productos.js';
import { requirePermiso, requireAdmin, validarScopeNegocio, tienePermisoEnNegocio } from '../middleware/authorize.js';

export const productosRouter = Router();

productosRouter.get('/', requirePermiso('productos.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    const productos = await listProductos(negocio_id);
    const puedeVerCosto = req.usuario.rol === 'administrador' || tienePermisoEnNegocio(req, negocio_id, 'costos.ver');
    if (!puedeVerCosto) for (const p of productos) delete p.costo_centavos;
    res.json(productos);
  } catch (err) { next(err); }
});

productosRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    if (!req.body.negocio_id || !req.body.nombre) return res.status(400).json({ error: 'negocio_id y nombre son obligatorios' });
    res.status(201).json(await crearProducto(req.body));
  } catch (err) { next(err); }
});

productosRouter.get('/:id', requirePermiso('productos.ver'), async (req, res, next) => {
  try {
    const p = await getProducto(req.params.id);
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    if (!validarScopeNegocio(req, p.negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    const puedeVerCosto = req.usuario.rol === 'administrador' || tienePermisoEnNegocio(req, p.negocio_id, 'costos.ver');
    if (!puedeVerCosto) delete p.costo_centavos;
    res.json(p);
  } catch (err) { next(err); }
});
