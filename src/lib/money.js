// Regla del spec: nunca usar floats para dinero. Todo se guarda en CENTAVOS (enteros).

export function toCentavos(pesos) {
  return Math.round(Number(pesos) * 100);
}

export function toPesos(centavos) {
  return centavos / 100;
}

export function formatARS(centavos) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(toPesos(centavos));
}
