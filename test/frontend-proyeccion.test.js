import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const styles=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const projection=(overrides={})=>({
  fechaCorte:'2026-10-19',desdeMes:'2026-10',hastaMes:'2028-02',
  mesActual:{mes:'2026-10',pendienteCentavos:48800000,cuotas:4,vencidoCentavos:2300000},
  mesSiguiente:{mes:'2026-11',pendienteCentavos:46500000,cuotas:3,vencidoCentavos:0},
  proximos7Dias:{desde:'2026-10-19',hasta:'2026-10-25',pendienteCentavos:15500000,cuotas:1},
  proximos14Dias:{desde:'2026-10-19',hasta:'2026-11-01',pendienteCentavos:31000000,cuotas:2},
  vencidoTotalCentavos:3300000,
  meses:[{mes:'2026-10',pendienteCentavos:48800000,cuotas:4,vencidoCentavos:2300000},
    {mes:'2026-11',pendienteCentavos:46500000,cuotas:3,vencidoCentavos:0},
    {mes:'2028-02',pendienteCentavos:9900000,cuotas:1,vencidoCentavos:0}],...overrides,
});
const resumen=p=>({vendidoTotalCentavos:111000000,cobradoMesCentavos:46500000,cobradoHoyCentavos:0,porCobrarHoyCentavos:0,
  saldoPendienteTotalCentavos:100000000,saldoVencidoCentavos:3300000,clientesEnMora:1,montoEnRiesgoCentavos:0,
  ventasActivas:3,ventasFinalizadas:1,proyeccionCobros:p});
function browser(respond=()=>resumen(projection())) {
  const dom=new JSDOM(page,{url:'https://zilky.test/#/inicio',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];
  w.fetch=async(url,opts={})=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>respond(url,opts)};};
  w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.localStorage.setItem('zilky_token','sesion-qa');
  w.qaState.usuario={id:'admin',rol:'administrador'};w.qaState.negocioActual='qa';w.qaState.negocios=[{id:'qa',nombre:'Tienda QA'}];
  return {w,calls,view:w.document.getElementById('view'),el:selector=>w.document.querySelector(selector)};
}
const monthRows=b=>[...b.view.querySelectorAll('[data-projection-month]')];
const next=b=>b.el('[data-projection-next]').click();
const metric=(b,key)=>b.el(`[data-projection-metric="${key}"]`);

test('Cobros previstos: muestra capital mensual, rangos visibles de 7/14 y vencidos sin presentar importes como facturación',async()=>{
  const b=browser();
  try {
    await b.w.viewInicio(b.view);
    assert.equal(b.calls[0].url,'/api/dashboard/resumen?negocio_id=qa');
    assert.equal(b.el('#proyeccionTitulo').textContent,'Cobros previstos');
    assert.match(metric(b,'mesActual').textContent,/Por cobrar este mes.*488\.000.*4 cuotas pendientes/s);
    assert.match(metric(b,'mesSiguiente').textContent,/Próximo mes.*465\.000.*3 cuotas pendientes/s);
    assert.match(metric(b,'proximos7Dias').textContent,/Próximos 7 días.*155\.000.*1 cuota pendiente/s);
    assert.match(metric(b,'proximos14Dias').textContent,/Próximos 14 días.*310\.000.*2 cuotas pendientes/s);
    assert.match(b.el('.projection-range').textContent,/7 días: del 19\/10\/2026 al 25\/10\/2026.*14 días: del 19\/10\/2026 al 01\/11\/2026.*Hoy incluido/s);
    assert.match(b.el('.cash-projection > .projection-overdue-tag').textContent,/Este mes incluye.*23\.000 vencidos/);
    assert.match(b.el('.projection-overdue').textContent,/33\.000/);
    assert.match(b.el('.cash-projection').textContent,/Capital pendiente según vencimiento\. No incluye mora ni ventas futuras\. Los vencidos no se suman a 7\/14 días\./);
    assert.match(b.el('.cash-projection').textContent,/14 días incluyen los próximos 7 días; los importes no se suman/);
    assert.match(b.el('.cash-projection').textContent,/no representa facturación fiscal/);
    assert.equal(metric(b,'mesSiguiente').querySelector('.projection-overdue-tag'),null);
  }finally{b.w.close();}
});

