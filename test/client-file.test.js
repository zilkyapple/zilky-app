import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { firmarToken } from '../src/lib/auth.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a = await crearNegocio({ nombre: 'Ficha A' });
const b = await crearNegocio({ nombre: 'Ficha B' });
const cliente = await crearCliente({ nombre: 'Compartido', apellido: 'QA', negocio_id: a.id });
await vincularClienteNegocio(cliente.id, b.id);
const otro = await crearCliente({ nombre: 'Otro', apellido: 'QA', negocio_id: a.id });
const lector = await crearUsuario({ email: 'ficha@qa.invalid', password_hash: 'unused', rol: 'empleado' });
await asignarNegocio(lector.id, a.id, { 'clientes.ver': true, 'comprobantes.ver': true });
await asignarNegocio(lector.id, b.id, { 'comprobantes.ver': true });
const recibos = [];
for (const [negocio, c] of [[a, cliente], [b, cliente], [a, otro]]) {
  const venta = await crearVenta({ negocio_id: negocio.id, cliente_id: c.id, modalidad: 'unico', monto_total_centavos: 1000, entrega_inicial_centavos: 100, plan: { fecha_limite: '2099-01-01' } });
  const pago = await registrarPago({ credito_id: venta.credito.id, monto_centavos: 200 });
  recibos.push({ inicial: venta.entregaInicial.comprobante.id, pago: pago.comprobante.id });
}
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
const base = `http://127.0.0.1:${server.address().port}/api`;
async function request(path, options = {}) {
  const r = await fetch(base + path, { ...options, headers: { Authorization: 'Bearer ' + firmarToken(lector), 'Content-Type': 'application/json' } });
  return { status: r.status, body: await r.json() };
}

test('Ficha PostgreSQL: comprobantes filtran simultáneamente cliente y negocio', async () => {
  const r = await request(`/comprobantes?negocio_id=${a.id}&cliente_id=${cliente.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(x => x.id).sort(), [recibos[0].inicial, recibos[0].pago].sort());
  assert.ok(r.body.every(x => x.cliente_id === cliente.id && x.negocio_id === a.id));
});

test('Ficha PostgreSQL: cliente compartido no concede comprobantes de otro negocio', async () => {
  const r = await request(`/comprobantes?negocio_id=${b.id}&cliente_id=${cliente.id}`);
  assert.equal(r.status, 403);
  assert.ok(!JSON.stringify(r.body).includes(recibos[1].pago));
});

test('Ficha PostgreSQL: lectura individual incluye finanzas sin conceder dashboard ni anulación', async () => {
  const detail = await request(`/clientes/${cliente.id}?negocio_id=${a.id}`);
  assert.equal(detail.status, 200); assert.equal(detail.body.historial.cantidadCompras, 1);
  assert.equal(detail.body.pagos.length, 2); assert.equal(detail.body.deudaTotalCentavos, 700);
  assert.equal((await request('/dashboard/resumen')).status, 403);
  const denied = await request(`/comprobantes/${recibos[0].pago}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'No autorizado QA' }) });
  assert.equal(denied.status, 403);
  const receipt = await request(`/comprobantes/${recibos[0].pago}`);
  assert.equal(receipt.status, 200); assert.equal(receipt.body.estado, 'emitido');
});
