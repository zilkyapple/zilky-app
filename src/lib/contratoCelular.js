// User-supplied model. Pure draft renderer: no financial writes, no signatures,
// no issuance. Seller identity is runtime data, never embedded in source code.
export const VERSION_CONTRATO_CELULAR = 'celular-2026-10-10-v1';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = v => esc(v || '__________________');
const dinero = v => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('Importe contractual inválido');
  return '$ ' + (v / 100).toLocaleString('es-AR', {minimumFractionDigits:2,maximumFractionDigits:2});
};
const fecha = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '') || Number.isNaN(Date.parse(v+'T12:00:00Z')) || new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v) throw new Error('Fecha contractual inválida');
  return v.split('-').reverse().join('/');
};

export const CLAUSULAS_CELULAR = [
  ['3. MORA Y RECARGO POR ATRASO', [
    'La falta de pago de una cuota en la fecha pactada producirá la mora de EL COMPRADOR.',
    'Sobre cada cuota vencida e impaga se aplicará un recargo del 15% sobre el importe de dicha cuota, conforme a lo pactado entre las partes y dentro de los límites permitidos por la legislación aplicable.',
    'El pago posterior de una cuota atrasada no elimina los recargos ya generados ni modifica las fechas de vencimiento de las cuotas restantes.'
  ]],
  ['4. INCUMPLIMIENTO DESDE LA PRIMERA CUOTA IMPAGA', [
    'La falta de pago de una sola cuota en su fecha de vencimiento constituirá incumplimiento de EL COMPRADOR.',
    'Desde la primera cuota vencida e impaga, EL VENDEDOR podrá exigir su pago junto con el recargo correspondiente y, si el incumplimiento persiste, podrá resolver el contrato y exigir la restitución del equipo, sin necesidad de esperar al vencimiento de una segunda cuota.',
    'EL VENDEDOR podrá otorgar voluntariamente un plazo adicional para regularizar la deuda. Cualquier tolerancia será excepcional y no implicará renuncia a sus derechos.'
  ]],
  ['5. RESTITUCIÓN DEL EQUIPO POR INCUMPLIMIENTO', [
    'En caso de resolución del contrato por incumplimiento de EL COMPRADOR, este deberá restituir el equipo a EL VENDEDOR en el estado en que se encuentre, sin perjuicio del desgaste derivado del uso normal.',
    'Las sumas abonadas hasta ese momento podrán ser imputadas, en la medida legalmente procedente, a compensar el uso del equipo, su depreciación, daños que excedan el uso normal, gastos administrativos, costos derivados de su recuperación y demás perjuicios efectivamente ocasionados por el incumplimiento.',
    'La restitución del equipo no implica automáticamente la devolución de las sumas previamente abonadas, debiendo realizarse, cuando legalmente corresponda, la liquidación pertinente.',
    'Iniciales de EL COMPRADOR en conformidad con esta cláusula: __________'
  ]],
  ['6. RESERVA DE DOMINIO', [
    'Hasta la cancelación total del precio acordado, el equipo permanecerá sujeto a la reserva de dominio establecida en este contrato.',
    'EL COMPRADOR tendrá la tenencia y utilización del equipo mientras cumpla con las obligaciones asumidas.'
  ]],
  ['7. PROHIBICIÓN DE VENTA O TRANSFERENCIA MIENTRAS EXISTA SALDO', [
    'Mientras exista saldo pendiente, EL COMPRADOR se compromete a no vender, ceder, entregar como parte de pago ni transferir el equipo a un tercero de manera que impida el cumplimiento de las obligaciones asumidas mediante este contrato.'
  ]],
  ['8. ESTADO DEL EQUIPO Y CONFORMIDAD', [
    'EL COMPRADOR declara haber revisado el equipo al momento de recibirlo y aceptar su condición estética y funcional, sin perjuicio de los derechos y garantías que legalmente le correspondan.'
  ]],
  ['9. GARANTÍA', [
    'La garantía correspondiente al equipo será la informada por EL VENDEDOR al momento de la operación y se aplicará conforme a las condiciones comunicadas a EL COMPRADOR y a la legislación vigente.',
    'La garantía no cubrirá daños ocasionados por golpes, caídas, líquidos, manipulación indebida, intervención de terceros, uso incorrecto u otras causas externas cuando legalmente corresponda su exclusión.'
  ]],
  ['10. REGISTRO Y CONSTANCIA DE LOS PAGOS', [
    'EL COMPRADOR abonará las cuotas mediante transferencia, efectivo u otro medio de pago aceptado por EL VENDEDOR.',
    'Los pagos realizados podrán acreditarse mediante el correspondiente comprobante de transferencia, recibo o mediante el registro de pago llevado por EL VENDEDOR.',
    'La firma del presente contrato constituye la documentación principal de la operación y de las obligaciones asumidas por ambas partes.',
    'No se exige pagaré como requisito general.',
    'Si las partes excepcionalmente acuerdan un pagaré u otro documento adicional, será complementario al contrato y no requisito general para la validez de la operación.'
  ]]
];

