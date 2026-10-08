# Etapa 5 — WhatsApp: preparación, sin activación

Estado: parcial. La Etapa 4 permanece como baseline. No se habilitó Cloud API ni se enviaron mensajes reales.

## Implementado

- Previsualización de los contactos de un cliente dentro de un negocio explícito, exclusiva del administrador. Acceso desde Gestión de cobranza y antecedentes → Previsualizar automatización.
- Consulta de solo lectura y snapshot consistente. No modifica fechas, estados, deuda, pagos ni comprobantes.
- Mensaje determinístico por cuota: capital pendiente más mora pendiente, excluyendo mora cobrada/perdonada. La cuota futura se presenta como recordatorio, con importe exigible cero; nunca como deuda vencida.
- Motivos visibles: contacto cerrado, fecha futura/reprogramada, pausa/inactividad, revisión, gestión especial manual, cuota saldada, teléfono sin prefijo internacional e integración no activada.
- Huella para detectar cambios de saldo exacto, destinatario, fechas, modo o nota. No equivale a deduplicación persistente ni a una garantía del proveedor.
- Funciones preparadas y probadas de verificación HMAC-SHA256 sobre cuerpo crudo y transición de estados de entrega sin retroceder de entregado/leído por eventos desordenados. Aún no hay endpoint de webhook registrado.
- Frontend neutraliza HTML y descarta respuestas al cambiar de negocio o cerrar/reemplazar el panel.

## Pendiente para completar la etapa

1. Identificar cuenta Meta Business y número emisor por negocio, y verificar el uso admitido para avisos sobre ventas propias financiadas. No se encontró esta configuración en el repositorio ni en el contexto recuperado.
2. Meta incluye «debt collection» entre los servicios restringidos. No asumir que el caso está autorizado ni que está prohibido sin verificar su encuadre concreto. Fuente oficial revisada: https://business.whatsapp.com/policy (actualizada 23/09/2026).
3. Plantillas aprobadas, consentimiento y bajas por destinatario. La previsualización no implica aprobación de plantilla.
4. Outbox persistente, activación/desactivación por negocio, revisión/aprobación, worker y deduplicación transaccional. Revalidar pagos, pausas y reprogramaciones inmediatamente antes de enviar. Ante resultado incierto no reenviar ciegamente.
5. Endpoint firmado y persistencia idempotente de eventos, conciliación de aceptado/enviado/entregado/leído/fallido.
6. Prueba con destinatario QA autorizado antes de cualquier habilitación real.

No se agregaron migraciones, secretos, dependencias ni conexiones salientes. La pestaña Cobrar → Todas no cambia. Las tablas financieras y los datos reales permanecen intactos.

## Validación

18 pruebas locales de reglas y frontend aprobadas. La suite completa PostgreSQL/Node 24 y 26 se ejecuta en el PR. Un test detectó que un cambio de un centavo no invalidaba la huella al conservar el texto redondeado; corregido incorporando capital y mora exactos.

No declarar esta etapa terminada por el éxito de estas pruebas: faltan la integración con el proveedor, la cola persistente y la validación de extremo a extremo.
