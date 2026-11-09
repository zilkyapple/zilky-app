# Auditoría de release pausado y autoridad futura de stock

Fecha: 2026-11-09. Base de producción informada: `7f7d465`. Código auditado:
`069b247` más los cambios puntuales de esta revisión. No se consultó ni modificó
la base real o la API comercial para esta auditoría.

## Dictamen

**GO condicionado para desplegar preparación y OAuth con los tres flags en
`false` y la conexión pausada. NO-GO para activar sincronización comercial,
entregas o reserva central.** La publicación de este módulo no conecta todavía
las ventas ordinarias de ambos canales ni carga automáticamente productos nuevos.

Los cambios nuevos de base son aditivos. La prueba aislada de primera creación
de las tablas conserva stock positivo, negativo y no controlado, deuda, dinero
y publicación original. Otra prueba aplica dos veces los cinco schemas sobre
datos operativos preexistentes y compara todas las filas ajenas a Tiendanube.

Esto no equivale a comprobar una restauración de la base real. Además, el
comando completo `npm run migrate` ejecuta pasos heredados que ya existen en
`main`: completa `organizacion_id='default'` donde es NULL, relaciones de
usuarios/cliente-negocio y hashes de invitaciones, y reconstruye el índice
único de entrega inicial vigente. No es correcto afirmar que ese comando nunca
modifica filas anteriores. Necesita respaldo y preflight del entorno real.

## Evidencia y condiciones del release

| Punto | Evidencia de código/prueba | Condición de publicación |
| --- | --- | --- |
| Worker apagado | `iniciarTiendanubeWorker` retorna antes de crear timer o consultar DB cuando `TIENDANUBE_SYNC_ENABLED !== 'true'`. | Verificar valor efectivo `false`, no solo el valor deseado del panel. |
| Motor apagado | `procesarEntrada` y `procesarSalida` retornan antes de transacción/API. | Mantener `TIENDANUBE_SYNC_ENABLED=false`. |
| Entregas apagadas | Router y servicio rechazan antes de DB/API cuando su bandera está apagada. | Mantener `TIENDANUBE_ENTREGAS_ENABLED=false`. |
| Reserva apagada | Sin ruta HTTP; fábrica false por defecto y verificador de canales false por defecto. | Mantener `TIENDANUBE_RESERVAS_ENABLED=false`; no inyectar un verificador permisivo. |
| OAuth | Exige administrador de la organización, estado aleatorio de un uso, scopes `write_products,read_orders`; guarda token cifrado y `pausada=TRUE`. | Secretos en servidor, callback correcto, clave de cifrado estable; no necesita `write_orders` para esta fase. |
| Reautorización | Revalida actor, conexión y ausencia de leases/reservas antes de reemplazar credenciales. Reinicia el baseline, no el stock. | No reautorizar para resolver una escritura incierta. |
| Vínculo | GET remoto de variante + inserción local de relación/outbox, sin escritura de producto remoto. | Relacionar cada talle/color correcto; esto no es publicación automática. |
| Webhooks en pausa | El receptor firmado encola metadatos; configurar webhooks puede crear registros remotos de notificaciones. | OFF no significa que OAuth, configuración o privacidad estén deshabilitados. |
| Web original | No hay cambio en sus tablas, rutas públicas ni habilitación por esta release. | No borrar ni desactivar para desplegar el módulo pausado. |
| Venta ordinaria | El único cambio es una envoltura que mantiene el camino normal; el bypass de reserva es una capacidad interna no representable en JSON. | No conectar la capacidad directamente a una ruta. |
| Migración | Los nuevos schemas crean tablas/índices, columnas y un trigger; no actualizan unidades existentes. | Ejecutar migración antes de usar endpoints nuevos; no ejecutar seed en producción. |

