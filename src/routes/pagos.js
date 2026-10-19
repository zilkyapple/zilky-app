import { vistaMora, perdonarMora } from '../services/moraService.js';
import { Router } from 'express';
import { registrarPago } from '../services/pagosService.js';
import { getCredito } from '../repositories/creditos.js';
import { getPago } from '../repositories/pagos.js';
import { vistaCorreccionPago, previsualizarCorreccionPago, corregirPago } from '../services/pagoCorreccionService.js';
import { requirePermiso, exigirPermisoNegocio, requireAdmin } from '../middleware/authorize.js';
export const pagosRouter = Router();

async function exigirPagoEditable(req) {
  const pago = await getPago(req.params.id);
  if (!pago) throw Object.assign(new Error('Pago no encontrado'), { status: 404 });
  exigirPermisoNegocio(req, pago.negocio_id, 'pagos.registrar');
}

pagosRouter.get('/:id/correccion', requireAdmin, async (req, res, next) => {
  try { await exigirPagoEditable(req); res.json(await vistaCorreccionPago(req.params.id)); } catch (e) { next(e); }
});
pagosRouter.post('/:id/correccion/vista', requireAdmin, async (req, res, next) => {
  try { await exigirPagoEditable(req); res.json(await previsualizarCorreccionPago(req.params.id, req.body)); } catch (e) { next(e); }
});
pagosRouter.patch('/:id/correccion', requireAdmin, async (req, res, next) => {
  try { await exigirPagoEditable(req); res.json(await corregirPago(req.params.id, req.body, req.usuarioId)); } catch (e) { next(e); }
});

pagosRouter.post('/', requirePermiso('pagos.registrar'), async (req, res, next) => {
  try {
    const { credito_id } = req.body;
    if (!credito_id) return res.status(400).json({ error: 'credito_id es obligatorio' });
    const credito = await getCredito(credito_id);
    if (!credito) return res.status(400).json({ error: 'Crédito no encontrado' });
    exigirPermisoNegocio(req, credito.negocio_id, 'pagos.registrar');
    res.status(201).json(await registrarPago({ ...req.body, usuario_id: req.usuarioId }));
  } catch (err) { next(err); }
});

// La condonación modifica una obligación: exclusiva del administrador.
pagosRouter.get('/cuotas/:id/mora', requireAdmin, async (req,res,next)=>{
  try { const data=await vistaMora(req.params.id); exigirPermisoNegocio(req,data.credito.negocio_id,'pagos.registrar'); res.json(data); } catch(e){next(e);}
});
pagosRouter.post('/cuotas/:id/perdonar-mora', requireAdmin, async (req,res,next)=>{
  try { const data=await vistaMora(req.params.id); exigirPermisoNegocio(req,data.credito.negocio_id,'pagos.registrar'); res.json(await perdonarMora(req.params.id,req.body,req.usuarioId)); } catch(e){next(e);}
});
