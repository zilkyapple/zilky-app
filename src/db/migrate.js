import { db, pool } from './connection.js';
import { createHash } from 'node:crypto';

const schema = `
CREATE TABLE IF NOT EXISTS organizaciones (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  plan TEXT DEFAULT 'basico',
  activa INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  nombre TEXT,
  rol TEXT DEFAULT 'administrador',
  activo INTEGER DEFAULT 1,
  invitacion_completada INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS usuario_organizacion (
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  organizacion_id TEXT NOT NULL REFERENCES organizaciones(id),
  rol TEXT DEFAULT 'administrador',
  activo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (NOW()::text),
  PRIMARY KEY (usuario_id, organizacion_id)
);

CREATE TABLE IF NOT EXISTS negocios (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  nombre TEXT NOT NULL,
  color TEXT DEFAULT '#10B981',
  logo_url TEXT,
  moneda TEXT DEFAULT 'ARS',
  dias_gracia INTEGER DEFAULT 7,
  mora_tipo TEXT DEFAULT 'porcentaje',
  mora_valor REAL DEFAULT 2,
  mora_periodo TEXT DEFAULT 'semana',
  mora_base TEXT DEFAULT 'saldo_vencido',
  mora_acumulativa INTEGER DEFAULT 0,
  orden_aplicacion_pago TEXT DEFAULT '["mora","capital"]',
  recordatorio_dias TEXT DEFAULT '[7,3,1,0]',
  cobranza_modo_negocio TEXT DEFAULT 'revisar',
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  nombre TEXT NOT NULL,
  apellido TEXT,
  telefono TEXT,
  whatsapp TEXT,
  instagram TEXT,
  dni TEXT,
  direccion TEXT,
  ciudad TEXT,
  provincia TEXT,
  fecha_nacimiento TEXT,
  trabajo TEXT,
  frecuencia_pago TEXT,
  foto_url TEXT,
  notas TEXT,
  seguimiento_estado TEXT,
  seguimiento_fecha TEXT,
  seguimiento_nota TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

-- Relación explícita cliente-negocio (no inferida solo desde créditos)
CREATE TABLE IF NOT EXISTS cliente_negocio (
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  created_at TEXT DEFAULT (NOW()::text),
  PRIMARY KEY (cliente_id, negocio_id)
);

CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  nombre TEXT NOT NULL,
  categoria TEXT,
  variante TEXT,
  sku TEXT,
  costo_centavos INTEGER DEFAULT 0,
  precio_contado_centavos INTEGER DEFAULT 0,
  precio_financiado_centavos INTEGER DEFAULT 0,
  stock INTEGER,
  stock_minimo INTEGER DEFAULT 0,
  imei TEXT,
  estado TEXT DEFAULT 'disponible',
  foto_url TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS ventas (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  fecha TEXT NOT NULL,
  modalidad TEXT NOT NULL,
  monto_total_centavos INTEGER NOT NULL,
  entrega_inicial_centavos INTEGER DEFAULT 0,
  notas TEXT,
  empleado TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS venta_detalle (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  producto_id TEXT REFERENCES productos(id),
  descripcion TEXT,
  cantidad INTEGER DEFAULT 1,
  precio_unitario_centavos INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS creditos (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  modalidad TEXT NOT NULL,
  monto_total_centavos INTEGER NOT NULL,
  entrega_inicial_centavos INTEGER DEFAULT 0,
  saldo_financiado_centavos INTEGER NOT NULL,
  fecha_inicio TEXT NOT NULL,
  estado TEXT DEFAULT 'activo',
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS cuotas (
  id TEXT PRIMARY KEY,
  credito_id TEXT NOT NULL REFERENCES creditos(id),
  numero INTEGER NOT NULL,
  monto_centavos INTEGER NOT NULL,
  saldo_pendiente_centavos INTEGER NOT NULL,
  mora_pagada_centavos INTEGER DEFAULT 0,
  fecha_vencimiento TEXT NOT NULL,
  fecha_saldada TEXT,
  dias_atraso_al_pagar INTEGER,
  estado_manual TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS pagos (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  credito_id TEXT REFERENCES creditos(id),
  fecha_hora TEXT NOT NULL,
  monto_centavos INTEGER NOT NULL,
  medio_pago TEXT DEFAULT 'efectivo',
  caja TEXT,
  empleado TEXT,
  comprobante_url TEXT,
  nota TEXT,
  saldo_anterior_centavos INTEGER,
  saldo_posterior_centavos INTEGER,
  anulado INTEGER DEFAULT 0,
  motivo_anulacion TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS pago_aplicaciones (
  id TEXT PRIMARY KEY,
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  cuota_id TEXT NOT NULL REFERENCES cuotas(id),
  capital_centavos INTEGER DEFAULT 0,
  interes_mora_centavos INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS saldo_favor (
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  monto_centavos INTEGER DEFAULT 0,
  PRIMARY KEY (cliente_id, negocio_id)
);

CREATE TABLE IF NOT EXISTS auditoria (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  entidad TEXT NOT NULL,
  entidad_id TEXT NOT NULL,
  accion TEXT NOT NULL,
  datos_anteriores TEXT,
  datos_nuevos TEXT,
  motivo TEXT,
  empleado TEXT,
  fecha_hora TEXT DEFAULT (NOW()::text)
);

CREATE INDEX IF NOT EXISTS idx_cuotas_credito ON cuotas(credito_id);
CREATE INDEX IF NOT EXISTS idx_pagos_credito ON pagos(credito_id);
CREATE INDEX IF NOT EXISTS idx_ventas_negocio ON ventas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_productos_negocio ON productos(negocio_id);
CREATE INDEX IF NOT EXISTS idx_cliente_negocio ON cliente_negocio(negocio_id);
CREATE INDEX IF NOT EXISTS idx_cliente_negocio_cliente ON cliente_negocio(cliente_id);

CREATE SEQUENCE IF NOT EXISTS comprobantes_seq;

CREATE TABLE IF NOT EXISTS comprobantes (
  id TEXT PRIMARY KEY,
  numero TEXT UNIQUE NOT NULL,
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  venta_id TEXT REFERENCES ventas(id),
  credito_id TEXT REFERENCES creditos(id),
  monto_centavos INTEGER NOT NULL,
  fecha_hora TEXT NOT NULL,
  medio_pago TEXT,
  saldo_restante_centavos INTEGER,
  usuario_id TEXT,
  estado TEXT DEFAULT 'emitido',
  anulado_motivo TEXT,
  anulado_por TEXT,
  anulado_fecha TEXT,
  comprobante_original_id TEXT REFERENCES comprobantes(id),
  created_at TEXT DEFAULT (NOW()::text)
);
CREATE INDEX IF NOT EXISTS idx_comprobantes_cliente ON comprobantes(cliente_id);
CREATE INDEX IF NOT EXISTS idx_comprobantes_negocio ON comprobantes(negocio_id);

-- Invitaciones de empleados
CREATE TABLE IF NOT EXISTS invitaciones (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  nombre TEXT,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocios TEXT DEFAULT '[]', -- JSON array de {negocio_id, permisos}
  estado TEXT DEFAULT 'pendiente', -- pendiente, usada, vencida, revocada
  expira_en TEXT NOT NULL,
  usada_en TEXT,
  usada_por TEXT,
  creado_por TEXT,
  creado_en TEXT DEFAULT (NOW()::text),
  revocada_en TEXT,
  revocada_por TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitaciones_email ON invitaciones(email, estado);

-- Asignación usuario-negocio con permisos granulares
CREATE TABLE IF NOT EXISTS usuario_negocio (
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  permisos TEXT DEFAULT '{}',
  activo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (NOW()::text),
  PRIMARY KEY (usuario_id, negocio_id)
);

-- Configuración de cobranza por cliente + negocio
CREATE TABLE IF NOT EXISTS cliente_negocio_cobranza (
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  modo TEXT DEFAULT 'revisar',
  activo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (NOW()::text),
  PRIMARY KEY (cliente_id, negocio_id)
);

-- Recordatorios / próximos contactos de cobranza
CREATE TABLE IF NOT EXISTS recordatorios (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  credito_id TEXT REFERENCES creditos(id),
  cuota_id TEXT REFERENCES cuotas(id),
  tipo TEXT NOT NULL,
  fecha_contacto TEXT NOT NULL,
  fecha_vencimiento_real TEXT,
  estado TEXT DEFAULT 'pendiente',
  modo_envio TEXT DEFAULT 'revisar',
  mensaje_plantilla TEXT,
  enviado_fecha TEXT,
  enviado_por TEXT,
  omitido_fecha TEXT,
  omitido_por TEXT,
  omitido_motivo TEXT,
  reprogramado_fecha TEXT,
  reprogramado_por TEXT,
  nueva_fecha_contacto TEXT,
  nota TEXT,
  created_at TEXT DEFAULT (NOW()::text),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_recordatorios_negocio ON recordatorios(negocio_id, fecha_contacto);
CREATE INDEX IF NOT EXISTS idx_recordatorios_estado ON recordatorios(estado, fecha_contacto);
CREATE INDEX IF NOT EXISTS idx_recordatorios_cuota ON recordatorios(cuota_id);

-- Cajas
CREATE TABLE IF NOT EXISTS cajas (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  fecha_apertura TEXT NOT NULL,
  fecha_cierre TEXT,
  monto_inicial_centavos INTEGER DEFAULT 0,
  monto_cierre_centavos INTEGER,
  estado TEXT DEFAULT 'abierta',
  notas TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);

-- Movimientos de caja
CREATE TABLE IF NOT EXISTS caja_movimientos (
  id TEXT PRIMARY KEY,
  caja_id TEXT NOT NULL REFERENCES cajas(id),
  tipo TEXT NOT NULL,
  concepto TEXT,
  monto_centavos INTEGER NOT NULL,
  medio_pago TEXT,
  pago_id TEXT REFERENCES pagos(id),
  usuario_id TEXT,
  fecha_hora TEXT DEFAULT (NOW()::text)
);

-- Contratos
CREATE TABLE IF NOT EXISTS contratos (
  id TEXT PRIMARY KEY,
  organizacion_id TEXT REFERENCES organizaciones(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  venta_id TEXT REFERENCES ventas(id),
  credito_id TEXT REFERENCES creditos(id),
  numero TEXT UNIQUE,
  contenido_html TEXT,
  estado TEXT DEFAULT 'borrador',
  firmado_fecha TEXT,
  firmado_por_cliente INTEGER DEFAULT 0,
  firma_url TEXT,
  created_at TEXT DEFAULT (NOW()::text)
);
`;

