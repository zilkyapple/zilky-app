import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser(respond = () => ({ seguimiento_estado: 'volver_a_contactar', seguimiento_nota: 'Nota guardada <QA>' })) {
  const dom = new JSDOM(page, { url: 'https://zilky.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [];
  w.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const body = await respond(url, opts);
    return { ok: !body?.error, status: body?.error ? 403 : 200, json: async () => body };
  };
  w.eval(purifier); w.eval(source + '\nwindow.qaState = state;');
  w.qaState.usuario = { rol: 'administrador' };
  w.qaState.negocioActual = 'negocio-qa';
  return { w, calls, el: id => w.document.getElementById(id) };
}

test('Seguimiento: reabrir carga el estado y la nota persistidos del negocio actual', async () => {
  const b = browser();
  try {
    await b.w.abrirEditarSeguimiento('cliente-qa');
    assert.equal(b.el('segEstado').value, 'volver_a_contactar');
    assert.equal(b.el('segNota').value, 'Nota guardada <QA>');
    assert.equal(b.calls[0].url, '/api/clientes/cliente-qa?negocio_id=negocio-qa');
  } finally { b.w.close(); }
});

test('Seguimiento: guardar sin cambios conserva los valores existentes', async () => {
  const b = browser();
  try {
    await b.w.abrirEditarSeguimiento('cliente-qa');
    b.el('btnGuardarSeguimiento').click(); await tick();
    const patch = b.calls.find(c => c.opts.method === 'PATCH');
    assert.equal(JSON.parse(patch.opts.body).seguimiento_estado, 'volver_a_contactar');
    assert.equal(JSON.parse(patch.opts.body).seguimiento_nota, 'Nota guardada <QA>');
  } finally { b.w.close(); }
});

test('Seguimiento: lectura denegada no ofrece un formulario vacío que sobrescriba datos', async () => {
  const b = browser(() => ({ error: 'No tenés permiso' }));
  try {
    await b.w.abrirEditarSeguimiento('cliente-qa');
    assert.equal(b.el('btnGuardarSeguimiento'), null);
    assert.match(b.el('activeSheet').textContent, /No tenés permiso/);
    assert.equal(b.calls.length, 1);
  } finally { b.w.close(); }
});

test('Seguimiento: una respuesta tardía no reemplaza otro modal', async () => {
  let finish;
  const b = browser(() => new Promise(resolve => { finish = resolve; }));
  try {
    const pending = b.w.abrirEditarSeguimiento('cliente-qa'); await tick();
    b.w.openSheet('<p>Otro formulario</p>');
    assert.equal(typeof finish, 'function');
    finish({ seguimiento_nota: 'Vieja' }); await pending;
    assert.equal(b.el('activeSheet').textContent, 'Otro formulario');
    assert.equal(b.el('segNota'), null);
  } finally { b.w.close(); }
});

test('Seguimiento: cambiar de negocio impide guardar el editor anterior', async () => {
  const b = browser();
  try {
    await b.w.abrirEditarSeguimiento('cliente-qa');
    b.w.qaState.negocioActual = 'otro-negocio';
    b.el('btnGuardarSeguimiento').click(); await tick();
    assert.equal(b.calls.filter(c => c.opts.method === 'PATCH').length, 0);
  } finally { b.w.close(); }
});

test('Seguimiento: un error al guardar conserva los cambios y habilita reintentar', async () => {
  let finish;
  const b = browser((url, opts) => opts.method === 'PATCH' ? new Promise(resolve => { finish = resolve; }) : { seguimiento_nota: 'Inicial' });
  try {
    await b.w.abrirEditarSeguimiento('cliente-qa');
    b.el('segNota').value = 'Actualizada';
    const button = b.el('btnGuardarSeguimiento');
    button.click(); button.click(); await tick();
    assert.equal(b.calls.filter(c => c.opts.method === 'PATCH').length, 1);
    assert.equal(button.disabled, true);
    finish({ error: 'Error temporal' }); await tick(); await tick();
    assert.equal(button.disabled, false);
    assert.equal(b.el('segNota').value, 'Actualizada');
  } finally { b.w.close(); }
});
