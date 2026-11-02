import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { integer, text } from '../lib/validation.js';
import { fail, huella, solicitudId } from '../lib/solicitud.js';
import { auditar } from '../lib/audit.js';
import { nowAR } from '../lib/dates.js';
import { normalizarFechaPago, fechaPagoAR } from '../lib/replayPagos.js';
import { resumenCobrosPedido } from '../lib/tiendaCobros.js';
import { crearCliente } from '../repositories/clientes.js';
import { crearPago, getPago, anularPago } from '../repositories/pagos.js';
import { crearComprobante, getComprobante, anularComprobanteRow } from '../repositories/comprobantes.js';
import { detallePedidoTienda } from './tiendaPedidosService.js';

function objeto(value, campos) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !campos.includes(k))) throw fail('Solicitud de cobro inválida');
}
function validarComun(n, input, campos) {
  objeto(input, ['negocio_id', 'solicitud_id', 'version', ...campos]);
  if (input.negocio_id !== undefined && input.negocio_id !== n) throw fail('El negocio no coincide con el pedido');
  solicitudId(input.solicitud_id);
  if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw fail('Volvé a revisar el pedido antes de continuar');
}
async function bloquearSolicitud(n, solicitud) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['tienda-cobro:' + n + ':' + solicitud]);
}
async function pedidoBloqueado(n, pedidoId) {
  const pedido = await db.prepare('SELECT * FROM tienda_pedidos WHERE id=? AND negocio_id=? FOR UPDATE').get(pedidoId, n);
  if (!pedido) throw fail('Pedido no encontrado en este negocio', 404);
  return pedido;
}
async function solicitudPrevia(n, pedidoId, input, actor, requestHash) {
  const cobro = await db.prepare('SELECT * FROM tienda_pedido_cobros WHERE negocio_id=? AND solicitud_id=?').get(n, input.solicitud_id);
  if (cobro) {
    if (cobro.pedido_id !== pedidoId || cobro.usuario_id !== actor || cobro.request_hash !== requestHash) throw fail('La solicitud ya se utilizó con otros datos', 409);
    return true;
  }
  const audit = await db.prepare(`SELECT * FROM auditoria WHERE entidad='tienda_pedido' AND accion='anular_cobro'
    AND datos_nuevos::jsonb->>'negocio_id'=? AND datos_nuevos::jsonb->>'solicitud_id'=? LIMIT 1`).get(n, input.solicitud_id);
  if (!audit) return false;
  if (audit.entidad_id !== pedidoId || audit.empleado !== actor || JSON.parse(audit.datos_nuevos).requestHash !== requestHash) throw fail('La solicitud ya se utilizó con otros datos', 409);
  return true;
}
async function clienteParaCobro(pedido, input, actor) {
  if (pedido.cliente_id) {
    if (input.cliente_id && input.cliente_id !== pedido.cliente_id) throw fail('El pedido ya tiene un cliente asociado', 409);
    const cliente = await db.prepare('SELECT c.id FROM clientes c JOIN cliente_negocio cn ON cn.cliente_id=c.id WHERE c.id=? AND cn.negocio_id=? AND c.consumidor_final_negocio IS NULL').get(pedido.cliente_id, pedido.negocio_id);
    if (!cliente) throw fail('El cliente del pedido requiere conciliación', 409);
    return cliente.id;
  }
  let cliente;
  if (input.cliente_id) {
    cliente = await db.prepare('SELECT c.id FROM clientes c JOIN cliente_negocio cn ON cn.cliente_id=c.id WHERE c.id=? AND cn.negocio_id=? AND c.consumidor_final_negocio IS NULL').get(input.cliente_id, pedido.negocio_id);
    if (!cliente) throw fail('Cliente no encontrado en este negocio', 403);
  } else {
    const contacto = pedido.contacto;
    if (!contacto || typeof contacto.nombre !== 'string' || typeof contacto.apellido !== 'string' || typeof contacto.telefono !== 'string') throw fail('El contacto del pedido requiere revisión', 409);
    cliente = await crearCliente({ nombre: text(contacto.nombre, 'Nombre', 100), apellido: text(contacto.apellido, 'Apellido', 100),
      telefono: text(contacto.telefono, 'Teléfono', 60), negocio_id: pedido.negocio_id,
      notas: 'Cliente creado al registrar un cobro del pedido web ' + pedido.codigo + '.' });
    await auditar('cliente', cliente.id, 'crear_desde_pedido_web', null, { cliente, negocio_id: pedido.negocio_id, pedido_id: pedido.id }, actor);
  }
  await db.prepare('UPDATE tienda_pedidos SET cliente_id=? WHERE id=? AND negocio_id=?').run(cliente.id, pedido.id, pedido.negocio_id);
  return cliente.id;
}
export async function registrarCobroPedido(n, pedidoId, input, actor) {
  validarComun(n, input, ['monto_centavos', 'medio_pago', 'fecha_hora', 'nota', 'cliente_id']);
  integer(input.monto_centavos, 'Importe del cobro', { min: 1 });
  if (!['efectivo', 'transferencia'].includes(input.medio_pago)) throw fail('Elegí efectivo o transferencia');
  if (input.fecha_hora !== undefined && typeof input.fecha_hora !== 'string') throw fail('Fecha y hora del pago inválidas');
  if (input.cliente_id !== undefined && (typeof input.cliente_id !== 'string' || !input.cliente_id)) throw fail('Cliente inválido');
  const nota = input.nota === undefined || input.nota === '' ? null : text(input.nota, 'Nota', 1000);
  const requestHash = huella({ accion: 'cobrar', negocio_id: n, pedidoId, input });
  return db.transaction(async () => {
    await bloquearSolicitud(n, input.solicitud_id);
    if (await solicitudPrevia(n, pedidoId, input, actor, requestHash)) return detallePedidoTienda(n, pedidoId);
    const pedido = await pedidoBloqueado(n, pedidoId);
    const antes = await detallePedidoTienda(n, pedidoId);
    if (antes.version !== input.version) throw fail('El pedido o sus cobros cambiaron. Volvé a revisar antes de continuar.', 409);
    if (pedido.estado !== 'confirmado') throw fail('Sólo se pueden registrar cobros de pedidos confirmados', 409);
    const fecha = normalizarFechaPago(input.fecha_hora ?? new Date().toISOString());
    const instante = Date.parse(fecha), creacion = fechaPagoAR(pedido.created_at);
    if (fecha.slice(0, 10) < creacion) throw fail('El cobro no puede ser anterior al día de creación del pedido');
    if (instante > Date.now()) throw fail('No se pueden registrar cobros futuros');
    const { resumen_cobros: resumen } = await resumenCobrosPedido(pedido);
    if (input.monto_centavos > resumen.saldo_centavos) throw fail('El importe supera el saldo pendiente del pedido', 409);
    const clienteId = await clienteParaCobro(pedido, input, actor);
    // This order lock also serializes confirmation/cancellation. All money paths
    // then take the same customer-before-cash locks as ordinary receipts.
    await db.lockClienteNegocio(clienteId, n);
    const saldo = resumen.saldo_centavos - input.monto_centavos;
    const pago = await crearPago({ negocio_id: n, cliente_id: clienteId, credito_id: null, tipo: 'pedido_web',
      monto_centavos: input.monto_centavos, medio_pago: input.medio_pago, fecha_hora: fecha, nota,
      saldo_anterior_centavos: resumen.saldo_centavos, saldo_posterior_centavos: saldo, usuario_id: actor });
    const comprobante = await crearComprobante({ pago_id: pago.id, negocio_id: n, cliente_id: clienteId,
      venta_id: null, credito_id: null, monto_centavos: pago.monto_centavos, medio_pago: pago.medio_pago,
      fecha_hora: pago.fecha_hora, saldo_restante_centavos: saldo, usuario_id: actor });
    const cobroId = id();
    await db.prepare(`INSERT INTO tienda_pedido_cobros(id,negocio_id,pedido_id,pago_id,comprobante_id,solicitud_id,request_hash,usuario_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(cobroId, n, pedidoId, pago.id, comprobante.id, input.solicitud_id, requestHash, actor);
    await auditar('pago', pago.id, 'crear_pedido_web', null, { pago, comprobante_id: comprobante.id, pedido_id: pedidoId, cobro_id: cobroId }, actor, nota);
    const despues = await detallePedidoTienda(n, pedidoId);
    await auditar('tienda_pedido', pedidoId, 'registrar_cobro', antes, { negocio_id: n, solicitud_id: input.solicitud_id, requestHash, cobro_id: cobroId, despues }, actor, nota);
    return despues;
  });
}
export async function anularCobroPedido(n, pedidoId, cobroId, input, actor) {
  validarComun(n, input, ['motivo']);
  const motivo = text(input.motivo, 'Motivo de anulación', 1000);
  const requestHash = huella({ accion: 'anular', negocio_id: n, pedidoId, cobroId, input });
  return db.transaction(async () => {
    await bloquearSolicitud(n, input.solicitud_id);
    if (await solicitudPrevia(n, pedidoId, input, actor, requestHash)) return detallePedidoTienda(n, pedidoId);
    await pedidoBloqueado(n, pedidoId);
    const antes = await detallePedidoTienda(n, pedidoId);
    if (antes.version !== input.version) throw fail('El pedido o sus cobros cambiaron. Volvé a revisar antes de continuar.', 409);
    const enlace = await db.prepare('SELECT * FROM tienda_pedido_cobros WHERE id=? AND pedido_id=? AND negocio_id=?').get(cobroId, pedidoId, n);
    if (!enlace) throw fail('Cobro no encontrado en este pedido', 404);
    const inicial = await getPago(enlace.pago_id);
    if (!inicial || inicial.tipo !== 'pedido_web' || inicial.credito_id || inicial.negocio_id !== n) throw fail('El cobro requiere conciliación', 409);
    await db.lockClienteNegocio(inicial.cliente_id, n);
    await db.prepare('SELECT id FROM pagos WHERE id=? FOR UPDATE').get(inicial.id);
    await db.prepare('SELECT id FROM comprobantes WHERE id=? FOR UPDATE').get(enlace.comprobante_id);
    const pago = await getPago(inicial.id), comprobante = await getComprobante(enlace.comprobante_id);
    if (!comprobante || comprobante.pago_id !== pago.id || comprobante.negocio_id !== n) throw fail('El comprobante requiere conciliación', 409);
    if (pago.anulado || comprobante.estado === 'anulado') throw fail('El cobro ya estaba anulado', 409);
    await anularPago(pago.id, motivo, actor);
    await anularComprobanteRow(comprobante.id, { motivo, usuarioId: actor, fecha: nowAR() });
    await auditar('pago', pago.id, 'anular_pedido_web', pago, await getPago(pago.id), actor, motivo);
    const despues = await detallePedidoTienda(n, pedidoId);
    await auditar('tienda_pedido', pedidoId, 'anular_cobro', antes, { negocio_id: n, solicitud_id: input.solicitud_id, requestHash, cobro_id: cobroId, despues }, actor, motivo);
    return despues;
  });
}
