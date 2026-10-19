import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { agregarIncidencia } from '../src/services/incidenciasService.js';
import { guardarContacto } from '../src/services/contactosCobranzaService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a = await crearNegocio({ nombre: 'QA entregas A', mora_valor: 0 });
const b = await crearNegocio({ nombre: 'QA entregas B', mora_valor: 0 });
const admin = await crearUsuario({ email: 'admin@fechas-entrega.invalid', password_hash: 'unused' });
const empleado = await crearUsuario({ email: 'empleado@fechas-entrega.invalid', password_hash: 'unused', rol: 'empleado' });
await asignarNegocio(empleado.id, a.id, { 'clientes.ver': true, 'clientes.editar': true, 'ventas.crear': true });
const cliente = await crearCliente({ nombre: 'Fechas', apellido: 'QA', negocio_id: a.id });
const hoy = todayAR();
const compra = addDays(hoy, -60);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function api(path, user = admin, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${firmarToken(user)}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const path = id => `/ventas/creditos/${id}/correccion`;
async function operacion({ negocio = a, primeraCuota = addDays(hoy, 30) } = {}) {
  const venta = await crearVenta({
    negocio_id: negocio.id, cliente_id: cliente.id, fecha: compra,
    modalidad: 'cuotas', monto_total_centavos: 300000,
    plan: { cantidad_cuotas: 3, valor_cuota_centavos: 100000, fecha_primera_cuota: primeraCuota },
  });
  await pool.query("UPDATE creditos SET producto_descripcion='Producto QA',condiciones='Condiciones QA' WHERE id=$1", [venta.credito.id]);
  return venta;
}
async function vista(id) {
  const response = await api(path(id));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
function correccion(preview, cambios = {}) {
  return {
    version: preview.version, motivo: 'QA corregir fecha de entrega', solicitud_id: randomUUID(),
    confirmar_correccion_pagos: true,
    datos: {
      monto_total_centavos: preview.credito.monto_total_centavos,
      entrega_inicial_centavos: preview.credito.entrega_inicial_centavos,
      fecha_inicio: preview.credito.fecha_inicio,
      producto_descripcion: preview.credito.producto_descripcion,
      condiciones: preview.credito.condiciones,
      cuotas: preview.cuotas.map(q => ({ id: q.id, monto_centavos: q.monto_centavos, fecha_vencimiento: q.fecha_vencimiento })),
      ...cambios,
    },
  };
}
async function finanzas() {
  const tables = ['ventas', 'creditos', 'cuotas', 'pagos', 'comprobantes', 'pago_aplicaciones'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows])));
}

test('Entrega PG: fecha física independiente de compra y cuotas conserva pagos y deuda de la otra tienda', async () => {
  const venta = await operacion();
  const otra = await operacion({ negocio: b });
  await registrarPago({ credito_id: venta.credito.id, monto_centavos: 5000, fecha_hora: `${addDays(hoy, -10)}T12:00:00-03:00` });
  await registrarPago({ credito_id: otra.credito.id, monto_centavos: 7000, fecha_hora: `${hoy}T12:00:00-03:00` });
  const preview = await vista(venta.credito.id);
  assert.equal(preview.credito.fecha_entrega_producto, null);
  const before = await finanzas();
  const entrega = addDays(hoy, -30);
  const request = correccion(preview, { fecha_entrega_producto: entrega });
  const response = await api(path(venta.credito.id), admin, 'PATCH', request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const after = await vista(venta.credito.id);
  assert.equal(after.credito.fecha_inicio, compra);
  assert.equal(after.credito.fecha_entrega_producto, entrega);
  assert.deepEqual(after.cuotas, preview.cuotas);
  assert.deepEqual(after.pagos, preview.pagos);
  assert.deepEqual(after.aplicaciones, preview.aplicaciones);
  before.creditos = before.creditos.map(cr => cr.id === venta.credito.id ? { ...cr, fecha_entrega_producto: entrega } : cr);
  assert.deepEqual(await finanzas(), before);
  assert.equal((await api(path(venta.credito.id), admin, 'PATCH', request)).status, 200);
  const logs = (await pool.query("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=$1 AND accion='corregir_financiacion'", [venta.credito.id])).rows;
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0].datos_anteriores).credito.fecha_entrega_producto, null);
  assert.equal(JSON.parse(logs[0].datos_nuevos).despues.credito.fecha_entrega_producto, entrega);
  assert.equal(logs[0].empleado, admin.id);
  assert.equal(logs[0].motivo, request.motivo);
});

