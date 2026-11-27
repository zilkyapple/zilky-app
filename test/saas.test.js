import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
// Edición de venta: se activa antes de cargar la app.
process.env.EDICION = 'saas';
process.env.PRECIO_MENSUAL_ARS = '10000';
process.env.DIAS_GRACIA = '10';
process.env.PLATAFORMA_ADMIN_EMAIL = 'duena@plataforma.invalid';
process.env.APP_URL = 'https://cobranzas.test';
process.env.MP_ACCESS_TOKEN = 'TEST-token-solo-para-tests';
delete process.env.MP_WEBHOOK_SECRET;
const { app } = await import('../src/app.js');
const { pool, conCuenta } = await import('../src/db/connection.js');
const { migrarPlataforma } = await import('../src/plataforma/esquema.js');
const { crearInvitacion } = await import('../src/repositories/invitaciones.js');

async function limpiar() {
  const { rows } = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^t_[a-z0-9]{16,40}$'");
  for (const { nspname } of rows) await pool.query(`DROP SCHEMA "${nspname}" CASCADE`);
  await pool.query('DROP TABLE IF EXISTS plataforma_eventos_pago, plataforma_funciones, plataforma_invitaciones, plataforma_directorio, plataforma_cuentas CASCADE');
}
await limpiar();
await migrarPlataforma();

// Mercado Pago simulado: solo se interceptan sus URLs.
const mp = { creadas: [], preapprovals: {}, pagos: {} };
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.mercadopago.com')) return fetchReal(url, opts);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/preapproval') && opts.method === 'POST') {
    const body = JSON.parse(opts.body); const id = `pre${mp.creadas.length + 1}`;
    mp.creadas.push(body);
    mp.preapprovals[id] = { id, status: 'pending', external_reference: body.external_reference, payer_email: body.payer_email, init_point: `https://mp.test/checkout/${id}` };
    return json(201, mp.preapprovals[id]);
  }
  let m = u.match(/\/preapproval\/([^/?]+)$/); if (m) return mp.preapprovals[m[1]] ? json(200, mp.preapprovals[m[1]]) : json(404, {});
  m = u.match(/\/authorized_payments\/([^/?]+)$/); if (m) return mp.pagos[m[1]] ? json(200, mp.pagos[m[1]]) : json(404, {});
  return json(404, {});
};

const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
async function api(path, token, method = 'GET', body, headers = {}) {
  const r = await fetchReal(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let datos = null; try { datos = JSON.parse(text); } catch { /* no JSON */ }
  return { status: r.status, body: datos, text };
}
const alta = (email, extra = {}) => api('/api/plataforma/registro', null, 'POST', { nombre: 'Titular QA', negocio: `Negocio ${email}`, telefono: '351 555 0000', email, password: 'secreto123', ...extra });
const cuentaDe = async (email) => (await pool.query('SELECT * FROM plataforma_cuentas WHERE email=$1', [email])).rows[0];
const webhook = (type, id) => api(`/api/plataforma/mercadopago/webhook?type=${type}&data.id=${id}`, null, 'POST', { type, data: { id } });

let A, B;
test('Alta: crea la cuenta, su espacio propio y el link de Mercado Pago en pesos', async () => {
  const r = await alta('ana@negocio.invalid');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.estado, 'pendiente_pago');
  assert.equal(r.body.init_point, 'https://mp.test/checkout/pre1');
  assert.deepEqual(mp.creadas[0].auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 10000, currency_id: 'ARS' });
  assert.equal(mp.creadas[0].back_url, 'https://cobranzas.test/app#/suscripcion');
  A = { token: r.body.token, cuenta: await cuentaDe('ana@negocio.invalid') };
  assert.match(A.cuenta.esquema, /^t_[a-z0-9]{20}$/);
  assert.equal(A.cuenta.telefono, '351 555 0000');
});

