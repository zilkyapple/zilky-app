import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio, actualizarNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearUsuario } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { guardarCaja } from '../src/services/cajaService.js';
import { vistaCorreccionPago, previsualizarCorreccionPago, corregirFechaPago } from '../src/services/fechaPagoService.js';
import { todayAR, addDays } from '../src/lib/dates.js';

// setup-env.js bloquea conexiones externas y bases que no terminen en _test.
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const negocio = await crearNegocio({ nombre: 'QA cobros históricos', mora_valor: 0 });
const admin = await crearUsuario({ email: 'admin@pagos-historicos.invalid', password_hash: 'unused' });
const hoy = todayAR(), compra = addDays(hoy, -90), primeraCuota = addDays(hoy, -60);
const anterior = addDays(hoy, -45), posterior = addDays(hoy, -15);
const instante = fecha => `${fecha}T12:00:00-03:00`;
test.after(async () => { await pool.end(); });

async function operacion(n = negocio, valor = 100000) {
  const cliente = await crearCliente({ nombre: 'Cobro histórico', apellido: 'QA', negocio_id: n.id });
  return { ...await crearVenta({
    negocio_id: n.id, cliente_id: cliente.id, fecha: compra, modalidad: 'cuotas', monto_total_centavos: 3 * valor,
    plan: { cantidad_cuotas: 3, valor_cuota_centavos: valor, fecha_primera_cuota: primeraCuota }, usuario_id: admin.id,
  }), cliente, negocio: n };
}
async function pagar(venta, { fecha = posterior, monto = 150000, cuota = null } = {}) {
  return registrarPago({ credito_id: venta.credito.id, monto_centavos: monto, fecha_hora: instante(fecha), cuota_id: cuota, usuario_id: admin.id });
}
async function estado(venta) {
  const creditoId = venta.credito.id;
  return {
    credito: (await pool.query('SELECT * FROM creditos WHERE id=$1', [creditoId])).rows[0],
    cuotas: (await pool.query('SELECT * FROM cuotas WHERE credito_id=$1 ORDER BY numero,id', [creditoId])).rows,
    pagos: (await pool.query('SELECT * FROM pagos WHERE credito_id=$1 ORDER BY id', [creditoId])).rows,
    aplicaciones: (await pool.query('SELECT a.* FROM pago_aplicaciones a JOIN pagos p ON p.id=a.pago_id WHERE p.credito_id=$1 ORDER BY a.id', [creditoId])).rows,
    comprobantes: (await pool.query('SELECT * FROM comprobantes WHERE credito_id=$1 ORDER BY id', [creditoId])).rows,
    auditoria: (await pool.query("SELECT * FROM auditoria WHERE (entidad='credito' AND entidad_id=$1) OR (entidad='pago' AND entidad_id IN (SELECT id FROM pagos WHERE credito_id=$1)) ORDER BY id", [creditoId])).rows,
    incidencias: (await pool.query('SELECT * FROM credito_incidencias WHERE credito_id=$1 ORDER BY id', [creditoId])).rows,
    saldoFavor: (await pool.query('SELECT * FROM saldo_favor WHERE cliente_id=$1 AND negocio_id=$2', [venta.cliente.id, venta.negocio.id])).rows,
    caja: (await pool.query('SELECT * FROM caja_asientos WHERE negocio_id=$1 ORDER BY id', [venta.negocio.id])).rows,
  };
}
function distribucion(s, pagoId) {
  return s.aplicaciones.filter(a => a.pago_id === pagoId).map(a => ({
    numero: s.cuotas.find(q => q.id === a.cuota_id).numero, capital: a.capital_centavos, mora: a.interes_mora_centavos,
  })).sort((a, b) => a.numero - b.numero);
}
function comprobarReciboVigente(s, pagoId, saldo) {
  const vigentes = s.comprobantes.filter(c => c.pago_id === pagoId && c.estado !== 'anulado');
  assert.equal(vigentes.length, 1);
  assert.equal(vigentes[0].saldo_restante_centavos, saldo);
  return vigentes[0];
}
async function aprobarPlanActual(pagoId) {
  const vista = await vistaCorreccionPago(pagoId);
  const input = { version: vista.version, fecha_hora: vista.pago.fecha_hora, recalcular: true };
  const preview = await previsualizarCorreccionPago(pagoId, input);
  assert.ok(preview.advertencias.some(a => /configuración actual/.test(a)));
  await corregirFechaPago(pagoId, { ...input, version_preview: preview.version_preview,
    motivo: 'QA aprobar aplicación histórica al plan actual', solicitud_id: randomUUID(), confirmar: true }, admin.id);
}

