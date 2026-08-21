import { db } from './connection.js';

const schema = `
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nombre TEXT,
  rol TEXT DEFAULT 'administrador',
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS negocios (
  id TEXT PRIMARY KEY,
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
  created_at TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY,
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

CREATE SEQUENCE IF NOT EXISTS comprobantes_seq;

CREATE TABLE IF NOT EXISTS comprobantes (
  id TEXT PRIMARY KEY,
  numero TEXT UNIQUE NOT NULL,
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  venta_id TEXT REFERENCES ventas(id),
  credito_id TEXT REFERENCES creditos(id),
  monto_centavos INTEGER NOT NULL,
  fecha_hora TEXT NOT NULL,
  medio_pago TEXT,
  saldo_restante_centavos INTEGER,
  usuario_id TEXT,
  estado TEXT DEFAULT 'emitido',      -- 'emitido' | 'anulado'
  anulado_motivo TEXT,
  anulado_por TEXT,
  anulado_fecha TEXT,
  comprobante_original_id TEXT REFERENCES comprobantes(id),
  created_at TEXT DEFAULT (NOW()::text)
);
CREATE INDEX IF NOT EXISTS idx_comprobantes_cliente ON comprobantes(cliente_id);
CREATE INDEX IF NOT EXISTS idx_comprobantes_negocio ON comprobantes(negocio_id);
`;

// Parches para bases ya desplegadas antes de esta versión (CREATE TABLE IF NOT EXISTS
// no agrega columnas nuevas a una tabla que ya existía, por eso van explícitas acá).
// Nada de esto borra datos.
const patches = `
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS recordatorio_dias TEXT DEFAULT '[7,3,1,0]';
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS fecha_saldada TEXT;
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS dias_atraso_al_pagar INTEGER;
ALTER TABLE productos ALTER COLUMN stock DROP NOT NULL;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_estado TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_fecha TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS seguimiento_nota TEXT;
`;

export async function migrate() {
  await db.exec(schema);
  await db.exec(patches);
  console.log('✔ Migraciones aplicadas.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
