import { Router } from 'express';
import { registrarUsuario, loginUsuario, aceptarInvitacion, consultarInvitacion } from '../services/authService.js';
import { requireAdmin, requireAuth } from '../middleware/authorize.js';
import { entrarCuentaEnPeticion } from '../db/connection.js';
import { modoSaaS } from '../plataforma/config.js';
import { esquemaPorEmail, esquemaPorInvitacion } from '../plataforma/cuentas.js';
import { hashToken } from '../repositories/invitaciones.js';
import { datosPlataformaParaSesion } from './plataforma.js';
// Edición de venta: antes de iniciar sesión o usar una invitación hay que
// saber a qué cuenta pertenece, y trabajar dentro de su esquema.
async function enCuenta(res, esquema, fn) {
  if (!modoSaaS()) return fn();
  if (!esquema) return null;
  return entrarCuentaEnPeticion(res, esquema, fn);
}
const credencialesInvalidas = () => Object.assign(new Error('Email o contraseña incorrectos'), { status: 401 });
const invitacionInvalida = () => Object.assign(new Error('La invitación no existe o ya no es válida'), { status: 404 });
const esquemaDeInvitacion = async (token) => (typeof token === 'string' && token.length && token.length <= 512) ? esquemaPorInvitacion(hashToken(token)) : null;
export const authRouter = Router();
authRouter.post('/registro', requireAdmin, async (req,res,next)=>{ try { const {usuario,token}=await registrarUsuario(req.body); res.status(201).json({usuario,token}); } catch(e){next(e);} });
authRouter.post('/login', async (req,res,next)=>{ try {
  const esquema = modoSaaS() ? await esquemaPorEmail(typeof req.body?.email==='string'?req.body.email:'') : null;
  if (modoSaaS() && !esquema) throw credencialesInvalidas();
  const {usuario,token}=await enCuenta(res, esquema, ()=>loginUsuario(req.body)); res.json({usuario,token}); } catch(e){next(e);} });
authRouter.post('/invitacion/aceptar', async (req,res,next)=>{ try {
  const esquema = modoSaaS() ? await esquemaDeInvitacion(req.body?.token) : null;
  if (modoSaaS() && !esquema) throw invitacionInvalida();
  const {usuario,token}=await enCuenta(res, esquema, ()=>aceptarInvitacion(req.body)); res.status(201).json({usuario,token}); } catch(e){next(e);} });
authRouter.get('/yo', requireAuth, async (req,res,next)=>{ try {
  const plataforma = await datosPlataformaParaSesion(req);
  res.json(plataforma ? { ...req.usuario, plataforma } : req.usuario); } catch(e){next(e);} });

authRouter.post('/invitacion/consultar', async (req,res,next)=>{ try {
  const esquema = modoSaaS() ? await esquemaDeInvitacion(req.body?.token) : null;
  if (modoSaaS() && !esquema) throw invitacionInvalida();
  res.json(await enCuenta(res, esquema, ()=>consultarInvitacion(req.body))); } catch(e){next(e);} });
