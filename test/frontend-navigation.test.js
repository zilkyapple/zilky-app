import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');
const negocios = [{ id: 'a', nombre: 'Negocio A' }, { id: 'b', nombre: 'Negocio B' }];
const cliente = { id: 'cliente-qa', nombre: 'Cliente', apellido: 'QA' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser(respond = () => []) {
  const dom = new JSDOM(page, { url: 'https://zilky.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [];
  w.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const result = await respond(url, opts);
    return { ok: !result?.error, status: result?.error ? 403 : 200, json: async () => result };
  };
  w.eval(purifier); w.eval(source + '\nwindow.qaState = state;');
  w.qaState.usuario = { rol: 'administrador' };
  w.qaState.negocios = negocios;
  w.qaState.negocioActual = 'a';
  return { w, calls, view: w.document.getElementById('view'), route(route) { w.history.replaceState({}, '', '/#/' + route); return w.render(); } };
}
function employee(b, permissions) {
  b.w.qaState.usuario = { rol: 'empleado', negocios: negocios.map(n => ({ negocio_id: n.id, activo: 1, permisos: permissions[n.id] || {} })) };
}

test('Venta desde una ficha conserva el cliente y consulta el negocio seleccionado', async () => {
  const b = browser(url => url.startsWith('/api/clientes/') ? cliente : []);
  try {
    await b.route('ventas/nueva/cliente-qa');
    assert.equal(b.view.querySelector('#vClienteId')?.value, cliente.id);
    assert.equal(b.view.querySelector('#vClienteBuscar')?.value, 'Cliente QA');
    assert.ok(b.calls.some(c => c.url === '/api/clientes/cliente-qa?negocio_id=a'));
  } finally { b.w.close(); }
});

test('Venta nueva sin ficha no intenta consultar un cliente llamado nueva', async () => {
  const b = browser();
  try { await b.route('ventas/nueva'); assert.ok(!b.calls.some(c => c.url.startsWith('/api/clientes/'))); }
  finally { b.w.close(); }
});

test('Venta global elige únicamente negocios con permiso para vender', async () => {
  const b = browser();
  try {
    employee(b, { a: { 'productos.ver': true }, b: { 'ventas.crear': true, 'productos.ver': true } });
    b.w.qaState.negocioActual = null;
    await b.route('ventas/nueva');
    const select = b.view.querySelector('#vNegocio');
    assert.equal(select?.value, 'b');
    assert.deepEqual([...select.options].map(o => o.value), ['b']);
    assert.ok(b.calls.some(c => c.url === '/api/productos?negocio_id=b'));
    assert.ok(!b.calls.some(c => c.url.includes('negocio_id=a')));
  } finally { b.w.close(); }
});

test('Venta manual permitida no exige permiso para leer productos', async () => {
  const b = browser(url => url.startsWith('/api/productos') ? { error: 'No tenés permiso' } : []);
  try {
    employee(b, { a: { 'ventas.crear': true, 'clientes.ver': true } });
    await b.route('ventas/nueva');
    assert.ok(b.view.querySelector('#btnCrearVenta'));
    assert.ok(!b.calls.some(c => c.url.startsWith('/api/productos')));
  } finally { b.w.close(); }
});

test('La búsqueda de clientes para vender filtra por el negocio de la venta', async () => {
  const b = browser();
  try {
    await b.route('ventas/nueva');
    const input = b.view.querySelector('#vClienteBuscar');
    input.value = 'Cliente'; input.dispatchEvent(new b.w.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 250));
    const call = b.calls.find(c => c.url.includes('/clientes?'));
    assert.ok(call);
    assert.equal(new URL(call.url, 'https://zilky.test').searchParams.get('negocio_id'), 'a');
  } finally { b.w.close(); }
});

test('El acceso a nueva venta desde la ficha también se oculta sin permiso', () => {
  const b = browser();
  try {
    employee(b, { a: { 'clientes.ver': true, 'dashboard_financiero.ver': true } });
    b.w.setHTML(b.view, '<a href="#/ventas/nueva/cliente-qa">Nueva venta</a>');
    assert.equal(b.view.querySelector('a').hidden, true);
  } finally { b.w.close(); }
});

test('Una respuesta financiera tardía no reemplaza la pantalla de otro negocio', async () => {
  let finish;
  const b = browser(url => url.includes('/dashboard/resumen') ? new Promise(resolve => { finish = resolve; }) : [{ id: 'p', nombre: 'Producto B', stock: 2 }]);
  try {
    const pending = b.route('inicio');
    await tick();
    b.w.qaState.negocioActual = 'b';
    await b.route('productos');
    finish({ vendidoTotalCentavos: 9876500 }); await pending;
    assert.match(b.view.textContent, /Producto B/);
    assert.doesNotMatch(b.view.textContent, /Vendido \(total\)|98.765/);
  } finally { b.w.close(); }
});

test('Un error de una ruta anterior no reemplaza la vista vigente', async () => {
  let finish;
  const b = browser(url => url.includes('/dashboard/resumen') ? new Promise(resolve => { finish = resolve; }) : [{ id: 'p', nombre: 'Producto B', stock: 2 }]);
  try {
    const pending = b.route('inicio'); await tick();
    await b.route('productos');
    finish({ error: 'Error anterior' }); await pending;
    assert.match(b.view.textContent, /Producto B/);
    assert.doesNotMatch(b.view.textContent, /Error anterior/);
  } finally { b.w.close(); }
});

test('La búsqueda conserva la respuesta más reciente aunque la anterior llegue después', async () => {
  let finish;
  const b = browser(url => url.includes('q=vieja') ? new Promise(resolve => { finish = resolve; }) : [{ ...cliente, nombre: 'Resultado actual' }]);
  try {
    await b.route('clientes');
    const pending = b.w.renderClientesList('vieja'); await tick();
    await b.w.renderClientesList('actual');
    finish([{ ...cliente, nombre: 'Resultado obsoleto' }]); await pending;
    assert.match(b.view.textContent, /Resultado actual/);
    assert.doesNotMatch(b.view.textContent, /Resultado obsoleto/);
  } finally { b.w.close(); }
});

test('Una búsqueda denegada retira los resultados anteriores y muestra el error', async () => {
  const b = browser(url => url.includes('q=denegada') ? { error: 'No tenés permiso' } : [cliente]);
  try {
    await b.route('clientes');
    await b.w.renderClientesList('denegada');
    assert.doesNotMatch(b.view.querySelector('#clientesList').textContent, /Cliente QA/);
    assert.match(b.view.querySelector('#clientesList').textContent, /No tenés permiso/);
  } finally { b.w.close(); }
});

for (const allowed of [true, false]) test('La ficha sin finanzas respeta acciones operativas ' + (allowed ? 'permitidas' : 'denegadas'), async () => {
  const b = browser(() => ({ ...cliente, historial: null, creditos: [], pagos: [] }));
  try {
    employee(b, { a: { 'clientes.ver': true, 'clientes.editar': allowed, 'ventas.crear': allowed } });
    await b.route('clientes/cliente-qa');
    assert.equal(b.view.querySelector('a[href="#/ventas/nueva/cliente-qa"]').hidden, !allowed);
    assert.equal(b.view.querySelector('[data-action="editar-seguimiento"]').hidden, !allowed);
    assert.match(b.view.textContent, /No tenés permiso para ver el historial financiero/);
    assert.equal(b.view.querySelector('.debt-hero, .credito-card'), null);
  } finally { b.w.close(); }
});

test('Cambio de cuenta en otra pestaña retira datos anteriores y carga permisos sin cerrar la nueva sesión', async () => {
  const user = { rol: 'empleado', negocios: [{ negocio_id: 'b', activo: 1, permisos: { 'productos.ver': true } }] };
  const b = browser(url => url === '/api/auth/yo' ? user : url === '/api/negocios' ? [negocios[1]] : []);
  try {
    b.w.setHTML(b.view, '<p>Finanzas de la cuenta anterior</p>');
    b.w.hideAuthScreen();
    b.w.localStorage.setItem('zilky_token', 'synthetic-new-session');
    b.w.dispatchEvent(new b.w.StorageEvent('storage', { key: 'zilky_token', oldValue: 'synthetic-old-session', newValue: 'synthetic-new-session', storageArea: b.w.localStorage }));
    assert.doesNotMatch(b.view.textContent, /Finanzas de la cuenta anterior/);
    await tick();
    assert.equal(b.w.qaState.usuario.rol, 'empleado');
    assert.deepEqual(Array.from(b.w.qaState.negocios, n => n.id), ['b']);
    assert.equal(b.w.localStorage.getItem('zilky_token'), 'synthetic-new-session');
    assert.equal(b.w.document.getElementById('authScreen').style.display, 'none');
  } finally { b.w.close(); }
});

test('Cerrar sesión en otra pestaña retira datos y menús de la cuenta anterior', async () => {
  const b = browser();
  try {
    b.w.setHTML(b.view, '<p>Información privada anterior</p>');
    b.w.openSheet('<p>Acciones privadas</p>');
    b.w.dispatchEvent(new b.w.StorageEvent('storage', { key: 'zilky_token', oldValue: 'synthetic-session', newValue: null, storageArea: b.w.localStorage }));
    assert.equal(b.w.qaState.usuario, null);
    assert.equal(b.view.textContent, '');
    assert.equal(b.w.document.getElementById('root').style.display, 'none');
    assert.equal(b.w.document.getElementById('sheetBackdrop').classList.contains('open'), false);
  } finally { b.w.close(); }
});

test('Una respuesta 401 de una sesión anterior no elimina la sesión nueva', async () => {
  const b = browser(); let finish;
  try {
    b.w.fetch = () => new Promise(resolve => { finish = resolve; });
    b.w.localStorage.setItem('zilky_token', 'synthetic-old-session');
    const pending = b.w.api('/clientes');
    b.w.localStorage.setItem('zilky_token', 'synthetic-new-session');
    finish({ ok: false, status: 401, json: async () => ({ error: 'Sesión anterior vencida' }) });
    await assert.rejects(pending, /Sesión anterior vencida/);
    assert.equal(b.w.localStorage.getItem('zilky_token'), 'synthetic-new-session');
  } finally { b.w.close(); }
});

test('Una carga anterior de cuenta no reemplaza los permisos de la cuenta nueva', async () => {
  let finish;
  const b = browser(url => url === '/api/auth/yo' ? new Promise(resolve => { finish = resolve; }) : negocios);
  try {
    b.w.localStorage.setItem('zilky_token', 'synthetic-old-session');
    const pending = b.w.arrancarApp(); await tick();
    b.w.localStorage.setItem('zilky_token', 'synthetic-new-session');
    employee(b, { b: { 'productos.ver': true } });
    finish({ rol: 'administrador' }); await pending;
    assert.equal(b.w.qaState.usuario.rol, 'empleado');
    assert.ok(!b.calls.some(c => c.url === '/api/negocios'));
  } finally { b.w.close(); }
});
