// No contiene payloads de Tiendanube, datos de contacto ni credenciales.
// Las solicitudes de desinstalación/borrado de tienda requieren revisión de
// la instalación vigente; nunca disparan un borrado ciego de conexiones.
export const tiendanubePrivacidadSchema = `
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_solicitudes (
 id TEXT PRIMARY KEY,
 clave TEXT NOT NULL UNIQUE,
 contenido_hash TEXT NOT NULL,
 store_id TEXT NOT NULL,
 negocio_id TEXT REFERENCES negocios(id),
 tipo TEXT NOT NULL CHECK(tipo IN ('customer-redact','customer-data-request','store-redact','uninstalled')),
 solicitud_ref TEXT,
 instalacion_actualizada_at TIMESTAMPTZ,
 evento_fecha TIMESTAMPTZ,
 estado TEXT NOT NULL CHECK(estado IN ('pendiente_revision','pendiente_entrega','completada')),
 reporte JSONB NOT NULL DEFAULT '{}',
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 actualizada_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tiendanube_privacidad_negocio_estado
 ON tiendanube_privacidad_solicitudes(negocio_id,estado,creada_at);
-- Impide que un webhook tardío recree pedidos redactados o vuelva a aplicar
-- movimientos de stock. No conserva el ID externo del pedido en claro.
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_borrados (
 store_id TEXT NOT NULL,
 order_hash TEXT NOT NULL,
 solicitud_id TEXT NOT NULL REFERENCES tiendanube_privacidad_solicitudes(id),
 borrado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(store_id,order_hash)
);
`;
