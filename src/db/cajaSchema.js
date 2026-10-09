// Additive schema: legacy caja placeholders and financial tables stay intact.
export const cajaSchema = `
CREATE TABLE IF NOT EXISTS caja_config (
 id TEXT PRIMARY KEY, nombre TEXT NOT NULL, activa BOOLEAN NOT NULL DEFAULT FALSE,
 arqueo BOOLEAN NOT NULL DEFAULT FALSE, modalidad TEXT NOT NULL DEFAULT 'negocio' CHECK(modalidad IN ('negocio','empleado')),
 version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caja_negocios (
 negocio_id TEXT PRIMARY KEY REFERENCES negocios(id), caja_id TEXT NOT NULL REFERENCES caja_config(id)
);
CREATE TABLE IF NOT EXISTS caja_sesiones (
 id TEXT PRIMARY KEY, caja_id TEXT NOT NULL REFERENCES caja_config(id), responsable_id TEXT NOT NULL REFERENCES usuarios(id),
 clave TEXT NOT NULL, apertura TIMESTAMPTZ NOT NULL DEFAULT now(), cierre TIMESTAMPTZ,
 inicial BIGINT NOT NULL CHECK(inicial>=0), arqueo BOOLEAN NOT NULL, contado BIGINT CHECK(contado>=0),
 esperado BIGINT, diferencia BIGINT, cerrado_por TEXT REFERENCES usuarios(id), notas TEXT NOT NULL DEFAULT '',
 UNIQUE(caja_id,clave,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS caja_sesion_abierta ON caja_sesiones(caja_id,clave) WHERE cierre IS NULL;
CREATE TABLE IF NOT EXISTS caja_asientos (
 id TEXT PRIMARY KEY, caja_id TEXT NOT NULL REFERENCES caja_config(id), sesion_id TEXT REFERENCES caja_sesiones(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id), pago_id TEXT REFERENCES pagos(id),
 tipo TEXT NOT NULL CHECK(tipo IN ('cobro','anulacion','ingreso','egreso','correccion')),
 monto BIGINT NOT NULL, medio TEXT NOT NULL, concepto TEXT NOT NULL,
 actor TEXT REFERENCES usuarios(id), fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
 solicitud_id TEXT UNIQUE, payload TEXT, resuelto BOOLEAN NOT NULL DEFAULT FALSE,
 resuelto_por TEXT REFERENCES usuarios(id), resolucion TEXT,
 UNIQUE(pago_id,tipo)
);
CREATE INDEX IF NOT EXISTS caja_asientos_sesion ON caja_asientos(sesion_id);
CREATE INDEX IF NOT EXISTS caja_asientos_pendientes ON caja_asientos(caja_id) WHERE sesion_id IS NULL;
`;
