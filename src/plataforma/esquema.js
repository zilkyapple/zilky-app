import { db, conCuenta } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
// Tablas propias de la plataforma, en el esquema public. Los datos de cada
// negocio viven en el esquema de su cuenta (t_...), nunca acá.
export const esquemaPlataforma = `
CREATE TABLE IF NOT EXISTS plataforma_cuentas (
  id TEXT PRIMARY KEY,
  esquema TEXT NOT NULL UNIQUE CHECK (esquema ~ '^t_[a-z0-9]{16,40}$'),
  nombre TEXT NOT NULL,
  negocio_nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telefono TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente_pago'
    CHECK (estado IN ('pendiente_pago','activa','pago_rechazado','bloqueada','cancelada','exenta')),
  mp_preapproval_id TEXT UNIQUE,
  mp_estado TEXT,
  mp_init_point TEXT,
  mp_monto_centavos BIGINT,
  primer_pago_en TIMESTAMPTZ,
  ultimo_pago_en TIMESTAMPTZ,
  rechazo_desde TIMESTAMPTZ,
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plataforma_cuentas ADD COLUMN IF NOT EXISTS mp_monto_centavos BIGINT;
CREATE TABLE IF NOT EXISTS plataforma_directorio (
  email TEXT PRIMARY KEY,
  esquema TEXT NOT NULL REFERENCES plataforma_cuentas(esquema) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS plataforma_invitaciones (
  token_hash TEXT PRIMARY KEY,
  esquema TEXT NOT NULL REFERENCES plataforma_cuentas(esquema) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS plataforma_funciones (
  clave TEXT PRIMARY KEY,
  habilitada BOOLEAN NOT NULL DEFAULT FALSE,
  actualizada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plataforma_ajustes (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plataforma_eventos_pago (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT REFERENCES plataforma_cuentas(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  recurso_id TEXT NOT NULL,
  estado TEXT,
  detalle JSONB,
  recibido_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
export async function migrarPlataforma() {
  await db.transaction(async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cobranzas:plataforma',0))");
    await db.exec(esquemaPlataforma);
  });
  const { rows } = await db.query('SELECT esquema FROM plataforma_cuentas ORDER BY creada_en');
  for (const { esquema } of rows) await conCuenta(esquema, () => migrate());
  console.log(`✔ Plataforma migrada (${rows.length} cuenta/s).`);
}
