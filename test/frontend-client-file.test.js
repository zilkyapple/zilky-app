import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const purifier = fs.readFileSync(new URL('../public/vendor/purify.min.js', import.meta.url), 'utf8');
const cliente = {
  id: 'cliente-qa', nombre: 'QA', apellido: 'Ficha', dni: 'TEST-DNI',
  direccion: '<img src=x onerror=alert(1)>', notas: 'Nota\nsegunda línea',
  seguimiento_estado: 'volver_a_contactar', seguimiento_nota: '<script>malicioso()</script>',
  seguimiento_fecha: '2026-10-04', historial: null, creditos: [], pagos: [],
};
function browser({ permisos = {}, admin = false, respuesta = cliente, recibos = [] } = {}) {
  const dom = new JSDOM(page, { url: 'https://zilky.test/#/clientes/cliente-qa', runScripts: 'outside-only' });
  const w = dom.window, calls = [];
  w.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => url.startsWith('/api/comprobantes?') ? recibos : respuesta }; };
  w.eval(purifier); w.eval(source + '\nwindow.qaState = state;');
  w.qaState.usuario = admin ? { rol: 'administrador' } : { rol: 'empleado', negocios: [
    { negocio_id: 'qa', activo: 1, permisos: { 'clientes.ver': true, ...permisos } },
    { negocio_id: 'otro', activo: 1, permisos: { 'comprobantes.ver': true } },
  ] };
  w.qaState.negocioActual = 'qa';
  w.qaState.negocios = [{ id: 'qa', nombre: 'Negocio QA' }, { id: 'otro', nombre: 'Otro negocio' }];
  return { w, calls, view: w.document.getElementById('view') };
}

test('Ficha: solo lectura muestra datos y seguimiento sin cargar ni mostrar finanzas', async () => {
  const b = browser();
  try {
    await b.w.render();
    assert.match(b.view.textContent, /Datos personales/);
    assert.match(b.view.textContent, /TEST-DNI/);
    assert.match(b.view.textContent, /Volver a contactar/);
    assert.match(b.view.textContent, /No tenés permiso para ver el historial financiero/);
    assert.equal(b.view.querySelector('.debt-hero, .credito-card, .hist-row'), null);
    assert.equal(b.view.querySelector('[data-action="editar-seguimiento"]').hidden, true);
    assert.deepEqual(b.calls, ['/api/clientes/cliente-qa?negocio_id=qa']);
  } finally { b.w.close(); }
});

