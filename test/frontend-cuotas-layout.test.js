import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const purifier=fs.readFileSync(new URL('../public/vendor/purify.min.js',import.meta.url),'utf8');
const styles=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const credito={id:'credito',cliente_id:'cliente',negocio_id:'tienda',modalidad:'cuotas',estado:'activo',monto_total_centavos:9700000,entrega_inicial_centavos:0,saldo_financiado_centavos:9700000,fecha_inicio:'2026-09-01',cuotas:[{
  id:'cuota',numero:4,monto_centavos:9700000,saldo_pendiente_centavos:8800000,fecha_vencimiento:'2026-10-01',estado:'mora',diasHasta:-18,diasAtraso:18,moraGenerada:1500000,moraPendiente:1250000,moraCobrada:200000,moraPerdonada:50000,
}]};

function browser(rol='administrador') {
  const dom=new JSDOM(page,{url:'https://zilky.test/',runScripts:'outside-only'}),w=dom.window;
  w.requestAnimationFrame=fn=>{fn(0);return 1;};
  w.eval(purifier);w.eval(source+'\nwindow.qaState=state;');
  w.qaState.usuario={rol};w.qaState.negocioActual='tienda';w.qaState.negocios=[{id:'tienda',nombre:'Tienda'}];
  const style=w.document.createElement('style');style.textContent=styles;w.document.head.appendChild(style);
  const view=w.document.getElementById('view');w.setHTML(view,w.creditoCardHtml(credito));
  return {w,view};
}

test('Cuotas: saldo y estado conservan su espacio y los controles mantienen sus destinos',()=>{
  const b=browser();
  try {
    const row=b.view.querySelector('.credito-cuota'),resumen=row.querySelector('.credito-cuota-resumen'),acciones=row.querySelector('.credito-cuota-acciones');
    assert.match(resumen.querySelector('.credito-cuota-importe').textContent,/88\.000/);
    assert.match(resumen.textContent,/En mora/);
    assert.equal(resumen.querySelector('button'),null);
    assert.match(row.querySelector('.credito-cuota-mora').textContent,/Mora generada:.*15\.000.*Pendiente:.*12\.500.*Cobrada:.*2\.000.*Perdonada:.*500/);
    assert.equal(acciones.querySelector('[data-action="corregir-financiacion"]').dataset.credito,'credito');
    assert.equal(acciones.querySelector('[data-action="corregir-financiacion"]').dataset.cuota,'cuota');
    assert.equal(acciones.querySelector('[data-action="perdonar-mora"]').dataset.cuota,'cuota');
    assert.equal(acciones.querySelector('[data-action="perdonar-mora"]').dataset.negocio,'tienda');
    assert.equal(b.w.getComputedStyle(row).display,'grid');
    assert.equal(b.w.getComputedStyle(resumen.querySelector('.credito-cuota-importe')).whiteSpace,'nowrap');
    assert.equal(b.w.getComputedStyle(acciones.querySelector('button')).flexShrink,'0');
    assert.equal(b.w.getComputedStyle(acciones.querySelector('button')).whiteSpace,'nowrap');
    const otra=b.w.document.createElement('div');otra.className='cuota-row';b.view.appendChild(otra);
    assert.equal(b.w.getComputedStyle(otra).display,'flex','Las filas de resumen ajenas a la compra conservan su layout');
  }finally{b.w.close();}
});

test('Cuotas: empleados conservan importes e historial visibles sin controles de administrador',()=>{
  const b=browser('empleado');
  try {
    assert.match(b.view.querySelector('.credito-cuota-resumen').textContent,/88\.000/);
    assert.match(b.view.querySelector('.credito-cuota-mora').textContent,/12\.500/);
    assert.equal(b.view.querySelector('.credito-cuota-acciones'),null);
    assert.equal(b.view.querySelector('[data-action="perdonar-mora"], [data-action="corregir-financiacion"]'),null);
  }finally{b.w.close();}
});
