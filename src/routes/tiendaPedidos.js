import { Router } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { requirePermiso, exigirPermisoNegocio, negocioSolicitado } from '../middleware/authorize.js';
import { crearPedidoPublico, listarPedidosTienda, detallePedidoTienda, confirmarPedidoTienda, cancelarPedidoTienda, exportarContactosTienda } from '../services/tiendaPedidosService.js';

export const tiendaPedidosRouter = Router();
export const tiendaPedidosPublicosRouter = Router();
const ventanas = new Map(), secreto = randomBytes(32), intervalo = 15 * 60 * 1000;
function limitar(req) {
  const ahora = Date.now();
  for (const [key, value] of ventanas) if (value.hasta <= ahora) ventanas.delete(key);
  const clave = createHmac('sha256', secreto).update(String(req.ip || req.socket.remoteAddress || '') + '\n' + req.params.slug).digest('hex');
  const ventana = ventanas.get(clave);
  if (ventana?.cantidad >= 10) throw Object.assign(new Error('Ya recibimos varios pedidos. Esperá unos minutos antes de enviar otro.'), { status: 429 });
  if (!ventana && ventanas.size >= 10000) ventanas.delete(ventanas.keys().next().value);
  ventanas.set(clave, { hasta: ventana?.hasta || ahora + intervalo, cantidad: (ventana?.cantidad || 0) + 1 });
}
tiendaPedidosPublicosRouter.post('/:slug/pedidos', async (req, res, next) => {
  try { res.status(201).json(await crearPedidoPublico(req.params.slug, req.body, { antesDeCrear: () => limitar(req) })); } catch (e) { if (e.status === 429) res.set('Retry-After', '900'); next(e); }
});
const autorizado = requirePermiso('tienda.pedidos');
function negocio(req) {
  const n = negocioSolicitado(req);
  if (!n) throw Object.assign(new Error('Seleccioná un negocio'), { status: 400 });
  exigirPermisoNegocio(req, n, 'tienda.pedidos');
  return n;
}
tiendaPedidosRouter.get('/pedidos', autorizado, async (req, res, next) => {
  try { res.json(await listarPedidosTienda(negocio(req), { estado: req.query.estado, encargos: req.query.encargos })); } catch (e) { next(e); }
});
tiendaPedidosRouter.get('/pedidos/:id', autorizado, async (req, res, next) => {
  try { res.json(await detallePedidoTienda(negocio(req), req.params.id)); } catch (e) { next(e); }
});
tiendaPedidosRouter.post('/pedidos/:id/confirmar', autorizado, async (req, res, next) => {
  try { res.json(await confirmarPedidoTienda(negocio(req), req.params.id, req.body, req.usuarioId)); } catch (e) { next(e); }
});
tiendaPedidosRouter.post('/pedidos/:id/cancelar', autorizado, async (req, res, next) => {
  try { res.json(await cancelarPedidoTienda(negocio(req), req.params.id, req.body, req.usuarioId)); } catch (e) { next(e); }
});
tiendaPedidosRouter.get('/contactos.csv', autorizado, async (req, res, next) => {
  try { const n = negocio(req); res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="contactos-tienda.csv"'); res.set('Cache-Control', 'no-store'); res.send(await exportarContactosTienda(n)); } catch (e) { next(e); }
});
