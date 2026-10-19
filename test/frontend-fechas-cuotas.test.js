import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const vista=()=>({version:'a'.repeat(64),credito:{id:'cr',negocio_id:'qa',monto_total_centavos:400000,entrega_inicial_centavos:100000,fecha_inicio:'2026-10-01',fecha_entrega_producto:'2026-10-03'},pagos:[],aplicaciones:[],cuotas:[
  {id:'q1',numero:1,monto_centavos:100000,saldo_pendiente_centavos:0,fecha_vencimiento:'2026-10-02',fecha_saldada:'2026-10-02',puede_quitar:false},
  {id:'q2',numero:2,monto_centavos:100000,saldo_pendiente_centavos:80000,fecha_vencimiento:'2026-11-01',puede_quitar:false},
  {id:'q3',numero:3,monto_centavos:100000,saldo_pendiente_centavos:100000,fecha_vencimiento:'2026-12-01',puede_quitar:true},
]});
const respuesta=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
function browser(respond=()=>respuesta(vista())) {
  const dom=new JSDOM(page,{url:'https://zilky.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];
  w.fetch=async(url,opts={})=>{calls.push({url,opts});return respond(url,opts);};
  w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.qaState.usuario={rol:'administrador'};w.qaState.negocioActual='qa';
  return {w,calls,el:id=>w.document.getElementById(id),sheet:()=>w.document.getElementById('activeSheet')};
}

test('Fechas y cuotas: acceso visible en compra, atajo pendiente y corrección solo de incidencias de equipo',()=>{
  const b=browser();
  try {
    const v=vista(),cr={...v.credito,cliente_id:'cliente',estado:'activo',modalidad:'cuotas',cuotas:v.cuotas,incidencias:[{id:'e1',tipo:'equipo_entregado',fecha:'2026-10-04'},{id:'e2',tipo:'equipo_retirado',fecha:'2026-10-05'},{id:'e3',tipo:'finalizada_correctamente',fecha:'2026-10-06'}]};
    b.w.setHTML(b.w.document.getElementById('view'),b.w.creditoCardHtml(cr));
    const view=b.w.document.getElementById('view');
    assert.match(view.textContent,/Entrega \/ retiro del producto por el cliente: 03\/10\/2026/);
    assert.equal(view.querySelector('[data-action="corregir-financiacion"]').textContent,'Editar fechas y cuotas');
    assert.equal(view.querySelectorAll('[data-action="corregir-financiacion"][data-cuota]').length,2);
    assert.equal(view.querySelectorAll('[data-action="corregir-fecha-incidencia"]').length,2);
    b.w.qaState.usuario={rol:'empleado'};
    b.w.setHTML(view,b.w.creditoCardHtml(cr));
    assert.equal(view.querySelector('[data-action="corregir-financiacion"], [data-action="corregir-fecha-incidencia"]'),null);
  }finally{b.w.close();}
});

test('Fechas y cuotas: separa fecha del producto del anticipo y permite limpiarla con null',async()=>{
  const b=browser((url,opts)=>respuesta(opts.method?{error:'Validación QA'}:vista(),opts.method?400:200));
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa');
    assert.equal(b.el('corFechaEntrega').value,'2026-10-03');
    assert.match(b.el('corFechaEntrega').closest('.field').textContent,/celular, la ropa/);
    b.el('corMotivo').value='Corregir fecha de retiro';
    b.el('corFechaEntrega').value='';b.el('corGuardar').click();await tick();
    let datos=JSON.parse(b.calls.at(-1).opts.body).datos;
    assert.equal(datos.fecha_entrega_producto,null);
    assert.equal(datos.entrega_inicial_centavos,100000);
    assert.equal(datos.fecha_inicio,'2026-10-01');
    b.el('corFechaEntrega').value='2026-10-07';b.el('corGuardar').click();await tick();
    datos=JSON.parse(b.calls.at(-1).opts.body).datos;
    assert.equal(datos.fecha_entrega_producto,'2026-10-07');
  }finally{b.w.close();}
});

test('Fechas y cuotas: saldadas bloqueadas y cuotas con historial conservadas después de un 400',async()=>{
  const b=browser((url,opts)=>respuesta(opts.method?{error:'Revisá la fecha'}:vista(),opts.method?400:200));
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa');
    const filas=()=>[...b.el('corCuotas').children];
    assert.match(filas()[0].textContent,/Cuota 1 · Saldada/);
    assert.match(filas()[1].textContent,/Capital pagado:.*200/);
    assert.equal(filas()[0].querySelector('.corMonto').disabled,true);
    assert.equal(filas()[0].querySelector('.corVence').disabled,true);
    assert.equal(filas()[1].querySelector('.corMonto').disabled,false);
    assert.equal(filas()[1].querySelector('.corQuitar').disabled,true);
    assert.equal(filas()[2].querySelector('.corQuitar').disabled,false);
    b.el('corMotivo').value='Corregir vencimientos';b.el('corGuardar').click();await tick();
    assert.equal(filas()[0].querySelector('.corMonto').disabled,true);
    assert.equal(filas()[0].querySelector('.corVence').disabled,true);
    assert.equal(filas()[0].querySelector('.corQuitar').disabled,true);
    assert.equal(filas()[1].querySelector('.corQuitar').disabled,true);
    assert.equal(filas()[1].querySelector('.corVence').disabled,false);
    assert.equal(b.sheet().querySelector('[data-action="cerrar-sheet"]').disabled,false);
    const datos=JSON.parse(b.calls.at(-1).opts.body).datos;
    assert.deepEqual(datos.cuotas[0],{id:'q1',monto_centavos:100000,fecha_vencimiento:'2026-10-02'});
  }finally{b.w.close();}
});

