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
-- No se reconstruye una huella para solicitudes antiguas: no existe evidencia
-- suficiente para atribuirlas a la instalación que hoy esté conectada.
ALTER TABLE tiendanube_privacidad_solicitudes ADD COLUMN IF NOT EXISTS instalacion_huella TEXT;
ALTER TABLE tiendanube_privacidad_solicitudes ADD COLUMN IF NOT EXISTS instalacion_creada_at TIMESTAMPTZ;
-- Un callback OAuth en vuelo no puede volver a crear una conexión eliminada.
-- /iniciar captura esta época y /callback la revalida bajo los mismos locks.
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_epocas (
 negocio_id TEXT PRIMARY KEY REFERENCES negocios(id),
 epoca BIGINT NOT NULL DEFAULT 0 CHECK(epoca>=0)
);
ALTER TABLE tiendanube_oauth_estados ADD COLUMN IF NOT EXISTS privacidad_epoca BIGINT NOT NULL DEFAULT 0;
-- Se guarda la huella del archivo, no una segunda copia del informe.
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_exportaciones (
 id TEXT PRIMARY KEY,
 solicitud_id TEXT NOT NULL REFERENCES tiendanube_privacidad_solicitudes(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 actor_id TEXT NOT NULL REFERENCES usuarios(id),
 informe_hash TEXT NOT NULL CHECK(informe_hash ~ '^[a-f0-9]{64}$'),
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_entregas (
 solicitud_id TEXT PRIMARY KEY REFERENCES tiendanube_privacidad_solicitudes(id),
 exportacion_id TEXT NOT NULL REFERENCES tiendanube_privacidad_exportaciones(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 actor_id TEXT NOT NULL REFERENCES usuarios(id),
 informe_hash TEXT NOT NULL CHECK(informe_hash ~ '^[a-f0-9]{64}$'),
 canal TEXT NOT NULL CHECK(canal IN ('recepcion_administrador','entrega_externa_declarada')),
 declarada_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Token de un solo uso, ligado al actor, instalación y estado exacto mostrado.
-- El resultado conserva conteos y decisiones, nunca credenciales ni contactos.
CREATE TABLE IF NOT EXISTS tiendanube_privacidad_confirmaciones (
 id TEXT PRIMARY KEY,
 solicitud_id TEXT NOT NULL REFERENCES tiendanube_privacidad_solicitudes(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 actor_id TEXT NOT NULL REFERENCES usuarios(id),
 token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 snapshot_hash TEXT NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 vence_at TIMESTAMPTZ NOT NULL,
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 consumida_at TIMESTAMPTZ,
 resultado JSONB
);
CREATE INDEX IF NOT EXISTS tiendanube_privacidad_confirmacion_solicitud
 ON tiendanube_privacidad_confirmaciones(solicitud_id,actor_id,creada_at);
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
