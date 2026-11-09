import test from 'node:test';
import assert from 'node:assert/strict';
import {calcularGanancias} from '../src/lib/ganancias.js';

test('Ropa: una sola deuda, entregas parciales y ganancia recién después de cubrir costo y comisión',()=>{
  const ventas=[{id:'now',fecha:'2026-10-05',vencimiento:'2026-11-04',precio_centavos:4300000,costo_centavos:2014385,comision_centavos:250000}];
  const pagos=[
    {venta_id:'now',fecha_hora:'2026-10-05T12:00:00-03:00',capital_centavos:1000000},
    {venta_id:'now',fecha_hora:'2026-10-20T12:00:00-03:00',capital_centavos:1200000},
    {venta_id:'now',fecha_hora:'2026-11-02T12:00:00-03:00',capital_centavos:2100000},
  ];
  const a=calcularGanancias(ventas,pagos.slice(0,1));
  assert.equal(a.realizadaCentavos,0);
  assert.equal(a.pendienteCentavos,2035615);
  const b=calcularGanancias(ventas,pagos.slice(0,2));
  assert.equal(b.realizadaCentavos,0,'Aun no recuperó compra con envío y comisión');
  const c=calcularGanancias(ventas,pagos);
  assert.equal(c.esperadaCentavos,2035615);
  assert.equal(c.realizadaCentavos,2035615);
  assert.equal(c.pendienteCentavos,0);
  assert.equal(c.meses.find(x=>x.mes==='2026-10').realizadaCentavos,0);
  assert.equal(c.meses.find(x=>x.mes==='2026-11').realizadaCentavos,2035615);
  assert.equal(c.meses.find(x=>x.mes==='2026-11').esperadaCentavos,2035615);
});

test('Ropa: sin anticipo solo un saldo, abonos sin duplicar ganancias y vencimiento distinto del mes de venta',()=>{
  const ventas=[{id:'v',fecha:'2026-10-31',vencimiento:'2026-12-03',precio_centavos:4300000,costo_centavos:2014385,comision_centavos:250000}];
  const pagos=[{venta_id:'v',fecha_hora:'2026-11-07',capital_centavos:2500000}];
  const a=calcularGanancias(ventas,pagos);
  assert.equal(a.realizadaCentavos,235615);
  assert.equal(a.pendienteCentavos,1800000);
  assert.equal(a.meses.find(x=>x.mes==='2026-12').esperadaCentavos,2035615);
  assert.equal(a.meses.find(x=>x.mes==='2026-11').realizadaCentavos,235615);
  assert.equal(a.meses.find(x=>x.mes==='2026-12').pendienteCentavos,1800000);
});
