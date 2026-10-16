# Suscripción Zilky: US$20 mensuales

Estado: base preparatoria, **no habilitada ni publicada para cobrar**. Sin migraciones,
sin rutas públicas, sin cambios en permisos, datos de producción o acceso actual.

## Decisiones confirmadas

- Un plan de referencia de USD 20 por mes. Sin alta, prueba gratis ni permanencia
  agregadas automáticamente. Falta definir si la unidad comercial será una
  organización (con varios negocios) u otra; no cobrar por empleado por defecto.
- Pago mediante checkout del procesador; nunca recibir PAN/CVV en Zilky.
- Medios de pago sujetos a disponibilidad del procesador/cuenta/país. No prometer
  todas las tarjetas ni asumir que saldo Mercado Pago habilita débito recurrente.
- Suscripciones de la plataforma separadas de ventas, cuotas, comisiones, caja y
  cuentas de clientes de los comercios. No sumar la membresía a deudas comerciales.

## Implementado en esta base

`suscripcionPlanService.js` conserva el plan de referencia, valida una cotización
aprobada del servidor y prepara el cuerpo de un checkout pendiente Mercado Pago
Argentina en ARS. Valida destino de redirección e importe, moneda, referencia y
receptor de un pago consultado al proveedor. No envía solicitudes externas.
Las pruebas usan importes ficticios y no crean planes ni cobros reales.

## Dependencias antes de una integración cobrable

1. Confirmar con el titular: cobrar efectivamente USD 20 o el equivalente ARS.
   Si ARS, acordar fuente/cotización, vigencia y regla para futuras renovaciones.
   No usar ARS 20 ni una conversión supuesta. Conservar los términos aceptados;
   cualquier actualización debe seguir el consentimiento y reglas del proveedor.
2. Conectar cuenta receptora de Mercado Pago y verificar moneda y métodos
   recurrentes disponibles. Guardar secretos sólo en entorno del servidor, nunca
   en frontend, repositorio ni chat. Probar con cuentas de prueba del proveedor.
3. Resolver aislamiento de propietarios: actualmente `scopeNegocios` permite
   acceso global a `rol=administrador`. No entregar ese rol mediante registro o
   compra. Vincular propietario a organización y comprobar alcance en cada ruta,
   consulta, exportación y recurso. Preservar acceso del administrador actual.
4. Diseñar y migrar tablas exclusivas de facturación: suscripción por organización,
   versión de precio, intentos de checkout, periodos facturados y ledger de pagos.
   Backup restaurable antes de migrar. Unicidad de ID externo de pago y del periodo;
   bloqueo/transacción al conciliar. Reintentos no crean otro contrato/cobro.
5. Montar checkout autenticado sólo para propietario de la organización validada.
   No aceptar moneda, importe, organización ajena ni fecha de habilitación del
   navegador. Persistir intento antes de POST /preapproval y conciliar errores de
   red ambiguos antes de reintentar. No suponer idempotencia del proveedor.
6. Implementar y verificar webhooks según la configuración de suscripciones de
   la cuenta; consultar siempre API autenticada. Correlacionar pago con factura
   recurrente, contrato y organización. Validar firma cuando esté disponible.
   Nunca habilitar por volver de checkout, por datos del webhook, por estado
   `authorized` solamente ni únicamente por la validación de importe de esta base.
7. Activar período sólo con pago confirmado y ledger idempotente. Conciliar
   devoluciones/contracargos, cancelaciones y eventos fuera de orden. Usar período
   del proveedor; no agregar 30 días por notificación. Definir política de acceso
   ante fallo/cancelación sin borrar datos ni bloquear clientes existentes.
8. Pantalla de plan/precio final/moneda, aceptación de renovación, estado de pago,
   próxima fecha, historial y cancelación. Pruebas de compra, renovación,
   duplicados, fallos, reembolso, cancelación, acceso y aislamiento de empresas.

## Fuentes oficiales consultadas (2026-10-16)

- https://www.mercadopago.com.ar/developers/en/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments
- https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval/post
- https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks

La documentación muestra checkout `pending` e `init_point` y ejemplos ARS.
Eso no prueba que cualquier cuenta acepte USD ni todos los medios recurrentes.
