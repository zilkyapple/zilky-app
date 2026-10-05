# Ampliación confirmada: Gestión especial (04/10/2026, 21:13–21:14 ART)

- La clasificación es **manual**, por cliente y negocio. No hay umbral de atraso ni proceso que envíe personas automáticamente a esta sección.
- El administrador puede pasar a Gestión especial y volver a cobranza normal. El empleado puede consultar antecedentes; registrar seguimiento requiere clientes.ver, clientes.editar y cobranzas.ver en el mismo negocio. No se delega la reclasificación sin una regla expresa.
- Cobrar conserva Hoy, Próximas, Vencidas, Gestión especial y Todas. Gestión especial agrupa por persona/negocio; Todas conserva las cuotas identificadas. Se excluye de recordatorios y calendario de gestión diaria, nunca del saldo financiero del administrador ni de la ficha.
- Entradas, salidas y seguimientos se conservan con fecha, responsable, motivo/resultado, deuda/capital/mora del momento y próxima fecha de contacto. No se borran después de pagar o volver a normal. La deuda original del evento es una fotografía, no el saldo actual.
- Los pagos y anulaciones mantienen su flujo normal. Registrar una clasificación no cambia pagos, cuotas, mora ni stock. Saldar una cuenta quita sus obligaciones de las listas pendientes; su antecedente sigue en la ficha y la clasificación solo cambia por decisión manual.
- Seguimiento mensual sugerido con fecha editable. Mensaje personalizado editable que abre WhatsApp; no envía automáticamente ni declara que un mensaje se envió. El usuario registra manualmente el resultado del contacto.
- Identificador de solicitud y bloqueo transaccional evitan duplicar eventos en reintentos/doble envío. Clasificación, historial y auditoría se confirman juntos.
- Esta sección muestra hechos y notas registrados; no crea listas negras, decisiones automáticas de crédito ni nuevas reglas de financiación.

# Etapa 3 — requisitos recuperados y preparación

Fecha: 4 de octubre de 2026. Base estable: `f0c4ffb5d2cfce39c958db5fa509b1c48c81836a`.

## Ampliación explícita del usuario — 04/10/2026, 20:42–20:48 ART

Esta definición reemplaza las restricciones anteriores de finanzas individuales
que se describen históricamente más abajo. No reabre por suposición otras reglas.

- `clientes.ver` permite consultar operaciones, producto adquirido, entrega,
  financiación, cuotas, deuda, vencimientos, atrasos, pagos y comprobantes de ese
  cliente en los negocios autorizados. No requiere dashboard financiero.
- Dashboard/resumen y listado general de comprobantes son exclusivos del
  administrador, incluso ante permisos antiguos de empleado. El empleado consulta
  comprobantes de un cliente y negocio explícitos. La anulación sigue requiriendo
  su permiso separado; la lectura no concede escritura.
- Cobranzas y calendario requieren clientes.ver + cobranzas.ver en el mismo
  negocio. Ofrecen los detalles operativos individuales; no entregan acumulados
  monetarios por día/negocio ni los calculan para mostrarlos en la UI del empleado.
- La aplicación no ofrece un endpoint alternativo de totales. Autorizar importes
  individuales implica que una persona podría sumarlos por su cuenta: no se puede
  garantizar impedir esa inferencia matemática sin quitar los datos operativos
  expresamente solicitados. No se presenta esa imposibilidad como garantía.
- Ropa puede operar con entrega inicial y un único saldo a plazo; productos
  financiados pueden usar varias cuotas. Se reutilizan las modalidades existentes,
  sin reglas basadas en nombres de negocios ni obligación de usar múltiples cuotas.
- Cada negocio puede habilitar `seguimiento_equipos`; empieza desactivado y solo
  el administrador puede configurarlo. El historial de pagos/cumplimiento sirve
  en todos los negocios. La ficha muestra porcentaje de cuotas pagadas a tiempo
  del cliente, con denominador cuotas pagadas; no inventa un índice global de
  personas cumplidoras ni una ventana temporal para ese indicador.

