import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { calcularMora } from '../mora.js';
import { diffDays } from '../dates.js';

// Preparación pura: no envía, no agenda, no escribe datos ni autoriza un envío.
export function previsualizarContacto({ contacto, cuota, cliente, negocio, gestion, hoy }) {
  if (contacto.cliente_id !== cliente.id || contacto.negocio_id !== negocio.id ||
      contacto.cuota_id !== cuota.id || cuota.cliente_id !== cliente.id || cuota.negocio_id !== negocio.id)
    throw new Error('Contacto fuera del cliente o negocio');
  const motivos = [];
  const modo = gestion?.modo || 'revisar';
  if (contacto.estado !== 'pendiente') motivos.push('contacto_cerrado');
  if (contacto.fecha_contacto > hoy) motivos.push('contacto_reprogramado_o_futuro');
  if (gestion?.activo === 0 || modo === 'pausada') motivos.push('cobranza_pausada');
  if (gestion?.gestion_especial === 1) motivos.push('gestion_especial_manual');
  if (modo !== 'automatico') motivos.push('requiere_revision');
  const mora = calcularMora(cuota, negocio, hoy).pendiente;
  const capital = cuota.estado_manual ? 0 : Math.max(0, cuota.saldo_pendiente_centavos);
  const importe = capital + mora;
  if (!Number.isSafeInteger(importe) || importe < 0) throw new Error('Importe inválido');
  if (!importe) motivos.push('cuota_saldada');
  // No adivinar país ni agregar prefijos a teléfonos locales.
  const telefono = String(cliente.whatsapp || cliente.telefono || '').trim().replace(/[ ()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(telefono)) motivos.push('telefono_internacional_pendiente');
  const dias = diffDays(cuota.fecha_vencimiento, hoy);
  const fecha = cuota.fecha_vencimiento.split('-').reverse().join('/');
  const monto = '$' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(importe / 100);
  let mensaje = null;
  if (importe > 0) {
    const detalle = dias > 0
      ? `Te recordamos que tu cuota vence el ${fecha} (en ${dias} día${dias === 1 ? '' : 's'}). El importe de esa cuota es ${monto}.`
      : `Tenés un saldo pendiente de ${monto}, correspondiente a tu cuota ${dias < 0 ? 'vencida' : 'con vencimiento hoy'}.`;
    mensaje = `${cliente.nombre}, cómo estás?\n${detalle}\nMantenenos al tanto.`;
  }
  // Huella de revisión; NO es una garantía de idempotencia del proveedor.
  const version = createHash('sha256').update(JSON.stringify([
    contacto.id, contacto.estado, contacto.fecha_contacto, contacto.reprogramado_fecha,
    contacto.nota, cliente.id, negocio.id, cuota.id, cuota.fecha_vencimiento,
    telefono, capital, mora, mensaje, modo, gestion?.activo ?? 1, gestion?.gestion_especial ?? 0, hoy,
  ])).digest('hex');
  return { contacto_id: contacto.id, cuota_id: cuota.id, numero: cuota.numero,
    fecha_contacto: contacto.fecha_contacto, fecha_vencimiento: cuota.fecha_vencimiento,
    modo, estado_contacto: contacto.estado, importe_cuota_centavos: importe,
    importe_exigible_centavos: dias <= 0 ? importe : 0, mensaje, version,
    envio_habilitado: false, motivos: [...motivos, 'integracion_no_activada'] };
}

export function verificarFirma(rawBody, firma, secreto) {
  if (!Buffer.isBuffer(rawBody) || typeof secreto !== 'string' || !secreto ||
      typeof firma !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(firma)) return false;
  const esperada = createHmac('sha256', secreto).update(rawBody).digest();
  return timingSafeEqual(esperada, Buffer.from(firma.slice(7), 'hex'));
}

// Una notificación atrasada jamás revierte una entrega/lectura confirmada.
export function estadoEntrega(actual, evento) {
  const orden = { preparado: 0, incierto: 1, aceptado: 2, sent: 3, delivered: 4, read: 5 };
  if (!['sent', 'delivered', 'read', 'failed'].includes(evento)) return actual;
  if (!(actual in orden) && actual !== 'failed') return actual;
  if (evento === 'failed') return ['delivered', 'read'].includes(actual) ? actual : 'failed';
  if (actual === 'failed') return ['delivered', 'read'].includes(evento) ? evento : actual;
  return orden[evento] > orden[actual] ? evento : actual;
}
