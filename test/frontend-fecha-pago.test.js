import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const vista=(overrides={})=>({
  pago:{id:'pago',negocio_id:'tienda',credito_id:'credito',tipo:'cuota',monto_centavos:15500000,medio_pago:'efectivo',fecha_hora:'2026-08-24T14:42:05Z',anulado:0},
  credito:{id:'credito',negocio_id:'tienda',fecha_inicio:'2026-07-28'},version:'version-credito',recalculo_disponible:true,advertencias:[],...overrides,
});
const calculo=(overrides={})=>({
  version:'version-credito',version_preview:'version-preview',fecha_hora:'2026-09-24T11:42:05-03:00',recalcular:true,
  antes:{capital_pendiente_centavos:48800000,mora_pendiente_centavos:0,saldo_favor_centavos:0},
  despues:{capital_pendiente_centavos:46500000,mora_pendiente_centavos:0,saldo_favor_centavos:0},
  cuotas:[{id:'cuota3',numero:3,capital_antes_centavos:2300000,capital_despues_centavos:0,mora_antes_centavos:0,mora_despues_centavos:0}],
  pagos_afectados:3,advertencias:['Se conservarán los comprobantes originales.'],...overrides,
});
function browser(respond=(url,opts)=>response(opts.method==='POST'?calculo():opts.method==='PATCH'?{id:'pago'}:vista())) {
  const dom=new JSDOM(page,{url:'https://zilky.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];
  const OriginalDate=w.Date;
  w.Date=class extends OriginalDate {
    constructor(...args){super(...(args.length?args:['2026-10-19T15:52:31Z']));}
    static now(){return new OriginalDate('2026-10-19T15:52:31Z').getTime();}
  };
  w.fetch=async(url,opts={})=>{calls.push({url,opts});return respond(url,opts);};
  w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.localStorage.setItem('zilky_token','sesion-qa');
  w.qaState.usuario={rol:'administrador'};w.qaState.negocioActual='tienda';w.qaState.negocios=[{id:'tienda',nombre:'Tienda QA'}];
  w.render=()=>{};
  return {w,calls,el:id=>w.document.getElementById(id),sheet:()=>w.document.getElementById('activeSheet')};
}
async function abrir(b){await b.w.abrirCorreccionFechaPago('pago','tienda');b.el('pagoCorFecha').value='2026-09-24';b.el('pagoCorMotivo').value='Se cargó agosto por error';}
async function revisar(b){b.el('pagoCorRevisar').click();await tick();}
const posts=b=>b.calls.filter(c=>c.opts.method==='POST');
const patches=b=>b.calls.filter(c=>c.opts.method==='PATCH');

test('Historial de pagos: explica capital, mora y saldo a favor, permite corregir pagos activos y conserva auditoría como texto seguro',()=>{
  const b=browser();
  try {
    const p={...vista().pago,capital_aplicado_centavos:13200000,mora_aplicada_centavos:2300000,remanente_centavos:0,
      aplicaciones:[{cuota_id:'q',numero:3,capital_centavos:13200000,interes_mora_centavos:2300000}],
      correcciones_fecha:[{fecha_hora:'2026-10-19T12:00:00-03:00',autor:'Admin',fecha_anterior:'2026-08-24T11:42:05-03:00',fecha_nueva:'2026-09-24T11:42:05-03:00',motivo:'<img src=x onerror=alert(1)>'}]};
    b.w.setHTML(b.el('view'),b.w.pagoHistorialHtml(p));
    assert.match(b.el('view').textContent,/Aplicado a capital:.*132\.000.*A mora:.*23\.000/);
    assert.match(b.el('view').textContent,/Cuota 3.*Capital:.*132\.000.*Mora:.*23\.000/);
    assert.match(b.el('view').textContent,/24\/08\/2026 11:42:05 → 24\/09\/2026 11:42:05 \(Argentina\)/);
    assert.equal(b.el('view').querySelector('img,[onerror]'),null);
    assert.equal(b.el('view').querySelector('[data-action="corregir-fecha-pago"]').dataset.negocio,'tienda');
    b.w.setHTML(b.el('view'),b.w.pagoHistorialHtml({...p,remanente_centavos:50000}));
    assert.match(b.el('view').textContent,/A saldo a favor:.*500/);
    b.w.setHTML(b.el('view'),b.w.pagoHistorialHtml({...p,anulado:1}));
    assert.equal(b.el('view').querySelector('[data-action="corregir-fecha-pago"]'),null);
    assert.match(b.el('view').textContent,/Aplicación anulada/);
    b.w.qaState.usuario={rol:'empleado'};
    b.w.setHTML(b.el('view'),b.w.pagoHistorialHtml(p));
    assert.equal(b.el('view').querySelector('[data-action="corregir-fecha-pago"]'),null);
  }finally{b.w.close();}
});

test('Fecha de pago: convierte fecha y hora guardadas a Argentina y exige una revisión antes de guardar',async()=>{
  const b=browser();
  try {
    await b.w.abrirCorreccionFechaPago('pago','tienda');
    assert.equal(b.el('pagoCorFecha').value,'2026-08-24');assert.equal(b.el('pagoCorHora').value,'11:42:05');
    assert.equal(b.el('pagoCorConfirmar').hidden,true);assert.equal(b.el('pagoCorConfirmar').disabled,true);
    assert.equal(b.el('pagoCorRecalcular').checked,true);
    b.el('pagoCorConfirmar').click();b.el('pagoCorRevisar').click();await tick();
    assert.equal(posts(b).length,0);assert.equal(patches(b).length,0);
    assert.match(b.el('pagoCorEstado').textContent,/motivo/);
    b.el('pagoCorFecha').value='2026-09-24';b.el('pagoCorMotivo').value='Fecha equivocada';
    await revisar(b);
    assert.deepEqual(JSON.parse(posts(b)[0].opts.body),{version:'version-credito',fecha_hora:'2026-09-24T11:42:05-03:00',recalcular:true});
    assert.equal(posts(b)[0].url,'/api/pagos/pago/correccion-fecha/previsualizar?negocio_id=tienda');
    assert.equal(patches(b).length,0);
    assert.match(b.el('pagoCorPreview').textContent,/488\.000.*465\.000/s);
    assert.match(b.el('pagoCorPreview').textContent,/Cuotas afectadas.*Cuota 3.*23\.000.*0/s);
    assert.match(b.el('pagoCorPreview').textContent,/comprobantes originales/);
    b.el('pagoCorConfirmar').click();await tick();
    const payload=JSON.parse(patches(b)[0].opts.body);
    assert.equal(payload.fecha_hora,'2026-09-24T11:42:05-03:00');assert.equal(payload.version_preview,'version-preview');
    assert.equal(payload.motivo,'Fecha equivocada');assert.equal(payload.confirmar,true);assert.equal(payload.negocio_id,'tienda');
    assert.match(payload.solicitud_id,/^[a-f0-9-]{36}$/i);
    assert.equal(b.el('sheetBackdrop').classList.contains('open'),false);
  }finally{b.w.close();}
});

test('Fecha de pago: desde Todos los autorizados corrige únicamente el negocio explícito del pago',async()=>{
  const b=browser();
  try {
    b.w.qaState.negocioActual=null;
    b.w.setHTML(b.el('view'),b.w.pagoHistorialHtml(vista().pago));
    b.el('view').querySelector('[data-action="corregir-fecha-pago"]').click();await tick();
    assert.equal(b.calls[0].url,'/api/pagos/pago/correccion-fecha?negocio_id=tienda');
    assert.equal(b.w.qaState.negocioActual,null);
    b.el('pagoCorFecha').value='2026-09-24';b.el('pagoCorMotivo').value='Mes equivocado';
    await revisar(b);b.el('pagoCorConfirmar').click();await tick();
    assert.equal(JSON.parse(patches(b)[0].opts.body).negocio_id,'tienda');
  }finally{b.w.close();}
});

test('Fecha de pago: cambios de fecha, hora, motivo y recálculo invalidan la revisión anterior',async()=>{
  const b=browser();
  try {
    await abrir(b);
    for(const [id,value] of [['pagoCorFecha','2026-09-25'],['pagoCorHora','12:30:00'],['pagoCorMotivo','Error de mes'],['pagoCorRecalcular',false]]){
      await revisar(b);assert.equal(b.el('pagoCorConfirmar').disabled,false);
      const input=b.el(id);if(input.type==='checkbox')input.checked=value;else input.value=value;
      input.dispatchEvent(new b.w.Event('input',{bubbles:true}));
      assert.equal(b.el('pagoCorConfirmar').hidden,true);assert.equal(b.el('pagoCorPreview').textContent,'');
      b.el('pagoCorConfirmar').click();assert.equal(patches(b).length,0);
    }
  }finally{b.w.close();}
});

test('Fecha de pago: una respuesta incierta bloquea cambios y reintenta exactamente el mismo cuerpo sin duplicar clics',async()=>{
  let terminar;
  const b=browser((url,opts)=>opts.method==='PATCH'?new Promise((resolve,reject)=>terminar=()=>reject(new Error('Sin conexión'))):response(opts.method==='POST'?calculo():vista()));
  try {
    await abrir(b);await revisar(b);
    b.el('pagoCorConfirmar').click();b.el('pagoCorConfirmar').click();assert.equal(patches(b).length,1);
    const original=patches(b)[0].opts.body;terminar();await tick();
    assert.equal(b.el('pagoCorFecha').disabled,true);assert.equal(b.el('pagoCorRevisar').disabled,true);
    assert.equal(b.sheet().querySelector('[data-action="cerrar-sheet"]').disabled,false);
    assert.match(b.el('pagoCorEstado').textContent,/mismos datos sin duplicar/);
    b.el('pagoCorFecha').value='2026-10-01';b.el('pagoCorMotivo').value='Otro motivo';
    b.el('pagoCorConfirmar').click();assert.equal(patches(b).length,2);assert.equal(patches(b)[1].opts.body,original);
    terminar();await tick();
  }finally{b.w.close();}
});

test('Fecha de pago: un rechazo de validación permite corregir datos y obliga a volver a revisar',async()=>{
  const b=browser((url,opts)=>response(opts.method==='PATCH'?{error:'La fecha es anterior a la compra'}:opts.method==='POST'?calculo():vista(),opts.method==='PATCH'?400:200));
  try {
    await abrir(b);await revisar(b);b.el('pagoCorConfirmar').click();await tick();
    assert.equal(b.el('pagoCorFecha').disabled,false);assert.equal(b.el('pagoCorMotivo').disabled,false);
    assert.equal(b.el('pagoCorConfirmar').hidden,true);assert.match(b.el('pagoCorEstado').textContent,/anterior a la compra/);
    b.el('pagoCorFecha').value='2026-09-25';await revisar(b);b.el('pagoCorConfirmar').click();await tick();
    assert.equal(JSON.parse(patches(b)[1].opts.body).fecha_hora,'2026-09-25T11:42:05-03:00');
  }finally{b.w.close();}
});

for(const fase of ['POST','PATCH'])test(`Fecha de pago: conflicto ${fase} exige revisar el estado actualizado`,async()=>{
  const b=browser((url,opts)=>response(opts.method===fase?{error:'La financiación cambió'}:opts.method==='POST'?calculo():vista(),opts.method===fase?409:200));
  try {
    await abrir(b);await revisar(b);if(fase==='PATCH'){b.el('pagoCorConfirmar').click();await tick();}
    assert.match(b.sheet().textContent,/La cuenta cambió/);assert.match(b.sheet().textContent,/Cerrá y abrí/);
    assert.equal(b.el('pagoCorConfirmar'),null);assert.equal(b.el('pagoCorRevisar'),null);
  }finally{b.w.close();}
});

for(const cambio of ['negocio','sesion','rol','cancelar','panel'])test(`Fecha de pago: cambiar ${cambio} invalida un formulario ya revisado`,async()=>{
  const b=browser();
  try {
    await abrir(b);await revisar(b);const confirmar=b.el('pagoCorConfirmar');
    if(cambio==='negocio')b.w.qaState.negocioActual='otra';
    if(cambio==='sesion')b.w.localStorage.setItem('zilky_token','otra');
    if(cambio==='rol')b.w.qaState.usuario={rol:'empleado'};
    if(cambio==='cancelar')b.w.closeSheet();
    if(cambio==='panel')b.w.openSheet('<p>Otro panel</p>');
    confirmar.click();await tick();assert.equal(patches(b).length,0);
  }finally{b.w.close();}
});

test('Fecha de pago: empleado no consulta el editor y cambiar de negocio antes de revisar no envía solicitudes',async()=>{
  const b=browser();
  try {
    b.w.qaState.usuario={rol:'empleado'};await b.w.abrirCorreccionFechaPago('pago','tienda');assert.equal(b.calls.length,0);
    b.w.qaState.usuario={rol:'administrador'};await abrir(b);b.w.qaState.negocioActual=null;
    await revisar(b);assert.equal(posts(b).length,0);
  }finally{b.w.close();}
});

test('Fecha de pago: anticipo y operaciones sin recálculo permiten corregir la fecha conservando la aplicación',async()=>{
  for(const inicial of [true,false]){
    const v=vista({recalculo_disponible:false,motivo_no_recalculo:'Se conserva la aplicación por una corrección previa.'});
    if(inicial)v.pago.tipo='entrega_inicial';
    const b=browser((url,opts)=>response(opts.method==='POST'?calculo({recalcular:false}):v));
    try {
      await abrir(b);assert.equal(b.el('pagoCorRecalcular'),null);
      assert.match(b.sheet().textContent,inicial?/La entrega inicial no se distribuye/:/corrección previa/);
      await revisar(b);assert.equal(JSON.parse(posts(b)[0].opts.body).recalcular,false);
      assert.match(b.el('pagoCorPreview').textContent,/Se conserva la aplicación actual/);
    }finally{b.w.close();}
  }
});

test('Fecha de pago: una previsualización tardía no reemplaza otro panel',async()=>{
  let terminar;
  const b=browser((url,opts)=>opts.method==='POST'?new Promise(resolve=>terminar=resolve):response(vista()));
  try {
    await abrir(b);b.el('pagoCorRevisar').click();b.w.openSheet('<p>Otro panel</p>');
    terminar(response(calculo()));await tick();assert.equal(b.sheet().textContent,'Otro panel');assert.equal(patches(b).length,0);
  }finally{b.w.close();}
});

test('Registrar pago: usa la hora de Argentina aun cuando el navegador está en UTC y explica la carga histórica',async()=>{
  const b=browser((url,opts)=>response(opts.method?{comprobante:{numero:'QA-1'}}:vista()));
  try {
    await b.w.abrirRegistrarPago('credito',155000);
    assert.match(b.sheet().textContent,/fecha real.*pagos antiguos/s);
    b.el('pagoFecha').value='2026-08-24';b.el('btnConfirmarPago').click();await tick();
    assert.equal(JSON.parse(posts(b)[0].opts.body).fecha_hora,'2026-08-24T12:52:31-03:00');
  }finally{b.w.close();}
});

test('Incidencias: avisa que hubo pagos corregidos sin reinterpretar ni borrar la incidencia original',()=>{
  const b=browser();
  try {
    const cr={id:'credito',negocio_id:'tienda',cliente_id:'cliente',incidencias:[{id:'atraso',tipo:'atrasada',fecha:'2026-10-19',motivo:'Antecedente original'}]};
    const original=JSON.stringify(cr);
    b.w.setHTML(b.el('view'),b.w.incidenciasHtml(cr));
    assert.equal(b.el('view').querySelector('[data-payment-correction-notice]'),null);
    for(const recalcular of [false,true]){
      b.w.setHTML(b.el('view'),b.w.incidenciasHtml({...cr,ultima_correccion_pagos:{fecha_hora:'2026-10-20T01:15:00Z',autor:'Admin',motivo:'Error al cargar el pago',recalcular}}));
      assert.match(b.el('view').querySelector('[data-payment-correction-notice]').textContent,/Hay pagos corregidos el 19\/10\/2026\. Las incidencias anteriores conservan la carga original; consultá las cuotas y pagos actualizados\./);
      assert.equal(b.el('view').querySelectorAll('ol li').length,1);
      assert.match(b.el('view').querySelector('ol li').textContent,/Atrasada · 19\/10\/2026Antecedente original/);
    }
    assert.equal(JSON.stringify(cr),original);
  }finally{b.w.close();}
});
