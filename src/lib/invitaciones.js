import { db } from '../db/connection.js';
import { badRequest } from './validation.js';
import { hashToken } from '../repositories/invitaciones.js';

export function normalizarEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw badRequest('Email inválido');
  return email.trim().toLowerCase();
}
export function validarNombre(nombre) {
  if (nombre != null && (typeof nombre !== 'string' || nombre.length > 200)) throw badRequest('Nombre inválido');
}
export function validarPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password, 'utf8') > 72) throw badRequest('La contraseña debe tener al menos 6 caracteres y hasta 72 bytes');
}
// Todas las operaciones sobre una cuenta/invitación usan el mismo orden de bloqueos.
// Debe ejecutarse dentro de db.transaction (bloqueo liberado al commit/rollback).
export async function bloquearEmail(email) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['invitacion:' + normalizarEmail(email)]);
}
export const emailDuplicado = () => Object.assign(new Error('Ya existe una cuenta con ese email'), { status: 409 });
export function estadoInvitacion(inv) {
  return inv.estado === 'pendiente' && !(new Date(inv.expira_en).getTime() > Date.now()) ? 'vencida' : inv.estado;
}
export function validarVigencia(inv) {
  if (!inv) throw Object.assign(new Error('Invitación no válida'), { status: 404 });
  const estado = estadoInvitacion(inv);
  if (estado !== 'pendiente') throw Object.assign(new Error(`Invitación ${estado === 'usada' ? 'ya utilizada' : estado === 'revocada' ? 'revocada' : 'vencida'}. Solicitá una nueva al administrador.`), { status: 410 });
}
export function asignacionesInvitacion(inv) {
  let negocios;
  try { negocios = typeof inv.negocios === 'string' ? JSON.parse(inv.negocios) : inv.negocios; } catch { throw badRequest('Asignaciones de invitación inválidas'); }
  if (!Array.isArray(negocios) || !negocios.length) throw badRequest('La invitación debe tener al menos un negocio');
  return negocios;
}
export function invitacionPublica(inv) {
  const { token, token_hash, ...result } = inv;
  return { ...result, estado: estadoInvitacion(inv) };
}
export async function buscarInvitacion(token, bloquear = false) {
  if (typeof token !== 'string' || !token.length || token.length > 512) throw badRequest('Token de invitación inválido');
  const hash = hashToken(token);
  let inv = await db.prepare('SELECT * FROM invitaciones WHERE token_hash=?').get(hash);
  if (bloquear && inv) {
    await bloquearEmail(inv.email);
    inv = await db.prepare('SELECT * FROM invitaciones WHERE token_hash=? FOR UPDATE').get(hash);
  }
  validarVigencia(inv);
  return inv;
}
