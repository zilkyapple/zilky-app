# Reserva central de inventario: preparación interna, no activada

## Estado real

`tiendanubeReservasService.js` es un servicio interno, sin ruta HTTP, sin botón y
sin integración con el alta ordinaria de ventas. No habilita una sincronización
operativa ni resuelve por sí solo la venta simultánea de la última unidad.

La bandera `TIENDANUBE_RESERVAS_ENABLED` es falsa por defecto. Aun activándola, el
verificador de servidor `canalesCentralizados` devuelve **false por defecto**.
No existe un campo de entrada que pueda saltar este bloqueo. Mantener ambos
cerrados hasta conectar y probar todos los canales que descuentan stock.

No se cambiaron los permisos de la aplicación privada ni se crearon pedidos
reales. La migración es aditiva: no modifica stock ni elimina la web original.

## Fundamento del protocolo

La documentación oficial de la Admin API 2025-03 describe `POST /orders` con
`inventory_behaviour: "claim"`: intenta reservar stock y valida la suma de las
cantidades por variante; devuelve 422 si supera la disponibilidad. El valor
predeterminado `bypass` no reserva. La misma referencia advierte que una línea
puede contener `issues.unclaimed_stock` por una carrera de compra. Por eso el
servicio no acepta cantidades no reservadas aunque el pedido exista.

Fuente primaria: <https://tiendanube.dev/api/resources/2025-03/order>.
No se presupone una clave de idempotencia remota ni una garantía adicional de
atomicidad que la documentación no afirme. Hace falta probar concurrencia real
con el checkout de la tienda antes de activar este diseño.

## Qué hace el servicio

1. Autoriza al usuario dentro de su organización y negocio. Exige conexión
   lista, `write_orders`, sin eventos ni salidas pendientes, precios publicados
   válidos y stock finito consistente con el baseline.
2. Persiste un intento único por negocio y UUID de solicitud, su huella de
   contenido, los productos y el token `sync_reserva_token`, **antes** del POST.
3. Envía un solo pedido con `claim`, estado pendiente, método offline, retiro
   local y ambos envíos de email desactivados. Usa los valores por defecto del
   proveedor para cliente/direcciones; este payload todavía requiere validación
   real. No registra una entrega física, cobro, comisión ni venta en Zilky.
4. Valida tienda, correlación, variantes, cantidades, precios, estado y ausencia
   de importes cobrados/descuentos/cargos inesperados. Luego adopta la reserva en
   una transacción local, usando el mismo ledger que el worker de webhooks.
5. El webhook que llega antes de la respuesta espera al token. Después, lee el
   pedido y ve la cantidad ya aplicada: no vuelve a descontar stock.

El precio del intento es el precio publicado a 30 días. La selección entre
contado y 30 días y el registro de dinero efectivamente recibido pertenecen a la
entrega posterior; el intento no convierte un pedido pendiente en un cobro.

| Situación | Resultado conservador |
| --- | --- |
| Misma solicitud y contenido | Devuelve el estado persistido; no repite POST. |
| Mismo UUID con otro contenido o actor | Rechazo. |
| Rechazo HTTP 422 | Intento rechazado, sin descuento local; ese UUID no se reenvía. |
| Timeout, 429, 5xx o respuesta ambigua | Revisión manual y pausa; conserva token y no reintenta. |
| Fallo local después del claim remoto | Rollback local, pausa y revisión; no cancela ni repite automáticamente el pedido. |
| Reinicio con intento `enviando` | Conserva el bloqueo, incluso si el token es antiguo. |
| `unclaimed_stock` positivo o ambiguo | No adopta la reserva local. |

El token no tiene una caducidad que autorice reenvíos. Los workers, el setup, la
revinculación y OAuth respetan ese bloqueo. El diagnóstico público muestra solo
un booleano, nunca el valor del token. El intento guarda únicamente un hash del
pedido; su identificador remoto legible queda en el resumen borrable por el
proceso de privacidad existente.

## Lo que falta antes de habilitar

- Adaptar la venta ordinaria de la app y la confirmación de pedidos de la web
  original para reservar primero y adoptar luego. Ningún camino de una variante
  centralizada puede seguir descontando solo en Zilky. Los productos no
  vinculados deben conservar su comportamiento actual.
- Revisar combos, correcciones, ajustes manuales, devoluciones y cualquier otro
  cambio de stock: implementar su protocolo o bloquear el caso no soportado para
  variantes centralizadas. No sirve cerrar únicamente el botón principal.
- Implementar conciliación administrativa de intentos inciertos: buscar y
  verificar el pedido remoto correlacionado y adoptarlo bajo bloqueo. Una
  búsqueda sin resultados no prueba que el POST no llegó; no habilita reenvío.
- Resolver cancelación/reposición y la continuación operativa después de un
  intento desconocido, sin borrar evidencia ni crear movimientos duplicados.
- Autorizar `write_orders` en la instalación real cuando el flujo esté listo y
  verificar el payload, los emails desactivados, los webhooks y el caso de dos
  compradores de la última unidad en un entorno controlado.

## Pruebas ejecutables

`test/tiendanube-reservas.test.js` usa PGlite local y APIs falsas inyectadas: cubre
autorización, flags, precios, idempotencia, doble clic, reinicio, 422, timeout,
webhook adelantado, última unidad, rollback local y privacidad. No usa
`DATABASE_URL`, dinero, correos ni stock real. Los resultados de esas pruebas
no sustituyen las pruebas reales del proveedor ni habilitan producción.
