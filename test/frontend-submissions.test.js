import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const dom = new JSDOM(page, { url: 'https://zilky.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, submissions = [];
  w.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return new Promise(resolve => submissions.push({ url, body: JSON.parse(opts.body), finish: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }) }));
    return { ok: true, status: 200, json: async () => [] };
  };
  w.eval(purifier); w.eval(source + '\nwindow.qaState = state;');
  w.qaState.usuario = { rol: 'administrador' };
  w.qaState.negocios = [{ id: 'qa', nombre: 'QA' }];
  w.qaState.negocioActual = 'qa';
  return { w, submissions, view: w.document.getElementById('view') };
}
async function sale(b) {
  await b.w.viewVentaNueva(b.view);
  b.view.querySelector('#vClienteId').value = 'cliente-qa';
  b.view.querySelector('#vMontoTotal').value = '1200';
  b.view.querySelector('#vEntrega').value = '300';
  return b.view.querySelector('#btnCrearVenta');
}
async function payment(b) {
  await b.w.abrirRegistrarPago('credito-qa', 100);
  return b.w.document.getElementById('btnConfirmarPago');
}
const click = (b, button) => button.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true }));

test('Venta: dos confirmaciones mientras espera la red envían una sola operación', async () => {
  const b = browser();
  try {
    const button = await sale(b), first = b.w.submitVenta();
    b.w.submitVenta();
    assert.equal(b.submissions.length, 1);
    assert.equal(button.disabled, true);
    assert.equal(b.submissions[0].body.entrega_inicial_centavos, 30000);
    b.submissions[0].finish({}); await first;
  } finally { b.w.close(); }
});

test('Venta: una confirmación exitosa permanece bloqueada hasta cambiar de pantalla', async () => {
  const b = browser();
  try {
    const button = await sale(b), pending = b.w.submitVenta();
    b.submissions[0].finish({}); await pending;
    assert.equal(button.disabled, true);
    b.w.submitVenta();
    assert.equal(b.submissions.length, 1);
  } finally { b.w.close(); }
});

test('Venta: una respuesta rechazada permite corregir y reintentar sin duplicar el intento', async () => {
  const b = browser();
  try {
    const button = await sale(b), first = b.w.submitVenta();
    b.submissions[0].finish({ error: 'Venta inválida' }, 400); await first;
    assert.equal(button.disabled, false);
    const retry = b.w.submitVenta();
    assert.equal(button.disabled, true);
    assert.equal(b.submissions.length, 2);
    b.submissions[1].finish({}); await retry;
  } finally { b.w.close(); }
});

test('Venta: falta de cliente no bloquea el formulario ni envía datos', async () => {
  const b = browser();
  try {
    const button = await sale(b); b.view.querySelector('#vClienteId').value = '';
    await b.w.submitVenta();
    assert.equal(button.disabled, false);
    assert.equal(b.submissions.length, 0);
  } finally { b.w.close(); }
});

test('Pago: dos confirmaciones mientras espera la red envían un solo cobro', async () => {
  const b = browser();
  try {
    const button = await payment(b); click(b, button); click(b, button);
    assert.equal(b.submissions.length, 1);
    assert.equal(button.disabled, true);
    assert.equal(b.submissions[0].body.monto_centavos, 10000);
    b.submissions[0].finish({ comprobante: { numero: 'QA-1' } }); await tick();
  } finally { b.w.close(); }
});

test('Pago: el cierre animado del formulario no permite cobrar nuevamente', async () => {
  const b = browser();
  try {
    const button = await payment(b); click(b, button);
    b.submissions[0].finish({ comprobante: { numero: 'QA-1' } }); await tick();
    assert.equal(button.disabled, true);
    click(b, button);
    assert.equal(b.submissions.length, 1);
  } finally { b.w.close(); }
});

test('Pago: una denegación permite corregir y reintentar, con un único cobro en curso', async () => {
  const b = browser();
  try {
    const button = await payment(b); click(b, button);
    b.submissions[0].finish({ error: 'No tenés permiso' }, 403); await tick();
    assert.equal(button.disabled, false);
    click(b, button);
    assert.equal(button.disabled, true);
    assert.equal(b.submissions.length, 2);
    b.submissions[1].finish({ comprobante: { numero: 'QA-2' } }); await tick();
  } finally { b.w.close(); }
});

test('Pago: un importe inválido no bloquea el formulario ni envía datos', async () => {
  const b = browser();
  try {
    const button = await payment(b); b.w.document.getElementById('pagoMonto').value = '0';
    click(b, button);
    assert.equal(button.disabled, false);
    assert.equal(b.submissions.length, 0);
  } finally { b.w.close(); }
});