test('Ficha: datos personales y notas se presentan como texto seguro', async () => {
  const b = browser();
  try {
    await b.w.render();
    assert.equal(b.view.querySelector('img, script, [onerror]'), null);
    assert.match(b.view.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(b.view.textContent, /<script>malicioso\(\)<\/script>/);
  } finally { b.w.close(); }
});

test('Ficha: selector no ofrece un negocio sin clientes.ver aunque tenga otro permiso', async () => {
  const b = browser();
  try {
    await b.w.render();
    assert.ok(b.view.querySelector('[data-action="ver-cliente-negocio"][data-id="qa"]'));
    assert.equal(b.view.querySelector('[data-action="ver-cliente-negocio"][data-id="otro"]'), null);
  } finally { b.w.close(); }
});

test('Ficha: comprobantes en otro negocio no habilita el acceso en el seleccionado', async () => {
  const b = browser();
  try {
    await b.w.render();
    assert.equal(b.view.querySelector('a[href^="#/comprobantes/cliente/"]'), null);
  } finally { b.w.close(); }
});

test('Ficha: lector de comprobantes puede abrirlos sin recibir dashboard financiero', async () => {
  const b = browser({ permisos: { 'comprobantes.ver': true } });
  try {
    await b.w.render();
    assert.equal(b.view.querySelector('a[href^="#/comprobantes/cliente/"]').getAttribute('href'), '#/comprobantes/cliente/cliente-qa');
    assert.equal(b.view.querySelector('.debt-hero'), null);
    assert.equal(b.calls.length, 1, 'La ficha no precarga comprobantes sin abrir su vista');
  } finally { b.w.close(); }
});

test('Ficha: vista global exige seleccionar negocio antes de consultar comprobantes', async () => {
  const b = browser({ admin: true });
  try {
    b.w.qaState.negocioActual = null;
    await b.w.render();
    assert.equal(b.view.querySelector('a[href^="#/comprobantes/cliente/"]'), null);
    b.w.history.replaceState({}, '', '/#/comprobantes/cliente/cliente-qa');
    await b.w.render();
    assert.match(b.view.textContent, /Elegí un negocio/);
    assert.equal(b.calls.length, 1);
  } finally { b.w.close(); }
});

test('Ficha: sin datos opcionales conserva contacto y estado vacío explícito', async () => {
  const b = browser({ respuesta: { id: 'cliente-qa', nombre: 'QA', apellido: 'Vacío', historial: null } });
  try {
    await b.w.render();
    assert.match(b.view.textContent, /Sin datos adicionales registrados/);
    assert.match(b.view.textContent, /Sin nota de seguimiento/);
    assert.doesNotMatch(b.view.textContent, /undefined|null/);
    assert.equal(b.view.querySelector('a[href="#/clientes"]').textContent.trim(), 'Volver a clientes');
  } finally { b.w.close(); }
});

test('Ficha financiera: conserva pagos mayores a doce, anulaciones y entrega inicial', async () => {
  const pagos = Array.from({ length: 14 }, (_, i) => ({ id: String(i), tipo: i === 0 ? 'entrega_inicial' : 'cuota', medio_pago: 'efectivo', fecha_hora: '2026-10-04T12:00:00', monto_centavos: 100 + i, anulado: i === 13 }));
  const b = browser({ admin: true, respuesta: { ...cliente, historial: { cantidadCompras: 1, cuotasPagadasATiempo: 0, cuotasPagadasTarde: 0, atrasoPromedioDias: 0, atrasoMaximoDias: 0, totalCobradoCentavos: 1300, comprasFinalizadas: 0 }, deudaTotalCentavos: 1000, pagos } });
  try {
    await b.w.render();
    assert.equal(b.view.querySelectorAll('.hist-row').length, 14);
    assert.match(b.view.textContent, /Entrega inicial/);
    assert.match(b.view.querySelectorAll('.hist-row')[13].textContent, /ANULADO/);
    assert.ok(b.view.querySelector('.debt-hero'));
    assert.equal(b.view.querySelectorAll('details').length, 5);
  } finally { b.w.close(); }
});

test('Comprobantes de ficha: consulta filtra cliente y negocio, con regreso a la ficha', async () => {
  const b = browser({ permisos: { 'comprobantes.ver': true } });
  try {
    b.w.history.replaceState({}, '', '/#/comprobantes/cliente/cliente-qa');
    await b.w.render();
    assert.deepEqual(b.calls, ['/api/comprobantes?negocio_id=qa&cliente_id=cliente-qa']);
    assert.ok(b.view.querySelector('a[href="#/clientes/cliente-qa"]'));
    assert.match(b.view.textContent, /Solo comprobantes de este cliente/);
  } finally { b.w.close(); }
});

for (const denegado of ['clientes.ver', 'comprobantes.ver']) {
  test('Comprobantes de ficha: acceso directo sin ' + denegado + ' no consulta datos', async () => {
    const b = browser({ permisos: { 'comprobantes.ver': true, [denegado]: false } });
    try {
      b.w.history.replaceState({}, '', '/#/comprobantes/cliente/cliente-qa');
      await b.w.render();
      assert.match(b.view.textContent, /No tenés permiso/);
      assert.equal(b.calls.length, 0);
    } finally { b.w.close(); }
  });
}

test('Comprobantes de ficha: lectura no concede anulación y cambiar negocio no mezcla permisos', async () => {
  const b = browser({ permisos: { 'comprobantes.ver': true }, recibos: [{ id: 'recibo', numero: 'QA-1', estado: 'vigente', tipo_pago: 'cuota', monto_centavos: 100, fecha_hora: '2026-10-04T12:00:00' }] });
  try {
    b.w.history.replaceState({}, '', '/#/comprobantes/cliente/cliente-qa');
    await b.w.render();
    assert.match(b.view.textContent, /QA-1/);
    assert.equal(b.view.querySelector('[data-action="anular-comprobante"]'), null);
    b.w.qaState.negocioActual = 'otro'; await b.w.render();
    assert.match(b.view.textContent, /No tenés permiso/);
    assert.equal(b.calls.length, 1);
  } finally { b.w.close(); }
});
