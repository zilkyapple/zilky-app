# Zilky App — Checkpoint Etapa 2

Sistema multinegocio para ventas financiadas, clientes, cuotas, pagos, mora,
comprobantes y cobranza sobre PostgreSQL/Neon.

Esta copia cierra la Etapa 1: autorización backend por negocio y permiso,
desactivación efectiva de usuarios, integridad de `cliente_negocio`, transacciones
financieras atómicas y entrega inicial diferenciada. Completa la Etapa 2: empleados,
asignaciones por negocio e invitaciones. No incluye etapas posteriores.

## Instalación local

Requisitos: Node.js 22.5+ y una base PostgreSQL descartable o de desarrollo.

```bash
npm ci
cp .env.example .env
# completar DATABASE_URL y JWT_SECRET
npm run migrate
npm start
```

Las migraciones no se ejecutan automáticamente al iniciar el servidor. Esto evita
alterar una base por accidente; `MIGRATE_ON_START=true` sólo debe habilitarse de forma
explícita en un entorno controlado.

## Seguridad y scope

- El backend valida JWT, usuario activo, rol, permiso y negocio solicitado en cada
  operación protegida; el frontend sólo refleja esos permisos.
- Un empleado sin asignaciones no lista negocios. Un permiso en un negocio no habilita
  operaciones en otro. Los administradores conservan acceso total.
- Un empleado no puede administrar administradores ni elevar sus propios privilegios.
- Negocios, clientes, productos, ventas, pagos, cobranza, comprobantes, dashboards,
  historial y costos aplican el scope específico requerido.
- El seguimiento de cliente se modifica con `negocio_id` explícito y permiso
  `clientes.editar` en ese negocio.

## Integridad financiera

En **Más → Empleados y permisos → Editar permisos**, el administrador puede
habilitar **Editar cuotas** por empleado y negocio. Requiere también **clientes.ver**
en ese negocio. Al recargar la app, el empleado autorizado puede corregir importes y
vencimientos de cuotas pendientes desde la ficha del cliente. Debe indicar un motivo;
el historial conserva quién hizo el cambio y los valores anteriores. Este permiso no
habilita cambiar la compra o el anticipo, agregar o quitar cuotas, modificar cuotas
saldadas, perdonar mora ni anular ventas o pagos. Se puede revocar en el mismo lugar,
y el servidor comprueba el permiso en cada consulta y corrección.

En **Nueva venta**, **Fecha de compra** indica cuándo se hizo la operación y
**Fecha de la primera cuota** indica el vencimiento acordado. Son independientes:
una compra con entrega en junio puede empezar a pagar cuotas en julio. La comisión
generada usa la fecha de compra; si el negocio liquida por cobro, el importe
habilitado para liquidar sigue los pagos recibidos. Los cierres aprobados conservan
sus totales y las cargas tardías se ajustan en un período abierto.

En **Clientes → ficha → compra → Eliminar venta cargada por error**, o desde
**Más → Ventas**, el administrador puede corregir una venta duplicada. Antes de
confirmar se muestran los productos que vuelven al stock y los pagos registrados.
Por ejemplo: con ocho unidades, dos cargas dejan seis; eliminar una carga devuelve
una unidad y deja siete. La otra venta se conserva.

Esta opción corrige una carga que no correspondía a una venta ni a un cobro real.
Si hay pagos, exige confirmar que también fueron registros erróneos. Anula la
venta, sus cuotas y esos pagos, sin crear un reintegro ni saldo a favor ficticio.
Sólo repone stock que fue efectivamente descontado. Los originales y su auditoría
se conservan; los períodos de caja y las liquidaciones cerradas no se reescriben.
Los casos con devoluciones o ajustes financieros que requieren conciliación se
identifican antes de confirmar. Las devoluciones reales siguen en las opciones
avanzadas de la venta.

**Inicio** es el Dashboard. **Cobros previstos** aparece al principio de esa
pantalla, antes de los indicadores históricos. Es exclusivo del administrador, tanto en la
pantalla como en la API. Muestra capital pendiente de cuotas ya vendidas: este
mes, el siguiente, los próximos 7 y 14 días y meses posteriores, con navegación
hasta el último vencimiento registrado. Respeta el negocio seleccionado o suma
todos los negocios. Los meses sin cuotas muestran cero.
El selector de mes conserva el mes elegido y muestra su importe pendiente;
los accesos a uno, dos o tres meses permiten consultar esos ingresos directamente.

