import bcrypt from 'bcryptjs';
import { crearUsuario, getUsuarioPorEmail } from '../repositories/usuarios.js';
import { firmarToken } from '../lib/auth.js';

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

export async function registrarUsuario({ email, password, nombre }) {
  if (!email || !password) throw badRequest('email y password son obligatorios');
  if (password.length < 6) throw badRequest('la contraseña debe tener al menos 6 caracteres');

  const existente = await getUsuarioPorEmail(email);
  if (existente) throw Object.assign(new Error('Ya existe una cuenta con ese email'), { status: 409 });

  const password_hash = await bcrypt.hash(password, 10);
  const usuario = await crearUsuario({ email, password_hash, nombre });
  return { usuario, token: firmarToken(usuario) };
}

export async function loginUsuario({ email, password }) {
  if (!email || !password) throw badRequest('email y password son obligatorios');

  const usuario = await getUsuarioPorEmail(email);
  if (!usuario) throw Object.assign(new Error('Email o contraseña incorrectos'), { status: 401 });

  const ok = await bcrypt.compare(password, usuario.password_hash);
  if (!ok) throw Object.assign(new Error('Email o contraseña incorrectos'), { status: 401 });

  const { password_hash, ...usuarioSinHash } = usuario;
  return { usuario: usuarioSinHash, token: firmarToken(usuario) };
}
