# Tiendanube ↔ Zilky (rama de desarrollo; no activada)

La tienda web propia (`/tienda/:slug`) **no se elimina, desactiva ni redirige**.
El stock maestro continúa en `productos` del negocio, con variantes separadas
por talle/color. Las fichas de Tiendanube son un canal comercial adicional.

Aplicación privada creada en Tiendanube: **51162**, `Zilky · Integración de stock`.
El código de esta rama no equivale a una conexión instalada ni desplegada.
Iniciar sesión en Render o en el Portal de Socios tampoco concede por sí solo
el token OAuth de la tienda ni activa el motor.

## Seguridad

- Requiere `TIENDANUBE_APP_ID=51162`, `TIENDANUBE_APP_SECRET` y
  `TIENDANUBE_TOKEN_KEY` (64 caracteres hexadecimales aleatorios). Configurar
  como secretos **solo en Render**, jamás en Git ni en el navegador del cliente.
  `TIENDANUBE_SYNC_ENABLED`, `TIENDANUBE_ENTREGAS_ENABLED` y
  `TIENDANUBE_RESERVAS_ENABLED` quedan apagadas por defecto; activar una no
  autoriza automáticamente las otras.
- Flujo de autorización de administrador: `POST /api/tiendanube/iniciar` con
  `{ "negocio_id": "..." }`. La respuesta genera la URL de autorización.
- Callback: `https://zilky-app.onrender.com/api/tiendanube/oauth/callback`.
  Usa `state` aleatorio de un solo uso, vinculado al negocio y usuario que
  inició la conexión, con 10 minutos de vencimiento. La conexión queda pausada.
- Eventos firmados: `POST /api/tiendanube/webhook`, HMAC del cuerpo sin alterar.
- Las rutas de administración requieren rol de administrador y membresía
  administrativa activa en la organización del negocio. El callback vuelve a
  comprobar ese permiso. Se consulta el estado con
  `GET /api/tiendanube/estado?negocio_id=...` sin exponer el token.
- Los vínculos por variante se crean individualmente y con verificación de la
  variante real mediante `POST /api/tiendanube/vinculos`.
- El administrador puede hacer una **conciliación de solo lectura comercial**
  con `POST /api/tiendanube/pedidos/conciliar` y
  `{ "negocio_id": "...", "order_id": "..." }`. Recupera el pedido real,
  detecta variantes sin vínculo, cambios de cantidad y cancelaciones. Guarda
  el estado para revisión, pero **no descuenta inventario ni marca cobros**.

## Implementado en esta rama

- Pantalla administrativa de conexión, catálogo y vínculo manual de variantes,
  diagnóstico, preparación de notificaciones y pausa. No hay publicación automática ni botón para activar un
  motor sin conciliar. Nunca empareja prendas únicamente por nombre.
- Inbox firmado y minimizado: solo tienda, evento, recurso y una marca temporal
  permitida. No guarda el cuerpo arbitrario ni datos de compradores.
- Notificaciones de idéntico contenido vuelven a encolar una lectura del pedido
  actual; la idempotencia del inventario depende del ledger, no del hash del
  mensaje. Una nueva edición puede tener el mismo cuerpo que otra anterior.
- Cola transaccional de cambios locales con control de versiones, lease de
  escritura y preservación de conflictos. Los reintentos 429 respetan backoff;
  una escritura con resultado incierto se detiene para revisión.
- Salida mediante `POST /products/:id/variants/stock`, `action: variation`
  y un ID de variante obligatorio: aplica el cambio local relativo, no pisa
  el stock remoto con un valor absoluto. Si ocurre un checkout entre lectura
  y escritura, conserva el baseline esperado y espera su notificación antes
  de verificar otra vez. Nunca repite un ajuste de resultado incierto.
- Motor conservador de reservas: pedido pendiente reserva una vez; pasar a
  pagado no vuelve a descontar. Pedidos previos al corte no se importan.
  Cancelaciones, reposiciones, faltantes, multidepósito o variantes no
  verificadas no se corrigen a ciegas.
- `product/updated` se trata como aviso para verificar stock, priorizando los
  pedidos que pueden explicar el cambio. No importa existencias arbitrarias.
- El worker está apagado por defecto. Requiere feature flag, conexión sin
  pausa, corte temporal, baseline por variante y webhooks verificados.
- Pruebas unitarias, HTTP, interfaz y PostgreSQL en memoria (PGlite). Estas
  pruebas no se conectan a la base del negocio ni hacen compras de prueba.

