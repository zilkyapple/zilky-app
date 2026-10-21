import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays, addMonths } from '../src/lib/dates.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { configurarComision, configurarProductoComision } from '../src/services/comisionesService.js';
import { guardarCaja, abrirCaja, cerrarCaja } from '../src/services/cajaService.js';

await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const admin = await crearUsuario({ email: 'admin@permiso-cuotas.invalid', nombre: 'Dueño QA', password_hash: 'unused' });
const adminToken = firmarToken(admin);
const hoy = todayAR();
const inicioMes = `${hoy.slice(0, 7)}-01`;
const compra = addMonths(inicioMes, -1);
const primera = `${compra.slice(0, 7)}-16`;
const objetivo = `${hoy.slice(0, 7)}-16`;
const corregida = addMonths(objetivo, 1);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function api(path, token = adminToken, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const ruta = (f, negocioId = f.negocio.id) => `/ventas/creditos/${f.venta.credito.id}/correccion${negocioId === null ? '' : `?negocio_id=${encodeURIComponent(negocioId)}`}`;
async function permisos(f, asignaciones = [{ negocio_id: f.negocio.id, permisos: { 'clientes.ver': true, 'cuotas.editar': true } }]) {
  const response = await api(`/usuarios/${f.empleado.id}`, adminToken, 'PATCH', { negocios: asignaciones });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
}
async function fixture({ conPagos = false, conCaja = false } = {}) {
  const negocio = await crearNegocio({ nombre: `Permiso cuotas ${randomUUID()}`, mora_valor: 0 });
  const empleado = await crearUsuario({ email: `${randomUUID()}@permiso-cuotas.invalid`, nombre: 'Editor QA', rol: 'empleado', password_hash: 'unused' });
  await asignarNegocio(empleado.id, negocio.id, { 'clientes.ver': true, 'clientes.editar': true, 'ventas.crear': true });
  const token = firmarToken(empleado);
  const cliente = await crearCliente({ nombre: 'Cliente', apellido: 'Cuotas QA', negocio_id: negocio.id });
  const producto = await crearProducto({ negocio_id: negocio.id, nombre: 'Producto cuotas QA', stock: 10, precio_financiado_centavos: 100000 });
  await configurarComision(negocio.id, { activa: true, visible_empleado: false, momento: 'cobro' }, admin.id);
  await configurarProductoComision(negocio.id, producto.id, { tipo: 'fijo', valor: 10000 }, admin.id);
  let sesion;
  if (conCaja) {
    const caja = await guardarCaja(null, { nombre: 'Caja QA', activa: true, arqueo: false, modalidad: 'negocio', negocios: [negocio.id] }, admin.id);
    sesion = await abrirCaja(caja.id, { inicial: 1000, solicitud_id: randomUUID() }, admin.id);
  }
  const venta = await crearVenta({
    negocio_id: negocio.id, cliente_id: cliente.id, fecha: compra, modalidad: 'cuotas',
    monto_total_centavos: 100000, entrega_inicial_centavos: 10000, medio_pago_entrega: 'efectivo',
    usuario_id: admin.id, comision_usuario_id: empleado.id, solicitud_id: randomUUID(),
    items: [{ producto_id: producto.id, cantidad: 1, precio_unitario_centavos: 100000 }],
    plan: { cantidad_cuotas: 3, valor_cuota_centavos: 30000, fecha_primera_cuota: primera },
  });
  if (conPagos) {
    for (const [indice, monto] of [[0, 30000], [1, 10000]]) {
      await registrarPago({ credito_id: venta.credito.id, cuota_id: venta.cuotas[indice].id, monto_centavos: monto,
        fecha_hora: `${hoy}T10:00:00-03:00`, medio_pago: 'efectivo', usuario_id: admin.id });
    }
  }
  if (sesion) await cerrarCaja(sesion.id, {}, admin.id);
  return { negocio, empleado, token, cliente, producto, venta };
}
async function vista(f, token = f.token, negocioId = f.negocio.id) {
  const response = await api(ruta(f, negocioId), token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
const datosCuotas = v => v.cuotas.map(({ id, monto_centavos, fecha_vencimiento }) => ({ id, monto_centavos, fecha_vencimiento }));
function solicitud(v, indice = 1, cambios = { fecha_vencimiento: corregida }) {
  const cuotas = datosCuotas(v);
  cuotas[indice] = { ...cuotas[indice], ...cambios };
  return { version: v.version, motivo: 'Corregir vencimiento cargado por error QA', solicitud_id: randomUUID(),
    confirmar_correccion_pagos: true, datos: { cuotas } };
}
async function protegidos() {
  const tablas = ['ventas', 'pagos', 'pago_aplicaciones', 'comprobantes', 'productos', 'producto_historial',
    'comision_acuerdos', 'comision_generaciones', 'comision_eventos', 'comision_liquidaciones', 'comision_cierres', 'caja_sesiones', 'caja_asientos'];
  return Object.fromEntries(await Promise.all(tablas.map(async tabla => [tabla, await db.prepare(`SELECT * FROM ${tabla} ORDER BY id`).all()])));
}
async function finanzas() {
  return { ...await protegidos(), creditos: await db.prepare('SELECT * FROM creditos ORDER BY id').all(), cuotas: await db.prepare('SELECT * FROM cuotas ORDER BY id').all() };
}
async function credito(f) {
  return { credito: await db.prepare('SELECT * FROM creditos WHERE id=?').get(f.venta.credito.id), cuotas: await db.prepare('SELECT * FROM cuotas WHERE credito_id=? ORDER BY numero').all(f.venta.credito.id) };
}

test('Permiso cuotas: jefe lo otorga y revoca inmediatamente con el mismo JWT; fecha corregida conserva pagos, stock, comisiones y caja cerrada', async () => {
  const f = await fixture({ conPagos: true, conCaja: true });
  assert.equal((await api(ruta(f), f.token)).status, 403, 'Editar clientes o crear ventas no concede editar cuotas');
  const original = await vista(f, adminToken);
  const body = solicitud(original);
  assert.equal((await api(ruta(f), f.token, 'PATCH', body)).status, 403);
  await permisos(f);
  const empleadoVista = await vista(f);
  assert.equal(empleadoVista.solo_cuotas, true);
  assert.equal(empleadoVista.venta, undefined);
  assert.equal(empleadoVista.credito.monto_total_centavos, undefined);
  assert.equal(empleadoVista.cuotas.length, 3, 'Incluye las saldadas para conservar el plan completo');
  assert.equal(empleadoVista.cuotas[1].fecha_vencimiento, objetivo);
  const antes = await protegidos();
  const antesCredito = await credito(f);
  const response = await api(ruta(f), f.token, 'PATCH', solicitud(empleadoVista));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await credito(f);
  assert.equal(despues.cuotas[1].fecha_vencimiento, corregida);
  assert.equal(despues.cuotas[1].saldo_pendiente_centavos, 20000, 'Conserva el capital parcialmente cobrado');
  assert.deepEqual(despues.cuotas[0], antesCredito.cuotas[0], 'No cambia la cuota saldada');
  assert.deepEqual(despues.cuotas[2], antesCredito.cuotas[2], 'No cambia otra cuota pendiente');
  for (const key of ['fecha_inicio', 'monto_total_centavos', 'entrega_inicial_centavos', 'saldo_financiado_centavos', 'producto_descripcion', 'condiciones']) {
    assert.equal(despues.credito[key], antesCredito.credito[key], key);
  }
  assert.deepEqual(await protegidos(), antes);
  const logs = await db.prepare("SELECT * FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion'").all(f.venta.credito.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].empleado, f.empleado.id);
  assert.equal(logs[0].motivo, body.motivo);
  assert.equal(JSON.parse(logs[0].datos_anteriores).cuotas[1].fecha_vencimiento, objetivo);
  await permisos(f, [{ negocio_id: f.negocio.id, permisos: { 'clientes.ver': true } }]);
  assert.equal((await api(ruta(f), f.token)).status, 403);
  assert.equal((await api(ruta(f), f.token, 'PATCH', solicitud(empleadoVista))).status, 403);
});

test('Permiso cuotas: exige clientes.ver y cuotas.editar en el mismo negocio, incluso con cliente compartido', async () => {
  const f = await fixture();
  const otro = await crearNegocio({ nombre: 'Otro negocio cuotas QA', mora_valor: 0 });
  await vincularClienteNegocio(f.cliente.id, otro.id);
  const ventaAjena = await crearVenta({ negocio_id: otro.id, cliente_id: f.cliente.id, fecha: compra, modalidad: 'unico', monto_total_centavos: 10000, plan: { fecha_limite: corregida } });
  await permisos(f, [
    { negocio_id: f.negocio.id, permisos: { 'cuotas.editar': true } },
    { negocio_id: otro.id, permisos: { 'clientes.ver': true } },
  ]);
  assert.equal((await api(ruta(f), f.token)).status, 403, 'No combina permisos de negocios distintos');
  const body = solicitud(await vista(f, adminToken));
  assert.equal((await api(ruta(f), f.token, 'PATCH', body)).status, 403);
  await permisos(f);
  assert.equal((await api(ruta(f), f.token)).status, 200, 'El cliente compartido no bloquea su financiación autorizada');
  const ajena = `/ventas/creditos/${ventaAjena.credito.id}/correccion?negocio_id=${otro.id}`;
  assert.equal((await api(ajena, f.token)).status, 403);
  assert.equal((await api(ajena, f.token, 'PATCH', body)).status, 403);
  assert.equal((await api(ruta(f, otro.id), f.token)).status, 403);
  assert.equal((await api(ruta(f, null), f.token)).status, 400, 'Requiere negocio explícito');
  assert.equal((await api(ruta(f, null), f.token, 'PATCH', body)).status, 400);
  assert.equal((await api(ruta(f, null), f.token, 'PATCH', { ...body, negocio_id: f.negocio.id })).status, 200);
});

test('Permiso cuotas: no permite modificar compra, entrega, total, producto, condiciones ni metadatos financieros de cuotas', async () => {
  const f = await fixture();
  await permisos(f);
  const v = await vista(f);
  const antes = await finanzas();
  const prohibidos = { monto_total_centavos: 200000, entrega_inicial_centavos: 0, fecha_inicio: addDays(compra, -1),
    fecha_entrega_producto: hoy, producto_descripcion: 'Producto ajeno', condiciones: 'Cambio contractual', negocio_id: randomUUID() };
  for (const [key, value] of Object.entries(prohibidos)) {
    const body = solicitud(v);
    body.datos[key] = value;
    const r = await api(ruta(f), f.token, 'PATCH', body);
    assert.equal(r.status, 400, `${key}: ${JSON.stringify(r.body)}`);
  }
  for (const extra of [{ saldo_pendiente_centavos: 0 }, { mora_generada_centavos: 0 }, { estado_manual: 'anulada' }, { numero: 99 }, { credito_id: randomUUID() }]) {
    const body = solicitud(v);
    Object.assign(body.datos.cuotas[1], extra);
    const r = await api(ruta(f), f.token, 'PATCH', body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  for (const extra of [{ solo_cuotas: false }, { usuario_id: admin.id }, { rol: 'administrador' }]) {
    const r = await api(ruta(f), f.token, 'PATCH', { ...solicitud(v), ...extra });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.deepEqual(await finanzas(), antes);
});

test('Permiso cuotas: conserva conjunto y orden de cuotas; rechaza altas, bajas, duplicados y cuotas de otra financiación', async () => {
  const f = await fixture();
  await permisos(f);
  const ajena = await crearVenta({ negocio_id: f.negocio.id, cliente_id: f.cliente.id, fecha: compra, modalidad: 'unico', monto_total_centavos: 7000, plan: { fecha_limite: corregida } });
  const v = await vista(f);
  const antes = await finanzas();
  const variantes = [
    qs => qs.slice(1),
    qs => [...qs, { monto_centavos: 5000, fecha_vencimiento: corregida }],
    qs => [...qs, { id: randomUUID(), monto_centavos: 5000, fecha_vencimiento: corregida }],
    qs => [qs[0], qs[0], qs[2]],
    qs => [qs[1], qs[0], qs[2]],
    qs => [qs[0], { ...qs[1], id: ajena.cuotas[0].id }, qs[2]],
  ];
  for (const cambiar of variantes) {
    const body = solicitud(v);
    body.datos.cuotas = cambiar(body.datos.cuotas);
    const response = await api(ruta(f), f.token, 'PATCH', body);
    assert.ok([400, 409].includes(response.status), JSON.stringify(response.body));
  }
  assert.deepEqual(await finanzas(), antes);
});

test('Permiso cuotas: protege cuotas saldadas incluso si una carga histórica no guardó fecha_saldada', async () => {
  const f = await fixture({ conPagos: true });
  await permisos(f);
  for (const legacy of [false, true]) {
    if (legacy) await db.prepare('UPDATE cuotas SET fecha_saldada=NULL WHERE id=?').run(f.venta.cuotas[0].id);
    const v = await vista(f);
    const antes = await finanzas();
    for (const cambios of [{ fecha_vencimiento: corregida }, { monto_centavos: 35000 }]) {
      const response = await api(ruta(f), f.token, 'PATCH', solicitud(v, 0, cambios));
      assert.equal(response.status, 409, JSON.stringify(response.body));
    }
    assert.deepEqual(await finanzas(), antes);
  }
});

test('Permiso cuotas: idempotencia conserva un solo cambio auditado; una solicitud reutilizada o una versión vieja devuelve 409', async () => {
  const f = await fixture();
  await permisos(f);
  const v = await vista(f);
  const body = solicitud(v);
  const response = await api(ruta(f), f.token, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await finanzas();
  const retry = await api(ruta(f), f.token, 'PATCH', body);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const diferente = structuredClone(body);
  diferente.datos.cuotas[1].fecha_vencimiento = addDays(corregida, 1);
  assert.equal((await api(ruta(f), f.token, 'PATCH', diferente)).status, 409);
  assert.equal((await api(ruta(f), f.token, 'PATCH', { ...diferente, solicitud_id: randomUUID() })).status, 409);
  assert.deepEqual(await finanzas(), despues);
  assert.equal((await db.prepare("SELECT count(*)::int cantidad FROM auditoria WHERE entidad='credito' AND entidad_id=? AND accion='corregir_financiacion'").get(f.venta.credito.id)).cantidad, 1);
});

test('Permiso cuotas: administrador conserva editor completo y autorización previa sin negocio explícito', async () => {
  const f = await fixture();
  const v = await vista(f, adminToken, null);
  assert.ok(v.venta);
  assert.equal(v.credito.monto_total_centavos, 100000);
  assert.notEqual(v.solo_cuotas, true);
  const body = { version: v.version, motivo: 'Administrador conserva alcance completo QA', solicitud_id: randomUUID(), confirmar_correccion_pagos: true,
    datos: { monto_total_centavos: v.credito.monto_total_centavos, entrega_inicial_centavos: v.credito.entrega_inicial_centavos,
      fecha_inicio: v.credito.fecha_inicio, producto_descripcion: 'Descripción corregida por dueño', condiciones: 'Condiciones corregidas por dueño', cuotas: datosCuotas(v) } };
  const response = await api(ruta(f, null), adminToken, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const despues = await credito(f);
  assert.equal(despues.credito.producto_descripcion, body.datos.producto_descripcion);
  assert.equal(despues.credito.condiciones, body.datos.condiciones);
  assert.equal((await api(ruta(f), null)).status, 401);
});

test('Permiso cuotas: un gestor de empleados sin este permiso no puede otorgarlo a otra cuenta ni elevar su propia cuenta', async () => {
  const f = await fixture();
  const gestor = await crearUsuario({ email: `${randomUUID()}@gestor-cuotas.invalid`, rol: 'empleado', password_hash: 'unused' });
  await asignarNegocio(gestor.id, f.negocio.id, { 'empleados.gestionar': true, 'clientes.ver': true });
  const token = firmarToken(gestor);
  const body = { negocios: [{ negocio_id: f.negocio.id, permisos: { 'clientes.ver': true, 'cuotas.editar': true } }] };
  for (const usuario of [f.empleado.id, gestor.id]) {
    const response = await api(`/usuarios/${usuario}`, token, 'PATCH', body);
    assert.equal(response.status, 403, JSON.stringify(response.body));
  }
  assert.equal((await api(ruta(f), f.token)).status, 403);
  assert.equal((await api(ruta(f), token)).status, 403);
});

test('Permiso cuotas: las invitaciones conservan una asignación explícita y nunca conceden el permiso por defecto', async () => {
  const f = await fixture();
  for (const habilitado of [false, true]) {
    const asignados = { 'clientes.ver': true, ...(habilitado ? { 'cuotas.editar': true } : {}) };
    const invitar = await api('/invitaciones', adminToken, 'POST', {
      email: `${randomUUID()}@invitacion-cuotas.invalid`, nombre: 'Invitado QA',
      negocios: [{ negocio_id: f.negocio.id, permisos: asignados }],
    });
    assert.equal(invitar.status, 201, JSON.stringify(invitar.body));
    assert.equal(invitar.body.emailEnviado, false, 'El entorno aislado no envía correos');
    const aceptar = await api('/auth/invitacion/aceptar', null, 'POST', {
      token: invitar.body.token, nombre: 'Invitado QA', password: 'solo-qa-local-cuotas-123',
    });
    assert.equal(aceptar.status, 201, JSON.stringify(aceptar.body));
    assert.equal((await api(ruta(f), aceptar.body.token)).status, habilitado ? 200 : 403);
  }
});