test('Sin pago la app queda bloqueada, pero se puede ver el estado y pagar', async () => {
  const r = await api('/api/negocios', A.token);
  assert.equal(r.status, 402); assert.equal(r.body.code, 'SUSCRIPCION_INACTIVA');
  const yo = await api('/api/auth/yo', A.token);
  assert.equal(yo.status, 200); assert.equal(yo.body.plataforma.cuenta.estado, 'pendiente_pago'); assert.equal(yo.body.plataforma.cuenta.habilitada, false);
  assert.equal(yo.body.plataforma.funciones.tienda, false); assert.equal(yo.body.plataforma.duena, false);
  const s = await api('/api/suscripcion', A.token); assert.equal(s.status, 200); assert.equal(s.body.precio_centavos, 1000000);
  const p = await api('/api/suscripcion/pagar', A.token, 'POST'); assert.equal(p.body.init_point, 'https://mp.test/checkout/pre1');
});

test('Mercado Pago autoriza la suscripción: la cuenta se activa y ve solo su negocio', async () => {
  mp.preapprovals.pre1.status = 'authorized';
  const w = await webhook('subscription_preapproval', 'pre1');
  assert.equal(w.status, 200); assert.equal(w.body.estado, 'activa');
  const n = await api('/api/negocios', A.token);
  assert.equal(n.status, 200); assert.deepEqual(n.body.map(x => x.nombre), ['Negocio ana@negocio.invalid']);
});

test('La dueña de la plataforma queda sin cargo y sin link de pago', async () => {
  const r = await alta('duena@plataforma.invalid');
  assert.equal(r.status, 201); assert.equal(r.body.estado, 'exenta'); assert.equal(r.body.init_point, null);
  B = { token: r.body.token, cuenta: await cuentaDe('duena@plataforma.invalid') };
  assert.equal((await api('/api/negocios', B.token)).status, 200);
});