Los rangos de 7 y 14 días incluyen hoy, según la fecha de Argentina; el de 14 días
incluye el de 7. El mes actual incluye cuotas vencidas dentro de ese mes, cuyo
importe se identifica; los atrasos de meses anteriores se mantienen separados.
La proyección toma el saldo restante tras pagos parciales, anticipados y
devoluciones. Excluye ventas anuladas/devueltas y cuotas con estado manual, sin
sumar mora, entregas iniciales ni ventas futuras. Gestión especial o cobranza
pausada no eliminan deuda. Son cobros programados, no facturación fiscal ni una
garantía de ingreso.

- Venta, stock, vínculo cliente-negocio, crédito, cuotas, entrega inicial, comprobante
  y auditoría se confirman en una única transacción PostgreSQL.
- Pagos y anulaciones bloquean el crédito/cliente-negocio, son atómicos y mantienen
  auditoría; los pagos normales pueden anularse sin borrar el comprobante original.
- La entrega inicial se registra como pago `tipo='entrega_inicial'`: cuenta como
  cobrado, no se aplica otra vez a cuotas ni saldo financiado, y no se anula desde el
  flujo normal. El endpoint responde 409 con la indicación de que su corrección queda
  para la edición/auditoría del financiamiento de la Etapa 6.
- No se generan pagos retroactivos ni backfill de entregas históricas.

## Migraciones

### Corregir fechas y cuotas

Un administrador puede abrir **Clientes → ficha → Editar fechas y cuotas** en la
compra del negocio correspondiente. También hay un acceso **Editar cuota** en
cada cuota pendiente. Permite corregir la fecha de compra, los importes y los
vencimientos pendientes, y registrar o corregir la fecha en que el cliente recibió
o retiró el producto (celular, ropa u otro artículo). Esta última fecha es opcional
y se guarda separada del anticipo de dinero; las ventas anteriores quedan sin fecha
física hasta que se complete el dato. Vaciar el campo borra una fecha mal cargada.

En **Historial de incidencias**, **Corregir fecha** permite corregir la entrega
voluntaria del equipo por el cliente o el retiro por falta de pago. Conserva el
hecho, su motivo y su responsable originales. Cada corrección registra motivo,
responsable y valores anteriores/nuevos; las versiones evitan pisar otros cambios.

Las cuotas saldadas y los pagos se conservan. Las cuotas con pagos, mora o contactos
no pueden quitarse del plan. Corregir un vencimiento conserva la mora ya generada;
si también hubo un error en ese importe, se revisa con **Perdonar mora**. No hace
falta eliminar al cliente para corregir una compra. La eliminación sigue reservada
a fichas sin actividad en ninguno de sus negocios.

La migración agrega `creditos.fecha_entrega_producto` como texto opcional sin
completar fechas históricas ni cambiar pagos, stock o deudas existentes. Se aplica
con el comando de migración habitual antes de ejecutar la versión nueva.

### Corregir la fecha del dinero recibido

En **Clientes → ficha → Historial de pagos → Corregir fecha del pago**, un
administrador puede corregir la fecha y hora reales del pago, incluida la entrega
inicial. Se usa la hora de Argentina. El importe y el medio de pago se conservan;
se exige un motivo y una vista previa antes de confirmar.

Para pagos de cuotas puede optarse por reconstruir la aplicación a capital y mora
en orden cronológico. La vista previa muestra los saldos anteriores y nuevos, las
cuotas afectadas y cualquier adopción de reglas actuales para pagos históricos sin
configuración registrada. Los cambios contractuales, las devoluciones, las cuotas
con estado manual, la mora perdonada o un cambio conocido de reglas requieren
conciliación para recalcular; sigue disponible corregir solamente la fecha.

No se registra dinero nuevo ni se modifica una caja cerrada. Se conservan los pagos
y los comprobantes originales; cuando corresponde se emite un reemplazo vinculado.
El historial permite consultar el motivo, el responsable y las fechas anteriores.
Una versión evita pisar cobros concurrentes y los reintentos no duplican cambios.

Los pagos nuevos conservan su destino y configuración de mora. Al cargar uno
anterior a otro ya registrado se reconstruye la secuencia si se conocen esas
reglas; los registros anteriores requieren revisar y confirmar la vista previa.
Editar documentación o un plan sin pagos ya no guarda como deuda fija la mora
estimada al día de hoy. Los saldos existentes se corrigen sólo mediante la revisión
explícita del administrador. La migración agrega campos de seguimiento a `pagos`
sin cambiar fechas ni importes históricos.

