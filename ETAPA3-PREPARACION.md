# Etapa 3 — requisitos recuperados y preparación

Fecha: 4 de octubre de 2026. Base estable: `f0c4ffb5d2cfce39c958db5fa509b1c48c81836a`.

Este documento distingue requisitos confirmados, comportamiento existente y
decisiones ausentes. No declara implementada la reorganización completa ni
reabre las Etapas 1 y 2.

## Fuentes revisadas

- Conversación de trabajo y contexto previo recuperable, con búsqueda específica
  de «Etapa 3», «Clientes reorganizados», ficha central, permisos y datos globales.
- `Pront.docx`, completo, especialmente apartados 14, 24, 26, 27, 43, 44, 46 y 47.
- Informe de cierre del 04/10/2026, versión 19, y evidencias acumuladas de QA.
- Inventario completo disponible de documentos y ZIP: Pront, checkpoints de
  Etapa 2, informes y evidencias. Los documentos de comisiones de Lucas no son
  especificaciones de Zilky y no se trasladan al producto.
- Checkpoint `ZILKY-ETAPA2-CORREGIDA(1).zip`, sus README e informe, y archivo
  histórico `zilky-app.zip` del repositorio, incluido su README.
- Historial de commits y ramas remotas actualizado con `git fetch origin`;
  documentación actual e histórica del repositorio. No apareció una rama ni
  un documento de implementación previa de Etapa 3.
- Esquema, repositorios, autorización, rutas, frontend y pruebas relativos a
  clientes, créditos, cuotas, pagos, comprobantes y seguimiento.

Resultado: hay un objetivo general explícito y reglas transversales suficientes
para preservar la base, pero no una especificación detallada adicional que
resuelva todo el alcance de «Clientes reorganizados».

## Requisitos confirmados

| Fuente | Requisito | Consecuencia técnica |
| --- | --- | --- |
| Pront 26 | Ficha central para entender la relación del cliente con el negocio | Reutilizar las relaciones existentes; no duplicar identidad ni movimientos |
| Pront 26 | Relacionar datos personales, negocio, ventas, financiaciones, cuotas, pagos, comprobantes, cobranzas, seguimiento e historial | Organizar accesos y datos existentes sin inventar otro motor financiero |
| Pront 26 | Contemplar contratos y comunicaciones futuras | Mantener puntos de extensión; implementación funcional corresponde a etapas posteriores |
| Pront 24 y 43 | Información operativa no equivale a finanzas globales | No conceder dashboard, costos ni totales consolidados por poder crear ventas o cobrar |
| Pront 26 y cierre 1/2 | Usuario + negocio + permiso | Aplicar permisos por recurso y negocio; no sumar permisos de negocios distintos |
| Pront 44 | Interfaz usable, sin saturación ni términos técnicos innecesarios | Resolver distribución visual como decisión técnica una vez determinado el comportamiento |
| Pront 46/47 | Secuencia de etapas y validación real | No mezclar cobranza avanzada, WhatsApp, edición de créditos, caja, contratos o exportaciones |

No es necesario pedir al usuario que decida colores, componentes, nombres de
funciones, índices o estructura del código. Esas son decisiones técnicas.

## Estado real y puntos de integración

| Área | Implementación existente | Límite que se conserva |
| --- | --- | --- |
| Identidad del cliente | `clientes` global; `cliente_negocio` explícita; búsqueda y duplicados globales con respuesta restringida | Un cliente puede comprar en varios negocios sin duplicar su identidad |
| Lista de clientes | Todos, Con deuda, Finalizados; búsqueda por nombre, apellido, DNI, teléfono e Instagram | Con deuda/Finalizados requieren cobranzas; Finalizados requiere negocio |
| Alta | `POST /api/clientes`; nombre/apellido obligatorios; negocio explícito en UI | `clientes.editar`, validación backend y rechazo de posibles duplicados para empleados |
| Ficha | `GET /api/clientes/:id` con filtro de negocio; contacto, acciones e historial autorizado | `clientes.ver` no habilita por sí solo historial/deuda |
| Finanzas de la ficha | Créditos, cuotas, pagos, riesgo e historial filtrados por intersección de permisos | Se conserva el contrato actual de `dashboard_financiero.ver`; no se amplía en esta preparación |
| Pagos en UI | Primeros 12 en la ficha, con entrega inicial y anulaciones diferenciadas | El backend conserva el historial; no se reescriben movimientos |
| Comprobantes | Pantalla y endpoints propios; listado permite `cliente_id` y `negocio_id` | Ver y anular son permisos separados; entrega inicial no se anula como pago ordinario |
| Seguimiento comercial | Estado, nota y fecha en `clientes`, editor existente con negocio explícito | No convertirlo silenciosamente en seguimiento de cobranza por negocio |
| Cobranza avanzada | Definición futura por cliente + negocio, modos y próximo contacto | Etapa 4; no migrar ni adjudicar notas históricas sin una regla definida |
| Ventas/financiación | Venta, crédito y cuotas relacionados; motor transaccional existente | Conservar redondeo aprobado, entrega inicial y auditoría |

