# Zilky — Informe final de Etapa 2

Fecha de verificación: 3 de octubre de 2026.
Base: copia de `ZILKY-ETAPA1-CORREGIDA.zip`. Etapa 1 conservada, sin nueva auditoría ni rediseño.

## Estado final

Etapa 2 implementada y validada localmente: backend, administración de empleados,
asignaciones/permisos por negocio, invitaciones, aceptación y frontend completo.
**172/172 pruebas aprobadas y 9/9 verificaciones de navegador aprobadas.**
La única validación externa pendiente es enviar y recibir un correo real con Resend,
usando credenciales válidas, remitente verificado y la URL pública definitiva.
No hubo deploy, conexiones a producción ni datos reales de producción.
No se comenzó Etapa 3 ni se modificó la semántica financiera de Etapa 1.

## Qué existía y qué faltaba

Ya existían rutas, repositorios y servicios de empleados e invitaciones, hash de token,
bcrypt, expiración de siete días, aceptación transaccional y restricciones de administradores.
La edición de asignaciones tenía validación y transacción. Se reutilizaron esas piezas.

Faltaban validación de negocios/permisos al aceptar, coordinación entre creación,
aceptación y regeneración concurrentes, regeneración atómica y filtrado de los campos
sensibles del listado. El email insertaba nombres sin escape y trasladaba errores del
proveedor a respuestas/logs. La pantalla mostraba solo invitaciones pendientes y el
invitado no podía verificar su invitación antes de crear contraseña.

## Correcciones e implementación

- Validación compartida de negocios existentes, IDs únicos, estructura de asignaciones,
  permisos reconocidos y valores booleanos. Rechazo de propiedades adicionales.
- Validación de email, nombre y contraseña. Contraseñas de al menos seis caracteres y
  hasta 72 bytes, evitando el truncamiento silencioso de bcrypt.
- Bloqueo transaccional por email, compartido por creación de empleado, invitación,
  aceptación, revocación y regeneración. Aceptación también bloquea la fila de invitación.
- Usuario, asignaciones, marca de uso y generación del JWT dentro de la misma transacción.
  Revalidación de todas las asignaciones inmediatamente antes de crear la cuenta.
- Regeneración transaccional: primero valida/crea; revoca todos los enlaces anteriores;
  cualquier fallo revierte los cambios. Se conserva el enlace anterior si la regeneración falla.
- Nuevas invitaciones guardan únicamente SHA-256 del token. Passwords con bcrypt.
  Las respuestas de consulta/listado no exponen token ni hash. El token nuevo solo se
  devuelve al administrador al crear/regenerar para ofrecer el enlace privado.
- Endpoint público de consulta de invitación, mensajes claros para inválida, usada,
  vencida o revocada y aceptación que no permite inyectar rol ni asignaciones.
- Email con contenido HTML escapado, alternativa de texto y errores genéricos sin
  secretos. Transporte inyectable para pruebas. Envío posterior al commit; un fallo de
  email conserva la invitación y ofrece enlace manual/reenvío en la interfaz.
- Pantalla de empleados: activos/inactivos, negocios y permisos actuales, editor de
  nombre y asignaciones, activación/desactivación e invitación multinegocio.
- Historial con los cuatro estados, revocación y regeneración/reenvío cuando corresponde.
  Prevención de doble envío mientras una solicitud está en curso.
- Invitado: consulta previa, email/negocios/vencimiento, creación de contraseña,
  sesión automática y retirada del token de la URL tras aceptar.
- Se conserva la protección backend de administradores y contra autoescalamiento.
  Los gestores empleados no pueden delegar permisos que no poseen ni negocios ajenos;
  las invitaciones siguen siendo exclusivas de administradores, igual que en la base.
- Se corrigió una carrera en el cierre de modales: un temporizador anterior ya no borra
  el nuevo modal con el enlace de invitación. Prueba de regresión específica incluida.

## Pruebas ejecutadas

Entorno: Node.js 24.19.0, npm 11.9.0, PostgreSQL 16.15 local, Chromium 134 con Playwright 1.51.1.
Bases descartables separadas: `zilky_stage2_test` y `zilky_browser_test`.

| Grupo | Resultado |
| --- | --- |
| 17 pruebas financieras originales | 17 aprobadas |
| 76 pruebas de Etapa 1 (seguridad, scope, datos y atomicidad) | 76 aprobadas |
| 11 pruebas de frontend del checkpoint anterior | 11 aprobadas |
| 53 pruebas nuevas de backend/seguridad/email de Etapa 2 | 53 aprobadas |
| 15 pruebas nuevas de frontend de Etapa 2 | 15 aprobadas |
| Suite completa `npm test` | **172 aprobadas; 0 fallidas; 0 omitidas; 0 canceladas** |
| Flujos reales de navegador | **9 aprobados; 0 fallidos; 0 errores JavaScript** |
| `npm ci --cache /tmp/zilky-npm-cache` | **Código 0; 212 paquetes instalados** |
| Arranque mediante `npm start` | **OK; HTML HTTP 200; login local HTTP 200** |

