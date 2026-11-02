import { Router } from 'express';
import { requirePermiso, negocioSolicitado, exigirPermisoNegocio } from '../middleware/authorize.js';
import { fail } from '../lib/solicitud.js';
import { registrarCobroPedido, anularCobroPedido } from '../services/tiendaCobrosService.js';

export const tiendaCobrosRouter = Router();
function negocio(req, permiso) {
  const n = negocioSolicitado(req); if (!n) throw fail('Seleccioná un negocio');
  exigirPermisoNegocio(req, n, 'tienda.pedidos'); exigirPermisoNegocio(req, n, permiso);
  return n;
}
tiendaCobrosRouter.post('/pedidos/:id/cobros', requirePermiso('tienda.pedidos'), async (req, res, next) => {
  try {
    const n = negocio(req, 'pagos.registrar');
    if (req.body.cliente_id !== undefined) exigirPermisoNegocio(req, n, 'clientes.ver');
    res.status(201).json(await registrarCobroPedido(n, req.params.id, req.body, req.usuarioId));
  } catch (error) { next(error); }
});
tiendaCobrosRouter.post('/pedidos/:id/cobros/:cobroId/anular', requirePermiso('tienda.pedidos'), async (req, res, next) => {
  try { res.json(await anularCobroPedido(negocio(req, 'comprobantes.anular'), req.params.id, req.params.cobroId, req.body, req.usuarioId)); }
  catch (error) { next(error); }
});
