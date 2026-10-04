import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settledClients = [
  { id: 'ana', nombre: 'Ana', apellido: 'García', telefono: '351111222', dni: '111', instagram: '@ana', total_compras: 1 },
  { id: 'bruno', nombre: 'Bruno', apellido: 'Pérez', telefono: '351333444', dni: '222', instagram: '@bruno', total_compras: 2 },
];
function browser() {
  const dom = new JSDOM(page, { url: 'https://zilky.test/#/clientes', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, posts = [], reads = [];
  w.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return new Promise(resolve => posts.push({ url, body: JSON.parse(opts.body), finish: (body, status = 201) => resolve({ ok: status < 400, status, json: async () => body }) }));
    reads.push(url);
    return { ok: true, status: 200, json: async () => url.includes('/finalizados') ? settledClients : [] };
  };
  w.eval(purifier); w.eval(source + '\nwindow.qaState = state;');
  w.qaState.usuario = { rol: 'empleado', negocios: [{ negocio_id: 'qa', activo: 1, permisos: { 'clientes.ver': true, 'clientes.editar': true, 'cobranzas.ver': true } }] };
  w.qaState.negocios = [{ id: 'qa', nombre: 'QA' }];
  w.qaState.negocioActual = 'qa';
  return { w, posts, reads, view: w.document.getElementById('view'), el: id => w.document.getElementById(id) };
}
async function createForm(b) {
  b.w.abrirCrearCliente();
  // Supports the old delayed form as well, so these tests reproduce its failures.
  await new Promise(resolve => setTimeout(resolve, 280));
  b.el('ncNombre').value = 'QA'; b.el('ncApellido').value = 'Cliente';
  return b.el('btnGuardarCliente');
}
const click = (b, button) => button.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true }));

test('Clientes: doble confirmación envía una sola alta al negocio del formulario', async () => {
  const b = browser();
  try {
    const button = await createForm(b); click(b, button); click(b, button);
    assert.equal(b.posts.length, 1); assert.equal(button.disabled, true);
    assert.equal(b.posts[0].body.negocio_id, 'qa');
    b.posts[0].finish({ id: 'nuevo' }); await tick();
  } finally { b.w.close(); }
});

test('Clientes: el cierre animado tras guardar no permite repetir el alta', async () => {
  const b = browser();
  try {
    const button = await createForm(b); click(b, button);
    b.posts[0].finish({ id: 'nuevo' }); await tick();
    click(b, button); assert.equal(b.posts.length, 1); assert.equal(button.disabled, true);
  } finally { b.w.close(); }
});

test('Clientes: una denegación conserva campos y permite un único reintento', async () => {
  const b = browser();
  try {
    const button = await createForm(b); click(b, button);
    b.posts[0].finish({ error: 'No tenés permiso' }, 403); await tick();
    assert.equal(button.disabled, false); assert.equal(b.el('ncApellido').value, 'Cliente');
    assert.match(b.el('toastRoot').textContent, /No tenés permiso/);
    click(b, button); click(b, button); assert.equal(b.posts.length, 2);
    b.posts[1].finish({ id: 'nuevo' }); await tick();
  } finally { b.w.close(); }
});

test('Clientes: campos obligatorios vacíos no envían ni bloquean el formulario', async () => {
  const b = browser();
  try {
    const button = await createForm(b); b.el('ncNombre').value = ' ';
    click(b, button); assert.equal(b.posts.length, 0); assert.equal(button.disabled, false);
  } finally { b.w.close(); }
});

test('Clientes: cambiar de negocio invalida el formulario anterior sin enviar un alta ajena', async () => {
  const b = browser();
  try {
    const button = await createForm(b); b.w.qaState.negocioActual = 'otro'; click(b, button);
    assert.equal(b.posts.length, 0);
  } finally { b.w.close(); }
});

test('Clientes: una respuesta tardía no cierra otro modal ni cambia de ficha', async () => {
  const b = browser();
  try {
    const button = await createForm(b); click(b, button);
    b.w.openSheet('<p>Otro formulario</p>');
    b.posts[0].finish({ id: 'nuevo' }); await tick();
    assert.equal(b.w.location.hash, '#/clientes');
    assert.equal(b.el('activeSheet').textContent, 'Otro formulario');
    assert.equal(b.el('sheetBackdrop').classList.contains('open'), true);
  } finally { b.w.close(); }
});

test('Clientes: cambiar de sesión invalida el formulario pendiente', async () => {
  const b = browser();
  try {
    const button = await createForm(b);
    b.w.localStorage.setItem('zilky_token', 'another-test-session'); click(b, button);
    assert.equal(b.posts.length, 0);
  } finally { b.w.close(); }
});

test('Clientes: revocar el permiso mientras el formulario está abierto impide el envío', async () => {
  const b = browser();
  try {
    const button = await createForm(b);
    b.w.qaState.usuario.negocios[0].permisos['clientes.editar'] = false; click(b, button);
    assert.equal(b.posts.length, 0);
  } finally { b.w.close(); }
});

test('Clientes: sin negocio no se abre un formulario de alta global', () => {
  const b = browser();
  try {
    b.w.qaState.negocioActual = null; b.w.abrirCrearCliente();
    assert.equal(b.el('btnGuardarCliente'), null); assert.equal(b.posts.length, 0);
  } finally { b.w.close(); }
});

test('Clientes: solo lectura no permite abrir el alta desde la función del formulario', () => {
  const b = browser();
  try {
    b.w.qaState.usuario.negocios[0].permisos['clientes.editar'] = false;
    b.w.abrirCrearCliente(); assert.equal(b.el('btnGuardarCliente'), null);
  } finally { b.w.close(); }
});

for (const [q, id] of [['ANA', 'ana'], ['Pérez', 'bruno'], ['351111', 'ana'], ['222', 'ana'], ['@bruno', 'bruno']]) {
  test('Clientes finalizados: buscar por ' + q + ' filtra dentro del negocio autorizado', async () => {
    const b = browser();
    try {
      b.w.qaState.clientesTab = 'finalizados';
      await b.w.viewClientes(b.view, q);
      const ids = [...b.view.querySelectorAll('[data-action="ver-cliente"]')].map(el => el.dataset.id);
      const expected = q === '222' ? ['ana', 'bruno'] : [id];
      assert.deepEqual(ids, expected);
      assert.deepEqual(b.reads, ['/api/clientes/finalizados?negocio_id=qa']);
    } finally { b.w.close(); }
  });
}

test('Clientes finalizados: una búsqueda sin coincidencias no vuelve a listar todos', async () => {
  const b = browser();
  try {
    b.w.qaState.clientesTab = 'finalizados'; await b.w.viewClientes(b.view, 'inexistente');
    assert.equal(b.view.querySelectorAll('[data-action="ver-cliente"]').length, 0);
    assert.match(b.view.textContent, /coincidan/);
  } finally { b.w.close(); }
});

test('Clientes finalizados: sin filtro conserva toda la lista autorizada', async () => {
  const b = browser();
  try {
    b.w.qaState.clientesTab = 'finalizados'; await b.w.viewClientes(b.view);
    assert.equal(b.view.querySelectorAll('[data-action="ver-cliente"]').length, 2);
  } finally { b.w.close(); }
});
