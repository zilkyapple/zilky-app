import { randomBytes } from 'node:crypto';
import { db } from '../db/connection.js';
import { id as nuevoId } from '../lib/id.js';
// Repositorio de la plataforma: siempre con nombres calificados (public.),
// porque también se llama desde dentro del esquema de una cuenta.
export function nuevoEsquema() { return 't_' + randomBytes(10).toString('hex'); }
const CAMPOS = 'id,esquema,nombre,negocio_nombre,email,telefono,estado,mp_preapproval_id,mp_estado,mp_init_point,primer_pago_en,ultimo_pago_en,rechazo_desde,creada_en,actualizada_en';
export async function insertarCuenta({ esquema, nombre, negocio_nombre, email, telefono, estado }) {
  const id = nuevoId();
  const { rows } = await db.query(`INSERT INTO public.plataforma_cuentas (id,esquema,nombre,negocio_nombre,email,telefono,estado) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CAMPOS}`,
    [id, esquema, nombre, negocio_nombre, email, telefono || null, estado]);
  return rows[0];
}
export async function cuentaPorEsquema(esquema) {
  return (await db.query(`SELECT ${CAMPOS} FROM public.plataforma_cuentas WHERE esquema=$1`, [esquema])).rows[0] || null;
}
export async function cuentaPorId(id) {
  return (await db.query(`SELECT ${CAMPOS} FROM public.plataforma_cuentas WHERE id=$1`, [id])).rows[0] || null;
}
export async function cuentaPorPreapproval(preapprovalId) {
  return (await db.query(`SELECT ${CAMPOS} FROM public.plataforma_cuentas WHERE mp_preapproval_id=$1`, [preapprovalId])).rows[0] || null;
}
export async function listarCuentas() {
  return (await db.query(`SELECT ${CAMPOS} FROM public.plataforma_cuentas ORDER BY creada_en DESC`)).rows;
}
const EDITABLES = ['estado','mp_preapproval_id','mp_estado','mp_init_point','primer_pago_en','ultimo_pago_en','rechazo_desde'];
export async function actualizarCuenta(id, cambios) {
  const claves = Object.keys(cambios).filter(k => EDITABLES.includes(k));
  if (!claves.length) return cuentaPorId(id);
  const sets = claves.map((k, i) => `${k}=$${i + 2}`).join(',');
  const { rows } = await db.query(`UPDATE public.plataforma_cuentas SET ${sets}, actualizada_en=now() WHERE id=$1 RETURNING ${CAMPOS}`, [id, ...claves.map(k => cambios[k])]);
  return rows[0] || null;
}
export async function esquemaPorEmail(email) {
  return (await db.query('SELECT esquema FROM public.plataforma_directorio WHERE email=$1', [String(email||'').toLowerCase().trim()])).rows[0]?.esquema || null;
}
export async function esquemaPorInvitacion(tokenHash) {
  return (await db.query('SELECT esquema FROM public.plataforma_invitaciones WHERE token_hash=$1', [tokenHash])).rows[0]?.esquema || null;
}
export async function funcionesHabilitadas() {
  const { rows } = await db.query('SELECT clave FROM public.plataforma_funciones WHERE habilitada');
  return rows.map(r => r.clave);
}
export async function fijarFuncion(clave, habilitada) {
  await db.query(`INSERT INTO public.plataforma_funciones (clave,habilitada) VALUES ($1,$2)
    ON CONFLICT (clave) DO UPDATE SET habilitada=EXCLUDED.habilitada, actualizada_en=now()`, [clave, !!habilitada]);
}