test('Fechas y cuotas: aplicaciones, mora y contactos impiden quitar aunque no venga puede_quitar',async()=>{
  const v=vista();
  v.cuotas=Array.from({length:5},(_,i)=>({id:`q${i}`,monto_centavos:10000,saldo_pendiente_centavos:10000,fecha_vencimiento:'2026-11-01'}));
  v.aplicaciones=[{cuota_id:'q0'}];v.cuotas[1].mora_generada_centavos=100;v.cuotas[2].mora_pagada_centavos=100;v.cuotas[3].mora_perdonada_centavos=100;v.cuotas[4].tiene_recordatorios=true;
  const b=browser(()=>respuesta(v));
  try {await b.w.abrirCorreccionFinanciacion('cr','qa');assert.equal([...b.el('corCuotas').querySelectorAll('.corQuitar')].every(el=>el.disabled),true);}
  finally{b.w.close();}
});

test('Fechas y cuotas: atajo enfoca vencimiento y renumera al quitar una cuota nueva',async()=>{
  const b=browser();
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa','q2');
    assert.equal(b.w.document.activeElement.closest('[data-id]').dataset.id,'q2');
    b.el('corAgregar').click();
    let filas=[...b.el('corCuotas').children];assert.match(filas.at(-1).textContent,/Cuota 4 · Nueva/);
    filas[2].querySelector('.corQuitar').click();
    filas=[...b.el('corCuotas').children];assert.match(filas.at(-1).textContent,/Cuota 3 · Nueva/);
  }finally{b.w.close();}
});

test('Fechas y cuotas: doble clic y reintento de red conservan el cuerpo; cancelar queda habilitado',async()=>{
  const b=browser((url,opts)=>{if(opts.method)throw new Error('Sin conexión');return respuesta(vista());});
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa');b.el('corMotivo').value='Error de carga';
    b.el('corGuardar').click();b.el('corGuardar').click();await tick();
    const original=b.calls.find(c=>c.opts.method);
    assert.equal(b.calls.filter(c=>c.opts.method).length,1);
    assert.equal(b.sheet().querySelector('[data-action="cerrar-sheet"]').disabled,false);
    b.el('corFechaEntrega').value='2026-10-10';b.el('corGuardar').click();await tick();
    assert.equal(b.calls.at(-1).opts.body,original.opts.body);
  }finally{b.w.close();}
});

