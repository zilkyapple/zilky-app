export const comisionesSchema = `
CREATE TABLE IF NOT EXISTS comision_config (
 negocio_id TEXT PRIMARY KEY REFERENCES negocios(id), activa BOOLEAN NOT NULL DEFAULT false,
 visible_empleado BOOLEAN NOT NULL DEFAULT false, momento TEXT NOT NULL DEFAULT 'venta' CHECK(momento IN ('venta','cobro'))
);
CREATE TABLE IF NOT EXISTS comision_producto (
 producto_id TEXT PRIMARY KEY REFERENCES productos(id), tipo TEXT NOT NULL CHECK(tipo IN ('fijo','porcentaje')),
 valor INTEGER NOT NULL CHECK(valor>=0), CHECK(tipo<>'porcentaje' OR valor<=10000)
);
CREATE TABLE IF NOT EXISTS comision_acuerdos (
 id TEXT PRIMARY KEY, venta_id TEXT NOT NULL UNIQUE REFERENCES ventas(id), negocio_id TEXT NOT NULL REFERENCES negocios(id),
 usuario_id TEXT NOT NULL REFERENCES usuarios(id), momento TEXT NOT NULL CHECK(momento IN ('venta','cobro')),
 base_centavos BIGINT NOT NULL CHECK(base_centavos>0), total_centavos BIGINT NOT NULL CHECK(total_centavos>=0),
 detalle JSONB NOT NULL, creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS comision_eventos (
 id TEXT PRIMARY KEY, acuerdo_id TEXT NOT NULL REFERENCES comision_acuerdos(id),
 fecha TEXT NOT NULL, importe_centavos BIGINT NOT NULL, motivo TEXT NOT NULL,
 creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comision_acuerdo_usuario ON comision_acuerdos(negocio_id,usuario_id);
CREATE TABLE IF NOT EXISTS comision_liquidaciones (
 id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL REFERENCES negocios(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 importe_centavos BIGINT NOT NULL CHECK(importe_centavos>0), fecha TEXT NOT NULL,
 nota TEXT NOT NULL DEFAULT '', autor TEXT NOT NULL REFERENCES usuarios(id), creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
