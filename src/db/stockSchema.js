export const stockSchema = `
ALTER TABLE productos ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS producto_historial (
 id TEXT PRIMARY KEY, producto_id TEXT NOT NULL REFERENCES productos(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id), tipo TEXT NOT NULL,
 stock_anterior INTEGER, stock_nuevo INTEGER,
 motivo TEXT NOT NULL, usuario_id TEXT REFERENCES usuarios(id),
 venta_id TEXT, solicitud_id TEXT, detalles JSONB NOT NULL DEFAULT '{}',
 creado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(producto_id,solicitud_id)
);
CREATE INDEX IF NOT EXISTS producto_historial_producto_fecha ON producto_historial(producto_id,creado_at DESC);
`;
