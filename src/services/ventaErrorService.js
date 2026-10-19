import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { auditar } from '../lib/audit.js';
import { text } from '../lib/validation.js';
import { fail, huella, solicitudId } from '../lib/solicitud.js';
import { nowAR, todayAR } from '../lib/dates.js';
import { calcularMora } from '../lib/mora.js';
import { anularPago, sumarSaldoFavor } from '../repositories/pagos.js';
import { anularComprobanteRow } from '../repositories/comprobantes.js';
import { generarComision, lockComisiones } from './comisionCierresService.js';
import { sincronizarComision } from './comisionesService.js';
import { recalcularEstadoCredito } from './pagosService.js';

const accion = 'eliminar_error_carga';
const parse = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const suma = values => {
  const total = values.reduce((a, b) => a + b, 0);
  if (values.some(v => !Number.isSafeInteger(v)) || !Number.isSafeInteger(total)) throw fail('Los importes requieren conciliación: están fuera de rango.', 409);
  return total;
};

async function cargar(n, v, bloquearProductos = false) {
  const venta = await db.prepare('SELECT * FROM ventas WHERE id=? AND negocio_id=?').get(v, n);
  if (!venta) throw fail('Venta no encontrada', 404);
  const credito = await db.prepare('SELECT * FROM creditos WHERE venta_id=?').get(v);
  if (!credito || credito.negocio_id !== n || credito.cliente_id !== venta.cliente_id) throw fail('La venta no tiene una financiación conciliable.', 409);
  const negocio = await db.prepare('SELECT * FROM negocios WHERE id=?' + (bloquearProductos ? ' FOR SHARE' : '')).get(n);
  const items = await db.prepare('SELECT * FROM venta_detalle WHERE venta_id=? ORDER BY id').all(v);
  const cuotas = await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY numero,id').all(credito.id);
  const pagos = await db.prepare('SELECT * FROM pagos WHERE credito_id=? ORDER BY id').all(credito.id);
  const aplicaciones = await db.prepare('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(credito.id);
  const comprobantes = await db.prepare('SELECT * FROM comprobantes WHERE credito_id=? OR venta_id=? ORDER BY id').all(credito.id, v);
  const contactos = await db.prepare('SELECT * FROM recordatorios WHERE credito_id=? ORDER BY id').all(credito.id);
  const devoluciones = await db.prepare('SELECT * FROM venta_devoluciones WHERE venta_id=? ORDER BY id').all(v);
  const historialStock = await db.prepare('SELECT * FROM producto_historial WHERE venta_id=? ORDER BY producto_id,id').all(v);
  const ids = new Set(historialStock.map(h => h.producto_id));
  for (const item of items) {
    const componentes = parse(item.componentes);
    if (Array.isArray(componentes) && componentes.length) componentes.forEach(c => ids.add(c.producto_id));
    else if (item.producto_id) ids.add(item.producto_id);
  }
  const productos = [];
  for (const productoId of [...ids].filter(Boolean).sort()) {
    const producto = await db.prepare('SELECT * FROM productos WHERE id=?' + (bloquearProductos ? ' FOR UPDATE' : '')).get(productoId);
    productos.push(producto || { id: productoId, inexistente: true });
  }
  const saldoFavor = await db.prepare('SELECT * FROM saldo_favor WHERE cliente_id=? AND negocio_id=?').get(venta.cliente_id, n);
  const acuerdo = await db.prepare('SELECT * FROM comision_acuerdos WHERE venta_id=?').get(v);
  const eventos = acuerdo ? await db.prepare('SELECT * FROM comision_eventos WHERE acuerdo_id=? ORDER BY id').all(acuerdo.id) : [];
  const generaciones = acuerdo ? await db.prepare('SELECT * FROM comision_generaciones WHERE acuerdo_id=? ORDER BY id').all(acuerdo.id) : [];
  const ajustes = acuerdo ? await db.prepare('SELECT * FROM comision_ajustes WHERE acuerdo_id=? ORDER BY id').all(acuerdo.id) : [];
  const cierres = acuerdo ? await db.prepare('SELECT * FROM comision_cierres WHERE negocio_id=? AND usuario_id=? ORDER BY id').all(n, acuerdo.usuario_id) : [];
  const liquidaciones = acuerdo ? await db.prepare('SELECT * FROM comision_liquidaciones WHERE negocio_id=? AND usuario_id=? ORDER BY id').all(n, acuerdo.usuario_id) : [];
  const asientos = await db.prepare('SELECT a.* FROM caja_asientos a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=? ORDER BY a.id').all(credito.id);
  const cajas = await db.prepare('SELECT c.* FROM caja_config c WHERE c.id IN (SELECT caja_id FROM caja_negocios WHERE negocio_id=?) OR c.id IN (SELECT a.caja_id FROM caja_asientos a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=?) ORDER BY c.id').all(n, credito.id);
  const sesiones = await db.prepare('SELECT s.* FROM caja_sesiones s WHERE s.id IN (SELECT a.sesion_id FROM caja_asientos a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=?) ORDER BY s.id').all(credito.id);
  const auditoria = await db.prepare(`SELECT * FROM auditoria WHERE (entidad='venta' AND entidad_id=?) OR (entidad='credito' AND entidad_id=?)
    OR (entidad='pago' AND entidad_id IN (SELECT id FROM pagos WHERE credito_id=?))
    OR (entidad='cuota' AND entidad_id IN (SELECT id FROM cuotas WHERE credito_id=?)) ORDER BY id`).all(v, credito.id, credito.id, credito.id);
  const snapshot = { venta, credito, negocio, items, cuotas, pagos, aplicaciones, comprobantes, contactos, devoluciones, historialStock, productos,
    saldo_favor_centavos: saldoFavor?.monto_centavos || 0, comisiones: { acuerdo, eventos, generaciones, ajustes, cierres, liquidaciones }, caja: { asientos, cajas, sesiones } };
  return { ...snapshot, auditoria, version: huella({ ...snapshot, hoy: todayAR(), auditoria: auditoria.map(a => ({ id: a.id, hash: huella(a) })) }) };
}

function analizar(s) {
  const activos = s.pagos.filter(p => !p.anulado);
  const advertencias = ['La venta quedará anulada por error de carga. Se conservarán el registro original y el historial de la corrección.'];
  const cantidades = new Map();
  let motivo = null;
  const bloquear = texto => { motivo ||= texto; };
  if (s.venta.estado !== 'activa') bloquear('La venta ya fue anulada o tiene devoluciones. Requiere conciliación desde su historial.');
  if (s.devoluciones.length || Number(s.venta.devolucion_centavos) !== 0) bloquear('La venta tiene devoluciones previas. Requiere conciliación desde Devoluciones y anulaciones.');
  if (s.cuotas.some(q => q.estado_manual)) bloquear('Hay cuotas con estado manual. Requiere conciliación antes de eliminar la venta.');
  if (s.contactos.some(c => c.negocio_id !== s.venta.negocio_id || c.cliente_id !== s.venta.cliente_id)) bloquear('Hay contactos de cobranza vinculados a otro cliente o negocio. Requiere conciliación.');
  if (s.cuotas.some(q => q.mora_perdonada_centavos > 0)) bloquear('La financiación tiene mora perdonada. Requiere conciliación antes de eliminar la venta.');
  if (s.comisiones.acuerdo && s.comisiones.acuerdo.negocio_id !== s.venta.negocio_id) bloquear('La comisión está vinculada a otro negocio. Requiere conciliación.');
  if (s.comisiones.ajustes.length || s.comisiones.eventos.some(e => (e.tipo || 'devengo') !== 'devengo')) bloquear('La comisión tiene ajustes manuales. Requiere conciliación antes de eliminar la venta.');
  for (const evento of s.auditoria.filter(e => e.entidad === 'credito' && e.accion === 'corregir_financiacion')) {
    const antes = parse(evento.datos_anteriores), nuevo = parse(evento.datos_nuevos), despues = nuevo?.despues;
    const cambioImportes = ['monto_total_centavos', 'entrega_inicial_centavos'].some(k => antes?.credito?.[k] !== undefined && despues?.credito?.[k] !== undefined && antes.credito[k] !== despues.credito[k]);
    const habiaPagos = antes?.pagos?.length > 0 || s.pagos.some(p => Date.parse(p.created_at) <= Date.parse(evento.fecha_hora));
    if (cambioImportes && habiaPagos) bloquear('Los importes o la entrega inicial se corrigieron después de registrar pagos. Requiere conciliación antes de eliminar la venta.');
  }
  if (s.comprobantes.some(c => c.negocio_id !== s.venta.negocio_id || c.cliente_id !== s.venta.cliente_id || c.credito_id !== s.credito.id || (c.venta_id && c.venta_id !== s.venta.id) || !s.pagos.some(p => p.id === c.pago_id))) bloquear('Hay comprobantes vinculados de forma inconsistente. Requiere conciliación.');
  if (s.caja.asientos.some(a => a.negocio_id !== s.venta.negocio_id)) bloquear('Hay movimientos de caja vinculados a otro negocio. Requiere conciliación.');
  for (const h of s.historialStock) {
    if (h.tipo !== 'venta') { bloquear('La venta ya tiene ajustes o reposiciones de stock. Revisá el historial antes de eliminarla.'); continue; }
    const cantidad = h.stock_anterior - h.stock_nuevo;
    if (h.negocio_id !== s.venta.negocio_id || !Number.isSafeInteger(h.stock_anterior) || !Number.isSafeInteger(h.stock_nuevo) || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
      bloquear('Los movimientos originales de stock requieren conciliación.'); continue;
    }
    cantidades.set(h.producto_id, suma([cantidades.get(h.producto_id) || 0, cantidad]));
  }
  const productos = s.productos.map(p => {
    const descontada = cantidades.get(p.id) || 0;
    if (p.inexistente || p.negocio_id !== s.venta.negocio_id) bloquear('Hay productos inexistentes o de otro negocio. Requiere conciliación de stock.');
    const reponer = p.stock == null ? 0 : descontada;
    const stockDespues = p.stock == null ? null : p.stock + reponer;
    if (p.stock != null && (!Number.isSafeInteger(stockDespues) || stockDespues < -2147483648 || stockDespues > 2147483647)) bloquear('El stock resultante está fuera de rango y requiere conciliación.');
    if (p.stock == null) advertencias.push(`“${p.nombre || p.id}” no lleva control de stock; su stock no se modificará.`);
    else if (!descontada) advertencias.push(`No hay un descuento original de stock para “${p.nombre}”; se conservarán sus unidades actuales.`);
    return { id: p.id, nombre: p.nombre || 'Producto no disponible', cantidad_reponer: reponer, cantidad_descontada: descontada, stock_actual: p.stock ?? null, stock_despues: stockDespues };
  });
  if (!productos.length) advertencias.push('Esta venta no tiene movimientos de stock que reponer.');
  let remanente = 0;
  for (const p of activos) {
    if (!['cuota', 'entrega_inicial'].includes(p.tipo || 'cuota') || p.negocio_id !== s.venta.negocio_id || p.cliente_id !== s.venta.cliente_id || !Number.isSafeInteger(p.monto_centavos) || p.monto_centavos <= 0) bloquear('Los pagos de esta venta requieren conciliación.');
    const apps = s.aplicaciones.filter(a => a.pago_id === p.id);
    if (apps.some(a => !s.cuotas.some(q => q.id === a.cuota_id) || a.capital_centavos < 0 || a.interes_mora_centavos < 0)) bloquear('Hay aplicaciones de pagos ajenas al crédito o con importes inválidos.');
    const aplicado = suma(apps.map(a => a.capital_centavos + a.interes_mora_centavos));
    if (p.tipo === 'entrega_inicial') {
      if (aplicado !== 0) bloquear('La entrega inicial tiene aplicaciones a cuotas y requiere conciliación.');
    } else if (aplicado > p.monto_centavos) bloquear('Hay pagos con aplicaciones superiores a su importe. Requiere conciliación.');
    else remanente = suma([remanente, p.monto_centavos - aplicado]);
    const recibos = s.comprobantes.filter(c => c.pago_id === p.id && c.estado !== 'anulado');
    if (recibos.length !== 1 || recibos.some(c => c.monto_centavos !== p.monto_centavos || c.negocio_id !== p.negocio_id || c.cliente_id !== p.cliente_id || c.credito_id !== s.credito.id)) bloquear('Los comprobantes vigentes de los pagos requieren conciliación.');
    if (s.caja.asientos.some(a => a.pago_id === p.id && a.tipo !== 'cobro')) bloquear('Hay correcciones de caja previas para un pago activo. Requiere conciliación.');
    if (s.caja.asientos.some(a => a.pago_id === p.id && a.tipo === 'cobro' && a.monto !== p.monto_centavos)) bloquear('El movimiento original de caja no coincide con el pago. Requiere conciliación.');
  }
  for (const q of s.cuotas) {
    const apps = s.aplicaciones.filter(a => a.cuota_id === q.id && activos.some(p => p.id === a.pago_id));
    const capital = suma(apps.map(a => a.capital_centavos)), mora = suma(apps.map(a => a.interes_mora_centavos));
    if (q.saldo_pendiente_centavos !== q.monto_centavos - capital || (q.mora_pagada_centavos || 0) !== mora) bloquear('Los saldos de las cuotas no coinciden con los pagos. Requiere conciliación antes de eliminar la venta.');
  }
  if (suma(activos.filter(p => p.tipo === 'entrega_inicial').map(p => p.monto_centavos)) !== s.credito.entrega_inicial_centavos) bloquear('La entrega inicial no coincide con sus pagos vigentes. Requiere conciliación.');
  if (remanente > s.saldo_favor_centavos) bloquear('El saldo a favor generado por esta venta ya fue utilizado. Requiere conciliación antes de eliminarla.');
  if (activos.length) advertencias.push('Se anularán los pagos y comprobantes de esta venta porque confirmás que se cargaron por error. Esta acción no registra una devolución de dinero.');
  if (s.caja.asientos.some(a => activos.some(p => p.id === a.pago_id) && a.tipo === 'cobro')) advertencias.push('Los cierres de caja se conservarán. Se dejará un aviso de corrección documental para revisar si hubo un movimiento real de dinero.');
  if (remanente) advertencias.push('Se retirará únicamente el saldo a favor generado por los pagos erróneos de esta venta.');
  if (s.comisiones.acuerdo) advertencias.push('La comisión se revertirá con nuevos ajustes. Los cierres y pagos ya liquidados se conservarán.');
  return { activos, remanente, productos, advertencias, motivo };
}

export async function vistaVentaError(n, v) {
  const s = await cargar(n, v), a = analizar(s);
  return { venta: s.venta, credito: s.credito, version: s.version, productos: a.productos,
    pagos: a.activos.map(p => ({ id: p.id, tipo: p.tipo || 'cuota', monto_centavos: p.monto_centavos, fecha_hora: p.fecha_hora })),
    total_pagos_centavos: suma(a.activos.map(p => p.monto_centavos)), capital_pendiente_centavos: suma(s.cuotas.map(q => q.saldo_pendiente_centavos)),
    advertencias: a.advertencias, permitido: !a.motivo, motivo_bloqueo: a.motivo };
}

function snapshot(s) {
  const { version, auditoria, ...datos } = s;
  return datos;
}

async function correccionCaja(s, p, actor, motivo, solicitud) {
  const original = s.caja.asientos.find(a => a.pago_id === p.id && a.tipo === 'cobro');
  if (!original) return;
  await db.prepare(`INSERT INTO caja_asientos(id,caja_id,negocio_id,pago_id,tipo,monto,medio,concepto,actor,payload)
    VALUES(?,?,?,?,'correccion',?,?,?,?,?)`).run(id(), original.caja_id, p.negocio_id, p.id, -p.monto_centavos, original.medio,
    'Venta cargada por error: corrección documental sin devolución automática de dinero. ' + motivo, actor,
    JSON.stringify({ venta_id: s.venta.id, asiento_original_id: original.id, solicitud_id: solicitud }));
}

export async function eliminarVentaError(n, v, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Solicitud inválida');
  const permitidos = ['negocio_id', 'version', 'solicitud_id', 'motivo', 'confirmar', 'confirmar_pagos_erroneos'];
  if (Object.keys(input).some(k => !permitidos.includes(k))) throw fail('Campo no permitido para eliminar la venta');
  if (input.negocio_id !== undefined && input.negocio_id !== n) throw fail('El negocio no coincide con la venta');
  if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw fail('Falta una versión válida de la venta');
  solicitudId(input.solicitud_id);
  const motivo = text(input.motivo, 'motivo', 1000);
  if (input.confirmar !== true) throw fail('Confirmá que la venta se cargó por error');
  if (input.confirmar_pagos_erroneos !== undefined && typeof input.confirmar_pagos_erroneos !== 'boolean') throw fail('La confirmación de pagos erróneos es inválida');
  const requestHash = huella({ negocio_id: n, venta_id: v, version: input.version, motivo, confirmar: true, confirmar_pagos_erroneos: input.confirmar_pagos_erroneos === true });
  return db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['venta-error-solicitud:' + input.solicitud_id]);
    const inicial = await db.prepare('SELECT * FROM ventas WHERE id=? AND negocio_id=?').get(v, n);
    if (!inicial) throw fail('Venta no encontrada', 404);
    await db.lockClienteNegocio(inicial.cliente_id, n);
    await db.prepare('SELECT id FROM ventas WHERE id=? AND negocio_id=? FOR UPDATE').get(v, n);
    await db.prepare('SELECT id FROM creditos WHERE venta_id=? FOR UPDATE').get(v);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('zilky:caja',0))");
    await lockComisiones(n);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalogo:' + n]);
    const anterior = await db.prepare("SELECT entidad_id,empleado,datos_nuevos FROM auditoria WHERE entidad='venta' AND accion=? AND (datos_nuevos::jsonb->>'solicitud_id')=? LIMIT 1").get(accion, input.solicitud_id);
    if (anterior) {
      const datos = parse(anterior.datos_nuevos);
      if (anterior.entidad_id !== v || anterior.empleado !== actor || datos.requestHash !== requestHash) throw fail('La solicitud ya se usó con otros datos', 409);
      return { ...datos.resultado, reintentado: true };
    }
    const s = await cargar(n, v, true);
    if (s.version !== input.version) throw fail('La venta, los pagos o el stock cambiaron. Volvé a revisar la eliminación.', 409);
    const a = analizar(s);
    if (a.motivo) throw fail(a.motivo, 409);
    if (a.activos.length && input.confirmar_pagos_erroneos !== true) throw fail('Confirmá que los pagos de esta venta también se cargaron por error');
    const razon = 'Venta cargada por error: ' + motivo;
    if (a.remanente) await sumarSaldoFavor(s.venta.cliente_id, n, -a.remanente);
    await db.prepare("UPDATE ventas SET estado='anulada',devolucion_centavos=monto_total_centavos WHERE id=?").run(v);
    // Repo anularPago conserva su integración con comisiones. Su aviso habitual
    // de devolución de efectivo se sustituye por una corrección documental.
    const previoCaja = (await db.query("SELECT current_setting('zilky.correccion_financiacion',true) valor")).rows[0].valor;
    await db.query("SELECT set_config('zilky.correccion_financiacion','1',true)");
    for (const p of a.activos) {
      const despues = await anularPago(p.id, razon, actor);
      await auditar('pago', p.id, 'anular_error_carga', p, despues, actor, motivo);
    }
    await db.query("SELECT set_config('zilky.correccion_financiacion',$1,true)", [previoCaja || '']);
    for (const p of a.activos) await correccionCaja(s, p, actor, motivo, input.solicitud_id);
    for (const c of s.comprobantes.filter(c => c.estado !== 'anulado')) await anularComprobanteRow(c.id, { motivo: razon, usuarioId: actor, fecha: nowAR() });
    for (const q of s.cuotas) {
      const mora = calcularMora(q, s.negocio, todayAR()).acumulada;
      await db.prepare("UPDATE cuotas SET saldo_pendiente_centavos=0,mora_pagada_centavos=0,mora_generada_centavos=?,mora_perdonada_centavos=?,estado_manual='anulada',fecha_saldada=NULL,dias_atraso_al_pagar=NULL WHERE id=? AND credito_id=?").run(mora, mora, q.id, s.credito.id);
    }
    for (const p of a.productos.filter(p => p.cantidad_reponer > 0)) {
      await db.prepare('UPDATE productos SET stock=? WHERE id=? AND negocio_id=?').run(p.stock_despues, p.id, n);
      await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,usuario_id,venta_id,solicitud_id,detalles)
        VALUES(?,?,?,'eliminar_error_carga',?,?,?,?,?,?,?::jsonb)`).run(id(), p.id, n, p.stock_actual, p.stock_despues, razon, actor, v, input.solicitud_id,
        JSON.stringify({ cantidad_repuesta: p.cantidad_reponer, movimientos_originales: s.historialStock.filter(h => h.producto_id === p.id).map(h => h.id) }));
    }
    if (s.comisiones.acuerdo) {
      const generado = suma(s.comisiones.generaciones.map(g => Number(g.importe_centavos)));
      if (generado) await generarComision(s.comisiones.acuerdo, -generado, todayAR(), razon, 'venta-error:' + input.solicitud_id);
      await sincronizarComision(s.credito.id, todayAR(), razon);
    }
    for (const contacto of s.contactos.filter(c => c.estado === 'pendiente')) {
      await db.prepare("UPDATE recordatorios SET estado='cancelado',omitido_fecha=?,omitido_por=?,omitido_motivo=? WHERE id=?").run(nowAR(), actor, razon, contacto.id);
      const actualizado = await db.prepare('SELECT * FROM recordatorios WHERE id=?').get(contacto.id);
      await auditar('contacto_cobranza', contacto.id, 'cancelado_error_carga', contacto, actualizado, actor, motivo);
    }
    await recalcularEstadoCredito(s.credito.id, s.negocio, todayAR(), actor);
    const despues = await cargar(n, v);
    const resultado = { id: v, venta: despues.venta, credito: despues.credito, productos: a.productos,
      pagos_anulados: a.activos.length, total_pagos_centavos: suma(a.activos.map(p => p.monto_centavos)), saldo_favor_retirado_centavos: a.remanente };
    await auditar('venta', v, accion, snapshot(s), { solicitud_id: input.solicitud_id, requestHash, resultado, despues: snapshot(despues) }, actor, motivo);
    return resultado;
  });
}