test('Cobros previstos: rellena meses vacíos y permite alcanzar toda deuda después de los primeros 12 meses sin nuevas consultas',async()=>{
  const b=browser();
  try {
    await b.w.viewInicio(b.view);
    assert.equal(b.view.children[0].className,'dashboard-heading');
    assert.equal(b.view.children[0].querySelector('h1').textContent,'Resumen financiero');
    assert.equal(b.view.children[1].matches('[data-cash-projection]'),true,'La previsión es el primer bloque después del título');
    assert.ok(b.el('.cash-projection').compareDocumentPosition(b.el('.kpi-grid'))&b.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(b.el('.projection-grid').nextElementSibling.className,'projection-month-picker');
    assert.equal(b.el('[data-projection-detail]').open,false,'Los doce meses no empujan el resto del resumen');
    assert.equal(monthRows(b).length,12);
    assert.equal(monthRows(b)[0].dataset.projectionMonth,'2026-10');assert.equal(monthRows(b).at(-1).dataset.projectionMonth,'2027-09');
    assert.match(b.el('[data-projection-month="2026-12"]').textContent,/diciembre de 2026.*0 cuotas pendientes.*\$\s*0/s);
    assert.equal(b.el('[data-projection-prev]').disabled,true);assert.equal(b.el('[data-projection-next]').disabled,false);
    next(b);
    assert.equal(monthRows(b)[0].dataset.projectionMonth,'2027-10');assert.equal(monthRows(b).at(-1).dataset.projectionMonth,'2028-02');
    assert.match(b.el('[data-projection-month="2028-02"]').textContent,/febrero de 2028.*1 cuota pendiente.*99\.000/s);
    assert.match(b.el('[data-projection-range]').textContent,/Página 2 de 2/);
    assert.equal(b.el('[data-projection-next]').disabled,true);assert.equal(b.el('[data-projection-prev]').disabled,false);
    b.el('[data-projection-prev]').click();assert.equal(monthRows(b)[0].dataset.projectionMonth,'2026-10');
    assert.equal(b.calls.length,1,'La paginación usa todos los meses recibidos, sin recargar otro negocio');
  }finally{b.w.close();}
});

test('Cobros previstos: conserva horizonte mínimo de un año aun sin cuotas pendientes',async()=>{
  const p=projection({hastaMes:'2026-10',meses:[],mesActual:{mes:'2026-10',pendienteCentavos:0,cuotas:0,vencidoCentavos:0}});
  const b=browser(()=>resumen(p));
  try {
    await b.w.viewInicio(b.view);assert.equal(monthRows(b).length,12);
    assert.equal(monthRows(b).every(row=>/0 cuotas pendientes/.test(row.textContent)),true);
    assert.equal(b.el('[data-projection-next]').disabled,true);assert.equal(b.el('#proyeccionMes').max,'2027-09');
  }finally{b.w.close();}
});

test('Cobros previstos: selector alcanza un vencimiento de 2099 y valida los límites de navegación',async()=>{
  const p=projection({hastaMes:'2099-12',meses:[{mes:'2099-12',pendienteCentavos:123456789000,cuotas:1,vencidoCentavos:0}]});
  const b=browser(()=>resumen(p));
  try {
    await b.w.viewInicio(b.view);
    let input=b.el('#proyeccionMes');assert.equal(input.min,'2026-10');assert.equal(input.max,'2099-12');
    input.value='2099-12';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));
    assert.equal(b.el('#proyeccionMes').value,'2099-12');
    assert.equal(b.el('[data-projection-month="2099-12"]').getAttribute('aria-current'),'date');
    assert.ok(b.el('[data-projection-month="2099-12"]'));
    assert.match(b.el('[data-projection-month="2099-12"]').textContent,/1\.234\.567\.890/);
    assert.equal(b.el('[data-projection-next]').disabled,true);
    const original=b.el('[data-projection-months]').textContent;
    input=b.el('#proyeccionMes');input.value='2100-01';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));
    assert.equal(b.el('[data-projection-months]').textContent,original);
    input.value='2026-09';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));assert.equal(b.el('[data-projection-months]').textContent,original);
    input.value='';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));assert.equal(b.el('[data-projection-months]').textContent,original);
  }finally{b.w.close();}
});

