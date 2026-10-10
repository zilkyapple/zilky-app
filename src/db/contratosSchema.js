export const contratosSchema = `
CREATE TABLE IF NOT EXISTS contrato_modelos (
 id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL REFERENCES negocios(id), nombre TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, documento JSONB NOT NULL, pagina JSONB NOT NULL,
 actualizado_por TEXT REFERENCES usuarios(id), actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS contrato_versiones (
 id TEXT PRIMARY KEY, contrato_id TEXT NOT NULL REFERENCES contratos(id), revision INTEGER NOT NULL,
 titulo TEXT NOT NULL, documento JSONB NOT NULL, pagina JSONB NOT NULL,
 estado TEXT NOT NULL CHECK(estado IN ('borrador','emitido')),
 autor TEXT REFERENCES usuarios(id), creado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(contrato_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_contrato_modelos_negocio ON contrato_modelos(negocio_id);
CREATE INDEX IF NOT EXISTS idx_contratos_negocio ON contratos(negocio_id);
`;
