# Ventas, stock y comisiones integradas

## Operación

- **Ventas → Nueva venta**: catálogo, cantidades y confirmación única. Contado admite cliente sin identificar; fiado, pago único pendiente y cuotas requieren cliente. Conserva búsqueda y creación de clientes.
- El vendedor queda identificado por usuario. Un empleado no puede atribuirse ventas de otro vendedor mediante el request. El administrador puede seleccionar un vendedor activo del negocio.
- La misma transacción crea venta, detalle, crédito, cuotas, entrega inicial y comprobante, movimientos de stock y acuerdo de comisión. La comisión nunca aumenta la deuda del cliente.
- La solicitud de venta se conserva en la sesión del navegador antes de enviarla. Tras pérdida de conexión o recarga aparece **Comprobar venta pendiente**. El servidor bloquea y deduplica por negocio, actor e identificador, y rechaza reutilizar una clave con otro contenido.
- Se conserva la política previa de stock: sin control no descuenta; si hay control y queda negativo, registra el movimiento y avisa. No se introdujo bloqueo nuevo de ventas por falta de stock.

## Comisiones

Se conservan activación, comisión fija/porcentual por producto, devengo al vender o proporcional al cobrar capital, filtros de fechas, movimientos, saldos acumulados y pagos al empleado. Los nuevos controles están en **Comisiones → Configuración y productos**.

Prioridad de reglas: vendedor y canal → canal general → comisión base del producto. Un valor cero significa sin comisión. Los canales son minorista, mayorista y combo. Una venta congela su regla, categoría, descripción y componentes; cambios posteriores no reescriben acuerdos históricos. No se precargan los importes de ejemplo.

Un combo es un producto comercial con precio propio y componentes. Se mueve stock de cada componente una vez, y solo se genera la comisión del combo. Se rechazan componentes ajenos, ciclos y combos anidados.

- **Generada**: importe acordado, más ajustes y menos devoluciones.
- **Liquidable**: ya devengado conforme a la regla congelada de la operación.
- **Pagada**: dinero registrado como entregado al vendedor.
- **Pendiente**: liquidable menos pagada. Puede ser negativo si se revierte una comisión ya pagada; el historial no se elimina.

Los pagos de comisión documentan dinero ya entregado. Mantienen el comportamiento previo: no realizan transferencias ni descuentan Caja automáticamente.

## Visibilidad y aislamiento

Cada negocio configura por empleado: nunca, al cierre publicado o en tiempo real; total, detalle, historial y permiso de venta manual son independientes. La API envía una lista explícita de campos autorizados. No entrega reglas ni costos en el catálogo operativo. Un empleado consulta exclusivamente sus propias comisiones, aunque altere `usuario_id` en la URL.

Configuración solicitada para Lucas: `modo=cierre`, `ver_total=true`, `ver_detalle=false`; mantiene su permiso existente de ventas. Aplicar a sus asignaciones verificadas del negocio después de migrar. La prueba E2E usa un Lucas ficticio. No asumir que esa prueba modificó la cuenta real.

Se preserva el modelo actual de la instalación: un administrador global administra sus negocios; los empleados quedan limitados por `usuario_negocio`. El alta de dueños independientes como clientes SaaS necesita una etapa separada de aislamiento por organización en toda la aplicación. Esta entrega no cambia silenciosamente los privilegios del administrador global.

## Cierre mensual

1. Seleccionar vendedor y mes terminado; revisar movimientos, saldo anterior y pendiente de cobro de ventas fiadas.
2. Aprobar con la versión revisada. Si hubo un movimiento concurrente, se rechaza y exige revisar otra vez.
3. Publicar para habilitar la consulta según los permisos del empleado.
4. Registrar pagos parciales o completos. Se validan tanto el saldo global disponible como lo asignado al cierre.

La aprobación guarda una copia inmutable. Una venta retroactiva, devolución, pago o ajuste que afectaría un período cerrado se contabiliza en un período abierto, conservando su fecha de origen. Los cierres publicados nunca se recalculan silenciosamente. Un empleado con detalle habilitado puede consultar el desglose original conservado de las operaciones con movimientos; los ajustes y devengos proporcionales aparecen por separado.

