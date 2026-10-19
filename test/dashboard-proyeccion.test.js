import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearProducto, getProducto } from '../src/repositories/productos.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { detalleVenta, devolverVenta } from '../src/services/ventasGestionService.js';
import { resumenGeneral } from '../src/services/dashboardService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays, addMonths } from '../src/lib/dates.js';

// La importación inicial exige TEST_DATABASE_URL local y descartable, con sufijo _test.
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@proyeccion.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'empleado@proyeccion.invalid', password_hash: 'unused', rol: 'empleado' });
const hoy = todayAR();
const inicioMes = `${hoy.slice(0, 7)}-01`;
const mes = hoy.slice(0, 7);
const siguiente = addMonths(inicioMes, 1).slice(0, 7);
const compra = addDays(hoy, -100);
const instante = fecha => `${fecha}T12:00:00-03:00`;
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function api(query = '', user = admin, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    ...(user ? { Authorization: `Bearer ${firmarToken(user)}` } : {}),
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
  };
  // http.request permite verificar también un filtro contradictorio entre query y cuerpo GET.
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: `/api/dashboard/resumen${query}`, method: 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
async function negocio(nombre) {
  return crearNegocio({ nombre: `QA proyección ${nombre}`, mora_valor: 0 });
}
async function venta(neg, { fecha = hoy, monto = 100000, cliente, entrega = 0, cantidad = 1, items = [] } = {}) {
  cliente ||= await crearCliente({ nombre: 'Proyección', apellido: 'QA', negocio_id: neg.id });
  return crearVenta({
    negocio_id: neg.id, cliente_id: cliente.id, fecha: compra, modalidad: 'cuotas', usuario_id: admin.id,
    monto_total_centavos: monto * cantidad + entrega, entrega_inicial_centavos: entrega, items,
    plan: { cantidad_cuotas: cantidad, valor_cuota_centavos: monto, fecha_primera_cuota: fecha },
  });
}
async function cobro(operacion, monto, cuota = operacion.cuotas[0].id) {
  return registrarPago({ credito_id: operacion.credito.id, cuota_id: cuota, monto_centavos: monto, fecha_hora: instante(hoy), usuario_id: admin.id });
}
async function proyeccion(scope) {
  const resumen = await resumenGeneral(scope);
  assert.ok(resumen.proyeccionCobros, 'El resumen incluye la proyección de capital pendiente');
  return resumen.proyeccionCobros;
}
const totalMeses = forecast => forecast.meses.reduce((sum, row) => sum + row.pendienteCentavos, 0);
async function devolver(neg, operacion, { tipo = 'devolucion', cantidad = 1 } = {}) {
  const detalle = await detalleVenta(neg.id, operacion.venta.id);
  return devolverVenta(neg.id, operacion.venta.id, {
    version: detalle.version, solicitud_id: randomUUID(), tipo, motivo: 'QA corregir mercadería devuelta', reponer: true,
    items: [{ id: detalle.items[0].id, cantidad }],
  }, admin.id);
}
async function snapshot() {
  const tablas = ['ventas', 'creditos', 'cuotas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'productos', 'producto_historial'];
  return Object.fromEntries(await Promise.all(tablas.map(async tabla => [tabla, (await pool.query(`SELECT * FROM ${tabla} ORDER BY id`)).rows])));
}

test('Proyección PG: agrupa capital por mes, incluye lo vencido de este mes y conserva meses futuros sin rellenar huecos', async () => {
  const neg = await negocio('meses');
  const lejano = addMonths(inicioMes, 18);
  await venta(neg, { fecha: addDays(inicioMes, -1), monto: 10000 });
  await venta(neg, { fecha: inicioMes, monto: 20000 });
  await venta(neg, { fecha: addDays(addMonths(inicioMes, 1), -1), monto: 30000 });
  await venta(neg, { fecha: `${siguiente}-01`, monto: 40000 });
  await venta(neg, { fecha: lejano, monto: 50000 });
  const forecast = await proyeccion(neg.id);
  const vencidoActual = hoy > inicioMes ? 20000 : 0;
  assert.equal(forecast.fechaCorte, hoy);
  assert.equal(forecast.desdeMes, mes);
  assert.equal(forecast.hastaMes, lejano.slice(0, 7));
  assert.deepEqual(forecast.mesActual, { mes, pendienteCentavos: 50000, cuotas: 2, vencidoCentavos: vencidoActual });
  assert.deepEqual(forecast.mesSiguiente, { mes: siguiente, pendienteCentavos: 40000, cuotas: 1, vencidoCentavos: 0 });
  assert.equal(forecast.vencidoTotalCentavos, 10000 + vencidoActual);
  assert.deepEqual(forecast.meses, [
    forecast.mesActual, forecast.mesSiguiente,
    { mes: lejano.slice(0, 7), pendienteCentavos: 50000, cuotas: 1, vencidoCentavos: 0 },
  ]);
  assert.ok(forecast.meses.every(row => row.pendienteCentavos > 0 && Number.isSafeInteger(row.pendienteCentavos)));
});

test('Proyección PG: ventanas de 7 y 14 días incluyen hoy y sus límites finales, sin sumar deudas vencidas', async () => {
  const neg = await negocio('límites');
  for (const [dias, monto] of [[-1, 100], [0, 200], [6, 300], [7, 400], [13, 500], [14, 600]]) {
    await venta(neg, { fecha: addDays(hoy, dias), monto });
  }
  const forecast = await proyeccion(neg.id);
  assert.deepEqual(forecast.proximos7Dias, { desde: hoy, hasta: addDays(hoy, 6), pendienteCentavos: 500, cuotas: 2 });
  assert.deepEqual(forecast.proximos14Dias, { desde: hoy, hasta: addDays(hoy, 13), pendienteCentavos: 1400, cuotas: 4 });
  assert.equal(forecast.vencidoTotalCentavos, 100);
});

test('Proyección PG: usa capital restante después de entrega inicial, pago parcial, adelanto y anulación; excluye mora y no modifica registros al consultar', async () => {
  const neg = await negocio('movimientos');
  const operacion = await venta(neg, { fecha: addDays(hoy, 2), monto: 200000, cantidad: 3, entrega: 100000 });
  assert.equal(totalMeses(await proyeccion(neg.id)), 600000, 'La entrega ya se descontó del financiamiento');
  const parcial = await cobro(operacion, 50000);
  await pool.query('UPDATE cuotas SET mora_generada_centavos=90000 WHERE id=$1', [operacion.cuotas[0].id]);
  assert.equal(totalMeses(await proyeccion(neg.id)), 550000, 'La mora no se proyecta como capital');
  const adelanto = await cobro(operacion, 200000, operacion.cuotas[1].id);
  let forecast = await proyeccion(neg.id);
  assert.equal(totalMeses(forecast), 350000);
  assert.equal(forecast.meses.reduce((sum, row) => sum + row.cuotas, 0), 2);
  assert.equal(forecast.proximos7Dias.pendienteCentavos, 150000);
  const antes = await snapshot();
  const response = await api(`?negocio_id=${neg.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.proyeccionCobros, forecast);
  assert.deepEqual(await snapshot(), antes, 'La consulta no reescribe deuda, recibos ni stock');
  await anularComprobante(adelanto.comprobante.id, { motivo: 'QA adelanto duplicado', usuarioId: admin.id });
  assert.equal(totalMeses(await proyeccion(neg.id)), 550000);
  await anularComprobante(parcial.comprobante.id, { motivo: 'QA pago duplicado', usuarioId: admin.id });
  forecast = await proyeccion(neg.id);
  assert.equal(totalMeses(forecast), 600000);
  assert.equal(forecast.meses.reduce((sum, row) => sum + row.cuotas, 0), 3);
});

test('Proyección PG: pausa y gestión especial conservan la deuda proyectada; los estados manuales la excluyen', async () => {
  const neg = await negocio('gestión');
  const manual = await venta(neg, { monto: 1000 });
  const pausada = await venta(neg, { monto: 2000 });
  const especial = await venta(neg, { monto: 3000 });
  await venta(neg, { monto: 4000 });
  await pool.query("UPDATE cuotas SET estado_manual='incobrable' WHERE id=$1", [manual.cuotas[0].id]);
  await pool.query("INSERT INTO cliente_negocio_cobranza(cliente_id,negocio_id,modo) VALUES($1,$2,'pausada') ON CONFLICT(cliente_id,negocio_id) DO UPDATE SET modo=EXCLUDED.modo", [pausada.credito.cliente_id, neg.id]);
  await pool.query('INSERT INTO cliente_negocio_cobranza(cliente_id,negocio_id,gestion_especial) VALUES($1,$2,1) ON CONFLICT(cliente_id,negocio_id) DO UPDATE SET gestion_especial=EXCLUDED.gestion_especial', [especial.credito.cliente_id, neg.id]);
  const forecast = await proyeccion(neg.id);
  assert.deepEqual(forecast.mesActual, { mes, pendienteCentavos: 9000, cuotas: 3, vencidoCentavos: 0 });
  assert.equal(forecast.proximos7Dias.pendienteCentavos, 9000);
  assert.equal(forecast.proximos14Dias.cuotas, 3);
});

test('Proyección PG: devolución parcial reduce el cobro esperado y la devolución completa deja de proyectarse sin repetir reposición', async () => {
  const neg = await negocio('devoluciones');
  const producto = await crearProducto({ negocio_id: neg.id, nombre: 'Producto QA proyección', stock: 8 });
  const operacion = await venta(neg, {
    fecha: addDays(hoy, 2), monto: 200000,
    items: [{ producto_id: producto.id, cantidad: 2, precio_unitario_centavos: 100000 }],
  });
  await cobro(operacion, 50000);
  assert.equal(totalMeses(await proyeccion(neg.id)), 150000);
  assert.equal((await getProducto(producto.id)).stock, 6);
  await devolver(neg, operacion);
  assert.equal(totalMeses(await proyeccion(neg.id)), 50000);
  assert.equal((await getProducto(producto.id)).stock, 7);
  await devolver(neg, operacion);
  assert.equal((await getProducto(producto.id)).stock, 8);
  // Una inconsistencia histórica no convierte una venta devuelta en un cobro esperado.
  await pool.query('UPDATE cuotas SET saldo_pendiente_centavos=45000,estado_manual=NULL WHERE id=$1', [operacion.cuotas[0].id]);
  const antes = await snapshot();
  const forecast = await proyeccion(neg.id);
  assert.equal(totalMeses(forecast), 0);
  assert.equal(forecast.proximos14Dias.cuotas, 0);
  assert.deepEqual(await snapshot(), antes);
});

test('Proyección PG: una venta anulada queda excluida aunque un saldo histórico siga guardado', async () => {
  const neg = await negocio('anuladas');
  const producto = await crearProducto({ negocio_id: neg.id, nombre: 'Producto QA anulación', stock: 4 });
  const operacion = await venta(neg, { monto: 100000, items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 100000 }] });
  assert.equal((await getProducto(producto.id)).stock, 3);
  await devolver(neg, operacion, { tipo: 'anulacion' });
  await pool.query('UPDATE cuotas SET saldo_pendiente_centavos=35000,estado_manual=NULL WHERE id=$1', [operacion.cuotas[0].id]);
  const forecast = await proyeccion(neg.id);
  assert.equal(totalMeses(forecast), 0);
  assert.equal(forecast.mesActual.pendienteCentavos, 0);
  assert.equal((await getProducto(producto.id)).stock, 4);
});

test('Proyección PG: scope vacío devuelve cero y Todos suma deudas del mismo cliente en negocios distintos', async () => {
  const vacia = await proyeccion([]);
  assert.equal(vacia.fechaCorte, hoy);
  assert.equal(vacia.desdeMes, mes);
  assert.equal(vacia.hastaMes, addMonths(inicioMes, 11).slice(0, 7));
  assert.deepEqual(vacia.meses, []);
  assert.deepEqual(vacia.mesActual, { mes, pendienteCentavos: 0, cuotas: 0, vencidoCentavos: 0 });
  assert.deepEqual(vacia.mesSiguiente, { mes: siguiente, pendienteCentavos: 0, cuotas: 0, vencidoCentavos: 0 });
  assert.equal(vacia.proximos7Dias.pendienteCentavos, 0);
  assert.equal(vacia.proximos14Dias.cuotas, 0);
  assert.equal(vacia.vencidoTotalCentavos, 0);
  const base = await proyeccion(null);
  const a = await negocio('compartido A');
  const b = await negocio('compartido B');
  const cliente = await crearCliente({ nombre: 'Compartido', apellido: 'Proyección', negocio_id: a.id });
  await venta(a, { cliente, monto: 11000 });
  await venta(b, { cliente, monto: 22000 });
  assert.equal((await proyeccion(a.id)).mesActual.pendienteCentavos, 11000);
  assert.equal((await proyeccion(b.id)).mesActual.pendienteCentavos, 22000);
  const seleccion = await proyeccion([a.id, b.id]);
  assert.equal(seleccion.mesActual.pendienteCentavos, 33000);
  assert.equal(seleccion.mesActual.cuotas, 2, 'Las deudas no se deduplican por cliente');
  const todos = await api();
  assert.equal(todos.status, 200, JSON.stringify(todos.body));
  assert.equal(todos.body.proyeccionCobros.mesActual.pendienteCentavos, base.mesActual.pendienteCentavos + 33000);
  assert.equal(todos.body.proyeccionCobros.mesActual.cuotas, base.mesActual.cuotas + 2);
  assert.equal(todos.body.proyeccionCobros.proximos7Dias.pendienteCentavos, base.proximos7Dias.pendienteCentavos + 33000);
});

test('Proyección API: sólo administrador accede; filtros contradictorios o repetidos se rechazan', async () => {
  const a = await negocio('permisos A');
  const b = await negocio('permisos B');
  await asignarNegocio(empleado.id, a.id, { 'dashboard_financiero.ver': true, 'cobranzas.ver': true, 'clientes.ver': true });
  await venta(a, { monto: 12300 });
  for (const query of ['', `?negocio_id=${a.id}`, `?negocio_id=${b.id}`]) {
    const denegada = await api(query, empleado);
    assert.equal(denegada.status, 403);
    assert.equal(denegada.body.proyeccionCobros, undefined);
  }
  assert.equal((await api('', null)).status, 401);
  const autorizada = await api(`?negocio_id=${a.id}`);
  assert.equal(autorizada.status, 200);
  assert.equal(autorizada.body.proyeccionCobros.mesActual.pendienteCentavos, 12300);
  assert.equal((await api(`?negocio_id=${a.id}`, admin, { negocio_id: b.id })).status, 400);
  assert.equal((await api(`?negocio_id=${a.id}&negocio_id=${b.id}`)).status, 400);
});
