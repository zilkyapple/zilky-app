// Browser checks use only a disposable local database; setup-env rejects remote URLs.
import './setup-env.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearNegocio } from '../src/repositories/negocios.js';
import { crearCliente } from '../src/repositories/clientes.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { addDays, todayAR } from '../src/lib/dates.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
await migrate();
await db.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const password = 'disposable-corrections-browser-123';
const password_hash = await bcrypt.hash(password, 10);
const admin = await crearUsuario({ email: 'owner@corrections-browser.invalid', nombre: 'Dueño QA', password_hash });
const employee = await crearUsuario({ email: 'employee@corrections-browser.invalid', nombre: 'Empleado QA', rol: 'empleado', password_hash });
const negocio = await crearNegocio({ nombre: 'Correcciones QA', mora_valor: 0 });
await asignarNegocio(employee.id, negocio.id, { 'clientes.ver': true, 'clientes.editar': true, 'cobranzas.ver': true, 'pagos.registrar': true, 'ventas.crear': true });
const cliente = await crearCliente({ nombre: 'Cliente', apellido: 'Correcciones QA', negocio_id: negocio.id });
const day = offset => addDays(todayAR(), offset);
const sale = await crearVenta({
  negocio_id: negocio.id, cliente_id: cliente.id, usuario_id: admin.id, fecha: day(-180),
  modalidad: 'cuotas', monto_total_centavos: 40000000, entrega_inicial_centavos: 10000000,
  plan: { cantidad_cuotas: 3, valor_cuota_centavos: 10000000, fecha_primera_cuota: day(-150) },
});
const paid = await registrarPago({ credito_id: sale.credito.id, usuario_id: admin.id, monto_centavos: 10000000, fecha_hora: `${day(-145)}T12:00:00-03:00` });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const output = process.env.BROWSER_ARTIFACTS || '/tmp/zilky-sales-browser';
await fs.mkdir(output, { recursive: true });
const errors = [], results = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const check = async (name, fn) => { await fn(); results.push({ name, passed: true }); console.log('PASS ' + name); };
const login = async (p, email) => {
  await p.goto(base);
  await p.locator('#authEmail').fill(email);
  await p.locator('#authPassword').fill(password);
  await p.locator('#authSubmit').click();
  await p.locator('#root').waitFor({ state: 'visible' });
  await p.locator('#negocioNombre').waitFor();
  await p.locator('.negocio-switch').click();
  await p.locator(`[data-action="elegir-negocio"][data-id="${negocio.id}"]`).click();
  await p.locator('#activeSheet').waitFor({ state: 'detached' });
  await p.evaluate(id => { location.hash = '#/clientes/' + id; }, cliente.id);
  await p.locator('.profile-name').waitFor();
};
const capture = async name => {
  await page.screenshot({ path: path.join(output, 'correcciones-' + name + '.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page overflow: ' + name);
  assert.equal(await page.locator('#activeSheet').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Editor overflow: ' + name);
};
try {
  await check('Owner corrects pickup, advance and paid-installment dates with an explicit review', async () => {
    await login(page, admin.email);
    await page.locator(`[data-action="corregir-financiacion"][data-credito="${sale.credito.id}"]`).click();
    await page.locator('#corFecha').fill(day(-183));
    await page.locator('#corEntregaFecha').fill(day(-185));
    await page.locator('#corCuotas .corVence').first().fill(day(-148));
    await page.locator('#corMotivo').fill('Fechas corregidas al pasar el cuaderno, prueba QA');
    assert.equal(await page.locator('#corCuotas .corVence').first().isEnabled(), true);
    await capture('fechas-movil-oscuro');
    await page.emulateMedia({ colorScheme: 'light' });
    await capture('fechas-movil-claro');
    await page.setViewportSize({ width: 834, height: 1112 });
    await capture('fechas-tablet-claro');
    await page.emulateMedia({ colorScheme: 'dark' });
    await capture('fechas-tablet-oscuro');
    await page.locator('#corRevisar').click();
    await page.locator('#corReview').waitFor({ state: 'visible' });
    assert.match(await page.locator('#corReview').innerText(), /Fecha de retiro del producto/);
    await page.locator('#corConfirmar').check();
    const response = page.waitForResponse(r => r.url().includes(`/ventas/creditos/${sale.credito.id}/correccion`) && r.request().method() === 'PATCH');
    await page.locator('#corGuardar').click();
    assert.equal((await response).status(), 200);
    await page.locator('#activeSheet').waitFor({ state: 'detached' });
    const credito = await db.prepare('SELECT * FROM creditos WHERE id=?').get(sale.credito.id);
    const cuota = await db.prepare('SELECT * FROM cuotas WHERE id=?').get(sale.cuotas[0].id);
    assert.equal(credito.fecha_inicio, day(-183));
    assert.equal(cuota.fecha_vencimiento, day(-148));
    assert.equal(cuota.fecha_saldada, day(-145));
    assert.equal(cuota.saldo_pendiente_centavos, 0);
    const initial = await db.prepare("SELECT * FROM pagos WHERE credito_id=? AND tipo='entrega_inicial' AND anulado=0").get(sale.credito.id);
    assert.equal(initial.fecha_hora.slice(0, 10), day(-185));
    assert.equal((await db.prepare('SELECT anulado FROM pagos WHERE id=?').get(sale.entregaInicial.pago.id)).anulado, 1);
  });
  await check('Owner previews and corrects one receipt without creating a second debt', async () => {
    await page.locator('summary').filter({ hasText: 'Historial de pagos (' }).click();
    await page.locator(`[data-action="corregir-pago"][data-id="${paid.pago.id}"]`).click();
    await page.locator('#corPagoFecha').fill(`${day(-144)}T14:30:00`);
    await page.locator('#corPagoMedio').selectOption('transferencia');
    await page.locator('#corPagoMotivo').fill('Fecha y medio del pago corregidos, prueba QA');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('pago-movil-oscuro');
    await page.locator('#corPagoRevisar').click();
    await page.locator('#corPagoReview').waitFor({ state: 'visible' });
    assert.match(await page.locator('#corPagoReview').innerText(), /Capital pendiente antes[\s\S]*Capital pendiente después/);
    await page.emulateMedia({ colorScheme: 'light' });
    await capture('revision-pago-movil-claro');
    await page.locator('#corPagoConfirmar').check();
    const response = page.waitForResponse(r => r.url().includes(`/pagos/${paid.pago.id}/correccion`) && r.request().method() === 'PATCH');
    await page.locator('#corPagoGuardar').click();
    const r = await response;
    assert.equal(r.status(), 200);
    const saved = await r.json();
    await page.locator('#activeSheet').waitFor({ state: 'detached' });
    const replacement = await db.prepare('SELECT * FROM pagos WHERE id=?').get(saved.reemplazo_id);
    assert.equal(replacement.monto_centavos, paid.pago.monto_centavos);
    assert.equal(replacement.fecha_hora.slice(0, 10), day(-144));
    assert.equal(replacement.medio_pago, 'transferencia');
    assert.equal((await db.prepare('SELECT anulado FROM pagos WHERE id=?').get(paid.pago.id)).anulado, 1);
    assert.equal((await db.prepare('SELECT sum(saldo_pendiente_centavos) saldo FROM cuotas WHERE credito_id=?').get(sale.credito.id)).saldo, 20000000);
    assert.equal(Number((await db.prepare('SELECT count(*) cantidad FROM creditos WHERE cliente_id=?').get(cliente.id)).cantidad), 1);
  });
  await check('An employee can inspect the client but has no financial correction actions', async () => {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    p.on('pageerror', e => errors.push(e.message));
    await login(p, employee.email);
    await p.locator('summary').filter({ hasText: 'Historial de pagos (' }).waitFor();
    assert.equal(await p.locator('[data-action="corregir-financiacion"],[data-action="corregir-pago"]').count(), 0);
    assert.match(await p.locator('.profile-name').innerText(), /Cliente Correcciones QA/);
    await p.screenshot({ path: path.join(output, 'correcciones-empleado.png'), fullPage: true });
    await p.close();
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'correcciones-resultado.json'), JSON.stringify({ results, javascriptErrors: errors }, null, 2));
  console.log(`${results.length} corrections E2E checks passed`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'correcciones-fallo.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'correcciones-fallo.html'), await page.content());
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}