`GET /api/tiendanube/diagnostico?negocio_id=...` distingue estos requisitos;
`pausada=false` por sí solo **no** significa integración operativa.
`POST /api/tiendanube/pausar` detiene nuevas operaciones. Una petición remota
ya iniciada debe terminar o conciliarse; pausar no deshace una petición en vuelo.

### Preparación explícita de webhooks (sin activar sincronización)

Las rutas nuevas son solo para administradores del negocio:

- `GET /api/tiendanube/webhooks/estado?negocio_id=...` informa por separado
  el último registro verificado y la recepción firmada real.
- `POST /api/tiendanube/webhooks/configurar` con `{ "negocio_id": "..." }`
  lista las suscripciones de la app, crea únicamente las faltantes y vuelve
  a consultar la lista. El destino sale exclusivamente de `APP_BASE_URL`
  HTTPS más `/api/tiendanube/webhook`; no acepta una URL en el formulario.
- `POST /api/tiendanube/webhooks/verificar` usa el mismo cuerpo y solo hace
  lecturas de la API remota. Nunca publica ni cambia existencias.

Se registran `order/created`, `order/updated`, `order/paid`,
`order/cancelled`, `order/edited`, `order/fulfilled`, `order/pending`,
`order/voided`, `product/updated` y `app/uninstalled`. Los tres webhooks
obligatorios de privacidad se configuran aparte en Partners.

Ambas acciones requieren una conexión pausada, sin escritura ni reserva
remota pendiente; se serializan con los demás procesos mediante un lease.
URLs antiguas o suscripciones duplicadas se informan para revisión, nunca
se eliminan o sustituyen silenciosamente. Si un POST tiene resultado
incierto, no vuelve a crearlo: primero debe verificarse el resultado remoto.

Un GET exitoso de `/webhooks` **no prueba entrega end-to-end**. Se guarda
`setup_webhooks_registrados_at` solamente tras confirmar la lista completa.
`sync_webhooks_at` se establece al verificar además que un evento auténtico,
ya validado por el receptor HMAC, ingresó después del registro. La evidencia
usa `hmac_validada_at`, escrita solo tras validar la firma; filas previas o
internas no reciben esa marca por defecto ni durante la migración. Esto prueba
alcance del receptor, no el flujo de venta/stock completo; el negocio sigue
pausado y no se escribe un baseline ni se habilita el motor.

Si el proceso se interrumpe y deja un lease, debe conciliarse antes de otro
intento. No se asume que vencer un temporizador equivale a que el proveedor
no recibió un POST. Tampoco se usa una reautorización para borrar ese bloqueo.

## Límites operativos: no ocultarlos

El ajuste relativo evita sobreescribir descuentos concurrentes, pero no hay
una reserva atómica de la última unidad entre ambas plataformas. Tiendanube
satura el stock a cero si se pide restar más de lo disponible, en vez de
rechazarlo. Si ambos canales venden la última prenda simultáneamente, el
motor detecta el faltante al recibir el pedido y pausa: eso **no evita** la
sobreventa ya ocurrida. Hay una prueba que reproduce expresamente ese límite.
No activar en dos canales simultáneos sin resolver o aceptar explícitamente
una política operativa para ese riesgo. La web original no se apaga sola.

Se preparó un servicio **interno y no operativo** para reservas centrales con
`POST /orders`, `inventory_behaviour: claim`. La API documenta rechazo 422
cuando no alcanza el stock; también se comprueba `issues.unclaimed_stock`.
El intento durable impide reenviar un POST de resultado incierto y bloquea
workers/reautorización mientras está pendiente. No crea cobros ni comisiones.
Además del flag exige un adaptador interno `canalesCentralizados`, que por
defecto devuelve falso. Todavía **no** está conectado a las ventas ordinarias
ni a la confirmación de la web original; tampoco hay flujo de resolución
manual para intentos inciertos. No garantiza la última unidad en producción.
Requiere `write_orders` adicional, aún no solicitado a la tienda real.

El servidor gratuito puede suspenderse por inactividad. El worker de este
proceso no garantiza disponibilidad permanente ni sincronización instantánea
mientras Render esté suspendido. No se cambió a un plan pago.

Una reserva no es una entrega, venta financiera ni cobro. El flag remoto
`paid` no genera dinero, comisiones ni ganancia. La adopción de reservas está
en un servicio separado, con rutas y pantalla operativa nuevas pero
apagadas por defecto. Usa una capacidad interna no representable en JSON
para crear la venta sin volver a descontar, con vínculo único por pedido.
Exige confirmación de entrega y de cobro real, conserva precios del pedido
y rechaza anticipos de otro día, cargos, descuentos o pagos no conciliados.
La venta común no debe usarse para descontar otra vez lo reservado.
El dashboard neto real/esperado mensual no forma parte del motor de stock.

