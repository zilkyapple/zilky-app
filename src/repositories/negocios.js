import { db } from '../db/connection.js';
import { id } from '../lib/id.js';

export async function crearNegocio(data) {
  const negId = id();
  await db.prepare(`
    INSERT INTO negocios (id, nombre, color, logo_url, dias_gracia, mora_tipo, mora_valor, mora_periodo, mora_base, mora_acumulativa, orden_aplicacion_pago)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    negId,
    data.nombre,
    data.color || '#10B981',
    data.logo_url || null,
    data.dias_gracia ?? 7,
    data.mora_tipo || 'porcentaje',
    data.mora_valor ?? 2,
    data.mora_periodo || 'semana',
    data.mora_base || 'saldo_vencido',
    data.mora_acumulativa ? 1 : 0,
    JSON.stringify(data.orden_aplicacion_pago || ['mora', 'capital'])
  );
  return getNegocio(negId);
}

export async function getNegocio(negId) {
  return db.prepare('SELECT * FROM negocios WHERE id = ?').get(negId);
}

export async function listNegocios() {
  return db.prepare('SELECT * FROM negocios ORDER BY created_at ASC').all();
}

export async function actualizarNegocio(negId, data) {
  const actual = await getNegocio(negId);
  if (!actual) return null;
  const merged = { ...actual, ...data };
  await db.prepare(`
    UPDATE negocios SET nombre=?, color=?, logo_url=?, dias_gracia=?, mora_tipo=?, mora_valor=?, mora_periodo=?, mora_base=?, mora_acumulativa=?, orden_aplicacion_pago=?
    WHERE id=?
  `).run(
    merged.nombre, merged.color, merged.logo_url, merged.dias_gracia, merged.mora_tipo,
    merged.mora_valor, merged.mora_periodo, merged.mora_base,
    merged.mora_acumulativa ? 1 : 0,
    typeof merged.orden_aplicacion_pago === 'string' ? merged.orden_aplicacion_pago : JSON.stringify(merged.orden_aplicacion_pago),
    negId
  );
  return getNegocio(negId);
}
