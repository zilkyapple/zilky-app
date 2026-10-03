import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';
import { validarAsignaciones } from '../lib/asignaciones.js';
import { asignarNegocio } from '../repositories/usuarios.js';
import { normalizarEmail, validarNombre, validarPassword, bloquearEmail, emailDuplicado, buscarInvitacion, asignacionesInvitacion } from '../lib/invitaciones.js';
import {
  crearUsuario,
  getUsuarioPorEmail,
  getUsuarioById
} from '../repositories/usuarios.js';
import { firmarToken } from '../lib/auth.js';

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

export async function registrarUsuario({ email, password, nombre }) {
  if (!email || !password) {
    throw badRequest('email y password son obligatorios');
  }

  if (password.length < 6) {
    throw badRequest('la contraseña debe tener al menos 6 caracteres');
  }

  if (await getUsuarioPorEmail(email)) {
    throw Object.assign(
      new Error('Ya existe una cuenta con ese email'),
      { status: 409 }
    );
  }

  const usuario = await crearUsuario({
    email,
    password_hash: await bcrypt.hash(password, 10),
    nombre
  });

  return {
    usuario,
    token: firmarToken(usuario)
  };
}

export async function crearEmpleado({ email, password, nombre }) {
  email = normalizarEmail(email); validarNombre(nombre); validarPassword(password);
  const password_hash = await bcrypt.hash(password, 10);
  return db.transaction(async () => {
    await bloquearEmail(email);
    if (await getUsuarioPorEmail(email)) throw emailDuplicado();
    return crearUsuario({ email, password_hash, nombre, rol: 'empleado', activo: 1, invitacion_completada: 1 });
  });
}

export async function loginUsuario({ email, password }) {
  if (!email || !password) {
    throw badRequest('email y password son obligatorios');
  }

  const usuario = await getUsuarioPorEmail(email);

  if (!usuario) {
    throw Object.assign(
      new Error('Email o contraseña incorrectos'),
      { status: 401 }
    );
  }

  if (!usuario.activo) {
    throw Object.assign(
      new Error('Usuario inactivo'),
      { status: 403 }
    );
  }

  if (!await bcrypt.compare(password, usuario.password_hash)) {
    throw Object.assign(
      new Error('Email o contraseña incorrectos'),
      { status: 401 }
    );
  }

  const { password_hash, ...usuarioSinHash } = usuario;

  return {
    usuario: usuarioSinHash,
    token: firmarToken(usuario)
  };
}

export async function consultarInvitacion({ token }) {
  const inv = await buscarInvitacion(token);
  const asignaciones = asignacionesInvitacion(inv);
  await validarAsignaciones(asignaciones);
  const negocios = [];
  for (const a of asignaciones) negocios.push(await db.prepare('SELECT id,nombre FROM negocios WHERE id=?').get(a.negocio_id));
  return { email: inv.email, nombre: inv.nombre, expira_en: inv.expira_en, negocios };
}

export async function aceptarInvitacion({ token, password, nombre, ...extra }) {
  if (Object.keys(extra).length) throw badRequest('Campo no permitido');
  validarPassword(password); validarNombre(nombre);
  // Rechazo temprano sin costo bcrypt para enlaces inválidos; se vuelve a comprobar bajo bloqueo.
  await buscarInvitacion(token);
  const password_hash = await bcrypt.hash(password, 10);
  try {
    return await db.transaction(async () => {
      const inv = await buscarInvitacion(token, true);
      const email = normalizarEmail(inv.email);
      if (await getUsuarioPorEmail(email)) throw emailDuplicado();
      const negocios = asignacionesInvitacion(inv);
      await validarAsignaciones(negocios);
      const usuario = await crearUsuario({ email, password_hash, nombre: nombre || inv.nombre, rol: 'empleado', activo: 1, invitacion_completada: 1 });
      for (const a of negocios) await asignarNegocio(usuario.id, a.negocio_id, a.permisos);
      await db.prepare("UPDATE invitaciones SET estado='usada', usada_en=?, usada_por=? WHERE id=?")
        .run(new Date().toISOString(), usuario.id, inv.id);
      return { usuario, token: firmarToken(usuario) };
    });
  } catch (e) {
    if (e.code === '23505') throw emailDuplicado();
    throw e;
  }
}
