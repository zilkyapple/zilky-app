import { Router } from 'express';
import { modoSaaS, diasGracia, MARCA, FUNCIONES_OPCIONALES } from '../plataforma/config.js';
import { registrarCuenta, linkDePago, procesarNotificacion, aplicarPrecioASuscripciones } from '../plataforma/suscripcionService.js';
import { precioActualCentavos, ajustePrecio, guardarPrecio } from '../plataforma/precio.js';
import { firmaValida } from '../plataforma/mercadopago.js';
import { cuentaHabilitada, soloDuenaPlataforma, esDuenaPlataforma, funcionDisponible } from '../plataforma/middleware.js';
import { listarCuentas, funcionesHabilitadas, fijarFuncion, cuentaPorId } from '../plataforma/cuentas.js';
import { rowsCSV } from './exportaciones.js';
import { requireAdmin } from '../middleware/authorize.js';

const soloSaaS = (req, res, next) => modoSaaS() ? next() : res.status(404).json({ error: 'No encontrado' });

// Público: configuración de la edición, alta de cuentas y avisos de Mercado Pago.
export const plataformaPublicaRouter = Router();
plataformaPublicaRouter.get('/config', async (req, res, next) => {
  try {
    if (!modoSaaS()) return res.json({ edicion: 'propia' });
    res.json({ edicion: 'saas', marca: MARCA, precio_centavos: await precioActualCentavos(), dias_gracia: diasGracia() });
  } catch (e) { next(e); }
});
plataformaPublicaRouter.post('/registro', soloSaaS, async (req, res, next) => {
  try { res.status(201).json(await registrarCuenta(req.body)); } catch (e) { next(e); }
});
plataformaPublicaRouter.post('/mercadopago/webhook', soloSaaS, async (req, res, next) => {
  try {
    const recursoId = req.query['data.id'] || req.body?.data?.id || req.query.id || null;
    const tipo = req.query.type || req.body?.type || req.query.topic || req.body?.topic || null;
    if (!firmaValida({ xSignature: req.headers['x-signature'], xRequestId: req.headers['x-request-id'], dataId: recursoId }))
      return res.status(401).json({ error: 'Firma inválida' });
    res.json(await procesarNotificacion({ tipo, recursoId: recursoId ? String(recursoId) : null }));
  } catch (e) { next(e); }
});

// Con sesión (sin exigir suscripción activa): ver el estado y pagar.
export const suscripcionRouter = Router();
suscripcionRouter.use(soloSaaS);
async function resumenCuenta(c) {
  return { estado: c.estado, habilitada: cuentaHabilitada(c), negocio: c.negocio_nombre, ultimo_pago_en: c.ultimo_pago_en,
    rechazo_desde: c.rechazo_desde, precio_centavos: await precioActualCentavos(), dias_gracia: diasGracia() };
}
suscripcionRouter.get('/', async (req, res, next) => {
  try {
    if (!req.cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json(await resumenCuenta(req.cuenta));
  } catch (e) { next(e); }
});
suscripcionRouter.post('/pagar', requireAdmin, async (req, res, next) => {
  try {
    if (!req.cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ init_point: await linkDePago(await cuentaPorId(req.cuenta.id)) });
  } catch (e) { next(e); }
});
export async function datosPlataformaParaSesion(req) {
  if (!modoSaaS() || !req.cuenta) return null;
  const funciones = {};
  for (const f of FUNCIONES_OPCIONALES) funciones[f] = await funcionDisponible(req, f);
  return { marca: MARCA, cuenta: await resumenCuenta(req.cuenta), funciones, duena: esDuenaPlataforma(req) };
}

// Solo la dueña de la plataforma: registro de suscriptores y funciones.
export const plataformaAdminRouter = Router();
plataformaAdminRouter.use(soloSaaS, soloDuenaPlataforma);
const ETIQUETA = { pendiente_pago: 'Pago pendiente', activa: 'Activa', pago_rechazado: 'Pago rechazado', bloqueada: 'Bloqueada', cancelada: 'Cancelada', exenta: 'Sin cargo' };
function filaSuscriptor(c) {
  return { nombre: c.nombre, negocio: c.negocio_nombre, email: c.email, telefono: c.telefono || '', estado: ETIQUETA[c.estado] || c.estado,
    alta: c.creada_en ? new Date(c.creada_en).toISOString().slice(0, 10) : '',
    primer_pago: c.primer_pago_en ? new Date(c.primer_pago_en).toISOString().slice(0, 10) : '',
    ultimo_pago: c.ultimo_pago_en ? new Date(c.ultimo_pago_en).toISOString().slice(0, 10) : '' };
}
plataformaAdminRouter.get('/cuentas', async (req, res, next) => {
  try { res.json((await listarCuentas()).map(c => ({ ...filaSuscriptor(c), estado_codigo: c.estado, habilitada: cuentaHabilitada(c) }))); } catch (e) { next(e); }
});
plataformaAdminRouter.get('/cuentas/exportar', async (req, res, next) => {
  try {
    const filas = (await listarCuentas()).map(filaSuscriptor);
    res.json({ filename: `suscriptores-${new Date().toISOString().slice(0, 10)}.csv`, csv: rowsCSV(filas), filas: filas.length });
  } catch (e) { next(e); }
});
plataformaAdminRouter.get('/funciones', async (req, res, next) => {
  try { const on = await funcionesHabilitadas(); res.json(FUNCIONES_OPCIONALES.map(clave => ({ clave, habilitada: on.includes(clave) }))); } catch (e) { next(e); }
});
plataformaAdminRouter.put('/funciones/:clave', async (req, res, next) => {
  try {
    if (!FUNCIONES_OPCIONALES.includes(req.params.clave) || typeof req.body?.habilitada !== 'boolean') return res.status(400).json({ error: 'Función inválida' });
    await fijarFuncion(req.params.clave, req.body.habilitada);
    res.json({ clave: req.params.clave, habilitada: req.body.habilitada });
  } catch (e) { next(e); }
});
plataformaAdminRouter.get('/precio', async (req, res, next) => {
  try { res.json({ ajuste: await ajustePrecio(), precio_centavos: await precioActualCentavos() }); } catch (e) { next(e); }
});
plataformaAdminRouter.put('/precio', async (req, res, next) => {
  try { res.json({ ajuste: await guardarPrecio({ usd: req.body?.usd, cotizacion: req.body?.cotizacion }) }); } catch (e) { next(e); }
});
plataformaAdminRouter.post('/precio/aplicar', async (req, res, next) => {
  try { res.json(await aplicarPrecioASuscripciones()); } catch (e) { next(e); }
});
