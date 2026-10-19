# Correcciones de cargas históricas

El administrador puede corregir una compra y sus pagos desde la ficha del cliente sin eliminar al cliente. Cada confirmación conserva motivo, responsable y valores anteriores.

## Compra y cuotas

En **Corregir fechas y cuotas** se revisan fecha de compra/retiro, producto, condiciones, total, entrega inicial y fecha del anticipo. El anticipo puede preceder al retiro.

Las cuotas permiten corregir importe y vencimiento, incluso el vencimiento de una cuota saldada. El capital ya aplicado se conserva: no se puede bajar el valor de una cuota por debajo del capital cobrado. Aumentar una cuota saldada vuelve a abrir únicamente su diferencia. Las cuotas sin actividad pueden agregarse o retirarse; las que tienen pagos, mora o antecedentes conservan su identidad.

**Interés por atraso** permite usar las reglas del negocio o dejar esa financiación sin interés. La segunda opción muestra el interés pendiente que se perdonará y exige confirmarlo; conserva el interés ya cobrado y las condonaciones anteriores. No cambia otras financiaciones. El precio financiado y los importes de las cuotas se editan por separado, sin imponer una tasa nueva.

Corregir una fecha conserva las aplicaciones históricas y el interés registrado. Cuando corresponde quitar interés pendiente, se debe revisar la opción sin interés o la condonación de mora existente.

## Pagos

Cada pago vigente tiene **Corregir pago** para cambiar fecha, importe, medio y nota. Primero se muestra el resultado en capital pendiente y saldo a favor. El importe de la entrega inicial se corrige desde el plan para revisar las cuotas conjuntamente.

- Una corrección de fecha conserva cómo se aplicó el dinero.
- Una reducción descuenta primero el excedente; luego el capital y la mora de las últimas cuotas de ese pago.
- Un aumento aplica únicamente la diferencia, según las reglas actuales de cobro y la fecha corregida.
- Los pagos posteriores conservan sus aplicaciones.

El pago y comprobante originales se conservan anulados y se genera el reemplazo, con vínculo e historial. La corrección documental no representa un ingreso nuevo o una devolución de efectivo. Si hay caja configurada, queda un aviso para conciliación. Los acuerdos y cierres de comisiones se conservan; las diferencias liquidables se registran con la política de períodos existente.

## Protecciones

Los permisos administrativos y la pertenencia al negocio se verifican en el servidor. Una vista desactualizada se rechaza; una solicitud repetida devuelve el mismo resultado. La interfaz conserva una solicitud de resultado incierto para comprobarla después de una recarga.

Las ventas devueltas/anuladas, cuotas con estados manuales, excedentes ya utilizados o datos incoherentes requieren conciliación. La edición no fuerza esos casos ni elimina antecedentes.

## Publicación

La actualización agrega dos campos de política de mora con el valor predeterminado `negocio`; no convierte automáticamente operaciones históricas a sin interés. Debe verificarse en PostgreSQL nativo y en navegador con datos descartables antes de desplegar. Los valores reales de los clientes se corrigen únicamente cuando el dueño los confirma en la aplicación.