Los pagos de comisión, ajustes y devoluciones conservan también la solicitud exacta en la sesión para recuperar respuestas inciertas después de recargar.

## Devoluciones y anulaciones

**Ventas → Ver ventas → operación** permite al administrador devolver unidades o anular todo lo restante, con motivo, confirmación y decisión explícita de reponer stock. La revisión incluye pagos y cuotas; un cobro concurrente invalida una vista anterior.

Primero se reduce capital pendiente. El importe ya pagado que exceda el capital queda como saldo a favor del cliente. Si la venta era anónima, el reintegro queda identificado en esa operación, nunca en una billetera compartida entre consumidores finales. No se simula una devolución de efectivo ni se anulan comprobantes pagados. Un reintegro efectivo requiere conciliación administrativa de dinero y Caja; no se implementa aquí un ejecutor de transferencias o reintegros bancarios.

Una devolución completa o anulación cancela también mora pendiente, con registro explícito en el historial. Devoluciones parciales conservan mora generada. Se revierten únicamente comisiones de las unidades devueltas. Los pagos, recibos, cuotas originales y acuerdos se conservan.

Se bloquean cambios posteriores del plan financiero o anulaciones de recibos de una venta ya devuelta: requieren conciliación para evitar volver a crear deuda que ya se acreditó al cliente.

## Migración y publicación

`ventasComisionesSchema` es aditivo y se ejecuta dentro de la transacción y el bloqueo global de migraciones existentes. Agrega tablas de solicitudes, reglas, visibilidad, cierres, generaciones, ajustes, componentes y devoluciones, además de columnas de identificación. Solo incorpora una generación inicial derivada de cada acuerdo histórico mediante `ON CONFLICT DO NOTHING`.

No elimina clientes, ventas, cuotas, pagos, comprobantes, empleados, permisos, acuerdos ni liquidaciones. No se atribuyen ventas históricas a empleados a partir de nombres libres. Por eso el historial personal del empleado no incorpora automáticamente ventas antiguas sin vendedor identificado; el administrador sí las conserva.

Antes de publicar:

1. Crear respaldo nuevo de la rama de producción y verificar restauración en una rama de QA; comparar estructura, conteos y huellas de tablas financieras.
2. Ensayar la migración y su segunda ejecución en la copia, comprobando invariantes de datos existentes.
3. Mantener auto-deploy desactivado; integrar solo el commit revisado con CI verde.
4. Desplegar, verificar hash/recursos HTTP y migración efectiva, y aplicar la política real de Lucas con auditoría.
5. Verificar lectura y una operación exclusivamente QA. No ejecutar fixtures destructivos sobre producción.

Al preparar esta entrega, Neon agotó sus cupos de ramas y snapshots. No se eliminaron respaldos ni ramas. Liberar ramas antiguas destinadas solo a verificar restauraciones requiere autorización explícita antes de continuar con el respaldo nuevo.

## Validación reproducible

- `npm test`: PostgreSQL local descartable; `test/setup-env.js` rechaza hosts remotos y bases sin sufijo `_test`.
- `test/ventas-comisiones-integradas.test.js`: venta simple/múltiple/anónima/fiada/financiada; combo; reglas congeladas; concurrencia e idempotencia; devolución/anulación; permisos y aislamiento; cierre/publicación/pagos parciales y completos; migración repetible sin cambios financieros.
- `test/ventas-comisiones-ui.test.js`: carrito, modalidades, permisos, recarga y recuperación de solicitudes, interfaz administrativa y empleado al cierre.
- `test/browser-ventas-comisiones.mjs`: navegador real contra PostgreSQL efímero. Verifica venta, stock, comisión, devolución, cierre, publicación, pago y visibilidad del empleado. Captura escritorio/tablet/móvil, oscuro y claro, y comprueba desbordes y errores JavaScript.

Las capturas y resultados de navegador se guardan como artefacto de CI durante siete días. Los ajustes visuales usan los tokens de Zilky y se limitan a Ventas y Comisiones.
