import { Router } from 'express';
import { registrarUsuario, loginUsuario } from '../services/authService.js';
import { getUsuarioById } from '../repositories/usuarios.js';

export const authRouter = Router();

authRouter.post('/registro', async (req, res, next) => {
  try {
    const { usuario, token } = await registrarUsuario(req.body);
    res.status(201).json({ usuario, token });
  } catch (err) { next(err); }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { usuario, token } = await loginUsuario(req.body);
    res.json({ usuario, token });
  } catch (err) { next(err); }
});

authRouter.get('/yo', async (req, res, next) => {
  try {
    const usuario = await getUsuarioById(req.usuarioId);
    res.json(usuario);
  } catch (err) { next(err); }
});