La coordinación de release informó que el build existente es
`npm install && npm run migrate`, con `npm run start` y auto-deploy apagado.
Por lo tanto, no hace falta cambiar `MIGRATE_ON_START`. Deben conservarse esos
comandos y comprobar el resultado real de la migración antes de autorizar OAuth.

### Preflight real, a ejecutar por el operador autorizado

`docs/tiendanube-preflight-readonly.sql` contiene consultas de solo lectura,
con los nombres exactos de estas tablas. Devuelven conteos y definición de índice,
sin exponer datos de clientes, contraseñas, tokens ni hashes de invitaciones.

La coordinación confirmó el preflight real bajo `SET TRANSACTION READ ONLY`:
0 organizaciones NULL en las ocho tablas, 8 invitaciones sin hashes faltantes ni
duplicados, 0 entregas iniciales duplicadas y un índice válido/listo, y 0 usuarios
o relaciones cliente-negocio pendientes de esos backfills. Esto cubre esas
comprobaciones de datos, no reemplaza el respaldo: el snapshot nuevo seguía
pendiente al recibir el informe. El SQL también se validó aquí con PGlite aislado,
tanto con columna legacy `token` como sin ella y con faltantes/duplicados ficticios.

- Respaldo restaurable de base antes del build. Guardar las variables vigentes
  para rollback, especialmente la clave de cifrado; no copiarlas a logs/chat.
- Revisar filas con `organizacion_id IS NULL` en las tablas tocadas por los
  backfills heredados; no asumir que todas corresponden a la organización default.
- Revisar invitaciones sin hash y entregas iniciales activas duplicadas por
  crédito. Un error de constraint aborta la transacción de migración completa.
- Confirmar flags efectivos falsos, conexiones pausadas y ausencia de una
  escritura comercial iniciada por versiones anteriores.
- Confirmar CI del commit exacto a desplegar. La coordinación informó CI remoto
  exitoso `42636852579` en `95aeeb`, con PostgreSQL aislado, Node 24/26 y
  regresiones de navegador; esta auditoría no sustituye esa verificación remota.
- Después del deploy: health/login, catálogo original, pantalla Tiendanube con
  diagnóstico apagado, OAuth que termina en pausa, sin stock/cobros/comisiones
  nuevos. No realizar una compra real para probar este release pausado.

Rollback del código no requiere borrar las tablas nuevas. El trigger permanece
y puede encolar metadatos de productos vinculados; con flags apagados no hay
salida remota. Un rollback no es motivo para eliminar stock, ventas, la web
original ni evidencias de intentos inciertos.

## Inventario de caminos de stock

La tabla incluye los escritores encontrados en `src`; crear un nombre o cambiar
una descripción no se trata como un movimiento de inventario.

