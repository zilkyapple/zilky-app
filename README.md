# Zilky App — Etapa 2 (online, con cuenta, multi-dispositivo)

Sistema para administrar ventas financiadas, clientes, pagos parciales, cuotas, mora,
productos/stock y múltiples negocios (Zilky Apple + Zilky Indumentaria, con posibilidad
de agregar más).

Desde esta etapa la app **corre contra una base de datos Postgres real** (no un archivo
local) y **tiene login con email y contraseña**, así que se puede desplegar en internet
con una dirección propia y usar exactamente igual desde el iPad, una PC, un iPhone o un
Android — todo guardado en un solo lugar, no en el dispositivo.

## 1. Instalación local (para desarrollo/pruebas en tu compu)

Requisitos: **Node.js 22.5 o superior** y **una base de datos Postgres** (puede ser una
local, o directamente la de Neon que vas a usar en producción — ver sección 2).

```bash
cd zilky-app
npm install
cp .env.example .env      # completá DATABASE_URL y JWT_SECRET (ver abajo)
npm run migrate           # crea las tablas
npm run seed               # (opcional) carga los 2 negocios + clientes/productos de ejemplo
npm start
```

Abrí `http://localhost:3000`. La primera vez te va a pedir crear una cuenta (email +
contraseña) — es tuya, queda guardada en la base de datos.

### Variables de entorno (`.env`)

| Variable | Qué hace |
|---|---|
| `PORT` | Puerto del servidor (Render lo define solo en producción) |
| `DATABASE_URL` | String de conexión a Postgres, ej: `postgresql://usuario:pass@host:5432/basededatos` |
| `JWT_SECRET` | Texto largo y secreto para firmar las sesiones. Generá el tuyo con: `node -e "console.log(require('crypto').randomUUID())"` |

## 2. Ponerla online (para usarla desde iPad, PC, iPhone y Android con cuenta)

Esto se hace en dos partes, **enteramente desde el navegador, sin instalar nada ni usar
la terminal** (sirve incluso si sólo tenés el iPad a mano).

### Parte A — la base de datos (Neon, gratis)

1. Entrá a **neon.tech** y creá una cuenta (con email, Google o GitHub).
2. Creá un proyecto nuevo (nombre, región más cercana, versión de Postgres — dejá la
   que venga por defecto).
3. En el dashboard del proyecto, tocá **"Connect"** y copiá el connection string. Si te
   muestra dos (uno dice "pooled" y otro no), usá el que **no** dice "pooled" — esta
   app ya maneja su propio pool de conexiones. Guardalo, lo necesitás en la Parte B.

### Parte B — el código y el despliegue (GitHub + Render, gratis)

1. Entrá a **github.com**, creá una cuenta si no tenés, y creá un repositorio nuevo
   (puede ser privado). Por ejemplo `zilky-app`.
2. En la página del repo, buscá la opción para subir archivos directamente (en el botón
   **"Add file" → "Upload files"**, o el enlace "uploading an existing file" que aparece
   en un repo vacío). Arrastrá **el contenido** de la carpeta `zilky-app` del zip que te
   pasé — no hace falta `node_modules` ni la carpeta `data`. Confirmá el commit.
3. Entrá a **render.com**, creá una cuenta (podés entrar directo con GitHub).
4. **"New" → "Web Service"**, conectá el repositorio que acabás de crear.
5. Configurá:
   - **Build Command**: `npm install && npm run migrate`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
6. En **"Environment Variables"** agregá:
   - `DATABASE_URL` → el connection string de Neon (Parte A)
   - `JWT_SECRET` → cualquier texto largo y secreto que inventes
7. **"Create Web Service"**. Esperá unos minutos a que termine de compilar.
8. Render te da una dirección propia (algo como `https://zilky-app.onrender.com`). Esa
   URL es la que abrís desde cualquier dispositivo — ahí creás tu cuenta y ya queda todo
   guardado en Neon, accesible desde donde sea.

**Dos cosas a tener en cuenta con los planes gratis** (no son errores, son así):
- Render "duerme" el servicio después de 15 minutos sin uso: la primera vez que alguien
  entra después de eso, tarda 30-60 segundos en despertar.
- Neon también "pausa" la base tras un rato sin uso; el primer request después de eso
  tarda un poco más de lo normal. El resto del tiempo anda a velocidad normal.
- Si más adelante esto se vuelve crítico para el día a día del negocio, existen planes
  pagos en ambos servicios (unos dólares por mes) que sacan esos límites — no hace falta
  ahora para probarlo.

Para cargar los datos de ejemplo en producción: en Render, abrí la pestaña **"Shell"**
del servicio y corré `npm run seed` (opcional — también podés arrancar directo con tus
clientes reales).

Cada vez que quieras actualizar la app (cuando sigamos con las próximas etapas), subís
los archivos nuevos a ese mismo repositorio de GitHub y Render redespliega solo.

## 3. Qué quedó funcionando en esta etapa

- **Cuentas de usuario**: registro y login con email y contraseña (con contraseña
  encriptada, nunca guardada en texto plano). La sesión se guarda en cada dispositivo,
  así que no hay que loguearse cada vez.
- **Base de datos Postgres real**, no un archivo local: los datos están accesibles desde
  cualquier dispositivo, no atados a una sola compu.
