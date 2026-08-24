import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { randomBytes, createHash } from 'node:crypto';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function crearInvitacion({ email, nombre, organizacion_id, negocios, creado_por }) {
  const invId = id();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expira = new Date();
  expira.setDate(expira.getDate() + 7);
  await db.prepare(`
    INSERT INTO invitaciones (id, token_hash, email, nombre, organizacion_id, negocios, expira_en, creado_por)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(invId, tokenHash, email.toLowerCase().trim(), nombre || null, organizacion_id || null,
    JSON.stringify(negocios || []), expira.toISOString(), creado_por || null);
  return { invitacion: await getInvitacion(invId), token };
}

export async function getInvitacion(invId) {
  return db.prepare('SELECT * FROM invitaciones WHERE id = ?').get(invId);
}
export async function getInvitacionPorToken(token) {
  return db.prepare('SELECT * FROM invitaciones WHERE token_hash = ?').get(hashToken(token));
}
export async function listInvitaciones() {
  return db.prepare('SELECT * FROM invitaciones ORDER BY creado_en DESC').all();
}
export async function revocarInvitacion(invId, revocadaPor) {
  await db.prepare(`UPDATE invitaciones SET estado='revocada', revocada_en=?, revocada_por=? WHERE id=? AND estado='pendiente'`)
    .run(new Date().toISOString(), revocadaPor || null, invId);
  return getInvitacion(invId);
}
export async function invalidarInvitacionesAnteriores(email, exceptoTokenHash) {
  await db.prepare(`UPDATE invitaciones SET estado='revocada', revocada_en=? WHERE email=? AND token_hash<>? AND estado='pendiente'`)
    .run(new Date().toISOString(), email.toLowerCase().trim(), exceptoTokenHash);
}
export async function limpiarInvitacionesVencidas() {
  await db.prepare(`UPDATE invitaciones SET estado='vencida' WHERE estado='pendiente' AND expira_en < ?`)
    .run(new Date().toISOString());
}
