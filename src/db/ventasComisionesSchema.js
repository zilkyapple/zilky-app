// Additive only: historical sales, agreements and employee payments are preserved.
export const ventasComisionesSchema = `
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS usuario_id TEXT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS vendedor_id TEXT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'minorista';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'activa';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS devolucion_centavos BIGINT NOT NULL DEFAULT 0;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumidor_final_negocio TEXT REFERENCES negocios(id);
CREATE UNIQUE INDEX IF NOT EXISTS cliente_consumidor_final ON clientes(consumidor_final_negocio) WHERE consumidor_final_negocio IS NOT NULL;
ALTER TABLE venta_detalle ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE venta_detalle ADD COLUMN IF NOT EXISTS componentes JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS venta_solicitudes (
 negocio_id TEXT NOT NULL REFERENCES negocios(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 solicitud_id TEXT NOT NULL, huella TEXT NOT NULL, respuesta JSONB NOT NULL,
 creado_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(negocio_id,usuario_id,solicitud_id)
);
CREATE TABLE IF NOT EXISTS producto_combo_componentes (
 combo_id TEXT NOT NULL REFERENCES productos(id), producto_id TEXT NOT NULL REFERENCES productos(id),
 cantidad INTEGER NOT NULL CHECK(cantidad>0), PRIMARY KEY(combo_id,producto_id), CHECK(combo_id<>producto_id)
);
CREATE TABLE IF NOT EXISTS comision_reglas (
 id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL REFERENCES negocios(id), producto_id TEXT NOT NULL REFERENCES productos(id),
 usuario_id TEXT REFERENCES usuarios(id), canal TEXT NOT NULL CHECK(canal IN ('minorista','mayorista','combo')),
 tipo TEXT NOT NULL CHECK(tipo IN ('fijo','porcentaje')), valor INTEGER NOT NULL CHECK(valor>=0),
 CHECK(tipo<>'porcentaje' OR valor<=10000)
);
CREATE UNIQUE INDEX IF NOT EXISTS comision_regla_unica ON comision_reglas(producto_id,COALESCE(usuario_id,''),canal);
CREATE TABLE IF NOT EXISTS comision_visibilidad (
 negocio_id TEXT NOT NULL REFERENCES negocios(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 modo TEXT NOT NULL CHECK(modo IN ('nunca','cierre','tiempo_real')),
 ver_total BOOLEAN NOT NULL DEFAULT true, ver_detalle BOOLEAN NOT NULL DEFAULT false,
 ver_historial BOOLEAN NOT NULL DEFAULT false, venta_manual BOOLEAN NOT NULL DEFAULT true,
 PRIMARY KEY(negocio_id,usuario_id)
);
CREATE TABLE IF NOT EXISTS comision_cierres (
 id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL REFERENCES negocios(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 mes TEXT NOT NULL, estado TEXT NOT NULL CHECK(estado IN ('aprobada','publicada')),
 resumen JSONB NOT NULL, version TEXT NOT NULL, autor TEXT NOT NULL REFERENCES usuarios(id),
 creado_at TIMESTAMPTZ NOT NULL DEFAULT now(), publicado_at TIMESTAMPTZ,
 UNIQUE(negocio_id,usuario_id,mes)
);
ALTER TABLE comision_liquidaciones ADD COLUMN IF NOT EXISTS fecha_contable TEXT;
ALTER TABLE comision_liquidaciones ADD COLUMN IF NOT EXISTS cierre_id TEXT REFERENCES comision_cierres(id);
ALTER TABLE comision_eventos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'devengo';
ALTER TABLE comision_eventos ADD COLUMN IF NOT EXISTS fecha_origen TEXT;
CREATE TABLE IF NOT EXISTS comision_generaciones (
 id TEXT PRIMARY KEY, acuerdo_id TEXT NOT NULL REFERENCES comision_acuerdos(id), fecha TEXT NOT NULL,
 importe_centavos BIGINT NOT NULL, motivo TEXT NOT NULL, creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO comision_generaciones(id,acuerdo_id,fecha,importe_centavos,motivo)
 SELECT 'alta:'||a.id,a.id,v.fecha,a.total_centavos,'Acuerdo original' FROM comision_acuerdos a JOIN ventas v ON v.id=a.venta_id
 ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS comision_ajustes (
 id TEXT PRIMARY KEY, acuerdo_id TEXT NOT NULL REFERENCES comision_acuerdos(id),
 importe_centavos BIGINT NOT NULL, motivo TEXT NOT NULL, fecha TEXT NOT NULL,
 autor TEXT NOT NULL REFERENCES usuarios(id), creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS venta_devoluciones (
 id TEXT PRIMARY KEY, venta_id TEXT NOT NULL REFERENCES ventas(id), negocio_id TEXT NOT NULL REFERENCES negocios(id),
 tipo TEXT NOT NULL CHECK(tipo IN ('devolucion','anulacion')), motivo TEXT NOT NULL,
 importe_centavos BIGINT NOT NULL CHECK(importe_centavos>0), capital_reducido_centavos BIGINT NOT NULL,
 saldo_favor_centavos BIGINT NOT NULL, detalle JSONB NOT NULL, antes JSONB NOT NULL,
 huella TEXT NOT NULL, usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ventas_negocio_fecha ON ventas(negocio_id,fecha DESC);
CREATE INDEX IF NOT EXISTS comision_cierres_usuario ON comision_cierres(negocio_id,usuario_id,mes DESC);
`;