// Snapshot input must be obtained by an authorized service; never trust IDs or
// financial amounts submitted by the browser. Rendering does not recalculate debt.
export function datosContratoCelular({cliente,venta,credito,cuotas,equipo={},vendedor={},fecha_documento,lugar,telefono_alternativo='',correo=''}) {
  if (!cliente || !venta || !credito || credito.venta_id!==venta.id || credito.cliente_id!==cliente.id || venta.cliente_id!==cliente.id || credito.negocio_id!==venta.negocio_id) throw new Error('La financiación no pertenece a la operación');
  if (!Array.isArray(cuotas) || !cuotas.length || cuotas.some(q=>q.credito_id!==credito.id)) throw new Error('Cuotas inválidas');
  const ordenadas=cuotas.map(q=>({numero:q.numero,monto_centavos:q.monto_centavos,fecha_vencimiento:q.fecha_vencimiento})).sort((a,b)=>a.numero-b.numero);
  ordenadas.forEach((q,i)=>{if(q.numero!==i+1)throw new Error('Numeración de cuotas inválida');dinero(q.monto_centavos);fecha(q.fecha_vencimiento);});
  dinero(venta.monto_total_centavos);dinero(venta.entrega_inicial_centavos);
  const total=ordenadas.reduce((s,q)=>s+q.monto_centavos,venta.entrega_inicial_centavos);
  if (!Number.isSafeInteger(total) || total!==venta.monto_total_centavos) throw new Error('Las cuotas y la entrega no coinciden con el total nominal');
  if(credito.monto_total_centavos!==venta.monto_total_centavos || credito.entrega_inicial_centavos!==venta.entrega_inicial_centavos)throw new Error('La financiación y la venta no coinciden');
  fecha(fecha_documento);
  const pick=(obj,keys)=>Object.fromEntries(keys.map(k=>[k,String(obj[k]??'')]));
  return {
    version:VERSION_CONTRATO_CELULAR,venta_id:venta.id,credito_id:credito.id,negocio_id:venta.negocio_id,
    comprador:{nombre:[cliente.nombre,cliente.apellido].filter(Boolean).join(' '),dni:cliente.dni||'',domicilio:[cliente.direccion,cliente.ciudad,cliente.provincia].filter(Boolean).join(', '),telefono:cliente.telefono||'',telefono_alternativo:String(telefono_alternativo),correo:String(correo)},
    vendedor:pick(vendedor,['nombre','dni']),equipo:pick(equipo,['marca','modelo','capacidad','imei','imei2','serie','estado','bateria','observaciones']),
    total_centavos:venta.monto_total_centavos,entrega_centavos:venta.entrega_inicial_centavos,cuotas:ordenadas,fecha_documento,lugar:String(lugar||'')
  };
}

export function advertenciasContratoCelular(negocio) {
  // The supplied model does not establish a recurring period or grace policy.
  // Do not silently interpret it as weekly/monthly interest or change the ledger.
  return [
    'Pendiente de definir si el recargo contractual del 15% se aplica una sola vez o se repite por período, y cómo convive con los días de gracia.',
    `Configuración actual: ${negocio.mora_tipo}, valor ${negocio.mora_valor}, período ${negocio.mora_periodo}, base ${negocio.mora_base}, gracia ${negocio.dias_gracia} días, acumulativa ${Boolean(negocio.mora_acumulativa)}.`
  ];
}

