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
