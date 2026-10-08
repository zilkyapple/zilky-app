export function toCentavos(pesos) { return Math.round(Number(pesos) * 100); }
export function toPesos(centavos) { return centavos / 100; }
// Solo para importes calculados de intereses/mora. No redondear pagos reales,
// capital pactado ni saldos después de un pago parcial.
export function redondearInteresCentavos(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new RangeError('Interés calculado inválido');
  const importe = Math.round(centavos / 50000) * 50000;
  if (!Number.isSafeInteger(importe)) throw new RangeError('Interés calculado fuera de rango');
  return importe;
}
export function formatARS(centavos) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(toPesos(centavos));
}
