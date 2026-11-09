# Tiendanube ↔ Zilky (desarrollo en curso)

La tienda web propia (`/tienda/:slug`) **no se elimina, desactiva ni redirige**.
El stock maestro continúa en `productos` del negocio, con variantes separadas
por talle/color. Las fichas de Tiendanube son un canal comercial adicional.

Aplicación privada creada en Tiendanube: **51162**, `Zilky · Integración de stock`.

## Seguridad

- Requiere `TIENDANUBE_APP_ID=51162`, `TIENDANUBE_APP_SECRET` y
  `TIENDANUBE_TOKEN_KEY` (64 caracteres hexadecimales aleatorios). Configurar
  como secretos **solo en Render**, jamás en Git ni en el navegador del cliente.
- Flujo de autorización de administrador: `POST /api/tiendanube/iniciar` con
  `{ "negocio_id": "..." }`. La respuesta genera la URL de autorización.
- Callback: `https://zilky-app.onrender.com/api/tiendanube/oauth/callback`.
  Usa `state` aleatorio de un solo uso, vinculado al negocio y usuario que
  inició la conexión, con 10 minutos de vencimiento. La conexión queda pausada.
- Eventos firmados: `POST /api/tiendanube/webhook`, HMAC del cuerpo sin alterar.
- Las rutas de administración requieren rol de administrador. Se consulta el
  estado con `GET /api/tiendanube/estado?negocio_id=...` sin exponer el token.
- Los vínculos por variante se crean individualmente y con verificación de la
  variante real mediante `POST /api/tiendanube/vinculos`.
- El administrador puede hacer una **conciliación de solo lectura comercial**
  con `POST /api/tiendanube/pedidos/conciliar` y
  `{ "negocio_id": "...", "order_id": "..." }`. Recupera el pedido real,
  detecta variantes sin vínculo, cambios de cantidad y cancelaciones. Guarda
  el estado para revisión, pero **no descuenta inventario ni marca cobros**.

## Garantías actuales y trabajo pendiente

El esquema adjunto almacena enlaces e inbox de webhooks y crea una cola
transaccional para todos los cambios locales de stock. Los cambios permanecen
**pausados**: no se envían automáticamente. Este primer avance **no equivale**
a sincronizar las ventas entre los sistemas.

Verificado en el Portal de Socios: los datos básicos y permisos están todavía
sin guardar; el callback que figura en el formulario es el predeterminado del
portal, no el callback de este repositorio. No se debe instalar la app ni
guardar URLs de privacidad mientras los endpoints correspondientes no estén
operativos en el servidor de producción.

Antes de activar la conexión se debe:

1. Completar la app privada y sus webhooks de privacidad en el Portal de Socios;
   autorizar los scopes mínimos `write_products` y `read_orders`.
2. Reconciliar tienda/negocio y mapear una por una las variantes existentes
   (40 fichas, 50 unidades iniciales); el stock actual puede haber cambiado.
3. Implementar y probar un procesador de entrada de pedidos y una salida de
   stock con verificación de versión; no sobrescribir ventas web concurrentes.
4. Probar webhooks duplicados, fuera de orden, ediciones y cancelaciones sin
   restock, errores 429, reintentos, pedidos pendientes y stock negativo.
5. Registrar cobros reales **separados** de pedidos pendientes. La comisión del
   vendedor se aplica por entrega/venta atribuida, no por pago final, y los
   empleados nunca ven montos de comisión sin permiso.
6. Mostrar `Publicado en Tiendanube`/`Publicar en tienda web` solo para
   productos que el dueño elija: no autopublicar todo el inventario.
7. Desplegar primero en entorno aislado con DB de pruebas, luego verificar
   producción sin pagos ni compradores reales.

No llamar a la sincronización «activa» hasta validar todos estos puntos.