test('Pagos históricos PG: ingresar un cobro anterior reconstruye por fecha, conserva pagos y emite recibos coherentes', async () => {
  const venta = await operacion();
  const tarde = await pagar(venta);
  const antes = await estado(venta);
  const temprano = await pagar(venta, { fecha: anterior, monto: 100000 });
  const despues = await estado(venta);
  assert.equal(temprano.recalculado, true);
  assert.deepEqual(despues.pagos.map(p => p.id).sort(), [tarde.pago.id, temprano.pago.id].sort());
  assert.equal(despues.pagos.find(p => p.id === tarde.pago.id).monto_centavos, 150000);
  assert.equal(despues.pagos.find(p => p.id === temprano.pago.id).monto_centavos, 100000);
  assert.deepEqual(distribucion(despues, temprano.pago.id), [{ numero: 1, capital: 100000, mora: 0 }]);
  assert.deepEqual(distribucion(despues, tarde.pago.id), [{ numero: 2, capital: 100000, mora: 0 }, { numero: 3, capital: 50000, mora: 0 }]);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [0, 0, 50000]);
  assert.equal(despues.cuotas[0].fecha_saldada, anterior);
  assert.equal(despues.cuotas[1].fecha_saldada, posterior);
  comprobarReciboVigente(despues, temprano.pago.id, 200000);
  const reemplazo = comprobarReciboVigente(despues, tarde.pago.id, 50000);
  assert.equal(despues.comprobantes.find(c => c.id === tarde.comprobante.id).estado, 'anulado');
  assert.equal(reemplazo.comprobante_original_id, tarde.comprobante.id);
  const reconstruccion = despues.auditoria.filter(a => a.accion === 'reconstruir_pagos_historicos');
  assert.equal(reconstruccion.length, 1);
  assert.deepEqual(JSON.parse(reconstruccion[0].datos_anteriores).aplicaciones.filter(a => a.pago_id === tarde.pago.id), antes.aplicaciones);
  assert.deepEqual(JSON.parse(reconstruccion[0].datos_nuevos).despues.aplicaciones, despues.aplicaciones);
  for (const p of [tarde.pago, temprano.pago]) assert.equal(despues.auditoria.filter(a => a.entidad === 'pago' && a.entidad_id === p.id && a.accion === 'crear').length, 1);
  assert.deepEqual(despues.caja, antes.caja);
});

test('Pagos históricos PG: conserva la cuota elegida y los IDs de distribuciones que no cambian', async () => {
  const venta = await operacion();
  const tarde = await pagar(venta, { monto: 70000, cuota: venta.cuotas[2].id });
  const antes = await estado(venta);
  const temprano = await pagar(venta, { fecha: anterior, monto: 100000 });
  const despues = await estado(venta);
  assert.equal(temprano.recalculado, true);
  const pagoDirigido = despues.pagos.find(p => p.id === tarde.pago.id);
  assert.equal(pagoDirigido.objetivo_registrado, true);
  assert.equal(pagoDirigido.cuota_objetivo_id, venta.cuotas[2].id);
  assert.deepEqual(distribucion(despues, tarde.pago.id), [{ numero: 3, capital: 70000, mora: 0 }]);
  assert.deepEqual(despues.aplicaciones.filter(a => a.pago_id === tarde.pago.id), antes.aplicaciones);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [0, 100000, 30000]);
  comprobarReciboVigente(despues, temprano.pago.id, 200000);
  comprobarReciboVigente(despues, tarde.pago.id, 130000);
});

test('Pagos históricos PG: un destino legacy desconocido rechaza la carga anterior y revierte todos sus cambios', async () => {
  const venta = await operacion();
  const tarde = await pagar(venta);
  await pool.query('UPDATE pagos SET objetivo_registrado=FALSE,cuota_objetivo_id=NULL,politica_mora=NULL WHERE id=$1', [tarde.pago.id]);
  const antes = await estado(venta);
  await assert.rejects(() => pagar(venta, { fecha: anterior, monto: 100000 }), e => e.status === 409 && /históricos sin destino/.test(e.message));
  assert.deepEqual(await estado(venta), antes);
});

test('Pagos históricos PG: aprobar la vista previa legacy adopta la política actual y permite después cargar un pago anterior', async () => {
  const venta = await operacion();
  const tarde = await pagar(venta);
  await pool.query('UPDATE pagos SET objetivo_registrado=FALSE,cuota_objetivo_id=NULL,politica_mora=NULL WHERE id=$1', [tarde.pago.id]);
  await aprobarPlanActual(tarde.pago.id);
  const aprobado = await estado(venta);
  assert.equal(aprobado.pagos[0].objetivo_registrado, true);
  assert.equal(aprobado.pagos[0].cuota_objetivo_id, null);
  assert.equal(aprobado.pagos[0].politica_mora.mora_valor, 0);
  const correccion = aprobado.auditoria.find(a => a.accion === 'corregir_fecha_pago');
  assert.equal(JSON.parse(correccion.datos_anteriores).pagos[0].politica_mora, null);
  assert.equal(JSON.parse(correccion.datos_anteriores).pagos[0].objetivo_registrado, false);
  const temprano = await pagar(venta, { fecha: anterior, monto: 100000 });
  assert.equal(temprano.recalculado, true);
  const despues = await estado(venta);
  assert.deepEqual(distribucion(despues, temprano.pago.id), [{ numero: 1, capital: 100000, mora: 0 }]);
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [0, 0, 50000]);
});

