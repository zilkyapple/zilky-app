import {nuevoProducto,editarProducto,moverStock,historialProducto} from '../services/productosService.js';
import { Router } from 'express';
import { listProductos, getProducto } from '../repositories/productos.js';
import { requirePermiso, requireAdmin, exigirPermisoNegocio, tienePermisoEnNegocio } from '../middleware/authorize.js';

export const productosRouter = Router();

productosRouter.get('/', requirePermiso('productos.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    exigirPermisoNegocio(req, negocio_id, 'productos.ver');
    const productos = await listProductos(negocio_id);
    const puedeVerCosto = req.usuario.rol === 'administrador' || tienePermisoEnNegocio(req, negocio_id, 'costos.ver');
    if (!puedeVerCosto) for (const p of productos) delete p.costo_centavos;
    res.json(productos);
  } catch (err) { next(err); }
});

productosRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    if (!req.body.negocio_id || !req.body.nombre) return res.status(400).json({ error: 'negocio_id y nombre son obligatorios' });
    res.status(201).json(await nuevoProducto(req.body,req.usuarioId));
  } catch (err) { next(err); }
});

productosRouter.get('/:id', requirePermiso('productos.ver'), async (req, res, next) => {
  try {
    const p = await getProducto(req.params.id);
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    exigirPermisoNegocio(req, p.negocio_id, 'productos.ver');
    const puedeVerCosto = req.usuario.rol === 'administrador' || tienePermisoEnNegocio(req, p.negocio_id, 'costos.ver');
    if (!puedeVerCosto) delete p.costo_centavos;
    res.json(p);
  } catch (err) { next(err); }
});

const wrap=f=>async(req,res,next)=>{try{await f(req,res);}catch(e){next(e);}};
productosRouter.put('/:id',requireAdmin,wrap(async(req,res)=>res.json(await editarProducto(req.params.id,req.body.negocio_id,req.body,req.usuarioId))));
productosRouter.post('/:id/stock',requireAdmin,wrap(async(req,res)=>res.json(await moverStock(req.params.id,req.body.negocio_id,req.body,req.usuarioId))));
productosRouter.get('/:id/historial',requireAdmin,wrap(async(req,res)=>res.json(await historialProducto(req.params.id,req.query.negocio_id))));
