import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { guardarConfigTienda, crearProductoTienda } from '../src/services/tiendasService.js';
import { crearPedidoPublico, detallePedidoTienda, confirmarPedidoTienda, cancelarPedidoTienda } from '../src/services/tiendaPedidosService.js';
import { registrarCobroPedido, anularCobroPedido } from '../src/services/tiendaCobrosService.js';
import { resumenGeneral, historialFinancieroCliente } from '../src/services/dashboardService.js';
import { crearVenta } from '../src/services/ventasService.js';
import { todayAR, addDays } from '../src/lib/dates.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'dashboard-tienda@qa.invalid', password_hash: 'unused' });
test.after(() => pool.end());

async function tienda(precio = 10000) {
  const negocio = await crearNegocio({ nombre: 'QA dashboard tienda ' + randomUUID(), mora_valor: 0 });
  const slug = 'dashboard-' + randomUUID();
  await guardarConfigTienda(negocio.id, { solicitud_id: randomUUID(), slug, habilitada: true }, admin.id);
  const producto = await crearProductoTienda(negocio.id, {
    solicitud_id: randomUUID(), nombre: 'Funda QA', precio_centavos: precio, stock: 20, publicado: true,
  }, admin.id);
  return { negocio, slug, producto, precio };
}
async function pedido(t, confirmar = true) {
  const recibido = await crearPedidoPublico(t.slug, {
    solicitud_id: randomUUID(), contacto: { nombre: 'Cliente', apellido: 'Web', telefono: '1122334455' },
    acepta_contacto: true, items: [{ producto_id: t.producto.id, cantidad: 1 }],
  });
  let detalle = await detallePedidoTienda(t.negocio.id, recibido.id);
  if (confirmar) detalle = await confirmarPedidoTienda(t.negocio.id, recibido.id, {
    solicitud_id: randomUUID(), version: detalle.version,
  }, admin.id);
  return detalle;
}
async function cobrar(t, detalle, monto, extra = {}) {
  const actualizado = await detallePedidoTienda(t.negocio.id, detalle.pedido.id);
  return registrarCobroPedido(t.negocio.id, detalle.pedido.id, {
    solicitud_id: randomUUID(), version: actualizado.version, monto_centavos: monto, medio_pago: 'transferencia', ...extra,
  }, admin.id);
}
async function snapshot() {
  const tablas = ['ventas', 'creditos', 'cuotas', 'pagos', 'comprobantes', 'pago_aplicaciones', 'saldo_favor', 'productos', 'producto_historial', 'tienda_pedidos', 'tienda_pedido_cobros'];
  return Object.fromEntries(await Promise.all(tablas.map(async tabla => [tabla, (await db.query(`SELECT * FROM ${tabla} ORDER BY 1`)).rows])));
}

