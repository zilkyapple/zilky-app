import bcrypt from 'bcryptjs';
import { pool } from '../db/connection.js';
import { randomUUID } from 'node:crypto';
import {
  crearUsuario,
  getUsuarioPorEmail,
  getUsuarioById
} from '../repositories/usuarios.js';
import { hashToken } from '../repositories/invitaciones.js';
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
  if (!email || !password) {
    throw badRequest('email y password son obligatorios');
  }

  if (password.length < 6) {
    throw badRequest('la contraseña debe tener al menos 6 caracteres');
  }

  const existente = await getUsuarioPorEmail(email);

  if (existente) {
    throw Object.assign(
      new Error('Ya existe una cuenta con ese email'),
      { status: 409 }
    );
  }

  const password_hash = await bcrypt.hash(password, 10);

  return crearUsuario({
    email,
    password_hash,
    nombre,
    rol: 'empleado',
    activo: 1,
    invitacion_completada: 1
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

export async function aceptarInvitacion({ token, password, nombre }) {
  if (!token || !password) {
    throw badRequest('token y password son obligatorios');
  }

  if (password.length < 6) {
    throw badRequest('la contraseña debe tener al menos 6 caracteres');
  }

  const tokenHash = hashToken(token);
  const passwordHash = await bcrypt.hash(password, 10);

  const client = await pool.connect();

  let uId;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM invitaciones WHERE token_hash=$1 FOR UPDATE',
      [tokenHash]
    );

    const inv = rows[0];

    if (!inv) {
      throw Object.assign(
        new Error('Invitación no válida'),
        { status: 404 }
      );
    }

    if (inv.estado !== 'pendiente') {
      throw Object.assign(
        new Error('Invitación ya utilizada o revocada'),
        { status: 410 }
      );
    }

    if (new Date(inv.expira_en) < new Date()) {
      throw Object.assign(
        new Error('Invitación vencida'),
        { status: 410 }
      );
    }

    const email = inv.email.toLowerCase().trim();

    const existente = await client.query(
      'SELECT id FROM usuarios WHERE email=$1',
      [email]
    );

    if (existente.rows.length) {
      throw Object.assign(
        new Error('Ya existe una cuenta con ese email'),
        { status: 409 }
      );
    }

    const negocios = JSON.parse(inv.negocios || '[]');

    if (!negocios.length) {
      throw badRequest('La invitación no tiene negocios asignados');
    }

    uId = randomUUID();

    await client.query(
      `
      INSERT INTO usuarios (
        id,
        email,
        password_hash,
        nombre,
        rol,
        activo,
        invitacion_completada
      )
      VALUES ($1,$2,$3,$4,'empleado',1,1)
      `,
      [
        uId,
        email,
        passwordHash,
        nombre || inv.nombre || null
      ]
    );

    for (const a of negocios) {
      await client.query(
        `
        INSERT INTO usuario_negocio (
          usuario_id,
          negocio_id,
          permisos,
          activo
        )
        VALUES ($1,$2,$3,1)
        ON CONFLICT(usuario_id,negocio_id)
        DO UPDATE SET
          permisos = EXCLUDED.permisos,
          activo = 1
        `,
        [
          uId,
          a.negocio_id,
          JSON.stringify(a.permisos || {})
        ]
      );
    }

    const used = await client.query(
      `
      UPDATE invitaciones
      SET
        estado='usada',
        usada_en=$1,
        usada_por=$2
      WHERE id=$3
        AND estado='pendiente'
      RETURNING id
      `,
      [
        new Date().toISOString(),
        uId,
        inv.id
      ]
    );

    if (used.rowCount !== 1) {
      throw Object.assign(
        new Error('Invitación ya utilizada'),
        { status: 409 }
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const usuario = await getUsuarioById(uId);

  return {
    usuario,
    token: firmarToken(usuario)
  };
}