test('Cobros previstos: una cuota posterior al hastaMes recibido tampoco queda truncada',async()=>{
  const b=browser(()=>resumen(projection({hastaMes:'2027-09',meses:[{mes:'2028-02',pendienteCentavos:9900000,cuotas:1,vencidoCentavos:0}]})));
  try {await b.w.viewInicio(b.view);assert.equal(b.el('#proyeccionMes').max,'2028-02');next(b);assert.ok(b.el('[data-projection-month="2028-02"]'));}
  finally{b.w.close();}
});

test('Cobros previstos: el selector conserva el mes preciso dentro de una página y muestra su monto',async()=>{
  const p=projection();p.meses.push({mes:'2026-12',pendienteCentavos:22200000,cuotas:2,vencidoCentavos:0});
  const b=browser(()=>resumen(p));
  try {
    await b.w.viewInicio(b.view);
    const input=b.el('#proyeccionMes');input.value='2026-12';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));
    assert.equal(b.el('#proyeccionMes').value,'2026-12');
    assert.match(b.el('[data-projection-selected]').textContent,/diciembre de 2026.*2 cuotas pendientes.*222\.000/s);
    assert.equal(b.el('[data-projection-month="2026-12"]').getAttribute('aria-current'),'date');
    assert.equal(b.el('[data-projection-month="2026-10"]').hasAttribute('aria-current'),false);
    b.el('[data-projection-detail]').open=true;next(b);
    assert.equal(b.el('[data-projection-detail]').open,true);assert.equal(b.el('#proyeccionMes').value,'2026-12');
    assert.match(b.el('[data-projection-selected]').textContent,/diciembre de 2026.*222\.000/s);
    b.el('[data-projection-prev]').click();assert.equal(b.el('[data-projection-detail]').open,true);
    assert.equal(b.el('[data-projection-month="2026-12"]').getAttribute('aria-current'),'date');
  }finally{b.w.close();}
});

