// Publicar únicamente los cambios de la operación, nunca el snapshot de pagos completo.
const parse = value => {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return result && typeof result === 'object' ? result : {}; }
  catch { return {}; }
};
export function resumenCorreccion(evento) {
  const antes = parse(evento.datos_anteriores), nuevo = parse(evento.datos_nuevos);
  const despues = nuevo.despues;
  const cambios = [];
  if (antes.credito && despues?.credito) {
    const agregar = (campo, etiqueta, tipo, anterior, actual) => {
      if ((anterior ?? null) !== (actual ?? null)) cambios.push({campo, etiqueta, tipo, anterior: anterior ?? null, nuevo: actual ?? null});
    };
    for (const [campo, etiqueta, tipo] of [
      ['monto_total_centavos', 'Importe de la operación', 'dinero'],
      ['entrega_inicial_centavos', 'Entrega inicial', 'dinero'],
      ['fecha_inicio', 'Fecha de compra', 'fecha'],
      ['producto_descripcion', 'Producto/equipo', 'texto'],
      ['condiciones', 'Condiciones de financiación', 'texto'],
    ]) agregar(campo, etiqueta, tipo, antes.credito[campo], despues.credito[campo]);
    const previas = Array.isArray(antes.cuotas) ? antes.cuotas : [];
    const actuales = Array.isArray(despues.cuotas) ? despues.cuotas : [];
    agregar('cantidad_cuotas', 'Cantidad de cuotas', 'numero', previas.length, actuales.length);
    for (const id of new Set([...previas, ...actuales].map(q => q.id))) {
      const a = previas.find(q => q.id === id), b = actuales.find(q => q.id === id);
      const etiqueta = `Cuota ${a?.numero ?? b?.numero}`;
      if (!a || !b) agregar('cuota', etiqueta, 'texto', a ? 'Existente' : null, b ? 'Agregada' : 'Retirada del plan');
      if (a && b) agregar('numero', `${etiqueta} · número`, 'numero', a.numero, b.numero);
      agregar('monto_centavos', `${etiqueta} · importe`, 'dinero', a?.monto_centavos, b?.monto_centavos);
      agregar('fecha_vencimiento', `${etiqueta} · vencimiento`, 'fecha', a?.fecha_vencimiento, b?.fecha_vencimiento);
    }
  }
  return {fecha_hora:evento.fecha_hora, motivo:evento.motivo, autor:evento.autor, cambios};
}