### Registro histórico e integridad

Migración aditiva: negocios.seguimiento_equipos + credito_incidencias. La migración
es repetible; no elimina datos ni reconstruye hechos históricos desconocidos.

Venta: registra al día o finalización al contado. Pago: conserva la aparición de
atraso observada antes de aplicarlo, regularización y finalización. Si se cancela
todo antes del último vencimiento, registra cancelación anticipada; de lo contrario,
finalización correcta. Anulación: agrega pago anulado y conserva todos los eventos.
El atraso actual se calcula desde cuotas/vencimientos; no hay un cron nuevo ni se
afirma haber registrado eventos durante intervalos históricos sin observaciones.
El historial anterior de atrasos pagados sigue visible desde las cuotas existentes.

Las incidencias de entrega voluntaria/retiro por falta de pago registran fecha,
motivo, autor y fecha de registro. Son anexos a la operación, de solo agregado,
con idempotencia por solicitud y auditoría transaccional. El administrador registra
estos hechos; los empleados autorizados los consultan. Deshabilitar equipos no
borra los hechos guardados. Los eventos no alteran cuotas, pagos, deuda ni stock.

El mensaje del usuario quedó cortado después de «fecha; motivo;». Sigue pendiente
recibir su continuación, especialmente si entrega/retiro debe tener consecuencias
financieras o de inventario, si debe registrar otros campos y si el empleado debe
poder registrarlo. Esas consecuencias no se presuponen ni se ejecutan.

Pruebas: ampliación HTTP/PostgreSQL en test/stage3.test.js, UI en
test/frontend-client-file.test.js y regresiones de atomicidad de incidencias en
test/stage1.test.js. Solo se sustituyen expectativas que contradicen la corrección
explícita de permisos. El resto de Etapas 1/2 debe seguir pasando sin cambios.

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

## Ficha central: consulta implementada con reglas existentes

La parte de consulta y organización no depende de resolver nuevas facultades de
edición. Se implementó sobre los contratos ya validados:

- Cabecera y contexto de negocio visibles; regreso a la lista y selector limitado
  a negocios con `clientes.ver`.
- Secciones plegables y accesibles para datos personales existentes, seguimiento
  comercial, historial financiero, financiaciones/cuotas e historial de pagos.
- Datos y notas escapados; estado explícito cuando faltan datos. No se agrega
  edición de identidad global ni se cambia el alcance del seguimiento comercial.
- Historial de pagos completo recibido del backend, sin el corte anterior de 12;
  se conservan entrega inicial, pagos anulados y montos del motor existente.
- Acceso desde la ficha a comprobantes filtrados por cliente y negocio. Requiere
  `clientes.ver` y `comprobantes.ver` en el mismo negocio; la vista global exige
  elegir negocio. No concede anulación ni permiso financiero por consultar.
- La ficha sin historial financiero sigue mostrando la denegación aprobada y no
  precarga operaciones restringidas. Contratos y comunicaciones quedan reservados
  a sus etapas; no se agregan botones sin función.

El modelo y endpoints existentes sostienen esas relaciones; no requieren
migración. La separación de secciones permite incorporar las etapas posteriores
sin cambiar la identidad del cliente ni duplicar movimientos.

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

`test/frontend-client-file.test.js` agrega 12 pruebas de la ficha: lectura sin
finanzas, escape de datos/notas, negocios autorizados, permisos separados y
mixtos, vista global, estados vacíos, historial mayor a 12, filtro de comprobantes,
acceso directo denegado y separación entre lectura y anulación.

`test/client-file.test.js` añade 3 pruebas HTTP reales sobre PostgreSQL descartable:
filtro simultáneo cliente/negocio con otro cliente en el mismo negocio y una
identidad compartida en otro; denegación de comprobantes del otro negocio; y
separación entre lectura, historial financiero y anulación sin mutaciones.

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
