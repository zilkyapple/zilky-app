# Privacidad de Tiendanube: procedimiento operativo

Esta pantalla administra solicitudes recibidas por los receptores con HMAC de
Tiendanube. No certifica cumplimiento legal, no verifica obligaciones externas,
no manda correos y no toca las prendas, cantidades de inventario, clientes,
ventas, créditos, pagos, comisiones ni la web original de Zilky.

Solo un usuario administrador activo que también sea administrador activo de
la organización propietaria del negocio puede consultar o ejecutar acciones.
El backend comprueba estas condiciones en cada operación; un permiso de vendedor
o de edición de tienda no habilita esta pantalla.

## Informe pendiente de entrega

1. Seleccionar el negocio y revisar la solicitud.
2. Descargar el informe. La exportación registra actor, fecha y huella del
   contenido; la solicitud sigue pendiente. La respuesta JSON prepara una
   descarga: no prueba que el archivo se haya recibido ni enviado por correo.
3. Revisar el contenido y completar la recepción o la entrega real al
   comerciante. El archivo cubre los resúmenes operativos que esta integración
   almacena; una solicitud que también alcance registros comerciales
   independientes de Zilky necesita revisión fuera de este flujo.
4. Elegir **Yo recibí el informe como administrador** o **Ya entregué el informe
   fuera de Zilky**, y confirmar que ocurrió realmente.

La constancia es una declaración del administrador, no una verificación externa
ni un envío automático. Si los datos fueron redactados después de exportar,
se rechaza la constancia sobre un archivo viejo y se exige exportar el actual.
El informe no se copia en la auditoría: se conserva su huella.

## Desinstalación o solicitud de borrar datos de integración

Recibir un evento no elimina ni revoca automáticamente una conexión. La acción
requiere una vista previa y confirmación explícita del administrador:

1. Pausar y conciliar todos los efectos operativos pendientes.
2. Abrir la solicitud y preparar una vista previa. Se compara una huella de la
   instalación capturada al recibir el evento (tienda, app, creación y credencial
   cifrada). No se atribuyen solicitudes antiguas a una instalación nueva.
3. Se consulta únicamente `GET /store`, con timeout de 15 segundos. Solo una
   respuesta 401 acredita que esa credencial fue rechazada; 200, 403 o un error
   de red bloquean la eliminación. Esto no prueba otras obligaciones externas.
4. Revisar los conteos exactos de datos a eliminar y las trazas que se conservan.
   Escribir `BORRAR INTEGRACION <store_id>` y marcar la confirmación explícita.

La vista previa dura 10 minutos y está ligada al actor, la solicitud y una huella
del estado completo revisado. Cualquier cambio relevante exige una nueva vista
previa. La confirmación vuelve a verificar la revocación. La acción no ofrece
deshacer desde la pantalla.

Se eliminan exclusivamente credencial/conexión, vínculos de variantes, salidas
de stock conciliadas, notificaciones procesadas, resúmenes de pedidos y estados
OAuth pendientes de ese negocio/tienda. Los resúmenes en informes ya entregados
se retiran, conservando la huella y su constancia. Se incrementa una época OAuth
para rechazar callbacks que estuvieran en vuelo antes del borrado.

Se conservan la auditoría de privacidad, marcas que impiden reimportar datos
redactados y trazas seudónimas de stock/reservas/entregas que sostienen la
idempotencia y el historial comercial. Eliminar estos registros o datos
comerciales locales requiere una decisión y un procedimiento diferentes; el
resultado de esta pantalla no se debe interpretar como una eliminación
universal de toda información de la persona o del comercio.

## Bloqueos deliberados

- Solicitud antigua sin huella de instalación, instalación distinta, evento
  anterior o app diferente: no se adivina la pertenencia, no se borra.
- Conexión activa, lease/reserva pendiente aunque su fecha haya vencido, inbox
  sin conciliar, outbox pendiente/incierto, pedido en revisión o reserva sin
  entrega: primero conciliar; esta pantalla no inventa ventas/cobros ni repone
  stock para poder continuar.
- Informe pendiente de entrega: completar su procedimiento antes de retirar
  resúmenes.
- Conexión ya ausente sin evidencia suficiente: revisión manual, no marca
  automáticamente la solicitud como completada.

Un reintento con la misma confirmación devuelve su constancia original y no
elimina una instalación posterior. Un fallo de transporte se considera resultado
desconocido hasta actualizar la pantalla, no motivo para repetir ciegamente.

## Montaje y pruebas

- Backend: `tiendanubePrivacidadRouter` en
  `/api/tiendanube/privacidad-gestion`, después de la autenticación.
- Frontend: `tiendanubePrivacidadView(view, ctx)` en la navegación del admin.
- Migración aditiva: `tiendanubePrivacidadSchema`, ya ejecutada por el migrador.
- Pruebas sin servicios externos: `tiendanube-privacidad-gestion.test.js`
  (PostgreSQL en memoria), `tiendanube-privacidad-http.test.js`,
  `frontend-tiendanube-privacidad.test.js` y `tiendanube-privacidad.test.js`.

Este flujo no activa la sincronización, no configura precios y no modifica
ningún flag de producción. La futura autoridad central de stock debe seguir
siendo segura incluso si se retira una conexión; esta pantalla no introduce
esa activación ni demuestra una venta de punta a punta.
