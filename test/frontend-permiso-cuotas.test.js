import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const respuesta=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const negocios=[{id:'qa',nombre:'Celulares'},{id:'otro',nombre:'Ropa'}];
const asignaciones=()=>[
  {negocio_id:'qa',activo:1,permisos:{'clientes.ver':true,'cuotas.editar':true}},
  {negocio_id:'otro',activo:1,permisos:{'clientes.ver':true,'cuotas.editar':false}},
];
const empleado=()=>({id:'empleado',nombre:'Empleado QA',email:'empleado@qa.invalid',rol:'empleado',activo:1,negocios:asignaciones()});
const vista=()=>({solo_cuotas:true,version:'a'.repeat(64),credito:{id:'cr',negocio_id:'qa',fecha_inicio:'2026-09-01'},
  pagos:[{id:'p',tipo:'cuota',monto_centavos:100000,fecha_hora:'2026-09-16T12:00:00-03:00',anulado:0}],
  aplicaciones:[{cuota_id:'q1',capital_centavos:100000}],cuotas:[
    {id:'q1',numero:1,monto_centavos:100000,saldo_pendiente_centavos:0,fecha_vencimiento:'2026-09-16',fecha_saldada:'2026-09-16',puede_quitar:false},
    {id:'q2',numero:2,monto_centavos:100000,saldo_pendiente_centavos:100000,fecha_vencimiento:'2026-10-16',puede_quitar:true},
    {id:'q3',numero:3,monto_centavos:100000,saldo_pendiente_centavos:100000,fecha_vencimiento:'2026-12-16',puede_quitar:true},
  ]});
