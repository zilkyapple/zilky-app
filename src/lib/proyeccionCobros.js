import { addDays, addMonths, todayAR } from './dates.js';

const vacio = mes => ({ mes, pendienteCentavos: 0, cuotas: 0, vencidoCentavos: 0 });
function sumar(a, b) {
  const total = a + b;
  if (!Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(total)) throw new RangeError('Importes de proyección fuera de rango');
  return total;
}

// Capital todavía pendiente de ventas existentes. No estima ventas nuevas ni
// mora futura, ni descuenta de nuevo dinero que ya se aplicó a las cuotas.
export function proyectarCobros(cuotas, fechaCorte = todayAR()) {
  const desdeMes = fechaCorte.slice(0, 7);
  const siguienteMes = addMonths(`${desdeMes}-01`, 1).slice(0, 7);
  const proximos7Dias = { desde: fechaCorte, hasta: addDays(fechaCorte, 6), pendienteCentavos: 0, cuotas: 0 };
  const proximos14Dias = { desde: fechaCorte, hasta: addDays(fechaCorte, 13), pendienteCentavos: 0, cuotas: 0 };
  const porMes = new Map();
  let vencidoTotalCentavos = 0;
  let hastaMes = addMonths(`${desdeMes}-01`, 11).slice(0, 7);

  for (const cuota of cuotas) {
    if (cuota.estado_manual || ['anulada', 'devuelta'].includes(cuota.venta_estado)) continue;
    const importe = cuota.saldo_pendiente_centavos;
    if (!Number.isSafeInteger(importe) || importe < 0) throw new RangeError('Saldo de cuota fuera de rango');
    if (importe === 0) continue;
    const fecha = cuota.fecha_vencimiento, mes = fecha.slice(0, 7);
    if (fecha < fechaCorte) vencidoTotalCentavos = sumar(vencidoTotalCentavos, importe);
    if (mes >= desdeMes) {
      const fila = porMes.get(mes) || vacio(mes);
      fila.pendienteCentavos = sumar(fila.pendienteCentavos, importe);
      fila.cuotas++;
      if (fecha < fechaCorte) fila.vencidoCentavos = sumar(fila.vencidoCentavos, importe);
      porMes.set(mes, fila);
      if (mes > hastaMes) hastaMes = mes;
    }
    for (const ventana of [proximos7Dias, proximos14Dias]) {
      if (fecha >= ventana.desde && fecha <= ventana.hasta) {
        ventana.pendienteCentavos = sumar(ventana.pendienteCentavos, importe);
        ventana.cuotas++;
      }
    }
  }
  return {
    fechaCorte, desdeMes, hastaMes,
    mesActual: porMes.get(desdeMes) || vacio(desdeMes),
    mesSiguiente: porMes.get(siguienteMes) || vacio(siguienteMes),
    proximos7Dias, proximos14Dias, vencidoTotalCentavos,
    // Sólo meses con saldo: la vista completa los huecos con cero al paginar.
    // Así una cuota lejana no obliga a transferir miles de meses vacíos.
    meses: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)),
  };
}