test('Dashboard web: confirmar suma vendido una sola vez y cobrar parcial/completo suma cobrado sin generar financiación', async () => {
  const t = await tienda();
  let detalle = await pedido(t, false);
  assert.equal((await resumenGeneral(t.negocio.id)).vendidoTotalCentavos, 0);
  detalle = await confirmarPedidoTienda(t.negocio.id, detalle.pedido.id, { solicitud_id: randomUUID(), version: detalle.version }, admin.id);
  let resumen = await resumenGeneral(t.negocio.id);
  assert.equal(resumen.vendidoTotalCentavos, t.precio);
  assert.equal(resumen.cobradoMesCentavos, 0);
  detalle = await cobrar(t, detalle, 4000);
  const clienteId = detalle.pedido.cliente_id;
  let historial = await historialFinancieroCliente(clienteId, t.negocio.id);
  assert.equal(historial.cantidadCompras, 1);
  assert.equal(historial.comprasFinalizadas, 0);
  assert.equal(historial.fechaUltimaCompra, detalle.pedido.confirmado_fecha.slice(0, 10));
  assert.equal(historial.totalCobradoCentavos, 4000);
  detalle = await cobrar(t, detalle, 6000, { medio_pago: 'efectivo' });
  resumen = await resumenGeneral(t.negocio.id);
  historial = await historialFinancieroCliente(clienteId, t.negocio.id);
  assert.equal(resumen.vendidoTotalCentavos, t.precio, 'Cada cobro conserva el único importe de venta');
  assert.equal(resumen.cobradoHoyCentavos, t.precio);
  assert.equal(resumen.cobradoMesCentavos, t.precio);
  assert.equal(historial.comprasFinalizadas, 1);
  assert.equal(historial.cantidadCompras, 1);
  for (const campo of ['capitalColocadoCentavos', 'saldoPendienteTotalCentavos', 'cuotasPendientes']) assert.equal(resumen[campo], 0, campo);
  for (const campo of ['cuotasTotales', 'cuotasPagadas', 'cuotasVencidasActualmente', 'deudaActualCentavos']) assert.equal(historial[campo], 0, campo);
  for (const tabla of ['ventas', 'creditos', 'cuotas', 'pago_aplicaciones', 'saldo_favor']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int t FROM ${tabla}`).get()).t, 0, tabla);
  }
  const antes = await snapshot();
  await resumenGeneral(t.negocio.id);
  await historialFinancieroCliente(clienteId, t.negocio.id);
  assert.deepEqual(await snapshot(), antes, 'Consultar estadísticas no modifica inventario ni registros financieros');
});

test('Dashboard web: anular cobro reabre finalizada; cancelar venta excluye vendido y compra pero conserva dinero realmente cobrado', async () => {
  const t = await tienda(20000);
  let detalle = await cobrar(t, await pedido(t), 20000);
  const clienteId = detalle.pedido.cliente_id;
  assert.equal((await historialFinancieroCliente(clienteId, t.negocio.id)).comprasFinalizadas, 1);
  detalle = await anularCobroPedido(t.negocio.id, detalle.pedido.id, detalle.cobros[0].id, {
    solicitud_id: randomUUID(), version: detalle.version, motivo: 'Cobro duplicado QA',
  }, admin.id);
  let historial = await historialFinancieroCliente(clienteId, t.negocio.id);
  assert.equal(historial.comprasFinalizadas, 0);
  assert.equal(historial.totalCobradoCentavos, 0);
  assert.equal(historial.cantidadCompras, 1);
  detalle = await cobrar(t, detalle, 5000);
  await cancelarPedidoTienda(t.negocio.id, detalle.pedido.id, {
    solicitud_id: randomUUID(), version: detalle.version, motivo: 'Cliente cancela QA',
  }, admin.id);
  const resumen = await resumenGeneral(t.negocio.id);
  historial = await historialFinancieroCliente(clienteId, t.negocio.id);
  assert.equal(resumen.vendidoTotalCentavos, 0);
  assert.equal(resumen.cobradoMesCentavos, 5000, 'Cancelar no inventa una devolución de dinero');
  assert.equal(historial.cantidadCompras, 0);
  assert.equal(historial.comprasFinalizadas, 0);
  assert.equal(historial.fechaUltimaCompra, null);
  assert.equal(historial.totalCobradoCentavos, 5000);
});

test('Dashboard web: suma ventas comunes y web y aísla negocios, scope vacío y último día de compra', async () => {
  const a = await tienda(11000), b = await tienda(22000);
  const cliente = await crearCliente({ nombre: 'Compartido', apellido: 'QA', negocio_id: a.negocio.id });
  await vincularClienteNegocio(cliente.id, b.negocio.id);
  await crearVenta({ negocio_id: a.negocio.id, cliente_id: cliente.id, usuario_id: admin.id, fecha: addDays(todayAR(), -10),
    modalidad: 'cuotas', monto_total_centavos: 7000,
    plan: { cantidad_cuotas: 1, valor_cuota_centavos: 7000, fecha_primera_cuota: addDays(todayAR(), 7) } });
  await cobrar(a, await pedido(a), 11000, { cliente_id: cliente.id });
  await cobrar(b, await pedido(b), 1000, { cliente_id: cliente.id });
  assert.equal((await resumenGeneral(a.negocio.id)).vendidoTotalCentavos, 18000);
  assert.equal((await resumenGeneral(b.negocio.id)).vendidoTotalCentavos, 22000);
  const ambos = await resumenGeneral([a.negocio.id, b.negocio.id]);
  assert.equal(ambos.vendidoTotalCentavos, 40000);
  assert.equal(ambos.cobradoMesCentavos, 12000);
  assert.equal(ambos.saldoPendienteTotalCentavos, 7000, 'La deuda proyectada corresponde sólo a la financiación real');
  assert.equal(ambos.porNegocio.find(n => n.negocio_id === a.negocio.id).vendidoTotalCentavos, 18000);
  const ha = await historialFinancieroCliente(cliente.id, a.negocio.id);
  const hb = await historialFinancieroCliente(cliente.id, b.negocio.id);
  const hab = await historialFinancieroCliente(cliente.id, [a.negocio.id, b.negocio.id]);
  assert.equal(ha.cantidadCompras, 2);
  assert.equal(hb.cantidadCompras, 1);
  assert.equal(hab.cantidadCompras, 3);
  assert.equal(ha.comprasFinalizadas, 1);
  assert.equal(hb.comprasFinalizadas, 0);
  assert.equal(hab.comprasFinalizadas, 1);
  assert.equal(ha.fechaUltimaCompra, todayAR());
  assert.equal(hab.totalCobradoCentavos, 12000);
  const vacio = await resumenGeneral([]);
  assert.equal(vacio.vendidoTotalCentavos, 0);
  assert.equal(vacio.cobradoMesCentavos, 0);
  const hv = await historialFinancieroCliente(cliente.id, []);
  assert.equal(hv.cantidadCompras, 0);
  assert.equal(hv.comprasFinalizadas, 0);
  assert.equal(hv.totalCobradoCentavos, 0);
  assert.equal(hv.fechaUltimaCompra, null);
});
