export const tiendaMediaSchema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_tienda_productos_id_negocio ON tienda_productos(id,negocio_id);
CREATE TABLE IF NOT EXISTS tienda_media (
  id TEXT PRIMARY KEY,
  tienda_producto_id TEXT NOT NULL,
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('imagen','video')),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime')),
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 31457280),
  nombre TEXT NOT NULL CHECK (length(nombre) BETWEEN 1 AND 180),
  orden INTEGER NOT NULL CHECK (orden >= 0),
  hash TEXT NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  solicitud_id TEXT,
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (NOW()::text),
  FOREIGN KEY (tienda_producto_id,negocio_id) REFERENCES tienda_productos(id,negocio_id) ON DELETE CASCADE,
  UNIQUE (tienda_producto_id,orden) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_tienda_media_producto ON tienda_media(tienda_producto_id,orden,id);
CREATE INDEX IF NOT EXISTS idx_tienda_media_negocio ON tienda_media(negocio_id);
CREATE TABLE IF NOT EXISTS tienda_media_contenido (
  media_id TEXT PRIMARY KEY REFERENCES tienda_media(id) ON DELETE CASCADE,
  datos BYTEA NOT NULL CHECK (octet_length(datos) > 0 AND octet_length(datos) <= 31457280)
);
-- Sólo metadatos: los reintentos no guardan otra copia del archivo ni lo recrean
-- si más tarde se eliminó de la tienda.
CREATE TABLE IF NOT EXISTS tienda_media_solicitudes (
  negocio_id TEXT NOT NULL REFERENCES negocios(id),
  solicitud_id TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  operacion TEXT NOT NULL CHECK (operacion IN ('subir','eliminar','ordenar')),
  tienda_producto_id TEXT NOT NULL,
  huella TEXT NOT NULL,
  resultado JSONB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (NOW()::text),
  PRIMARY KEY (negocio_id,solicitud_id)
);
`;