function browser(respond=()=>respuesta(vista())) {
  const dom=new JSDOM(page,{url:'https://zilky.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];
  w.fetch=async(url,opts={})=>{calls.push({url,opts});return respond(url,opts);};
  w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.localStorage.setItem('zilky_token','sesion-empleado');
  w.qaState.usuario=empleado();w.qaState.negocios=negocios;w.qaState.negocioActual='qa';
  return {w,calls,view:w.document.getElementById('view'),el:id=>w.document.getElementById(id),sheet:()=>w.document.getElementById('activeSheet')};
}
function tarjeta(b,negocioId='qa') {
  const v=vista();
  const cr={...v.credito,negocio_id:negocioId,cliente_id:'cliente',estado:'activo',modalidad:'cuotas',cuotas:v.cuotas.map(q=>({...q,estado:q.fecha_saldada?'pagada':'mora',moraGenerada:100,moraPendiente:100})),incidencias:[]};
  b.w.setHTML(b.view,b.w.creditoCardHtml(cr));
  return b.view;
}

test('Permiso de cuotas UI: la invitación ofrece una casilla legible por negocio y conserva sus valores separados',async()=>{
  const b=browser(url=>respuesta(url==='/api/negocios'?negocios:[]));
  try {
    b.w.qaState.usuario={id:'jefe',rol:'administrador'};
    await b.w.viewEmpleados(b.view);
    for(const id of ['qa','otro']) {
      const check=b.view.querySelector(`[data-negocio="${id}"][data-permiso="cuotas.editar"]`);
      assert.ok(check);assert.match(check.closest('label').textContent,/Editar cuotas/);
      assert.equal(check.disabled,true);assert.equal(check.checked,false);
      b.view.querySelector(`.inv-negocio-check[data-id="${id}"]`).click();
    }
    b.view.querySelector('[data-negocio="qa"][data-permiso="cuotas.editar"]').click();
    b.view.querySelector('[data-negocio="qa"][data-permiso="clientes.ver"]').click();
    const values=JSON.parse(JSON.stringify(b.w.recogerAsignaciones('inv')));
    assert.equal(values.find(a=>a.negocio_id==='qa').permisos['cuotas.editar'],true);
    assert.equal(values.find(a=>a.negocio_id==='otro').permisos['cuotas.editar'],false);
    assert.match(b.view.textContent,/Requiere ver clientes/i);
  } finally {b.w.close();}
});

test('Permiso de cuotas UI: editar un empleado guarda la concesión por negocio y muestra su nombre legible',async()=>{
  const b=browser((url,opts)=>respuesta(url==='/api/usuarios/empleado'&&!opts.method?empleado():url==='/api/negocios'?negocios:url==='/api/usuarios'?[empleado()]:[]));
  try {
    b.w.qaState.usuario={id:'jefe',rol:'administrador'};
    b.w.history.replaceState({},'','/#/empleados');
    await b.w.editarEmpleado('empleado');
    const allowed=b.sheet().querySelector('[data-negocio="qa"][data-permiso="cuotas.editar"]');
    const denied=b.sheet().querySelector('[data-negocio="otro"][data-permiso="cuotas.editar"]');
    assert.equal(allowed.checked,true);assert.equal(denied.checked,false);
    allowed.click();denied.click();await b.w.guardarEmpleado('empleado');
    const req=b.calls.find(c=>c.opts.method==='PATCH'),body=JSON.parse(req.opts.body);
    assert.equal(req.url,'/api/usuarios/empleado');
    assert.equal(body.negocios.find(a=>a.negocio_id==='qa').permisos['cuotas.editar'],false);
    assert.equal(body.negocios.find(a=>a.negocio_id==='otro').permisos['cuotas.editar'],true);
    await b.w.viewEmpleados(b.view);
    const row=b.view.querySelector('[data-action="editar-empleado"][data-id="empleado"]').closest('.list-item');
    assert.match(row.querySelector('details').textContent,/Editar cuotas/);
    assert.doesNotMatch(row.querySelector('details').textContent,/cuotas\.editar/);
  } finally {b.w.close();}
});

test('Permiso de cuotas UI: el acceso requiere ver clientes y editar cuotas en la misma asignación activa',async()=>{
  for(const mode of ['permitido','sin-cuotas','sin-clientes','otro-negocio','inactivo']) {
    const b=browser();
    try {
      const actual=b.w.qaState.usuario.negocios[0];
      if(mode==='sin-cuotas')actual.permisos['cuotas.editar']=false;
      if(mode==='sin-clientes')actual.permisos['clientes.ver']=false;
      if(mode==='inactivo')actual.activo=0;
      const id=mode==='otro-negocio'?'otro':'qa',view=tarjeta(b,id);
      const controls=view.querySelectorAll('[data-action="corregir-financiacion"]');
      assert.equal(controls.length>0,mode==='permitido',mode);
      if(mode==='permitido')assert.equal(controls[0].textContent,'Editar cuotas');
      assert.equal(view.querySelector('[data-action="perdonar-mora"],[data-action="eliminar-venta-error"]'),null);
      if(mode!=='permitido') {
        await b.w.abrirCorreccionFinanciacion('cr',id);
        assert.equal(b.calls.length,0,'No carga financiación sin permiso: '+mode);
      }
    } finally {b.w.close();}
  }
});

test('Permiso de cuotas UI: el editor del empleado conserva cuotas existentes y bloquea las saldadas',async()=>{
  const b=browser();
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa','q2');
    assert.match(b.sheet().querySelector('.sheet-title').textContent,/Editar cuotas/);
    assert.equal(b.calls[0].url,'/api/ventas/creditos/cr/correccion?negocio_id=qa');
    assert.equal(b.sheet().querySelector('#corTotal,#corEntrega,#corFecha,#corFechaEntrega,#corProducto,#corCondiciones,#corAgregar,.corQuitar'),null);
    const rows=[...b.el('corCuotas').children];assert.equal(rows.length,3);
    assert.equal(rows[0].querySelector('.corMonto').disabled,true);assert.equal(rows[0].querySelector('.corVence').disabled,true);
    assert.equal(rows[1].querySelector('.corMonto').disabled,false);assert.equal(rows[1].querySelector('.corVence').disabled,false);
    assert.equal(b.w.document.activeElement,rows[1].querySelector('.corVence'));
    assert.ok(b.el('corConfirmar'));assert.ok(b.el('corMotivo'));
  } finally {b.w.close();}
});

test('Permiso de cuotas UI: corregir octubre a noviembre envía sólo las cuotas, con motivo y confirmación',async()=>{
  const b=browser((url,opts)=>respuesta(opts.method?{error:'Revisión QA'}:vista(),opts.method?400:200));
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa');
    const rows=[...b.el('corCuotas').children];rows[1].querySelector('.corVence').value='2026-11-16';rows[1].querySelector('.corMonto').value='1200';
    b.el('corMotivo').value='Se cargó octubre en lugar de noviembre';b.el('corConfirmar').checked=true;b.el('corGuardar').click();await tick();
    const req=b.calls.find(c=>c.opts.method==='PATCH'),body=JSON.parse(req.opts.body);
    assert.equal(req.url,'/api/ventas/creditos/cr/correccion');
    assert.deepEqual(Object.keys(body.datos),['cuotas']);
    assert.equal(body.negocio_id,'qa');assert.equal(body.version,'a'.repeat(64));assert.equal(body.confirmar_correccion_pagos,true);
    assert.equal(body.motivo,'Se cargó octubre en lugar de noviembre');assert.match(body.solicitud_id,/^[a-f0-9-]{36}$/i);
    assert.deepEqual(body.datos.cuotas,[
      {id:'q1',monto_centavos:100000,fecha_vencimiento:'2026-09-16'},
      {id:'q2',monto_centavos:120000,fecha_vencimiento:'2026-11-16'},
      {id:'q3',monto_centavos:100000,fecha_vencimiento:'2026-12-16'},
    ]);
    assert.equal(rows[0].querySelector('.corVence').disabled,true,'Un 400 conserva el bloqueo de la cuota saldada');
    assert.equal(rows[1].querySelector('.corVence').disabled,false);
  } finally {b.w.close();}
});