test('Fechas y cuotas: cambiar negocio o cancelar invalida el envío de un formulario abierto',async()=>{
  for(const accion of ['cambiar','cancelar']) {
    const b=browser();
    try {
      await b.w.abrirCorreccionFinanciacion('cr','qa');b.el('corMotivo').value='Error';
      if(accion==='cambiar')b.w.qaState.negocioActual='otro';else b.w.closeSheet();
      b.el('corGuardar').click();await tick();assert.equal(b.calls.filter(c=>c.opts.method).length,0);
    }finally{b.w.close();}
  }
});

test('Fechas y cuotas: una carga tardía no reemplaza otro panel',async()=>{
  let terminar;const b=browser(()=>new Promise(resolve=>terminar=resolve));
  try {
    const carga=b.w.abrirCorreccionFinanciacion('cr','qa');
    b.w.openSheet('<p>Otro panel</p>');terminar(respuesta(vista()));await carga;
    assert.equal(b.sheet().textContent,'Otro panel');
  }finally{b.w.close();}
});

test('Incidencia: obtiene versión y corrige solo la fecha con motivo de auditoría separado y reintento estable',async()=>{
  const evento={id:'inc',tipo:'equipo_entregado',fecha:'2026-10-05',motivo:'Motivo original'};
  const b=browser((url,opts)=>{if(opts.method)throw new Error('Sin conexión');return respuesta({evento,version:'b'.repeat(64)});});
  try {
    await b.w.abrirCorreccionFechaIncidencia('cliente','cr','qa','inc');
    const ruta='/api/clientes/cliente/creditos/cr/incidencias/inc?negocio_id=qa';
    assert.equal(b.calls[0].url,ruta);assert.equal(b.el('incCorFecha').value,'2026-10-05');assert.equal(b.el('incCorMotivo').value,'');
    assert.match(b.sheet().textContent,/Motivo original/);
    b.el('incCorFecha').value='2026-10-06';b.el('incCorMotivo').value='Fecha mal cargada';
    b.el('incCorGuardar').click();b.el('incCorGuardar').click();await tick();
    const enviado=b.calls.at(-1);assert.equal(enviado.url,ruta);assert.equal(enviado.opts.method,'PATCH');
    const payload=JSON.parse(enviado.opts.body);
    assert.deepEqual(Object.keys(payload).sort(),['fecha','motivo','solicitud_id','version']);
    assert.equal(payload.fecha,'2026-10-06');assert.equal(payload.motivo,'Fecha mal cargada');assert.equal(payload.version,'b'.repeat(64));
    b.el('incCorFecha').value='2026-10-07';b.el('incCorGuardar').click();await tick();
    assert.equal(b.calls.at(-1).opts.body,enviado.opts.body);assert.equal(b.calls.filter(c=>c.opts.method).length,2);
    assert.equal(b.sheet().querySelector('[data-action="cerrar-sheet"]').disabled,false);
  }finally{b.w.close();}
});

test('Incidencia: cambio de negocio y cancelación invalidan el envío, empleado no carga el editor',async()=>{
  for(const accion of ['cambiar','cancelar','empleado']) {
    const b=browser(()=>respuesta({evento:{id:'inc',tipo:'equipo_retirado',fecha:'2026-10-05'},version:'b'.repeat(64)}));
    try {
      if(accion==='empleado')b.w.qaState.usuario={rol:'empleado'};
      await b.w.abrirCorreccionFechaIncidencia('cliente','cr','qa','inc');
      if(accion==='empleado'){assert.equal(b.calls.length,0);continue;}
      b.el('incCorMotivo').value='Corregir fecha';
      if(accion==='cambiar')b.w.qaState.negocioActual='otro';else b.w.closeSheet();
      b.el('incCorGuardar').click();await tick();assert.equal(b.calls.filter(c=>c.opts.method).length,0);
    }finally{b.w.close();}
  }
});
