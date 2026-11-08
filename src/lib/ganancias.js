// El margen se libera solamente cuando los cobros de capital recuperan
// el costo de la mercadería (con envío) y la comisión del vendedor.
// Los abonos se imputan al mes en que realmente ingresaron.
export function calcularGanancias(ventas, pagos) {
  const map=new Map();
  const meses=new Map();
  const mes=(key)=>{if(!meses.has(key))meses.set(key,{mes:key,esperadaCentavos:0,realizadaCentavos:0,pendienteCentavos:0});return meses.get(key);};
  let esperadaCentavos=0,realizadaCentavos=0;
  for(const v of ventas){
    const precio=Number(v.precio_centavos),gasto=Number(v.costo_centavos)+Number(v.comision_centavos);
    const margen=precio-gasto;
    const dato={precio,gasto,margen,cobrado:0,realizado:0,vence:v.vencimiento?.slice(0,7)||v.fecha.slice(0,7)};
    map.set(v.id,dato);esperadaCentavos+=margen;
    mes(dato.vence).esperadaCentavos+=margen;
  }
  for(const p of pagos){
    const v=map.get(p.venta_id);if(!v)continue;
    const anterior=v.realizado;
    v.cobrado=Math.min(v.precio,v.cobrado+Math.max(0,Number(p.capital_centavos)));
    v.realizado=Math.max(0,v.cobrado-v.gasto);
    // La pérdida de una venta bajo costo se hace visible al cerrar el saldo.
    if(v.cobrado>=v.precio&&v.margen<0)v.realizado=v.margen;
    const delta=v.realizado-anterior;
    mes(p.fecha_hora.slice(0,7)).realizadaCentavos+=delta;
    realizadaCentavos+=delta;
  }
  for(const v of map.values())mes(v.vence).pendienteCentavos+=v.margen-v.realizado;
  return {esperadaCentavos,realizadaCentavos,pendienteCentavos:esperadaCentavos-realizadaCentavos,
    meses:[...meses.values()].sort((a,b)=>a.mes.localeCompare(b.mes))};
}