// Parches no destructivos para bases ya desplegadas
const patches = `
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS recordatorio_dias TEXT DEFAULT '[7,3,1,0]';
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS cobranza_modo_negocio TEXT DEFAULT 'revisar';
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS fecha_saldada TEXT;
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS dias_atraso_al_pagar INTEGER;
ALTER TABLE productos ALTER COLUMN stock DROP NOT NULL;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_estado TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_fecha TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_nota TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo INTEGER DEFAULT 1;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS invitacion_completada INTEGER DEFAULT 1;

-- Compatibilidad con bases ya existentes: CREATE TABLE IF NOT EXISTS no agrega
-- columnas nuevas a tablas que ya estaban creadas.
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE creditos ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS organizacion_id TEXT REFERENCES organizaciones(id);

-- Migración de datos existentes a organización por defecto
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizaciones WHERE id = 'default') THEN
    INSERT INTO organizaciones (id, nombre) VALUES ('default', 'Organización Principal');
  END IF;
END $$;

UPDATE usuarios SET invitacion_completada = 1 WHERE invitacion_completada IS NULL;

-- Asignar usuarios existentes a la org default si no tienen asignación
INSERT INTO usuario_organizacion (usuario_id, organizacion_id, rol, activo)
SELECT id, 'default', COALESCE(rol, 'administrador'), 1
FROM usuarios u
WHERE NOT EXISTS (SELECT 1 FROM usuario_organizacion uo WHERE uo.usuario_id = u.id);

-- Asignar organizacion_id a tablas existentes
UPDATE negocios SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE clientes SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE productos SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE ventas SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE creditos SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE pagos SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE comprobantes SET organizacion_id = 'default' WHERE organizacion_id IS NULL;
UPDATE auditoria SET organizacion_id = 'default' WHERE organizacion_id IS NULL;

-- Poblar cliente_negocio desde operaciones existentes (relación explícita)
INSERT INTO cliente_negocio (cliente_id, negocio_id)
SELECT DISTINCT cliente_id, negocio_id FROM ventas
UNION
SELECT DISTINCT cliente_id, negocio_id FROM creditos
UNION
SELECT DISTINCT cliente_id, negocio_id FROM pagos
ON CONFLICT DO NOTHING;
`;

