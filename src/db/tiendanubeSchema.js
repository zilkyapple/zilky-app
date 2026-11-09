// Conexión opcional por negocio. Todo nace pausado: la migración jamás publica,
// descuenta stock ni modifica la web original de Zilky.
export const tiendanubeSchema = `
CREATE TABLE IF NOT EXISTS tiendanube_conexiones (
 negocio_id TEXT PRIMARY KEY REFERENCES negocios(id),
 store_id TEXT NOT NULL UNIQUE,
 app_id TEXT NOT NULL,
 token_cifrado TEXT NOT NULL,
 scopes TEXT NOT NULL,
 pausada BOOLEAN NOT NULL DEFAULT TRUE,
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 actualizada_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tiendanube_oauth_estados (
 state_hash TEXT PRIMARY KEY,
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 vence_at TIMESTAMPTZ NOT NULL,
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tiendanube_variantes (
 producto_id TEXT PRIMARY KEY REFERENCES productos(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 store_id TEXT NOT NULL,
 product_id TEXT NOT NULL,
 variant_id TEXT NOT NULL,
 vinculada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(store_id,variant_id),
 FOREIGN KEY(negocio_id) REFERENCES tiendanube_conexiones(negocio_id)
);
CREATE INDEX IF NOT EXISTS tiendanube_variantes_negocio_idx ON tiendanube_variantes(negocio_id);
CREATE TABLE IF NOT EXISTS tiendanube_stock_outbox (
 producto_id TEXT PRIMARY KEY REFERENCES productos(id),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 stock_deseado INTEGER,
 version BIGINT NOT NULL DEFAULT 1,
 estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviando','sincronizado','revision_manual')),
 intentos INTEGER NOT NULL DEFAULT 0,
 proximo_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 ultimo_error TEXT,
 actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tiendanube_eventos (
 id BIGSERIAL PRIMARY KEY,
 store_id TEXT NOT NULL,
 topic TEXT NOT NULL,
 recurso_id TEXT NOT NULL,
 body_hash TEXT NOT NULL,
 payload JSONB NOT NULL,
 recibido_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 procesado_at TIMESTAMPTZ,
 error TEXT,
 UNIQUE(store_id,topic,recurso_id,body_hash)
);
CREATE INDEX IF NOT EXISTS tiendanube_eventos_pendientes ON tiendanube_eventos(recibido_at) WHERE procesado_at IS NULL;
CREATE TABLE IF NOT EXISTS tiendanube_pedidos (
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 store_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 estado TEXT NOT NULL DEFAULT 'pendiente',
 cantidades JSONB NOT NULL DEFAULT '{}',
 pagado BOOLEAN NOT NULL DEFAULT FALSE,
 cancelado BOOLEAN NOT NULL DEFAULT FALSE,
 pendiente_revision BOOLEAN NOT NULL DEFAULT TRUE,
 actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(store_id,order_id)
);
CREATE OR REPLACE FUNCTION tiendanube_encolar_stock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stock IS DISTINCT FROM OLD.stock AND EXISTS (
   SELECT 1 FROM tiendanube_variantes v WHERE v.producto_id = NEW.id AND v.negocio_id = NEW.negocio_id
 ) THEN
   INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado)
   VALUES(NEW.id,NEW.negocio_id,NEW.stock)
   ON CONFLICT(producto_id) DO UPDATE SET stock_deseado=EXCLUDED.stock_deseado,
     version=tiendanube_stock_outbox.version+1,estado='pendiente',intentos=0,
     proximo_intento=NOW(),ultimo_error=NULL,actualizado_at=NOW();
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tiendanube_stock_sync ON productos;
CREATE TRIGGER tiendanube_stock_sync AFTER UPDATE OF stock ON productos
FOR EACH ROW EXECUTE FUNCTION tiendanube_encolar_stock();
`;
