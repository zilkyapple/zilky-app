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
  `TIENDANUBE_SYNC_ENABLED` y `TIENDANUBE_ENTREGAS_ENABLED` quedan apagadas
  por defecto; activar una no autoriza automáticamente la otra.
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
  diagnóstico y pausa. No hay publicación automática ni botón para activar un
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

## Límites operativos: no ocultarlos

El ajuste relativo evita sobreescribir descuentos concurrentes, pero no hay
una reserva atómica de la última unidad entre ambas plataformas. Tiendanube
satura el stock a cero si se pide restar más de lo disponible, en vez de
rechazarlo. Si ambos canales venden la última prenda simultáneamente, el
motor detecta el faltante al recibir el pedido y pausa: eso **no evita** la
sobreventa ya ocurrida. Hay una prueba que reproduce expresamente ese límite.
No activar en dos canales simultáneos sin resolver o aceptar explícitamente
una política operativa para ese riesgo. La web original no se apaga sola.

El servidor gratuito puede suspenderse por inactividad. El worker de este
proceso no garantiza disponibilidad permanente ni sincronización instantánea
mientras Render esté suspendido. No se cambió a un plan pago.

Una reserva no es una entrega, venta financiera ni cobro. El flag remoto
`paid` no genera dinero, comisiones ni ganancia. La adopción de reservas está
en un servicio experimental separado, sin rutas ni pantalla operativa y
apagado por defecto. Usa una capacidad interna no representable en JSON
para crear la venta sin volver a descontar, con vínculo único por pedido.
Exige confirmación de entrega y de cobro real, conserva precios del pedido
y rechaza anticipos de otro día, cargos, descuentos o pagos no conciliados.
La venta común no debe usarse para descontar otra vez lo reservado.
El dashboard neto real/esperado mensual no forma parte del motor de stock.

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

Las tres rutas comprueban la firma HMAC. La app **todavía no está instalada**,
los endpoints **todavía no están desplegados** y no debe asumirse que reciben
solicitudes hasta que Render tenga el código y los secretos. No instalar antes.

Antes de activar la conexión se debe:

1. Obtener la sesión de Socios y configurar los secretos en el servicio Render
   correcto, sin mostrarlos ni incluirlos en la rama pública. El acceso a
   Render fue verificado el 09/11/2026; las cuatro variables de integración no
   estaban configuradas al inspeccionar sus nombres.
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
[ajustes de stock por variante](https://tiendanube.github.io/api-documentation/resources/product-variant).
