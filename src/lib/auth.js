import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('\n✗ Falta JWT_SECRET en el .env (cualquier texto largo y secreto sirve).\n');
  process.exit(1);
}

export function firmarToken(usuario) {
  return jwt.sign({ sub: usuario.id, email: usuario.email }, SECRET, { expiresIn: '30d' });
}

export function verificarToken(token) {
  return jwt.verify(token, SECRET); // lanza si es inválido/expiró
}
