# Correcciones para datos reales — 2026-10-08

Estado: PR #13 integrada y desplegada; flujo principal validado con cliente ficticio en el negocio QA de producción.
Commit desplegado: 91d317bf87e35c41fbd3b121529be34ec39ce95d.
Render confirmó estado live el 2026-10-08 a las 16:07:47 (Argentina).
Baseline: f446d4f4a2b8df185653c829bfa9dc044e268034.

## Alcance y comportamiento

- Cobrar → Todas conserva todas las cuotas, conforme a la última indicación.
- Datos básicos del cliente editables con motivo, auditoría antes/después/actor y
  versión para evitar sobrescrituras. Identidad compartida: un empleado necesita
  permiso de edición en todos los negocios vinculados; en otro caso, administrador.
- Eliminación individual, exclusiva del administrador, con previsualización,
  motivo y confirmación escrita ELIMINAR. Solo fichas sin actividad: cualquier
  operación, pago, comprobante, seguimiento o saldo bloquea el borrado. Auditoría
  de identidad/vínculos conservada. Revalidación transaccional y reintentos seguros.
- Editor de financiación para administradores: importe, entrega, fecha, cantidad
  de cuotas, importes/vencimientos pendientes, descripción del producto y condiciones.
  Conserva pagos y aplicaciones; cuotas con actividad no se eliminan. Una cuota
  saldada no admite cambiar importe/vencimiento. No admite importes inferiores al
  capital ya cobrado: requiere conciliación del excedente, sin inventar devoluciones.
  Corregir la entrega anula lógicamente el registro y comprobante originales y emite
  los corregidos, con confirmación explícita. No representa un nuevo ingreso de caja.
  La descripción corregida no modifica inventario ni reemplaza un IMEI vinculado.
  Auditoría completa antes/después; fecha/actor/motivo visibles en la ficha.
- Mora generada, cobrada, perdonada y pendiente separadas. Perdonar es una acción
  del administrador con motivo y corte al importe mostrado. No cambia días de gracia
  del negocio ni borra atraso histórico. Los atrasos posteriores pueden generar
  nueva mora. El saldo de mora sigue cobrable aunque el capital ya esté saldado.
  No se inventa mora histórica de cuotas antiguas saldadas sin registro previo.
- Mora automática redondeada al múltiplo de $500 más cercano, mitades hacia arriba.
  Capital pactado y pagos reales no se redondean; hacerlo alteraría dinero registrado.
- WhatsApp usa únicamente saldo exigible (cuotas vencidas/hoy y su mora pendiente),
  excluyendo cuotas futuras y mora perdonada. Tres renglones, nombre real, saludo
  sin signo inicial, singular/plural adecuado. No se envían mensajes automáticamente.
- La ficha separa cuota vencida y días de atraso, vencimiento de hoy y próximo futuro.
- Reintentos conservan solicitud y payload; versiones viejas no pisan pagos/cambios.
  No se ampliaron permisos financieros globales del empleado.

## Migración

- Cuotas: mora_generada_centavos y mora_perdonada_centavos (BIGINT, cero inicial,
  no negativos). Créditos: producto_descripcion y condiciones (texto opcional).
- Índice único de entrega inicial limita entregas activas, conservando las anuladas.
- Migración transaccional repetible; no recrea clientes, cuotas, pagos ni comprobantes.
- Antes de publicar: respaldo privado del proveedor y restauración independiente.
  Se verificaron las 25 tablas por conteos/huellas de contenido y las secuencias.
  Nunca ejecutar la suite destructiva sobre producción ni sobre la copia real.
  Renovar respaldo antes de desplegar por las altas concurrentes del usuario.

## Pruebas y seguimiento

- 149 pruebas locales de frontend y lógica: aprobadas.
- Suite PostgreSQL completa en CI aislada, Node 24/26. El checkpoint de mora pasó
  ambas variantes y auditoría de dependencias. Validación final: 351 pruebas aprobadas, 0 fallos y 0 omitidas en ambas versiones; auditoría de dependencias sin vulnerabilidades.
