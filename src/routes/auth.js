import { Router } from 'express';
import { registrarUsuario, loginUsuario, aceptarInvitacion } from '../services/authService.js';
import { requireAdmin, requireAuth } from '../middleware/authorize.js';
export const authRouter = Router();
authRouter.post('/registro', requireAdmin, async (req,res,next)=>{ try { const {usuario,token}=await registrarUsuario(req.body); res.status(201).json({usuario,token}); } catch(e){next(e);} });
authRouter.post('/login', async (req,res,next)=>{ try { const {usuario,token}=await loginUsuario(req.body); res.json({usuario,token}); } catch(e){next(e);} });
authRouter.post('/invitacion/aceptar', async (req,res,next)=>{ try { const {usuario,token}=await aceptarInvitacion(req.body); res.status(201).json({usuario,token}); } catch(e){next(e);} });
authRouter.get('/yo', requireAuth, async (req,res,next)=>{ try { res.json(req.usuario); } catch(e){next(e);} });
