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
function browser({ permisos = {}, admin = false, respuesta = cliente, recibos = [], ahora } = {}) {
  const dom = new JSDOM(page, { url: 'https://zilky.test/#/clientes/cliente-qa', runScripts: 'outside-only' });
  const w = dom.window, calls = [];
  if (ahora) {
    const OriginalDate = w.Date;
    w.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [ahora])); }
      static now() { return new OriginalDate(ahora).getTime(); }
    };
  }
  w.requestAnimationFrame = fn => { fn(0); return 1; };
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

test('Ficha: clientes.ver habilita comprobantes individuales sin permiso consolidado', async () => {
  const b = browser();
  try {
    await b.w.render();
    assert.ok(b.view.querySelector('a[href^="#/comprobantes/cliente/"]'));
    assert.equal(b.w.puede('comprobantes.ver'), false);
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

for (const denegado of ['clientes.ver']) {
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

const creditoOperativo={id:'credito-qa',cliente_id:'cliente-qa',negocio_id:'qa',estado:'activo',modalidad:'unico',fecha_inicio:'2026-09-01',monto_total_centavos:20000,entrega_inicial_centavos:10000,saldo_financiado_centavos:10000,
  items:[{descripcion:'Equipo <QA>',cantidad:1,producto_imei:'QA-IMEI'}],
  cuotas:[{numero:1,monto_centavos:10000,saldo_pendiente_centavos:9000,fecha_vencimiento:'2026-10-01',estado:'gracia',diasHasta:-3,diasAtraso:3}],
  incidencias:[{tipo:'al_dia',fecha:'2026-09-01',motivo:'Nota <segura>'}],seguimientoEquipos:false};
const operativo={...cliente,historial:{cantidadCompras:1,cuotasPagadas:2,cuotasPagadasATiempo:1,cuotasPagadasTarde:1},deudaTotalCentavos:9000,creditos:[creditoOperativo]};

test('Etapa3 UI: empleado ve producto, entrega, plan, atraso y cumplimiento individual sin dashboard',async()=>{
  const b=browser({respuesta:operativo});
  try {
    await b.w.render();
    for(const text of ['Equipo <QA>','QA-IMEI','Entrega inicial','Valor:','3 días de atraso','50%','Historial de incidencias','Nota <segura>'])assert.ok(b.view.textContent.includes(text),text);
    assert.ok(b.view.querySelector('.debt-hero'));
    assert.equal(b.view.querySelector('[data-action="registrar-pago"]').hidden,true);
    assert.equal(b.view.querySelector('[data-action="incidencia-equipo"]'),null);
    assert.equal(b.view.querySelector('segura'),null);
  }finally{b.w.close();}
});
for(const route of ['inicio','comprobantes'])test('Etapa3 UI: permiso antiguo no habilita consolidado '+route,async()=>{
  const b=browser({permisos:{'dashboard_financiero.ver':true,'comprobantes.ver':true}});
  try{b.w.history.replaceState({},'','/#/'+route);await b.w.render();assert.match(b.view.textContent,/No tenés permiso/);assert.equal(b.calls.length,0);}finally{b.w.close();}
});
test('Etapa3 UI: comprobantes individuales accesibles con solo clientes.ver',async()=>{
  const b=browser();
  try{b.w.history.replaceState({},'','/#/comprobantes/cliente/cliente-qa');await b.w.render();assert.equal(b.calls.length,1);assert.match(b.calls[0],/cliente_id=cliente-qa/);}finally{b.w.close();}
});
for(const admin of [false,true])test('Etapa3 UI: calendario diario '+(admin?'conserva total para admin':'no suma importes para empleado'),async()=>{
  const b=browser({admin,permisos:{'cobranzas.ver':true,'dashboard_financiero.ver':true},respuesta:[{cliente_id:'c',cliente_nombre:'Cliente',numero:1,total_cuotas:1,saldo_pendiente_centavos:12300,estado:'proxima',credito_id:'cr',negocio_id:'qa'}]});
  try {await b.w.abrirDiaCalendario('2026-10-04');const sub=b.w.document.querySelector('.sheet-sub').textContent;assert.equal(sub.includes('por cobrar'),admin);assert.match(b.w.document.querySelector('.list-item-amount').textContent,/123/);}finally{b.w.close();}
});
test('Etapa3 UI: opción de equipos depende de configuración, no del nombre del negocio',async()=>{
  const b=browser({admin:true,respuesta:operativo});
  try {
    await b.w.render();assert.equal(b.view.querySelector('[data-action="incidencia-equipo"]'),null);
    b.w.fetch=async()=>({ok:true,status:200,json:async()=>({...operativo,creditos:[{...creditoOperativo,seguimientoEquipos:true}]})});
    await b.w.render();assert.ok(b.view.querySelector('[data-action="incidencia-equipo"]'));
  }finally{b.w.close();}
});
test('Etapa3 UI: incidencia bloquea doble envío y reintenta exactamente la misma solicitud',async()=>{
  const b=browser({admin:true});let finish;
  try {
    b.w.abrirIncidenciaEquipo('cliente-qa','credito-qa','qa');
    b.w.document.getElementById('incMotivo').value='QA';
    const calls=[];
    b.w.fetch=(url,opts)=>{calls.push({url,opts});return new Promise(resolve=>{finish=resolve;});};
    const button=b.w.document.getElementById('incGuardar');button.click();button.click();
    assert.equal(calls.length,1);assert.equal(button.disabled,true);
    assert.equal(b.w.document.getElementById('incMotivo').disabled,true);
    finish({ok:false,status:503,json:async()=>({error:'Respuesta incierta'})});
    await new Promise(r=>setImmediate(r));button.click();
    assert.equal(calls.length,2);assert.equal(calls[0].opts.body,calls[1].opts.body);
    finish({ok:false,status:503,json:async()=>({error:'QA'})});await new Promise(r=>setImmediate(r));
  }finally{b.w.close();}
});
test('Etapa3 UI: cambiar negocio o sesión invalida formulario de incidencia',()=>{
  const b=browser({admin:true});
  try {
    b.w.abrirIncidenciaEquipo('cliente-qa','credito-qa','qa');b.w.document.getElementById('incMotivo').value='QA';
    b.w.qaState.negocioActual='otro';b.w.document.getElementById('incGuardar').click();assert.equal(b.calls.length,0);
    b.w.qaState.negocioActual='qa';b.w.localStorage.setItem('zilky_token','cambiado');b.w.document.getElementById('incGuardar').click();assert.equal(b.calls.length,0);
  }finally{b.w.close();}
});

const gestion={negocio_id:'qa',gestion_especial:1,proximo_contacto:'2026-11-04',historial:[{accion:'entrada',fecha:'2026-10-04T21:00:00-03:00',usuario_nombre:'Admin <QA>',deuda_centavos:10000,nota:'No pagó <script>alert(1)</script>',proximo_contacto:'2026-11-04'}]};
for (const [ahora, hoy, proximo] of [
  ['2026-10-05T01:15:00Z', '2026-10-04', '2026-11-04'],
  ['2026-10-05T03:00:00Z', '2026-10-05', '2026-11-05'],
  ['2026-02-01T01:15:00Z', '2026-01-31', '2026-02-28'],
  ['2028-02-01T01:15:00Z', '2028-01-31', '2028-02-29'],
]) {
  test('Fechas operativas: Gestión especial usa hoy argentino y próximo mes válido en ' + ahora, () => {
    const b = browser({ admin: true, ahora });
    try {
      b.w.abrirGestionCliente('cliente-qa', 'qa', 'entrada');
      const fecha = b.w.document.getElementById('gestionFecha');
      assert.equal(fecha.min, hoy, 'No adelantar la fecha argentina al cambiar el día UTC');
      assert.equal(fecha.value, proximo, 'Conservar el día o limitar al último del mes siguiente');
      b.w.abrirIncidenciaEquipo('cliente-qa', 'credito-qa', 'qa');
      assert.equal(b.w.document.getElementById('incFecha').value, hoy);
    } finally { b.w.close(); }
  });
}
test('Gestión especial: empleado ve antecedente sin poder reclasificar',async()=>{
  const b=browser({permisos:{'cobranzas.ver':true},respuesta:{...cliente,historial:{},gestionCobranza:[gestion]}});
  try{await b.w.render();assert.match(b.view.textContent,/Ingresó a Gestión especial/);assert.match(b.view.textContent,/Admin <QA>/);assert.equal(b.view.querySelector('[data-action="gestion-cliente"]'),null);assert.equal(b.view.querySelector('script'),null);assert.ok(b.view.querySelector('[data-action="mensaje-especial"]'));}finally{b.w.close();}
});
test('Gestión especial: administrador puede devolver a normal sin borrar antecedentes',async()=>{
  const b=browser({admin:true,respuesta:{...cliente,historial:{},gestionCobranza:[gestion]}});
  try{await b.w.render();assert.ok(b.view.querySelector('[data-action="gestion-cliente"][data-tipo="salida"]'));assert.match(b.view.textContent,/No pagó/);}finally{b.w.close();}
});
test('Gestión especial: Cobrar conserva cinco pestañas en orden y agrupa por persona',async()=>{
  const b=browser({admin:true});b.w.qaState.cobranzaTab='especial';
  b.w.fetch=async url=>({ok:true,json:async()=>url.includes('recordatorios')?[]:{hoy:[],proximas:[],vencidas:[],todas:[],especial:[{cliente_id:'c',negocio_id:'qa',cliente_nombre:'QA',cliente_apellido:'Especial',deudaCentavos:10000,cuotas:4,proximo_contacto:'2026-11-04'}]}});
  try{await b.w.viewCobrar(b.view);assert.deepEqual([...b.view.querySelectorAll('#cobranzaTabs button')].map(e=>e.dataset.tab),['hoy','proximas','vencidas','especial','todas']);assert.match(b.view.textContent,/4 cuota\(s\)/);assert.match(b.view.textContent,/seleccionadas manualmente/);}finally{b.w.close();}
});
test('Gestión especial: formulario conserva la solicitud tras respuesta incierta y evita doble click',async()=>{
  const b=browser({admin:true}),calls=[];let release;
  b.w.fetch=async(url,opts)=>{calls.push(JSON.parse(opts.body));if(calls.length===1)await new Promise(r=>release=r);return{ok:false,status:500,json:async()=>({error:'Incierto'})};};
  try{
    b.w.abrirGestionCliente('cliente-qa','qa','entrada');const d=b.w.document;
    d.getElementById('gestionNota').value='Elegido manualmente QA';const button=d.getElementById('gestionGuardar');button.click();button.click();assert.equal(calls.length,1);release();await new Promise(r=>setTimeout(r,0));button.click();await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
  }finally{b.w.close();}
});
test('Gestión especial: cambiar negocio impide guardar un modal viejo',()=>{
  const b=browser({admin:true});
  try{b.w.abrirGestionCliente('cliente-qa','qa','entrada');b.w.document.getElementById('gestionNota').value='QA';b.w.qaState.negocioActual='otro';b.w.document.getElementById('gestionGuardar').click();assert.equal(b.calls.length,0);}finally{b.w.close();}
});
test('Gestión especial: mensaje editable genera enlace manual y no registra envío ni seguimiento',async()=>{
  const b=browser({permisos:{'cobranzas.ver':true},respuesta:{...cliente,telefono:'5493510000000',deudaTotalCentavos:7500,gestionCobranza:[gestion]}});
  try{await b.w.abrirMensajeEspecial('cliente-qa','qa');const d=b.w.document;assert.match(d.getElementById('gestionMensaje').value,/QA/);assert.match(d.getElementById('activeSheet').textContent,/No se envía ni se marca como enviado/);d.getElementById('gestionMensaje').value='Texto personalizado & QA';d.getElementById('gestionMensaje').dispatchEvent(new b.w.Event('input'));assert.match(d.getElementById('gestionWhatsapp').href,/Texto%20personalizado%20%26%20QA/);assert.deepEqual(b.calls,['/api/clientes/cliente-qa?negocio_id=qa']);}finally{b.w.close();}
});
