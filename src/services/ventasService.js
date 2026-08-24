import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { todayAR, addDays, addMonths } from '../lib/dates.js';
import { descontarStock, getProducto } from '../repositories/productos.js';
import { crearCredito, getCredito } from '../repositories/creditos.js';
import { crearCuota, listCuotasPorCredito } from '../repositories/cuotas.js';
import { getCliente, vincularClienteNegocio } from '../repositories/clientes.js';

export async function crearVenta(input) {
  const {
    negocio_id, cliente_id, fecha = todayAR(), modalidad, items = [],
    entrega_inicial_centavos = 0, empleado = null, notas = null, plan = {},
  } = input;

  if (!negocio_id || !cliente_id || !modalidad) throw badRequest('negocio_id, cliente_id y modalidad son obligatorios');
  if (!['libre', 'unico', 'cuotas'].includes(modalidad)) throw badRequest(`modalidad inválida: ${modalidad}`);

  const cliente = await getCliente(cliente_id);
  if (!cliente) throw badRequest('Cliente no encontrado');

  const montoItems = items.reduce((acc, it) => acc + it.precio_unitario_centavos * (it.cantidad || 1), 0);
  const monto_total_centavos = input.monto_total_centavos ?? montoItems;
  if (!monto_total_centavos || monto_total_centavos <= 0) throw badRequest('monto_total_centavos debe ser mayor a 0');
  if (entrega_inicial_centavos < 0 || entrega_inicial_centavos > monto_total_centavos) throw badRequest('entrega_inicial_centavos inválida');

  const ventaId = id();
  const advertencias = [];

  // 1) Descontar stock de los items que tengan producto_id — nunca bloquea la venta.
  for (const it of items) {
    if (it.producto_id) {
      const producto = await getProducto(it.producto_id);
      if (producto && producto.negocio_id !== negocio_id) throw badRequest('Ese producto pertenece a otro negocio.');
      const { advertencia } = await descontarStock(it.producto_id, it.cantidad || 1);
      if (advertencia) advertencias.push(advertencia);
    }
  }

  // 2) Registrar venta + detalle
  await db.prepare(`
    INSERT INTO ventas (id, negocio_id, cliente_id, fecha, modalidad, monto_total_centavos, entrega_inicial_centavos, notas, empleado)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(ventaId, negocio_id, cliente_id, fecha, modalidad, monto_total_centavos, entrega_inicial_centavos, notas, empleado);

  for (const it of items) {
    await db.prepare(`
      INSERT INTO venta_detalle (id, venta_id, producto_id, descripcion, cantidad, precio_unitario_centavos)
      VALUES (?,?,?,?,?,?)
    `).run(id(), ventaId, it.producto_id || null, it.descripcion || null, it.cantidad || 1, it.precio_unitario_centavos);
  }

  // 3) Vincular explícitamente cliente con el negocio (relación cliente_negocio)
  await vincularClienteNegocio(cliente_id, negocio_id);

  // 4) Crédito
  const saldoFinanciado = monto_total_centavos - entrega_inicial_centavos;
  const credito = await crearCredito({
    venta_id: ventaId, negocio_id, cliente_id, modalidad,
    monto_total_centavos, entrega_inicial_centavos,
    saldo_financiado_centavos: saldoFinanciado, fecha_inicio: fecha,
  });

  // 5) Cuotas según modalidad
  if (saldoFinanciado <= 0) {
    // pagado 100% al contado: no genera cuotas
  } else if (modalidad === 'cuotas') {
    const { cantidad_cuotas, valor_cuota_centavos, fecha_primera_cuota, intervalo_dias = 30 } = plan;
    if (!cantidad_cuotas || !valor_cuota_centavos || !fecha_primera_cuota) {
      throw badRequest('plan.cantidad_cuotas, plan.valor_cuota_centavos y plan.fecha_primera_cuota son obligatorios para modalidad "cuotas"');
    }
    const usarMeses = intervalo_dias === 30;
    for (let i = 0; i < cantidad_cuotas; i++) {
      const vencimiento = usarMeses ? addMonths(fecha_primera_cuota, i) : addDays(fecha_primera_cuota, i * intervalo_dias);
      await crearCuota({ credito_id: credito.id, numero: i + 1, monto_centavos: valor_cuota_centavos, fecha_vencimiento: vencimiento });
    }
  } else {
    const fechaLimite = plan.fecha_limite || addDays(fecha, plan.plazo_dias || 30);
    await crearCuota({ credito_id: credito.id, numero: 1, monto_centavos: saldoFinanciado, fecha_vencimiento: fechaLimite });
  }

  return {
    venta: await db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId),
    credito: await getCredito(credito.id),
    cuotas: await listCuotasPorCredito(credito.id),
    advertencias,
  };
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