test('Pagos históricos PG: la rama de crédito ya saldado reasigna el saldo a favor al pago cronológicamente excedente', async () => {
  const venta = await operacion();
  const tarde = await pagar(venta, { monto: 300000 });
  const temprano = await pagar(venta, { fecha: anterior, monto: 150000 });
  const despues = await estado(venta);
  assert.equal(temprano.recalculado, true);
  assert.equal(temprano.remanente, 0);
  assert.equal(temprano.pago.saldo_posterior_centavos, 150000);
  assert.equal(despues.credito.estado, 'finalizado');
  assert.deepEqual(despues.cuotas.map(q => q.saldo_pendiente_centavos), [0, 0, 0]);
  assert.deepEqual(distribucion(despues, temprano.pago.id), [{ numero: 1, capital: 100000, mora: 0 }, { numero: 2, capital: 50000, mora: 0 }]);
  assert.deepEqual(distribucion(despues, tarde.pago.id), [{ numero: 2, capital: 50000, mora: 0 }, { numero: 3, capital: 100000, mora: 0 }]);
  assert.equal(despues.saldoFavor.length, 1);
  assert.equal(despues.saldoFavor[0].monto_centavos, 150000);
  comprobarReciboVigente(despues, temprano.pago.id, 150000);
  comprobarReciboVigente(despues, tarde.pago.id, 0);
  assert.equal(despues.pagos.reduce((s, p) => s + p.monto_centavos, 0), 450000);
});

test('Pagos históricos PG: un cambio de política de mora bloquea el recálculo automático y conserva la operación previa', async () => {
  const n = await crearNegocio({ nombre: 'QA política histórica modificada', mora_valor: 0 });
  const venta = await operacion(n);
  const tarde = await pagar(venta);
  assert.equal(tarde.pago.politica_mora.mora_valor, 0);
  await actualizarNegocio(n.id, { mora_valor: 5 });
  const antes = await estado(venta);
  await assert.rejects(() => pagar(venta, { fecha: anterior, monto: 100000 }), e => e.status === 409 && /configuración de mora cambió/.test(e.message));
  assert.deepEqual(await estado(venta), antes);
});

test('Pagos históricos PG: con mora real, ingresar en orden inverso reproduce los mismos saldos y distribuciones sin duplicar caja', async () => {
  const n = await crearNegocio({ nombre: 'QA cronología con intereses', mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana', dias_gracia: 7 });
  await guardarCaja(null, { nombre: 'Caja QA cronología', activa: true, arqueo: false, modalidad: 'negocio', negocios: [n.id] }, admin.id);
  const fechaTemprana = addDays(primeraCuota, 10), fechaTardia = addDays(primeraCuota, 40);
  const cronologica = await operacion(n, 10000000);
  await pagar(cronologica, { fecha: fechaTemprana, monto: 8000000 });
  await pagar(cronologica, { fecha: fechaTardia, monto: 12000000 });
  const esperado = await estado(cronologica);
  const inversa = await operacion(n, 10000000);
  const tarde = await pagar(inversa, { fecha: fechaTardia, monto: 12000000 });
  const antes = await estado(inversa);
  const temprano = await pagar(inversa, { fecha: fechaTemprana, monto: 8000000 });
  const real = await estado(inversa);
  const comparable = s => ({
    cuotas: s.cuotas.map(q => Object.fromEntries(['numero', 'monto_centavos', 'saldo_pendiente_centavos', 'mora_generada_centavos', 'mora_pagada_centavos', 'fecha_saldada', 'dias_atraso_al_pagar'].map(k => [k, q[k]]))),
    pagos: [...s.pagos].sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)).map(p => ({
      fecha: p.fecha_hora, monto: p.monto_centavos, saldoAnterior: p.saldo_anterior_centavos, saldoPosterior: p.saldo_posterior_centavos,
      aplicaciones: distribucion(s, p.id),
    })),
    saldoFavor: s.saldoFavor.reduce((suma, r) => suma + r.monto_centavos, 0),
  });
  assert.equal(temprano.recalculado, true);
  assert.ok(real.aplicaciones.reduce((s, a) => s + a.interes_mora_centavos, 0) > 0, 'La comparación debe incluir mora efectivamente cobrada');
  assert.deepEqual(comparable(real), comparable(esperado));
  assert.deepEqual(real.pagos.map(p => p.id).sort(), [tarde.pago.id, temprano.pago.id].sort());
  assert.equal(real.pagos.find(p => p.id === tarde.pago.id).monto_centavos, 12000000);
  assert.equal(real.pagos.find(p => p.id === temprano.pago.id).monto_centavos, 8000000);
  assert.equal(real.caja.length, antes.caja.length + 1);
  assert.ok(real.caja.every(a => a.tipo === 'cobro'));
  for (const p of real.pagos) {
    const asientos = real.caja.filter(a => a.pago_id === p.id);
    assert.equal(asientos.length, 1);
    assert.equal(asientos[0].monto, p.monto_centavos);
    comprobarReciboVigente(real, p.id, p.saldo_posterior_centavos);
  }
});