async function migrarTokensInvitaciones() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='invitaciones'`);
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (!names.has('token_hash')) await client.query('ALTER TABLE invitaciones ADD COLUMN token_hash TEXT');
    if (names.has('token')) {
      const { rows } = await client.query('SELECT id, token FROM invitaciones WHERE token IS NOT NULL AND token_hash IS NULL');
      for (const row of rows) {
        const hash = createHash('sha256').update(row.token).digest('hex');
        await client.query('UPDATE invitaciones SET token_hash=$1 WHERE id=$2', [hash, row.id]);
      }
    }
    const missing = await client.query('SELECT COUNT(*)::int AS n FROM invitaciones WHERE token_hash IS NULL');
    if (missing.rows[0].n > 0) throw new Error('Hay invitaciones sin token_hash; migración detenida para no perder datos');
    await client.query('ALTER TABLE invitaciones ALTER COLUMN token_hash SET NOT NULL');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_invitaciones_token_hash ON invitaciones(token_hash)');
    await client.query('DROP INDEX IF EXISTS idx_invitaciones_token');
    if (names.has('token')) await client.query('ALTER TABLE invitaciones DROP COLUMN token');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

export async function migrate() {
  await db.exec(schema);
  await migrarTokensInvitaciones();
  await db.exec(patches);
  console.log('✔ Migraciones aplicadas.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