test('Permiso de cuotas UI: una respuesta perdida reintenta el mismo cuerpo limitado sin duplicar el doble clic',async()=>{
  const b=browser((url,opts)=>{if(opts.method)throw Error('Sin conexión');return respuesta(vista());});
  try {
    await b.w.abrirCorreccionFinanciacion('cr','qa');
    b.el('corMotivo').value='Error de mes';b.el('corConfirmar').checked=true;
    const due=b.el('corCuotas').children[1].querySelector('.corVence');due.value='2026-11-16';
    b.el('corGuardar').click();b.el('corGuardar').click();await tick();
    const sent=b.calls.find(c=>c.opts.method);assert.equal(b.calls.filter(c=>c.opts.method).length,1);
    assert.equal(b.sheet().querySelector('[data-action="cerrar-sheet"]').disabled,false);
    due.value='2026-12-16';b.el('corGuardar').click();await tick();
    assert.equal(b.calls.filter(c=>c.opts.method).length,2);assert.equal(b.calls.at(-1).opts.body,sent.opts.body);
    assert.deepEqual(Object.keys(JSON.parse(sent.opts.body).datos),['cuotas']);
  } finally {b.w.close();}
});

test('Permiso de cuotas UI: revocar el permiso, cambiar sesión, negocio o rol invalida el envío abierto',async()=>{
  for(const action of ['revocar','clientes','token','negocio','rol','cerrar']) {
    const b=browser();
    try {
      await b.w.abrirCorreccionFinanciacion('cr','qa');b.el('corMotivo').value='Corregir fecha';
      b.el('corConfirmar').checked=true;const save=b.el('corGuardar');
      if(action==='revocar')b.w.qaState.usuario.negocios[0].permisos['cuotas.editar']=false;
      if(action==='clientes')b.w.qaState.usuario.negocios[0].permisos['clientes.ver']=false;
      if(action==='token')b.w.localStorage.setItem('zilky_token','otra-sesion');
      if(action==='negocio')b.w.qaState.negocioActual='otro';
      if(action==='rol')b.w.qaState.usuario.rol='administrador';
      if(action==='cerrar')b.w.closeSheet();
      save.click();await tick();assert.equal(b.calls.filter(c=>c.opts.method).length,0,action);
    } finally {b.w.close();}
  }
});

test('Permiso de cuotas UI: una carga tardía no abre el editor después de perder el permiso',async()=>{
  let resolve;const b=browser(()=>new Promise(done=>{resolve=done;}));
  try {
    const pending=b.w.abrirCorreccionFinanciacion('cr','qa');
    b.w.qaState.usuario.negocios[0].permisos['cuotas.editar']=false;
    resolve(respuesta(vista()));await pending;
    assert.equal(b.el('corCuotas'),null);assert.equal(b.calls.length,1);
  } finally {b.w.close();}
});