Los parches son aditivos y usan `IF NOT EXISTS`. La migración de invitaciones conserva
la columna/token legacy y crea/usa `token_hash`; si encuentra registros sin hash se
detiene antes de cambiar restricciones. Se agrega `pagos.tipo` con valor `cuota` y un
índice único parcial para entregas iniciales. No se borra información existente.

## Pruebas

La suite requiere una base local cuyo nombre termine en `_test`; se rechazan URLs que no
sean localhost/127.0.0.1 para evitar ejecutar truncados contra producción.

```bash
TEST_DATABASE_URL="postgresql://usuario:pass@127.0.0.1:5432/zilky_stage2_test" npm test
```

La corrida de entrega pasó **172/172 tests**: 104 regresiones del checkpoint anterior
(incluidas las 17 financieras originales) y 68 pruebas nuevas de Etapa 2.
También pasaron **9/9 verificaciones E2E en Chromium**, con viewport de escritorio y móvil.
Ver `INFORME-ETAPA2.md` y `evidencia-etapa2/` para resultados y capturas.

## Empleados e invitaciones

Desde **Más → Empleados y permisos**, un administrador puede invitar, consultar y
editar empleados, asignar varios negocios con permisos diferentes y activar/desactivar
cuentas. El historial muestra invitaciones pendientes, usadas, vencidas y revocadas.
Regenerar y reenviar invalida todos los enlaces anteriores de ese email. Las invitaciones
vencen en 7 días, se usan una sola vez y crean usuarios de rol empleado.

Los empleados con `empleados.gestionar` solo gestionan otras cuentas de empleado
completamente comprendidas en su scope. No pueden administrar administradores ni
modificarse a sí mismos, ni delegar permisos que no poseen. El flujo de invitaciones
sigue reservado a administradores, como en el checkpoint previo.

### Email con Resend

Configurar únicamente en el backend:

- `RESEND_API_KEY`: credencial real de Resend (nunca incluirla en código ni frontend).
- `RESEND_FROM`: remitente/dominio autorizado y verificado en Resend.
- `APP_BASE_URL`: URL pública de la app, por ejemplo `https://tu-dominio.example/`.

La invitación queda confirmada en la base antes de enviar el email. Un fallo del
proveedor no borra la invitación: la pantalla informa el fallo y permite copiar el enlace
para compartirlo de forma privada o regenerarlo y reenviarlo. El enlace solo se muestra
al crear/regenerar; no se puede reconstruir a partir del hash guardado.

Se probaron localmente la composición del email y los errores con un transporte simulado.
**Queda pendiente comprobar recepción real en una casilla con credenciales y remitente
verificados.** El ZIP no contiene credenciales ni envía emails durante las pruebas.

### Navegador real (prueba adicional)

`test/browser-stage2.mjs` requiere Playwright/Chromium instalado por separado y otra
base **local descartable**, cuyo nombre termine en `_test`. Vacía las tablas de esa base.
No ejecutarlo contra una base con datos a preservar.

```bash
TEST_DATABASE_URL="postgresql://usuario:pass@127.0.0.1:5432/zilky_browser_test" \
PLAYWRIGHT_MODULE="/ruta/al/playwright/index.mjs" \
node test/browser-stage2.mjs
```

Opcionales: `CHROMIUM_EXECUTABLE` para un binario de Chromium existente y
`BROWSER_ARTIFACTS` para elegir dónde guardar las capturas/resultados (por defecto `/tmp/zilky-stage2-browser`).
No se agrega Playwright como dependencia necesaria para ejecutar Zilky ni la suite habitual.

`test/browser-fechas-cuotas.mjs` usa las mismas variables y restricciones de base
local descartable para comprobar el editor de fechas y cuotas en escritorio y
móvil, la persistencia al recargar, las cuotas saldadas, las fechas de incidencias
y el aislamiento de pagos y negocios. Sus capturas y `resultado.json` se guardan
en `BROWSER_ARTIFACTS` (por defecto `/tmp/zilky-fechas-browser`).

## Fuera de alcance de esta entrega

Etapa 3 y posteriores: clientes reorganizados, cobranza avanzada, WhatsApp Cloud API,
edición de créditos, caja, contratos y exportaciones.

## Estructura

```text
src/
  db/            conexión y migraciones PostgreSQL
  lib/           auth, fechas, mora, validación y auditoría
  middleware/    autenticación y autorización por scope
  repositories/  persistencia de negocios, clientes, créditos, cuotas, pagos, etc.
  services/      ventas, pagos, comprobantes, dashboard, usuarios e invitaciones
  routes/        endpoints API
public/          frontend HTML/CSS/JS y DOMPurify vendorizado
test/            regresiones, seguridad, atomicidad y frontend
```