La pantalla `#/tiendanube/pedidos` y el router operativo separado requieren
el negocio autorizado y permisos `tienda.pedidos` + `ventas.crear`; no abren la
pantalla administrativa a vendedores. Permiten elegir contado o 30 días,
entrega inicial real (incluido cero), cliente, fecha y vencimiento. Las rutas
devuelven 409 con el flag apagado. La confirmación crea la entrega **local**:
no marca pagos ni envíos en Tiendanube. Los casos con pasarela, envíos/cargos,
promociones o anticipos de otro día continúan bloqueados para conciliación.
No se muestran costos, comisiones ni totales financieros globales al empleado.

Verificado en el Portal de Socios el 09/11/2026: los **datos básicos están
finalizados** para la app 51162; se guardaron los permisos `Edit Products` y
`View Orders`, la URL de página de la app y el callback de este repositorio.
Se guardaron los tres webhooks obligatorios en URLs independientes:

- `POST /api/tiendanube/privacy/store-redact`: registra revisión pendiente de
  la instalación afectada. No borra automáticamente una reinstalación nueva.
- `POST /api/tiendanube/privacy/customer-redact`: elimina resúmenes e inbox de
  pedidos solicitados y minimiza informes anteriores. Conserva un tombstone
  y el ledger de stock seudonimizado para evitar descontar de nuevo. No borra
  ventas ni comprobantes locales.
- `POST /api/tiendanube/privacy/customer-data-request`: prepara un reporte
  mínimo con estado `pendiente_entrega`. No afirma haberlo enviado al cliente.

Las revisiones de tienda/desinstalación y entrega de reportes todavía requieren
un procedimiento operativo; un HTTP 202 no equivale a borrado ni envío final.
El panel administrativo muestra ahora solicitudes y resúmenes, incluso sin
conexión vigente, pero leerlos no los marca como completados ni los envía.

Las tres rutas comprueban la firma HMAC. La app **todavía no está instalada**,
los endpoints **todavía no están desplegados** y no debe asumirse que reciben
solicitudes hasta que Render tenga el código y los secretos. No instalar antes.

Antes de activar la conexión se debe:

1. Sesión de Socios y panel comercial verificados el 09/11/2026. Se guardaron
   las claves privadas de la integración en el servicio Render correcto;
   los tres flags continúan en `false`. Guardar la clave de cifrado por la API
   provocó un redeploy de la misma versión de producción anterior, no de esta
   rama. Falta la sesión del dueño en Zilky App para vincular el negocio correcto.
   Ningún secreto se guarda en este repositorio.
2. Completar pruebas y revisión; desplegar primero contra una base aislada,
   luego el código pausado. Finalizar el procedimiento de privacidad antes de
   instalar. La app privada requiere `write_products` y `read_orders`.
3. Autorizar OAuth en la tienda correcta, registrar y verificar los webhooks
   comerciales reales. El callback siempre deja la conexión pausada y exige
   volver a verificar el baseline tras una reautorización.
4. Conciliar tienda/negocio y mapear las variantes existentes una por una
   (40 fichas y 50 unidades fueron la carga inicial; no el stock actual
   confirmado). Resolver pedidos en tránsito y diferencias antes del corte.
5. Probar flujo real controlado de reserva → entrega → venta sin segundo
   descuento, pagos reales, comisión al retirar aunque la entrega sea cero,
   un único saldo a 30 días y permisos de empleado. No crear dinero a partir
   de un estado de pedido. Resolver la concurrencia de ambos canales.
   La ruta/UI de entrega nueva ya existe en la rama; sus pruebas aisladas no
   reemplazan la autorización, conciliación y prueba reales.
6. Implementar publicación explícita y galerías según las capacidades del
   canal. Cargar producto en Zilky no debe publicar todo el inventario sin
   elección del dueño. El precio comercial publicado es el de 30 días;
   contado efectivo/transferencia descuenta $2.500 por prenda, no por pedido.
   Ejemplo: publicado $42.500, contado $40.000.
7. Activar únicamente después de la verificación de punta a punta y monitorear
   errores/revisiones. Hasta entonces, los inventarios siguen independientes.

No llamar a la sincronización «activa» hasta validar todos estos puntos.

Referencias oficiales verificadas: [OAuth](https://tiendanube.dev/docs-api/authentication),
[webhooks](https://tiendanube.github.io/api-documentation/resources/webhook) y
[pedidos](https://tiendanube.github.io/api-documentation/resources/order),
[reservas de pedidos 2025-03](https://tiendanube.dev/api/resources/2025-03/order),
[ajustes de stock por variante](https://tiendanube.github.io/api-documentation/resources/product-variant).
