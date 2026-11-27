import jwt from 'jsonwebtoken';
import { esquemaActual } from '../db/connection.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('\n✗ Falta JWT_SECRET en el .env (cualquier texto largo y secreto sirve).\n');
  process.exit(1);
}

export function firmarToken(usuario) {
  // Edición de venta: el token lleva la cuenta (esquema) a la que pertenece.
  const ten = esquemaActual();
  return jwt.sign({ sub: usuario.id, email: usuario.email, ...(ten ? { ten } : {}) }, SECRET, { expiresIn: '30d' });
}
export function verificarToken(token) {
  return jwt.verify(token, SECRET);
}