- Casos añadidos: versiones viejas, permisos, historial intacto, eliminación segura,
  perdón idempotente, cobro solo de mora, anulación, corrección de entrega con originales,
  migración repetida, reducción al capital cobrado conservando fecha y atraso reales.
- Se actualizó proxy-addr a 2.0.8 por vulnerabilidad crítica reportada por npm audit.
- Producción: acceso de administrador y flujo QA verificados el 08/10. Ver evidencia de validación al final.
- Un respaldo anterior no autoriza restaurar encima de nuevas operaciones reales.
  Reversión de aplicación debe conservar columnas aditivas e historial creado.

## Comprobación posterior al despliegue

- Migración aplicada y build exitoso en Render; commit publicado verificado.
- Conteos y huellas de los valores anteriores de las 25 tablas permanecen idénticos
  después de migrar (se excluyen únicamente las cuatro columnas nuevas).
- No se borraron datos reales ni se enviaron mensajes de WhatsApp.
- El proveedor no permitió un segundo snapshot por límite de capacidad. El respaldo
  restaurado se comparó inmediatamente antes del despliegue: las 25 tablas seguían
  idénticas a producción, y sus secuencias habían sido verificadas.
- Pantalla de acceso de producción abre correctamente. Tras un primer intento rechazado, el usuario completó el acceso y se verificó el flujo QA.
- La suite de integración verificó esos comportamientos sobre PostgreSQL aislado.
  La comprobación visual complementaria se detalla a continuación.

## Archivos modificados

- `public/app.js`: formularios, ficha, mora y WhatsApp.
- `src/db/migrate.js`: campos nuevos e índice de entrega inicial activa.
- `src/lib/{clientData,money,mora,vencimientos}.js`: validación y cálculos.
- `src/repositories/cuotas.js`: persistencia y selección de saldos.
- `src/routes/{clientes,pagos,ventas}.js`: API y permisos.
- `src/services/{clientDataService,clientDeletionService,financiacionService,moraService}.js`:
  servicios de edición, eliminación protegida, corrección y condonación.
- `src/services/{pagosService,comprobantesService,dashboardService,incidenciasService}.js`:
  integración con pagos, comprobantes y estados.
- `test/{client-corrections-unit,client-corrections,frontend-client-file,stage1}.test.js`:
  regresión y nuevos casos.
- `package-lock.json`: actualización de seguridad de proxy-addr.
- Este informe.

## Validación visual autenticada — 08/10/2026

Se usó únicamente el negocio QA y una ficha ficticia identificada como prueba.
No se modificaron clientes reales, no se enviaron mensajes y la sesión quedó abierta.

- Alta de cliente y corrección de nombre/observaciones verificadas al volver a la ficha.
- Venta con entrega de $200 y dos cuotas; corrección auditada del importe, fecha,
  descripción y condiciones. Cuotas corregidas: $70.000 vencidos y $70.000 futuros.
- Se mostraron por separado 30 días de atraso y el próximo vencimiento futuro.
- Mora generada de $5.500; pago QA de $500 imputado a mora; perdón auditado de $5.000.
  La ficha conservó generación, cobro, perdón y atraso como conceptos separados.
- Enlace de WhatsApp inspeccionado sin enviarlo: tres líneas y exigible de $70.000,
  excluyendo cuota futura y mora perdonada. Número ficticio usado exclusivamente en QA.
- Pago QA final: saldo cero, 2/2 cuotas saldadas, una pagada tarde y otra anticipada.
  El historial conservó 30 días de atraso y decisión de mora con actor/motivo.
- Tres comprobantes visibles: entrega, cobro parcial de mora y pago final.
- Eliminación bloqueada con detalle de operaciones, cuotas, pagos y comprobantes.
  La eliminación efectiva de fichas vacías se verificó en PostgreSQL aislado; no se
  hizo un borrado irreversible desde el navegador de producción.
- La ficha QA quedó finalizada, sin deuda de prueba activa. Sus movimientos ficticios
  permanecen en el negocio QA para preservar evidencia; no son ingresos reales.
- No fue necesaria otra modificación de código durante esta validación visual.
