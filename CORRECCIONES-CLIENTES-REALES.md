# Correcciones para datos reales — 2026-10-08

Estado: implementación en PR #13; validación final y despliegue pendientes.
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
  ambas variantes y auditoría de dependencias. Validación final del editor en curso.
- Casos añadidos: versiones viejas, permisos, historial intacto, eliminación segura,
  perdón idempotente, cobro solo de mora, anulación, corrección de entrega con originales,
  migración repetida, reducción al capital cobrado conservando fecha y atraso reales.
- Se actualizó proxy-addr a 2.0.8 por vulnerabilidad crítica reportada por npm audit.
- Producción: falta validación autenticada del flujo completo en navegador; el
  navegador disponible muestra inicio de sesión. No declarar cerrado este punto.
- Un respaldo anterior no autoriza restaurar encima de nuevas operaciones reales.
  Reversión de aplicación debe conservar columnas aditivas e historial creado.