test('Entrega PG: omitir el campo conserva la fecha y null permite borrar una carga equivocada', async () => {
  const venta = await operacion();
  const id = venta.credito.id;
  const entrega = addDays(hoy, -20);
  const first = await api(path(id), admin, 'PATCH', correccion(await vista(id), { fecha_entrega_producto: entrega }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const omitted = correccion(await vista(id), { condiciones: 'Condiciones corregidas QA' });
  assert.equal(Object.hasOwn(omitted.datos, 'fecha_entrega_producto'), false);
  assert.equal((await api(path(id), admin, 'PATCH', omitted)).status, 200);
  assert.equal((await vista(id)).credito.fecha_entrega_producto, entrega);
  assert.equal((await api(path(id), admin, 'PATCH', correccion(await vista(id), { fecha_entrega_producto: null }))).status, 200);
  assert.equal((await vista(id)).credito.fecha_entrega_producto, null);
});

test('Entrega PG: fechas imposibles, futuras y anteriores a compra se rechazan sin cambiar finanzas', async () => {
  const venta = await operacion();
  const preview = await vista(venta.credito.id);
  const before = await finanzas();
  for (const fecha of ['2026-02-30', '19/10/2026', '', 123, {}, addDays(hoy, 1), addDays(compra, -1)]) {
    const response = await api(path(venta.credito.id), admin, 'PATCH', correccion(preview, { fecha_entrega_producto: fecha }));
    assert.equal(response.status, 400, `Fecha ${JSON.stringify(fecha)}: ${JSON.stringify(response.body)}`);
  }
  assert.deepEqual(await finanzas(), before);
});

test('Entrega PG: mover compra después de una entrega existente también se valida cuando el campo se omite', async () => {
  const venta = await operacion();
  const id = venta.credito.id;
  assert.equal((await api(path(id), admin, 'PATCH', correccion(await vista(id), { fecha_entrega_producto: addDays(hoy, -20) }))).status, 200);
  const preview = await vista(id);
  const before = await finanzas();
  assert.equal((await api(path(id), admin, 'PATCH', correccion(preview, { fecha_inicio: addDays(hoy, -10) }))).status, 400);
  assert.deepEqual(await finanzas(), before);
});

test('Entrega PG: la compra no puede moverse después de entregas o retiros de equipo registrados', async () => {
  for (const tipo of ['equipo_entregado', 'equipo_retirado']) {
    const venta = await operacion();
    await agregarIncidencia({ creditoId: venta.credito.id, tipo, fecha: addDays(hoy, -40), clave: `equipo:${randomUUID()}`, motivo: 'QA hecho registrado', usuarioId: admin.id });
    const preview = await vista(venta.credito.id);
    const before = await finanzas();
    const incidencias = (await pool.query('SELECT * FROM credito_incidencias WHERE credito_id=$1 ORDER BY secuencia', [venta.credito.id])).rows;
    const response = await api(path(venta.credito.id), admin, 'PATCH', correccion(preview, { fecha_inicio: addDays(hoy, -30) }));
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.deepEqual(await finanzas(), before);
    assert.deepEqual((await pool.query('SELECT * FROM credito_incidencias WHERE credito_id=$1 ORDER BY secuencia', [venta.credito.id])).rows, incidencias);
  }
});

test('Entrega PG: versión anterior no pisa la nueva fecha y empleados no pueden corregirla', async () => {
  const venta = await operacion();
  const preview = await vista(venta.credito.id);
  assert.equal((await api(path(venta.credito.id), empleado)).status, 403);
  const request = correccion(preview, { fecha_entrega_producto: addDays(hoy, -20) });
  assert.equal((await api(path(venta.credito.id), empleado, 'PATCH', request)).status, 403);
  assert.equal((await api(path(venta.credito.id), admin, 'PATCH', request)).status, 200);
  const stale = correccion(preview, { fecha_entrega_producto: addDays(hoy, -10) });
  assert.equal((await api(path(venta.credito.id), admin, 'PATCH', stale)).status, 409);
  assert.equal((await vista(venta.credito.id)).credito.fecha_entrega_producto, request.datos.fecha_entrega_producto);
});

test('Entrega PG: ficha e historial muestran la fecha corregida y su cambio sin exponer snapshots', async () => {
  const venta = await operacion();
  const entrega = addDays(hoy, -15);
  const request = correccion(await vista(venta.credito.id), { fecha_entrega_producto: entrega });
  assert.equal((await api(path(venta.credito.id), admin, 'PATCH', request)).status, 200);
  const response = await api(`/clientes/${cliente.id}?negocio_id=${a.id}`);
  assert.equal(response.status, 200);
  const credito = response.body.creditos.find(cr => cr.id === venta.credito.id);
  assert.equal(credito.fecha_entrega_producto, entrega);
  assert.equal(credito.correcciones.length, 1);
  const historial = credito.correcciones[0];
  assert.equal(historial.motivo, request.motivo);
  assert.deepEqual(historial.cambios.find(c => c.campo === 'fecha_entrega_producto'), {
    campo: 'fecha_entrega_producto', etiqueta: 'Entrega / retiro del producto por el cliente', tipo: 'fecha', anterior: null, nuevo: entrega,
  });
  assert.equal(historial.datos_anteriores, undefined);
  assert.equal(historial.datos_nuevos, undefined);
});

test('Entrega PG: migración repetible conserva fechas conocidas y no inventa entregas en ventas previas', async () => {
  const conocida = await operacion();
  const desconocida = await operacion();
  const entrega = addDays(hoy, -15);
  await agregarIncidencia({ creditoId: desconocida.credito.id, tipo: 'equipo_retirado', fecha: hoy, clave: `equipo:${randomUUID()}`, usuarioId: admin.id });
  assert.equal((await api(path(conocida.credito.id), admin, 'PATCH', correccion(await vista(conocida.credito.id), { fecha_entrega_producto: entrega }))).status, 200);
  for (let i = 0; i < 2; i++) {
    await migrate();
    assert.equal((await vista(conocida.credito.id)).credito.fecha_entrega_producto, entrega);
    assert.equal((await vista(desconocida.credito.id)).credito.fecha_entrega_producto, null);
  }
});

test('Plan PG: puede_quitar protege cuotas con pagos y contactos y mantiene versión basada en datos crudos', async () => {
  const venta = await operacion();
  await registrarPago({ credito_id: venta.credito.id, cuota_id: venta.cuotas[0].id, monto_centavos: 5000, fecha_hora: `${hoy}T12:00:00-03:00` });
  await guardarContacto({ clienteId: cliente.id, negocioId: a.id, cuotaId: venta.cuotas[1].id, fecha: hoy, nota: 'QA contacto previo', solicitudId: randomUUID(), usuarioId: admin.id });
  const preview = await vista(venta.credito.id);
  assert.deepEqual(preview.cuotas.map(q => q.puede_quitar), [false, false, true]);
  const raw = {
    credito: preview.credito, venta: preview.venta,
    cuotas: preview.cuotas.map(({ puede_quitar, ...q }) => q),
    pagos: preview.pagos, aplicaciones: preview.aplicaciones,
  };
  assert.equal(preview.version, createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  const before = await finanzas();
  for (const id of [venta.cuotas[0].id, venta.cuotas[1].id]) {
    const request = correccion(preview);
    request.datos.cuotas = request.datos.cuotas.filter(q => q.id !== id);
    assert.equal((await api(path(venta.credito.id), admin, 'PATCH', request)).status, 409);
  }
  assert.deepEqual(await finanzas(), before);
});

test('Plan PG: puede_quitar considera mora calculada aunque todavía no se haya guardado', async () => {
  const negocio = await crearNegocio({ nombre: 'QA mora calculada entrega', dias_gracia: 0, mora_tipo: 'fijo', mora_valor: 500, mora_periodo: 'semana' });
  const venta = await operacion({ negocio, primeraCuota: addDays(hoy, -10) });
  const preview = await vista(venta.credito.id);
  const primera = preview.cuotas[0];
  assert.equal(primera.mora_generada_centavos, 0);
  assert.equal(primera.puede_quitar, false);
  assert.equal(preview.cuotas[1].puede_quitar, true);
  const before = await finanzas();
  const request = correccion(preview);
  request.datos.cuotas = request.datos.cuotas.filter(q => q.id !== primera.id);
  assert.equal((await api(path(venta.credito.id), admin, 'PATCH', request)).status, 409);
  assert.deepEqual(await finanzas(), before);
});