- **Multiempresa real**: cada negocio tiene su config, clientes, productos, ventas y
  créditos separados, con vista consolidada en el dashboard.
- **Motor financiero** (ver tests en la sección 5):
  - Modalidad **libre** (indumentaria: pagos parciales sin monto fijo, con fecha límite).
  - Modalidad **cuotas** (Apple: cuotas mensuales que aceptan pagos parciales que se van
    acumulando hasta completar la cuota vigente).
  - Modalidad **único** (pago único con fecha límite).
  - **Vencimiento + 7 días de gracia + mora recién desde el día 8**, calculada
    dinámicamente.
  - Interés moratorio configurable por negocio (%, fijo, por día/semana/mes, sobre saldo
    vencido o sobre el total, simple o acumulativo).
  - Distribución automática de cada pago: mora vencida primero, después capital de la
    cuota más antigua, con el excedente pasando a la siguiente cuota o a saldo a favor.
- **Clientes**: alta rápida, detección de duplicados por DNI/teléfono, perfil único
  compartido entre negocios con deuda separada y consolidada.
- **Productos y stock** por negocio, con descuento automático al vender.
- **Dashboard** general y por negocio, **cobranza** agrupada por vencimiento/atraso,
  **perfil de riesgo** básico por cliente, y botón de **WhatsApp** con mensaje prearmado.
- Interfaz mobile-first: navegación inferior, botón flotante "+", diseño oscuro con
  acento de color que cambia según el negocio elegido.

## 4. Qué queda para las próximas etapas

- **Permisos por rol**: hoy cualquiera que tenga una cuenta ve todo el negocio. Falta
  diferenciar administrador / vendedor / cobrador / solo lectura, como pide el spec
  original.
- Contratos en PDF con firma.
- Módulo de caja completo (ingresos/egresos/transferencias entre cajas, cierre diario).
- Auditoría visible desde la interfaz (la tabla ya existe en la base, falta la pantalla).
- Módulo "Estado del negocio" completo (balance general, rentabilidad, PAR 30/60/90,
  proyecciones) — hoy sólo está el dashboard resumido.
- Exportaciones a Excel/CSV/PDF.
- Envío automático de recordatorios (hoy es manual, se aprieta un botón).
- Refinanciación de créditos (el estado existe en el modelo de datos, falta el flujo).
- Recuperar contraseña olvidada (hoy si alguien pierde la contraseña no hay forma de
  resetearla desde la app; se puede hacer a mano en la base mientras tanto).

Decime cuál de estos te urge más y seguimos por ahí.

## 5. Tests automáticos

Los 5 casos del spec original están como tests automáticos, corriendo contra un
Postgres real (por defecto uno local; se puede apuntar a otro con `TEST_DATABASE_URL`):

```bash
TEST_DATABASE_URL="postgresql://usuario:pass@host:5432/basededatos_de_test" npm test
```

Importante: los tests **truncan las tablas** de la base a la que apunten antes de
correr — nunca los corras contra tu base de producción con datos reales.

## 6. Estructura del proyecto

```
src/
  db/            migrate.js (esquema), seed.js (datos de ejemplo), connection.js (Postgres)
  lib/           money.js (centavos), dates.js (huso horario AR), mora.js (motor financiero puro), auth.js (JWT)
  middleware/    requireAuth.js (exige sesión válida)
  repositories/  una función por entidad, consultas SQL directas
  services/      authService, ventasService, pagosService, dashboardService
  routes/        /api/auth, /api/negocios, /api/clientes, /api/ventas, /api/pagos, /api/dashboard, /api/productos
  app.js/server.js
public/          frontend (HTML/CSS/JS plano, sin build step) + pantalla de login
test/            tests del motor financiero
```

### Por qué estas decisiones técnicas

- **Postgres** en vez de un archivo local: es lo que permite que la misma información
  se vea desde el iPad, la PC y el celular a la vez, y lo que hace posible desplegar en
  un servicio como Render.
- **JWT + bcrypt** para las cuentas, en vez de depender de un servicio externo de login:
  todo el código de autenticación queda en este mismo proyecto, sin atarte a un tercero.
- **Plata en centavos (enteros)**, nunca en decimales, para evitar errores de redondeo.
- **Estados calculados al vuelo** (nunca guardados como "verdad congelada"): así el
  dashboard y la cobranza siempre reflejan la fecha de hoy.
- **Frontend sin build step**: HTML/CSS/JS directo sin React/Vite, para que instalar sea
  literalmente `npm install && npm start` sin pasos intermedios.

## 7. Endpoints principales

```
POST   /api/auth/registro        { email, password, nombre }
POST   /api/auth/login           { email, password }
GET    /api/auth/yo              (requiere sesión)

GET    /api/negocios
POST   /api/negocios
PATCH  /api/negocios/:id

GET    /api/clientes?q=texto
POST   /api/clientes
GET    /api/clientes/:id

GET    /api/productos?negocio_id=...
POST   /api/productos

POST   /api/ventas
POST   /api/pagos

GET    /api/dashboard/resumen?negocio_id=...
GET    /api/dashboard/cobranza?negocio_id=...
```

Todos los endpoints salvo `/api/auth/*` requieren el header `Authorization: Bearer <token>`
que te devuelve el login.