| Entrada | Implementación concreta | Qué toca hoy | Requisito antes de autoridad central |
| --- | --- | --- | --- |
| `POST /api/ventas` | `ventasService.crearVentaInterna` → `repositories/productos.descontarStock` | Agrupa SKUs, expande componentes de combos, descuenta cada SKU; admite stock negativo y respeta NULL. Crea financiación/comisión y eventualmente cobro. | Clasificar todos los SKUs antes de crear efectos; reservar centralizados antes de entregar y adoptar una sola vez. No cambiar el comportamiento de no vinculados. |
| Alta de producto | `productosService.nuevoProducto` → `crearProducto` | Inserta stock inicial. No crea una ficha Tiendanube. | Producto nuevo nace local/no publicado; publicación y vínculo son acciones separadas. |
| Edición de producto | `editarProducto` | Rechaza `stock` en el cuerpo; cambia nombre, precios, costo, foto y revisión. | No es bypass de stock, pero aún no hay propagación automática del catálogo/precios a Tiendanube. |
| `POST /api/productos/:id/stock` | `productosService.moverStock` | Reposición, conteo absoluto o `sin_control`; UPDATE directo. | Reposición/conteo deben tener protocolo central propio o bloquearse para vinculados centralizados. No permitir pasar a NULL como forma de evitar el control. |
| Definición de combo | `comisionReglasService.guardarCombo` | No mueve stock; altera el conjunto de componentes que descontará una venta futura. | Impedir cambiar relaciones de combos que involucren SKUs centralizados sin recomprobar los vínculos y reservas. |
| `POST /api/ventas/:id/devoluciones` | `ventasGestionService.devolverVenta` | Con `reponer=true`, suma unidades de los componentes congelados en la venta; ajusta deuda y comisión. | Una devolución de venta Tiendanube no puede reponer localmente y además volver a reponer por webhook. Requiere ledger de retorno o bloqueo explícito. |
| `POST /api/ventas/:id/eliminar-error` | `ventaErrorService.eliminarVentaError` | Anula documentalmente; repone cantidades demostradas por historial original tipo `venta`. Conserva registros. | Las entregas Tiendanube tienen historial `entrega_tiendanube` y hoy son rechazadas por este flujo. Mantener el bloqueo hasta tener corrección central especializada. |
| `PATCH /api/ventas/creditos/:id/correccion` | `financiacionService.corregirFinanciacion` | Modifica fechas, importes y cuotas; no modifica SKU/cantidad/stock. | No necesita reclamar unidades, pero una entrega Tiendanube exige trazabilidad de corrección financiera para no contradecir el precio original de su vínculo. |
| Pedido público original | `tiendaPedidosService.crearPedidoPublico` | Guarda pedido/contacto pendiente. Comprueba stock, pero **no lo reserva**. | Puede conservarse como solicitud no garantizada o dirigir checkout a Tiendanube; nunca prometer disponibilidad firme solo por recibir la solicitud. |
| `POST /api/tiendas/pedidos/:id/confirmar` | `tiendaPedidosService.cambiarEstado` | Descuenta SKUs directamente y congela `stock_movimientos`. No crea una venta normal. | Reclamar primero y asociar el mismo ledger central, o bloquear confirmación para centralizados. Cerrar únicamente el formulario de ventas no alcanza. |
| `POST /api/tiendas/pedidos/:id/cancelar` | `tiendaPedidosService.cambiarEstado` | Si estaba confirmado repone `stock_movimientos`; si pendiente, no mueve stock. | Separar cancelación sin reserva de liberación de una reserva central; no duplicar reposición. |
| Cobro/anulación de cobro web original | `tiendaCobrosService` | Pagos/comprobantes de tipo `pedido_web`, sin movimiento de stock ni venta normal. | Al migrar un pedido original a una entrega Tiendanube hay que conciliar pagos existentes, no capturarlos otra vez. |
| Importación de pedido Tiendanube | `tiendanubeSyncService.aplicarReserva` | Descuenta local y baseline y escribe ledger. Trigger encola salida que debe resolverse sin segundo descuento. | Solo aceptar reserva comprobada; `unclaimed_stock` positivo/ambiguo detiene el flujo. |
| Reserva local central | `tiendanubeReservasService` | POST claim y posterior adopción en el mismo ledger. Interno y apagado. | Conectar a todos los caminos pertinentes; no habilitar solo esta fábrica. |
| Entrega de reserva Tiendanube | `tiendanubeEntregasService` → `crearVentaConReservaTiendanube` | Adopta sin otro descuento; crea venta, deuda/cobro real y comisión. | Comprobar reserva/actor y evitar otros registros paralelos de esa operación. |

El trigger `tiendanube_encolar_stock` es **AFTER UPDATE**, no un bloqueo de
autoridad. Solo encola el último stock deseado para productos vinculados. Por sí
solo no impide ventas locales simultáneas, modificaciones manuales ni negativos.

Hay dos casos adicionales que no se resuelven mirando solo ese trigger:

- Venta manual sin `producto_id`: hoy no mueve stock por diseño. Para prometer
  control de ropa centralizado, esas ventas deben exigir elegir SKU o ir a un
  flujo de revisión expresamente separado. No se puede inferir la prenda de un
  texto libre. No hay que quitar ventas manuales a otros negocios/rubros.
