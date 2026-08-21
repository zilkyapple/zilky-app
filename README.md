# Zilky App — Etapa 3 (multinegocio con clientes globales)

Sistema para administrar ventas financiadas, clientes, pagos parciales, cuotas, mora,
comprobantes, cobranzas, calendario y múltiples negocios (Zilky Apple + Zilky
Indumentaria + los que agregues), con login propio y base de datos en Postgres.

## 1. Instalación local

Requisitos: **Node.js 22.5+** y **una base Postgres** (local o directamente Neon).

```bash
cd zilky-app
npm install
cp .env.example .env      # completá DATABASE_URL y JWT_SECRET
npm run migrate
npm run seed               # opcional: datos de ejemplo
npm start
```

## 2. Resumen de lo implementado en esta etapa

- **Clientes globales**: un mismo cliente (nombre+apellido obligatorios; DNI, teléfono
  e Instagram opcionales) puede comprar en varios negocios sin duplicarse. Lo que SÍ
  queda estrictamente aislado por negocio son las ventas, créditos, cuotas, pagos,
  comprobantes, mora, cobranza, calendario y dashboards — todo filtrado por
  `negocio_id` en el backend, no sólo ocultado en la pantalla.
- **Atraso histórico real**: cada cuota guarda `dias_atraso_al_pagar` en el momento en
  que se termina de pagar. Si el cliente pagó tarde, ese dato queda para siempre aunque
  el estado pase a "pagada" — no se pierde para analizar riesgo más adelante.
- **Comprobantes internos**: cada pago genera automáticamente un comprobante con
  numeración única real (`ZLK-YYYYMMDD-NNNNNN`, usando una secuencia de Postgres, así
  que nunca se repite ni con escrituras simultáneas). Anular un comprobante NO lo edita:
  lo marca como anulado (motivo, quién, cuándo), revierte el saldo de las cuotas
  afectadas, y el comprobante original queda intacto para trazabilidad.
- **Cobranzas** reorganizada: Hoy / Próximas (ventana configurable: 3, 5, 7 días o la
  que quieras) / Vencidas / Todas. Cada cuota muestra número de cuota (ej: "3/6").
- **Calendario mensual**: por día, cantidad de vencimientos y monto a cobrar; tocás un
  día y ves quién vence.
- **Clientes finalizados**: por negocio, quiénes ya no tienen deuda ahí pero sí
  compraron — con estados de seguimiento comercial (contactado / no interesado / volver
  a contactar).
- **Historial financiero del cliente**: compras, cuotas totales/pagadas/a tiempo/tarde,
  deuda actual, total cobrado, atraso promedio y máximo, última compra/pago — filtrable
  por negocio o consolidado.
- **Seguridad**: toda consulta de ventas/cuotas/pagos/comprobantes/dashboard exige y
  valida `negocio_id` en el backend (antes de esta etapa, la lista de clientes no
  filtraba nada en el servidor; ya está corregido). Contraseñas con bcrypt, sesión con
  JWT, `DATABASE_URL`/`JWT_SECRET` sólo por variables de entorno, nunca en el código.
- Todo lo de etapas anteriores sigue intacto: login, stock opcional no bloqueante,
  creación de negocios, recordatorios de WhatsApp configurables (semi-automáticos, sin
  API paga), mora con 7 días de gracia, distribución automática de pagos.

## 3. Cambios de base de datos (todos no-destructivos, con `IF NOT EXISTS`)

- `clientes`: + `instagram`, + `seguimiento_estado`, + `seguimiento_fecha`, + `seguimiento_nota`
- `cuotas`: + `dias_atraso_al_pagar`
- Tabla nueva `comprobantes` + secuencia `comprobantes_seq` para la numeración única
- Ninguna columna ni tabla existente se borró ni se modificó de forma destructiva

## 4. Tests: 17/17 ✔

Los 4 casos originales del motor financiero + 13 nuevos, incluyendo el que prueba
exactamente el escenario de aislamiento (mismo cliente comprando en dos negocios,
cada dashboard ve sólo lo suyo):

```bash
TEST_DATABASE_URL="postgresql://usuario:pass@host:5432/basededatos_test" npm test
```

## 5. Pendiente real (no implementado, para no fingir que algo funciona sin backend)

- Permisos por rol (hoy cualquier cuenta logueada ve todos los negocios).
- Contratos en PDF con firma.
- Módulo de caja completo.
- Exportaciones a Excel/CSV/PDF.
- Recuperar contraseña olvidada.
- Refinanciación de créditos (el estado existe en el modelo, falta el flujo).

## 6. Desplegar la actualización en Render/Neon sin perder datos

1. Subí estos archivos actualizados a tu mismo repositorio de GitHub (reemplazando los
   anteriores — podés arrastrar y soltar de nuevo desde "Add file → Upload files").
2. Render va a redesplegar solo. El **Build Command** ya incluye `npm run migrate`, así
   que las columnas y tablas nuevas se crean automáticamente contra tu misma base de
   Neon — no se toca ni se borra ningún dato existente.
3. No hace falta correr `npm run seed` de nuevo (sólo agrega datos si la base está
   vacía; si ya tenés negocios cargados, no hace nada).
4. Nada de tu login ni tus negocios/clientes/ventas actuales se pierde: las migraciones
   son aditivas.

## 7. Estructura del proyecto

```
src/
  db/            migrate.js, seed.js, connection.js (Postgres)
  lib/           money.js, dates.js, mora.js (motor financiero puro), auth.js
  middleware/    requireAuth.js
  repositories/  negocios, clientes, productos, creditos, cuotas, pagos, usuarios, comprobantes
  services/      authService, ventasService, pagosService, dashboardService, comprobantesService
  routes/        auth, negocios, clientes, productos, ventas, pagos, dashboard, comprobantes
public/          frontend (HTML/CSS/JS plano) — Inicio, Clientes, Cobrar, Calendario,
                 Ventas, Productos, Comprobantes, Configuración, Más
test/            17 tests del motor financiero y las reglas de negocio
```

## 8. Endpoints nuevos de esta etapa

```
GET    /api/clientes/finalizados?negocio_id=...
PATCH  /api/clientes/:id/seguimiento
GET    /api/dashboard/calendario?negocio_id=...&mes=YYYY-MM
GET    /api/dashboard/calendario/dia?negocio_id=...&fecha=YYYY-MM-DD
GET    /api/comprobantes?negocio_id=...&cliente_id=...
POST   /api/comprobantes/:id/anular   { motivo }
GET    /api/dashboard/cobranza?negocio_id=...&ventana_dias=7
```
