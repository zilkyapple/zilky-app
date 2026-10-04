import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');

function browser(respond = () => []) {
  const dom = new JSDOM(page, { url: 'https://zilky.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [];
  w.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => respond(url, opts) };
  };
  w.eval(purifier);
  w.eval(source + '\nwindow.permissionState = state;');
  w.permissionState.usuario = { rol: 'empleado', negocios: [{ negocio_id: 'qa', activo: 1, permisos: { 'clientes.ver': true, 'productos.ver': true } }] };
  w.permissionState.negocios = [{ id: 'qa', nombre: 'QA' }];
  w.permissionState.negocioActual = 'qa';
  return { w, calls, view: w.document.getElementById('view') };
}

for (const route of ['inicio', 'cobrar', 'calendario', 'ventas/nueva', 'ventas/nueva/cliente-qa', 'comprobantes', 'empleados', 'configuracion']) {
  test('Acceso directo sin permiso bloquea la pantalla ' + route, async () => {
    const b = browser();
    try {
      b.w.history.replaceState({}, '', '/#/' + route);
      await b.w.render();
      assert.match(b.view.textContent, /No tenés permiso|Requiere administrador/);
      assert.equal(b.view.querySelector('input, select, button'), null);
      assert.equal(b.calls.length, 0, 'No carga datos ni formularios de la función restringida');
    } finally { b.w.close(); }
  });
}

test('Un permiso en otro negocio no habilita la ruta del negocio seleccionado', async () => {
  const b = browser();
  try {
    b.w.permissionState.negocioActual = 'otro';
    b.w.history.replaceState({}, '', '/#/clientes');
    await b.w.render();
    assert.match(b.view.textContent, /No tenés permiso/);
    assert.equal(b.calls.length, 0);
  } finally { b.w.close(); }
});

test('La lectura permitida de productos sigue mostrando el stock del negocio', async () => {
  const b = browser(() => [{ id: 'p', nombre: 'Producto QA', stock: 2, precio_financiado_centavos: 120000 }]);
  try {
    b.w.history.replaceState({}, '', '/#/productos');
    await b.w.render();
    assert.match(b.view.textContent, /Producto QA/);
    assert.match(b.view.textContent, /Stock: 2/);
    assert.equal(b.calls[0].url, '/api/productos?negocio_id=qa');
  } finally { b.w.close(); }
});

test('El administrador conserva acceso a la configuración del negocio', async () => {
  const b = browser(() => ({ id: 'qa', nombre: 'QA', recordatorio_dias: '[]', dias_gracia: 7, mora_valor: 2, mora_periodo: 'semana' }));
  try {
    b.w.permissionState.usuario = { rol: 'administrador' };
    b.w.history.replaceState({}, '', '/#/configuracion');
    await b.w.render();
    assert.ok(b.view.querySelector('#btnGuardarConfig'));
    assert.equal(b.calls[0].url, '/api/negocios/qa');
  } finally { b.w.close(); }
});

test('Sin cobranzas oculta filtros financieros y descarta un filtro previo', async () => {
  const b = browser(() => [{ id: 'c', nombre: 'Cliente QA', apellido: '' }]);
  try {
    b.w.permissionState.clientesTab = 'deuda';
    b.w.history.replaceState({}, '', '/#/clientes');
    await b.w.render();
    assert.match(b.view.textContent, /Cliente QA/);
    assert.equal(b.view.querySelector('[data-tab="deuda"], [data-tab="finalizados"]'), null);
    assert.equal(b.w.permissionState.clientesTab, 'todos');
    assert.ok(b.calls.every(call => !call.url.includes('con_deuda') && !call.url.includes('finalizados')));
  } finally { b.w.close(); }
});

test('Con cobranzas conserva los filtros financieros del negocio autorizado', async () => {
  const b = browser();
  try {
    b.w.permissionState.usuario.negocios[0].permisos['cobranzas.ver'] = true;
    b.w.history.replaceState({}, '', '/#/clientes');
    await b.w.render();
    assert.ok(b.view.querySelector('[data-tab="deuda"]'));
    assert.ok(b.view.querySelector('[data-tab="finalizados"]'));
  } finally { b.w.close(); }
});