Archivos de integración: `public/app.js`, `src/routes/clientes.js`,
`src/repositories/clientes.js`, `src/middleware/authorize.js`,
`src/routes/comprobantes.js`, `src/services/dashboardService.js` y
`src/db/migrate.js`.

## Correcciones independientes realizadas en esta preparación

Se reprodujeron fallos del flujo existente sin decidir funcionalidades nuevas:

1. Confirmaciones repetidas de alta enviaban varias solicitudes. Ahora el botón
   queda bloqueado durante la solicitud y después del éxito; una denegación
   permite corregir y reintentar conservando los campos.
2. El alta tomaba el negocio vigente al guardar, aunque el formulario se hubiera
   abierto en otro. Ahora queda vinculada al negocio del formulario y se impide
   enviar si cambian negocio, sesión, permiso o modal.
3. Una respuesta tardía de alta podía cerrar otro modal y cambiar de ficha.
   Ahora se verifica la vigencia del formulario antes de actuar sobre la UI.
4. La búsqueda en Finalizados ignoraba el texto. Ahora filtra el resultado ya
   autorizado por nombre, apellido, DNI, teléfono o Instagram, sin obtener
   datos de negocios adicionales ni cambiar la definición de Finalizados.

Esto evita dobles envíos desde ese formulario. No constituye idempotencia
general del backend ni garantiza deduplicar solicitudes HTTP arbitrarias.

No hay migraciones, cambios de dependencias, cambios en permisos backend,
credenciales, cálculos financieros, roles ni datos históricos.

## Pruebas preparadas

`test/frontend-clients.test.js` agrega 17 casos de interacción: doble envío,
cierre animado, rechazo/reintento, campos vacíos, cambio de negocio, cambio de
sesión, respuesta tardía, revocación del permiso, ausencia de negocio, solo
lectura y búsqueda en Finalizados por cada campo/con y sin coincidencias.

Antes de la corrección: 14 casos iniciales, 3 aprobados y 11 fallidos. Después:
17 casos aprobados y suite de frontend completa de 86 aprobados. El workflow
existente incorpora automáticamente este archivo en `npm test`.

La regresión completa usa PostgreSQL 17 descartable con Node 24 y 26. Se ejecuta
por los cambios presentes, no para repetir manualmente el cierre de 1/2. El
informe de ejecución identifica sus resultados y el commit desplegado.

Para completar la reorganización, la matriz deberá comprobar administrador,
cliente de solo lectura, vendedor, cobrador, lector de comprobantes y permisos
mixtos entre negocios; datos compartidos y operaciones aisladas; estados vacíos,
errores, respuesta tardía y navegación móvil; integridad financiera sin cambios.

## Definiciones que no se pudieron recuperar

1. **Alcance de modificación de la identidad compartida.** No se especifica si
   Etapa 3 debe agregar edición de datos personales, vincular clientes existentes
   a otros negocios o resolver/fusionar duplicados; tampoco quién podría hacerlo
   ni cómo afectarían esos cambios a negocios compartidos. Son comportamientos
   distintos, no simples elecciones visuales. No se implementan por suposición.
2. **Información operativa dentro de la ficha.** Pront distingue datos de una
   operación de finanzas globales, pero no define qué bloques de la nueva ficha
   debe ver cada perfil sin dashboard financiero. La base validada mantiene sus
   permisos; no se amplía acceso para completar una pantalla.
3. **Criterio funcional de cierre de Etapa 3.** Falta precisar si basta centralizar
   consultas y accesos ya existentes o si las modificaciones anteriores forman
   parte de esta etapa. Contratos, automatizaciones y correcciones de crédito no
   se adelantan desde sus etapas futuras.

Para resolverlo basta recuperar el fragmento original de requisitos, o definir
esas tres reglas de producto. No hace falta volver a autenticar las cuentas ni
repetir las pruebas manuales de Etapas 1 y 2.