- Carga histórica: hoy una venta fechada en el pasado también descuenta stock.
  La migración de historial anterior al corte no debe reclamar mercadería actual
  automáticamente. Requiere una ruta histórica conciliada distinta de una
  entrega física nueva.

## Adaptador mínimo con cobertura completa de bypasses

La cobertura completa no significa admitir desde el primer día todos los casos;
un caso no implementado debe quedar bloqueado para inventario centralizado, no
caer silenciosamente al comportamiento local.

1. **Autoridad persistente y separada de la pausa.** Añadir un modo explícito
   `local`/`tiendanube` para el inventario vinculado, default local. Vincular no
   centraliza. Una vez centralizado, apagar flags, perder la conexión o pausar
   workers debe impedir nuevas entregas de esos SKUs, no devolverles autoridad
   local. Reautorizar tampoco debe borrar ese modo. Volver a local exige un corte
   conciliado, sin pedidos/reservas inciertas.
2. **Una clasificación de stock compartida.** Bajo el bloqueo de catálogo,
   expandir combos y agregar las cantidades por SKU. Obtener una instantánea
   con versiones y distinguir no vinculados, vinculados aún locales y
   centralizados. El mismo clasificador/guard debe usarse en todos los escritores
   de la tabla anterior, no únicamente en `descontarStock`.
3. **Orquestar fuera de la transacción financiera.** Validar usuario, negocio,
   cliente, precio y fecha; persistir intento; realizar claim sin mantener
   bloqueos financieros durante la llamada de red; volver a comprobar antes de
   la transacción de entrega. Esa transacción adopta lo reservado y crea una
   sola venta/comisión/cobro real. Resultado remoto desconocido permanece
   bloqueado, sin reenvío automático.
4. **Primer subconjunto explícito.** Admitir ventas simples completamente
   centralizadas y ventas completamente locales. Para un primer adaptador
   pequeño, bloquear carritos mixtos y combos que toquen centralizados hasta
   implementar adopción parcial y snapshot de componentes. El resto de los
   productos conserva stock negativo/NULL y sus reglas actuales.
5. **Web original conservada.** La opción de menor riesgo es conservar catálogo
   e imágenes y enviar el checkout a Tiendanube. Si se conserva la confirmación
   propia, esta debe usar claim/adopción; recepción del pedido no equivale a
   reserva. Los pedidos anteriores y sus cobros necesitan conciliación, no una
   nueva venta de cero.
6. **Cerrar también mutaciones no comerciales.** Para centralizados, bloquear
   conteo/sin-control, devolución con reposición, cancelación con reserva y
   cambio de combos hasta implementar su operación durable específica. Reposición
   frecuente requiere ese protocolo: no sería honesto ofrecerla como automática
   si solo existe este bloqueo. Un conteo absoluto concurrente puede pisar ventas
   remotas; no sustituirlo por una escritura ciega.
7. **Reconciliación y prueba de corte.** Resolver intentos inciertos mediante
   lectura y correlación del pedido; guardar ledger de retornos y referencias
   de adopción. Probar última unidad, doble clic, timeout, webhook adelantado,
   cancelación, devolución y cambio de permisos en todos los canales antes de
   modificar el modo de autoridad.

No se implementó masivamente este adaptador en el release pausado. El documento
`tiendanube-reserva-central-interna.md` describe la fábrica ya preparada y sus
límites técnicos.

## Prueba puntual añadida

`test/tiendanube-release-pausado.test.js` usa PGlite, APIs de red prohibidas y
flags falsos. Comprueba primera creación y repetición de schemas, bloqueo sin
DB/red, venta normal con negativos y NULL, movimientos manuales, combos y
devolución, pedido/cancelación de la web original y anulación por error. No
realiza acciones sobre cuentas o datos reales.
