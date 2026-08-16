import { verificarToken } from '../lib/auth.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta iniciar sesión' });
  try {
    const payload = verificarToken(token);
    req.usuarioId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o vencida, iniciá sesión de nuevo' });
  }
}
