import { Router } from 'express';
import { requireAuth, requireAdmin, requirePermiso, negocioSolicitado, exigirPermisoNegocio, tienePermisoEnNegocio } from '../middleware/authorize.js';
import { vistaTienda, guardarConfigTienda, catalogoExistenteTienda, listarProductosTienda, crearProductoTienda, editarProductoTienda, tiendaPublica } from '../services/tiendasService.js';
import { fail } from '../lib/solicitud.js';

export const tiendasRouter = Router();
export const tiendaPublicaRouter = Router();
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
function negocio(req, permiso = 'tienda.editar') {
  const n = negocioSolicitado(req); if (!n) throw fail('Seleccioná un negocio');
  exigirPermisoNegocio(req, n, permiso); return n;
}
tiendasRouter.get('/', requireAuth, wrap(async (req, res) => {
  const n = negocioSolicitado(req); if (!n) throw fail('Seleccioná un negocio');
  if (!tienePermisoEnNegocio(req, n, 'tienda.editar') && !tienePermisoEnNegocio(req, n, 'tienda.pedidos')) throw fail('No tenés permiso en este negocio', 403);
  res.json(await vistaTienda(n));
}));
tiendasRouter.put('/config', requireAdmin, wrap(async (req, res) => res.json(await guardarConfigTienda(negocio(req), req.body, req.usuarioId))));
tiendasRouter.get('/catalogo', requirePermiso('tienda.editar'), wrap(async (req, res) => res.json(await catalogoExistenteTienda(negocio(req)))));
tiendasRouter.get('/productos', requirePermiso('tienda.editar'), wrap(async (req, res) => res.json(await listarProductosTienda(negocio(req)))));
tiendasRouter.post('/productos', requirePermiso('tienda.editar'), wrap(async (req, res) => res.status(201).json(await crearProductoTienda(negocio(req), req.body, req.usuarioId))));
tiendasRouter.put('/productos/:id', requirePermiso('tienda.editar'), wrap(async (req, res) => res.json(await editarProductoTienda(negocio(req), req.params.id, req.body, req.usuarioId))));
tiendaPublicaRouter.get('/:slug', wrap(async (req, res) => res.json(await tiendaPublica(req.params.slug))));
