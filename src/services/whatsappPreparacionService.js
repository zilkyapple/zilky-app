import { db } from '../db/connection.js';
import { todayAR } from '../lib/dates.js';
import { previsualizarContacto } from '../lib/whatsapp/preparacion.js';

export async function prepararWhatsApp(clienteId, negocioId) {
  // Snapshot consistente de solo lectura: no altera saldos ni confirma contactos.
  const { rows } = await db.query(`SELECT row_to_json(r) contacto, row_to_json(cu) cuota,
    row_to_json(cl) cliente, row_to_json(n) negocio, row_to_json(g) gestion
    FROM cliente_negocio cn JOIN clientes cl ON cl.id=cn.cliente_id
    JOIN negocios n ON n.id=cn.negocio_id
    LEFT JOIN cliente_negocio_cobranza g ON g.cliente_id=cn.cliente_id AND g.negocio_id=cn.negocio_id
    LEFT JOIN recordatorios r ON r.cliente_id=cn.cliente_id AND r.negocio_id=cn.negocio_id
    LEFT JOIN creditos cr ON cr.id=r.credito_id AND cr.cliente_id=cn.cliente_id AND cr.negocio_id=cn.negocio_id
    LEFT JOIN cuotas cu ON cu.id=r.cuota_id AND cu.credito_id=cr.id
    WHERE cn.cliente_id=$1 AND cn.negocio_id=$2 ORDER BY r.fecha_contacto,r.id`, [clienteId, negocioId]);
  if (!rows.length) throw Object.assign(new Error('Cliente no encontrado en este negocio'), { status: 404 });
  const hoy = todayAR();
  return { envio_habilitado: false, fecha: hoy, contactos: rows.filter(r => r.contacto && r.cuota).map(r =>
    previsualizarContacto({ ...r, cuota: { ...r.cuota, cliente_id: clienteId, negocio_id: negocioId }, hoy })) };
}