test('Cobros previstos: atajos a uno, dos y tres meses consultan el mes y monto correspondientes',async()=>{
  const p=projection();p.meses.push({mes:'2026-12',pendienteCentavos:22200000,cuotas:2,vencidoCentavos:0},{mes:'2027-01',pendienteCentavos:33300000,cuotas:3,vencidoCentavos:0});
  const b=browser(()=>resumen(p));
  try {
    await b.w.viewInicio(b.view);
    for(const [offset,mes,valor] of [[1,'2026-11','465.000'],[2,'2026-12','222.000'],[3,'2027-01','333.000']]){
      b.el(`[data-projection-offset="${offset}"]`).click();assert.equal(b.el('#proyeccionMes').value,mes);
      assert.ok(b.el('.projection-selected-amount').textContent.includes(valor));
      assert.equal(b.el(`[data-projection-offset="${offset}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(b.el(`[data-projection-month="${mes}"]`).getAttribute('aria-current'),'date');
    }
    assert.equal(b.calls.length,1);
  }finally{b.w.close();}
});

test('Cobros previstos: si la respuesta no trae proyección muestra aviso recuperable y actualiza sin duplicar solicitudes',async()=>{
  let cantidad=0,terminar;
  const b=browser(()=>++cantidad===1?resumen(undefined):new Promise(resolve=>terminar=resolve));
  try {
    await b.w.viewInicio(b.view);
    assert.match(b.el('[data-projection-unavailable]').textContent,/No se pudo cargar la previsión de cobros/);
    assert.equal(b.el('[data-cash-projection]'),null);
    const buttons=[...b.view.querySelectorAll('[data-dashboard-refresh]')];assert.equal(buttons.length,2);
    buttons[1].click();buttons[0].click();await tick();
    assert.equal(b.calls.length,2);assert.equal(buttons.every(button=>button.disabled),true);
    assert.equal(b.calls[1].opts.cache,'no-store');
    terminar(resumen(projection()));await tick();
    assert.equal(b.el('[data-projection-unavailable]'),null);assert.ok(b.el('[data-cash-projection]'));
    assert.equal(b.el('[data-dashboard-refresh]').disabled,false);
  }finally{b.w.close();}
});

test('Cobros previstos: Actualizar conserva las guardas si cambia el negocio durante la consulta',async()=>{
  let cantidad=0,terminar;
  const b=browser(()=>++cantidad===1?resumen(projection()):new Promise(resolve=>terminar=resolve));
  try {
    await b.w.viewInicio(b.view);b.el('[data-dashboard-refresh]').click();await tick();
    b.w.qaState.negocioActual='otra';b.view.textContent='Otra tienda';terminar(resumen(projection()));await tick();
    assert.equal(b.view.textContent,'Otra tienda');assert.equal(b.el('[data-cash-projection]'),null);
  }finally{b.w.close();}
});

test('Cobros previstos: el resumen global conserva todos los negocios y codifica el negocio elegido al consultar',async()=>{
  const b=browser();
  try {
    b.w.qaState.negocioActual=null;await b.w.viewInicio(b.view);
    assert.equal(b.calls[0].url,'/api/dashboard/resumen');assert.match(b.el('.projection-cutoff').textContent,/Todos los negocios/);
    b.w.qaState.negocioActual='tienda & ropa';b.w.qaState.negocios=[{id:'tienda & ropa',nombre:'Ropa QA'}];await b.w.viewInicio(b.view);
    assert.equal(b.calls[1].url,'/api/dashboard/resumen?negocio_id=tienda%20%26%20ropa');assert.match(b.el('.projection-cutoff').textContent,/Ropa QA/);
  }finally{b.w.close();}
});

test('Cobros previstos: un empleado con permiso financiero antiguo no consulta ni renderiza el dashboard',async()=>{
  const b=browser();
  try {
    b.w.qaState.usuario={id:'empleado',rol:'empleado',negocios:[{negocio_id:'qa',activo:1,permisos:{'dashboard_financiero.ver':true}}]};
    await b.w.viewInicio(b.view);assert.match(b.view.textContent,/Requiere administrador/);assert.equal(b.calls.length,0);
    assert.equal(b.w.proyeccionCobrosHtml(projection()),'');
    await b.w.render();assert.equal(b.el('[data-cash-projection]'),null);assert.equal(b.calls.length,0);
  }finally{b.w.close();}
});

for(const cambio of ['negocio','sesion','rol','usuario','navegacion'])test(`Cobros previstos: descarta la respuesta tardía después de cambiar ${cambio}`,async()=>{
  let terminar;
  const b=browser(()=>new Promise(resolve=>terminar=resolve));
  try {
    const pending=b.w.viewInicio(b.view);await tick();b.view.textContent='Pantalla actual';
    if(cambio==='negocio')b.w.qaState.negocioActual='otra';
    if(cambio==='sesion')b.w.localStorage.setItem('zilky_token','otra');
    if(cambio==='rol')b.w.qaState.usuario={id:'admin',rol:'empleado'};
    if(cambio==='usuario')b.w.qaState.usuario={id:'otro-admin',rol:'administrador'};
    if(cambio==='navegacion')b.view.remove();
    terminar(resumen(projection()));await pending;
    assert.equal(b.view.textContent,'Pantalla actual');assert.equal(b.view.querySelector('[data-cash-projection]'),null);
  }finally{b.w.close();}
});

test('Cobros previstos: un fallo tardío de otra sesión no reemplaza la pantalla actual',async()=>{
  let rechazar;
  const b=browser(()=>new Promise((resolve,reject)=>rechazar=reject));
  try {
    const pending=b.w.viewInicio(b.view);await tick();b.w.localStorage.setItem('zilky_token','otra');b.view.textContent='Nueva sesión';
    rechazar(new Error('Sin conexión'));await assert.doesNotReject(pending);assert.equal(b.view.textContent,'Nueva sesión');
  }finally{b.w.close();}
});

for(const cambio of ['negocio','sesion','rol','usuario'])test(`Cobros previstos: sus controles no navegan datos después de cambiar ${cambio}`,async()=>{
  const b=browser();
  try {
    await b.w.viewInicio(b.view);const meses=b.el('[data-projection-months]').textContent;
    if(cambio==='negocio')b.w.qaState.negocioActual='otra';
    if(cambio==='sesion')b.w.localStorage.removeItem('zilky_token');
    if(cambio==='rol')b.w.qaState.usuario={id:'admin',rol:'empleado'};
    if(cambio==='usuario')b.w.qaState.usuario={id:'otro-admin',rol:'administrador'};
    next(b);const input=b.el('#proyeccionMes');input.value='2028-02';input.dispatchEvent(new b.w.Event('change',{bubbles:true}));
    b.el('[data-projection-offset="2"]').click();b.el('[data-dashboard-refresh]').click();
    assert.equal(b.el('[data-projection-months]').textContent,meses);assert.equal(b.calls.length,1);
  }finally{b.w.close();}
});

test('Cobros previstos: datos de texto se escapan y meses inválidos no crean atributos o controles',async()=>{
  const ataque='<img src=x onerror="alert(1)">';
  const p=projection({fechaCorte:ataque,mesActual:{mes:ataque,pendienteCentavos:100,cuotas:1,vencidoCentavos:0},meses:[{mes:ataque,pendienteCentavos:100,cuotas:1,vencidoCentavos:0}]});
  const b=browser(()=>resumen(p));
  try {
    b.w.qaState.negocios[0].nombre=ataque;await b.w.viewInicio(b.view);
    assert.equal(b.view.querySelector('img,script,[onerror]'),null);
    assert.match(b.el('.projection-cutoff').textContent,/<img src=x/);
    assert.equal(metric(b,'mesActual').querySelector('h3').textContent,'Por cobrar este mes');assert.equal(monthRows(b).length,12);
  }finally{b.w.close();}
});

test('Cobros previstos: estilos móviles conservan dos columnas compactas y permiten encoger controles',()=>{
  const b=browser();
  try {
    const style=b.w.document.createElement('style');style.textContent=styles;b.w.document.head.append(style);
    const rules=[...style.sheet.cssRules];
    const mobile=rules.find(rule=>rule.media?.mediaText==='(max-width:480px)'&&[...rule.cssRules].some(inner=>inner.selectorText==='.projection-grid'));
    assert.ok(mobile,'Las tarjetas tienen una variante para teléfonos');
    const inner=[...mobile.cssRules];
    assert.equal(inner.find(rule=>rule.selectorText==='.projection-grid').style.getPropertyValue('grid-template-columns'),'repeat(2,minmax(0,1fr))');
    assert.equal(inner.find(rule=>rule.selectorText==='.projection-month').style.getPropertyValue('grid-template-columns'),'minmax(0,1fr)');
    assert.equal(inner.find(rule=>rule.selectorText==='.projection-month-amount').style.getPropertyValue('text-align'),'left');
    assert.equal(rules.find(rule=>rule.selectorText==='.projection-month-picker input').style.getPropertyValue('min-width'),'0');
    assert.equal(rules.find(rule=>rule.selectorText==='.projection-amount').style.getPropertyValue('white-space'),'nowrap');
  }finally{b.w.close();}
});