export function renderBorradorContratoCelular(d) {
  const p=t=>`<p>${t}</p>`;
  const equipos=[['Marca','marca'],['Modelo','modelo'],['Capacidad','capacidad'],['IMEI','imei'],['IMEI 2','imei2'],['Número de serie','serie'],['Estado del equipo','estado'],['Condición de batería','bateria']];
  const rows=equipos.map(([label,k])=>`<tr><th>${label}</th><td>${field(d.equipo[k])}</td></tr>`).join('');
  const values=[...new Set(d.cuotas.map(q=>q.monto_centavos))];
  return `<article lang="es" data-modelo="${VERSION_CONTRATO_CELULAR}">
    <p><strong>BORRADOR — pendiente de definir condiciones de mora. No emitido ni firmado.</strong></p>
    <h1>CONTRATO DE COMPRAVENTA DE EQUIPO CELULAR CON PAGO EN CUOTAS</h1>
    ${p(`Entre ${field(d.vendedor.nombre)}, DNI N.º ${field(d.vendedor.dni)}, en adelante “EL VENDEDOR”, y ${field(d.comprador.nombre)}, DNI N.º ${field(d.comprador.dni)}, con domicilio ${field(d.comprador.domicilio)}, teléfono ${field(d.comprador.telefono)}, en adelante “EL COMPRADOR”, se celebra el presente contrato de compraventa sujeto a las siguientes condiciones:`)}
    <h2>1. EQUIPO OBJETO DE LA OPERACIÓN</h2><table><thead><tr><th>Dato</th><th>Información</th></tr></thead><tbody>${rows}</tbody></table>
    ${p('EL COMPRADOR declara haber recibido el equipo y haber tenido oportunidad de verificar su estado general y funcionamiento.')}
    <h2>2. PRECIO Y FORMA DE PAGO</h2>
    ${p(`Entrega inicial: ${dinero(d.entrega_centavos)}`)}${p(`Cantidad de cuotas: ${d.cuotas.length}`)}
    ${p(`Importe de cada cuota: ${values.length===1?dinero(values[0]):'según detalle de cuotas.'}`)}${p(`Total nominal de la operación: ${dinero(d.total_centavos)}`)}
    <p>Fechas de vencimiento:</p><table><thead><tr><th>Cuota</th><th>Vencimiento</th><th>Importe</th></tr></thead><tbody>${d.cuotas.map(q=>`<tr><td>${esc(q.numero)}</td><td>${fecha(q.fecha_vencimiento)}</td><td>${dinero(q.monto_centavos)}</td></tr>`).join('')}</tbody></table>
    ${CLAUSULAS_CELULAR.map(([title,paragraphs])=>`<h2>${title}</h2>${paragraphs.map(t=>p(esc(t))).join('')}${title.startsWith('8.')?p('Estado: '+field(d.equipo.estado))+p('Condición de batería: '+field(d.equipo.bateria))+p('Observaciones: '+field(d.equipo.observaciones)):''}`).join('')}
    <h2>11. DATOS DE CONTACTO</h2>${p('Teléfono: '+field(d.comprador.telefono))}${p('Teléfono alternativo: '+field(d.comprador.telefono_alternativo))}${p('Domicilio: '+field(d.comprador.domicilio))}${p('Correo electrónico: '+field(d.comprador.correo))}
    <h2>12. ACEPTACIÓN</h2>${p('EL COMPRADOR declara haber leído y comprendido el presente contrato antes de firmarlo y aceptar sus condiciones, incluyendo especialmente:')}
    ${['a) Fechas y montos de las cuotas.','b) Recargo del 15% sobre cada cuota vencida.','c) Consecuencias del incumplimiento desde la primera cuota impaga.','d) Posibilidad de resolución del contrato y restitución del equipo.','e) Condiciones respecto de los importes previamente abonados.'].map(p).join('')}
    ${p('Lugar: '+field(d.lugar))}${p('Fecha: '+fecha(d.fecha_documento))}
    <h2>FIRMAS</h2><h3>EL VENDEDOR</h3>${p('Firma: ______________________________')}${p('Aclaración: '+field(d.vendedor.nombre))}${p('DNI: '+field(d.vendedor.dni))}
    <h3>EL COMPRADOR</h3>${p('Firma: ______________________________')}${p('Aclaración: '+field(d.comprador.nombre))}${p('DNI: '+field(d.comprador.dni))}${p('Iniciales cláusula 5: __________')}
  </article>`;
}
