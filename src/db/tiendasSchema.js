// Additive storefronts: existing inventory is linked, never copied or backfilled.
export const tiendasSchema = `
CREATE TABLE IF NOT EXISTS tiendas_config (
 negocio_id TEXT PRIMARY KEY REFERENCES negocios(id),
 habilitada BOOLEAN NOT NULL DEFAULT FALSE,
 slug TEXT UNIQUE,
 nombre TEXT NOT NULL DEFAULT '',
 descripcion TEXT NOT NULL DEFAULT '',
 tipo TEXT NOT NULL DEFAULT 'general' CHECK(tipo IN ('iphone','ropa','general')),
 whatsapp TEXT NOT NULL DEFAULT '',
 secciones JSONB NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tienda_productos (
 id TEXT PRIMARY KEY,
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 producto_id TEXT NOT NULL REFERENCES productos(id),
 nombre TEXT NOT NULL,
 descripcion TEXT NOT NULL DEFAULT '',
 categoria TEXT NOT NULL DEFAULT '',
 modelos JSONB NOT NULL DEFAULT '[]',
 talle TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL DEFAULT '',
 publicado BOOLEAN NOT NULL DEFAULT FALSE,
 precio_centavos INTEGER NOT NULL CHECK(precio_centavos>=0),
 orden INTEGER NOT NULL DEFAULT 0 CHECK(orden>=0),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(negocio_id,producto_id)
);
CREATE INDEX IF NOT EXISTS tienda_productos_catalogo ON tienda_productos(negocio_id,publicado,orden,id);
CREATE TABLE IF NOT EXISTS tienda_pedidos (
 id TEXT PRIMARY KEY,
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 codigo TEXT NOT NULL UNIQUE,
 solicitud_id TEXT NOT NULL,
 solicitud_hash TEXT NOT NULL,
 estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','confirmado','cancelado')),
 contacto JSONB NOT NULL,
 nota TEXT,
 acepta_contacto BOOLEAN NOT NULL DEFAULT FALSE,
 total_centavos BIGINT NOT NULL CHECK(total_centavos>=0),
 stock_movimientos JSONB NOT NULL DEFAULT '[]',
 stock_reposiciones JSONB NOT NULL DEFAULT '[]',
 confirmado_por TEXT REFERENCES usuarios(id),
 confirmado_fecha TEXT,
 cancelado_por TEXT REFERENCES usuarios(id),
 cancelado_fecha TEXT,
 motivo_cancelacion TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(negocio_id,solicitud_id)
);
CREATE INDEX IF NOT EXISTS tienda_pedidos_negocio_fecha ON tienda_pedidos(negocio_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS tienda_pedido_items (
 id TEXT PRIMARY KEY,
 pedido_id TEXT NOT NULL REFERENCES tienda_pedidos(id),
 producto_web_id TEXT NOT NULL REFERENCES tienda_productos(id),
 producto_id TEXT NOT NULL REFERENCES productos(id),
 nombre TEXT NOT NULL,
 descripcion TEXT NOT NULL DEFAULT '',
 precio_unitario_centavos INTEGER NOT NULL CHECK(precio_unitario_centavos>=0),
 cantidad INTEGER NOT NULL CHECK(cantidad>0),
 subtotal_centavos BIGINT NOT NULL CHECK(subtotal_centavos>=0),
 componentes JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS tienda_pedido_items_pedido ON tienda_pedido_items(pedido_id,id);
CREATE TABLE IF NOT EXISTS tienda_contactos (
 id TEXT PRIMARY KEY,
 pedido_id TEXT NOT NULL UNIQUE REFERENCES tienda_pedidos(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 nombre TEXT NOT NULL,
 apellido TEXT NOT NULL DEFAULT '',
 telefono TEXT NOT NULL,
 email TEXT NOT NULL DEFAULT '',
 acepta_contacto BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tienda_contactos_negocio_fecha ON tienda_contactos(negocio_id,created_at DESC,id);
-- Historical orders remain ordinary orders; only new checkout items opt in.
ALTER TABLE tienda_pedido_items ADD COLUMN IF NOT EXISTS es_encargo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tienda_pedido_items ADD COLUMN IF NOT EXISTS opciones JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS cliente_id TEXT REFERENCES clientes(id);
CREATE TABLE IF NOT EXISTS tienda_pedido_cobros (
 id TEXT PRIMARY KEY,
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 pedido_id TEXT NOT NULL REFERENCES tienda_pedidos(id),
 pago_id TEXT NOT NULL UNIQUE REFERENCES pagos(id),
 comprobante_id TEXT NOT NULL UNIQUE REFERENCES comprobantes(id),
 solicitud_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 usuario_id TEXT REFERENCES usuarios(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(negocio_id,solicitud_id)
);
CREATE INDEX IF NOT EXISTS tienda_pedido_cobros_pedido ON tienda_pedido_cobros(pedido_id,id);
`;