Los 68 tests nuevos cubren aceptación, bcrypt, hash de token, tres negocios, permisos
independientes, vencimiento, revocación, regeneración, email duplicado, asignaciones
inválidas, desconocidas o duplicadas, revalidación al aceptar y solicitudes simultáneas.
También incluyen intentos de administrar/desactivar administradores, autoasignarse
negocios/privilegios, delegar permisos ajenos y usar permisos de Apple en Indumentaria.

Se inyectaron fallos mediante triggers PostgreSQL en la segunda asignación, al marcar
la invitación usada y al revocar el enlace anterior. Se compararon snapshots completos
antes/después para demostrar rollback de usuarios, asignaciones e invitaciones.
Los errores controlados en el log corresponden a esas pruebas negativas aprobadas.

Pruebas de navegador con backend real: login administrador; invitación desde UI;
regeneración; aceptación móvil y sesión; rechazo de reutilización; edición posterior;
desactivación/reactivación y JWT; revocación e historial; escritorio/móvil sin desborde.
Capturas revisadas a 1440×1050 y 390×844. Evidencia en `evidencia-etapa2/`.

## Archivos modificados

| Archivo | Motivo |
| --- | --- |
| `src/services/usuariosService.js` | Reutilizar validador compartido y rechazar campos adicionales al crear |
| `src/services/authService.js` | Consulta pública, validación y aceptación atómica coordinada por email |
| `src/services/invitacionesService.js` | Ciclo transaccional, estados y respuestas sin campos sensibles |
| `src/services/emailService.js` | Transporte comprobable, escape, texto y errores seguros |
| `src/routes/auth.js` | Ruta de consulta pública de invitación |
| `src/routes/invitaciones.js` | Validación estricta del cuerpo de creación |
| `public/app.js` | Flujo de empleados/invitaciones, permisos, estados y protección del modal |
| `public/index.html` | Datos y navegación del formulario de aceptación |
| `public/styles.css` | Asignaciones legibles y acciones adaptadas a móvil |
| `test/frontend.test.js` | Agregar al mock el nuevo endpoint de consulta previa, sin quitar regresiones |
| `README.md` | Uso, configuración y pruebas del nuevo checkpoint |

Agregados: `src/lib/asignaciones.js`, `src/lib/invitaciones.js`,
`test/stage2.test.js`, `test/frontend-stage2.test.js`, `test/browser-stage2.mjs`,
este informe, `MANIFIESTO-SHA256.txt` y los siete archivos de evidencia en `evidencia-etapa2/`.

`package.json` y `package-lock.json` se conservaron: ya estaban sincronizados y
`npm ci` funciona. No se alteraron migraciones, servicios financieros, rutas de pagos,
ventas, clientes, productos ni sus garantías. No se eliminó ningún archivo del checkpoint.

## Compatibilidad y pendientes reales

- Prueba real de Resend pendiente, como se autorizó si no había credenciales disponibles.
  Un proveedor que acepta el envío no garantiza que la casilla lo reciba: queda por
  verificar entrega, carpeta de spam y apertura del enlace público.
- npm informa avisos heredados de deprecación de `glob` y `whatwg-encoding`, además de
  una opción `http-proxy` propia del entorno. No impiden la instalación. No se cambiaron
  dependencias fuera de alcance ni se presenta este trabajo como una auditoría nueva de ellas.
- Compatibilidad PostgreSQL/Neon mantenida. Se probó PostgreSQL local, no una conexión a Neon.
- La migración legacy de Etapa 1 se mantiene intacta: conserva datos históricos. Si ya
  existía una columna `token`, no se borra; las nuevas invitaciones no escriben en ella
  y las respuestas HTTP la excluyen. No hubo backfill ni eliminación de datos.
- No hay bloqueos de implementación pendientes dentro de Etapa 2. La comprobación externa
  de email mencionada no se simuló como si hubiese sido un envío real.

## Uso del próximo checkpoint

Extraer el ZIP, ejecutar `npm ci`, configurar las variables de backend y una base propia.
Para una instalación nueva, ejecutar `npm run migrate` explícitamente antes de `npm start`.
Esta entrega no agrega migraciones sobre el checkpoint de Etapa 1.
Los comandos reproducibles de pruebas y la configuración de Resend están en `README.md`.
El ZIP excluye `node_modules`, `.env`, bases de datos y archivos temporales.