test('Una cuenta no ve ni toca los clientes de otra', async () => {
  const publicoAntes = (await pool.query('SELECT count(*)::int AS n FROM public.clientes')).rows[0].n;
  const negB = (await api('/api/negocios', B.token)).body[0].id;
  const cB = await api('/api/clientes', B.token, 'POST', { nombre: 'Cliente', apellido: 'De B', negocio_id: negB });
  assert.equal(cB.status, 201, JSON.stringify(cB.body));
  const listaA = await api('/api/clientes', A.token);
  assert.equal(listaA.status, 200);
  assert.ok(!listaA.body.some(c => c.id === cB.body.id), 'A no debe ver clientes de B');
  const directo = await api(`/api/clientes/${cB.body.id}`, A.token);
  assert.ok([403, 404].includes(directo.status), JSON.stringify(directo));
  const negociosA = (await api('/api/negocios', A.token)).body.map(n => n.id);
  assert.ok(!negociosA.includes(negB));
  const enB = await conCuenta(B.cuenta.esquema, async () => (await pool.query(`SELECT count(*)::int AS n FROM "${B.cuenta.esquema}".clientes`)).rows[0].n);
  assert.equal(enB, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.clientes')).rows[0].n, publicoAntes, 'el esquema public no se toca');
});

test('Un token con una cuenta inexistente o sin cuenta no carga usuario', async () => {
  const { firmarToken } = await import('../src/lib/auth.js');
  assert.equal((await api('/api/negocios', firmarToken({ id: 'x', email: 'x@x.invalid' }))).status, 401);
});

test('Correo único en toda la plataforma, también para empleados', async () => {
  assert.equal((await alta('ana@negocio.invalid')).status, 409);
  const { crearUsuario } = await import('../src/repositories/usuarios.js');
  await assert.rejects(() => conCuenta(B.cuenta.esquema, () => crearUsuario({ email: 'ANA@negocio.invalid', password_hash: 'x', rol: 'empleado' })), e => e.status === 409);
  const enB = (await pool.query(`SELECT count(*)::int AS n FROM "${B.cuenta.esquema}".usuarios WHERE email='ana@negocio.invalid'`)).rows[0].n;
  assert.equal(enB, 0, 'si el correo está tomado no queda un usuario a medias');
});

test('Inicio de sesión: entra a su propia cuenta', async () => {
  const ok = await api('/api/auth/login', null, 'POST', { email: 'ana@negocio.invalid', password: 'secreto123' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await api('/api/negocios', ok.body.token)).body.map(n => n.nombre), ['Negocio ana@negocio.invalid']);
  assert.equal((await api('/api/auth/login', null, 'POST', { email: 'ana@negocio.invalid', password: 'otra-clave' })).status, 401);
  assert.equal((await api('/api/auth/login', null, 'POST', { email: 'nadie@negocio.invalid', password: 'secreto123' })).status, 401);
});

test('Las invitaciones llevan a la cuenta que las creó', async () => {
  const negA = (await api('/api/negocios', A.token)).body[0].id;
  const { token } = await conCuenta(A.cuenta.esquema, () => crearInvitacion({ email: 'emple@negocio.invalid', nombre: 'Emple', negocios: [{ negocio_id: negA, permisos: { 'clientes.ver': true } }] }));
  const c = await api('/api/auth/invitacion/consultar', null, 'POST', { token });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.deepEqual(c.body.negocios.map(n => n.id), [negA]);
  assert.equal((await api('/api/auth/invitacion/consultar', null, 'POST', { token: 'no-existe' })).status, 404);
  const ac = await api('/api/auth/invitacion/aceptar', null, 'POST', { token, password: 'secreto123', nombre: 'Emple' });
  assert.equal(ac.status, 201, JSON.stringify(ac.body));
  assert.equal((await api('/api/negocios', ac.body.token)).status, 200);
  assert.equal((await pool.query("SELECT esquema FROM plataforma_directorio WHERE email='emple@negocio.invalid'")).rows[0].esquema, A.cuenta.esquema);
});

test('Cobro rechazado: días de gracia y después bloqueo; un cobro aprobado reactiva', async () => {
  mp.pagos.ap1 = { id: 'ap1', preapproval_id: 'pre1', status: 'recycling', payment: { status: 'rejected' } };
  assert.equal((await webhook('subscription_authorized_payment', 'ap1')).body.estado, 'pago_rechazado');
  assert.equal((await api('/api/negocios', A.token)).status, 200, 'dentro de los días de gracia sigue andando');
  await pool.query("UPDATE plataforma_cuentas SET rechazo_desde=now()-interval '11 days' WHERE id=$1", [A.cuenta.id]);
  assert.equal((await api('/api/negocios', A.token)).status, 402);
  mp.pagos.ap2 = { id: 'ap2', preapproval_id: 'pre1', status: 'processed', payment: { status: 'approved' } };
  assert.equal((await webhook('subscription_authorized_payment', 'ap2')).body.estado, 'activa');
  assert.equal((await api('/api/negocios', A.token)).status, 200);
  const c = await cuentaDe('ana@negocio.invalid');
  assert.ok(c.ultimo_pago_en && c.primer_pago_en); assert.equal(c.rechazo_desde, null);
});

test('Cancelar la suscripción en Mercado Pago bloquea la cuenta sin borrar datos', async () => {
  mp.preapprovals.pre1.status = 'cancelled';
  assert.equal((await webhook('subscription_preapproval', 'pre1')).body.estado, 'cancelada');
  assert.equal((await api('/api/negocios', A.token)).status, 402);
  const p = await api('/api/suscripcion/pagar', A.token, 'POST');
  assert.equal(p.body.init_point, 'https://mp.test/checkout/pre2', 'genera un link nuevo para reactivar');
});

test('Panel de la dueña: lista y descarga de suscriptores; nadie más lo ve', async () => {
  const l = await api('/api/plataforma-admin/cuentas', B.token);
  assert.equal(l.status, 200); assert.equal(l.body.length, 2);
  assert.ok(l.body.some(c => c.email === 'ana@negocio.invalid' && c.telefono === '351 555 0000'));
  const x = await api('/api/plataforma-admin/cuentas/exportar', B.token);
  assert.match(x.body.csv, /ana@negocio\.invalid/); assert.match(x.body.filename, /^suscriptores-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal((await api('/api/plataforma-admin/cuentas', A.token)).status, 404);
  assert.equal((await api('/api/plataforma-admin/cuentas', null)).status, 401);
});

test('Tienda y Tiendanube apagadas para clientes hasta que la dueña las active', async () => {
  mp.preapprovals.pre2.status = 'authorized';
  await webhook('subscription_preapproval', 'pre2');
  const off = await api('/api/tiendas', A.token);
  assert.equal(off.status, 404); assert.equal(off.body.error, 'Función no disponible');
  assert.notEqual((await api('/api/tiendas', B.token)).body?.error, 'Función no disponible', 'la dueña siempre la tiene');
  assert.equal((await api('/api/tienda-publica/algo', null)).status, 404);
  assert.equal((await api('/api/plataforma-admin/funciones/tienda', B.token, 'PUT', { habilitada: true })).status, 200);
  assert.notEqual((await api('/api/tiendas', A.token)).body?.error, 'Función no disponible');
  assert.equal((await api('/api/auth/yo', A.token)).body.plataforma.funciones.tienda, true);
});

test('Webhook con secreto: rechaza firmas falsas y acepta las válidas', async () => {
  process.env.MP_WEBHOOK_SECRET = 'secreto-webhook';
  try {
    const mal = await api('/api/plataforma/mercadopago/webhook?type=subscription_preapproval&data.id=pre2', null, 'POST', {}, { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'r1' });
    assert.equal(mal.status, 401);
    const v1 = createHmac('sha256', 'secreto-webhook').update('id:pre2;request-id:r1;ts:1700;').digest('hex');
    const bien = await api('/api/plataforma/mercadopago/webhook?type=subscription_preapproval&data.id=pre2', null, 'POST', {}, { 'x-signature': `ts=1700,v1=${v1}`, 'x-request-id': 'r1' });
    assert.equal(bien.status, 200);
  } finally { delete process.env.MP_WEBHOOK_SECRET; }
});

test('Página de venta en "/" con el precio en pesos; la app en "/app"', async () => {
  process.env.PLATAFORMA_CONTACTO = 'WhatsApp <351> 555';
  try {
    const venta = await api('/');
    assert.equal(venta.status, 200);
    assert.match(venta.text, /Empezar por \$\s10\.000 al mes/);
    assert.match(venta.text, /href="\/app#\/crear-cuenta"/);
    assert.match(venta.text, /Contacto: WhatsApp &lt;351&gt; 555/);
    assert.doesNotMatch(venta.text, /\{\{|US\$|Tiendanube|Tienda web/);
    assert.match((await api('/app')).text, /id="authScreen"/);
    assert.match((await api('/?token=abc')).text, /id="authScreen"/, 'los enlaces de invitación abren la app');
  } finally { delete process.env.PLATAFORMA_CONTACTO; }
});

test('Sin EDICION=saas la app sigue como siempre', async () => {
  process.env.EDICION = '';
  try {
    assert.match((await api('/plataforma-config.js')).text, /"propia"/);
    assert.equal((await alta('otra@negocio.invalid')).status, 404);
    assert.equal((await api('/api/plataforma/config')).body.edicion, 'propia');
    assert.match((await api('/')).text, /id="authScreen"/, 'la raíz sigue siendo la app');
  } finally { process.env.EDICION = 'saas'; }
  assert.match((await api('/plataforma-config.js')).text, /"saas"/);
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = fetchReal;
  await limpiar();
  await pool.end();
});
