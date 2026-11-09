// Additive only. Applying this schema never enables the worker or changes stock.
export const tiendanubeSyncSchema = `
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_activada_at TIMESTAMPTZ;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_baseline_at TIMESTAMPTZ;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_webhooks_at TIMESTAMPTZ;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_motivo_pausa TEXT;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_lease_token TEXT;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_lease_hasta TIMESTAMPTZ;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS setup_webhooks_url TEXT;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS setup_webhooks_registrados_at TIMESTAMPTZ;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS setup_webhooks_error TEXT;
ALTER TABLE tiendanube_variantes ADD COLUMN IF NOT EXISTS sync_baseline_at TIMESTAMPTZ;
ALTER TABLE tiendanube_variantes ADD COLUMN IF NOT EXISTS sync_stock_remoto INTEGER;
ALTER TABLE tiendanube_variantes ADD COLUMN IF NOT EXISTS sync_verificar_despues TIMESTAMPTZ;
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_token TEXT;
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_version BIGINT;
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_stock INTEGER;
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_delta INTEGER;
-- Legacy column name; TRUE now means the POST variation may have reached the
-- remote server. It must never be retried solely because our lease expired.
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_put_iniciado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tiendanube_stock_outbox ADD COLUMN IF NOT EXISTS envio_iniciado_at TIMESTAMPTZ;
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS sync_estado TEXT NOT NULL DEFAULT 'pendiente';
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS sync_ultimo_evento_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Procedencia explícita: solo el receptor que validó el HMAC escribe esta
-- marca. Filas previas o internas no son evidencia de recepción firmada.
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS hmac_validada_at TIMESTAMPTZ;
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS sync_intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tiendanube_eventos ADD COLUMN IF NOT EXISTS sync_proximo_intento TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE TABLE IF NOT EXISTS tiendanube_pedido_stock (
 store_id TEXT NOT NULL,
 order_hash TEXT NOT NULL,
 variant_id TEXT NOT NULL,
 producto_id TEXT NOT NULL REFERENCES productos(id),
 cantidad_aplicada INTEGER NOT NULL CHECK(cantidad_aplicada>=0),
 actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(store_id,order_hash,variant_id)
);
CREATE INDEX IF NOT EXISTS tiendanube_inbox_sync_pendiente ON tiendanube_eventos(store_id,sync_proximo_intento,id)
 WHERE procesado_at IS NULL AND sync_estado IN ('pendiente','reintento');
-- A later local sale must not erase evidence of an ambiguous remote write.
-- Versions/desired stock continue advancing, but review stays latched until
-- explicitly reconciled by an administrator.
CREATE OR REPLACE FUNCTION tiendanube_encolar_stock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stock IS DISTINCT FROM OLD.stock AND EXISTS (
   SELECT 1 FROM tiendanube_variantes v WHERE v.producto_id=NEW.id AND v.negocio_id=NEW.negocio_id
 ) THEN
   INSERT INTO tiendanube_stock_outbox(producto_id,negocio_id,stock_deseado)
   VALUES(NEW.id,NEW.negocio_id,NEW.stock)
   ON CONFLICT(producto_id) DO UPDATE SET stock_deseado=EXCLUDED.stock_deseado,
     version=tiendanube_stock_outbox.version+1,
     estado=CASE WHEN tiendanube_stock_outbox.estado='revision_manual' THEN 'revision_manual' ELSE 'pendiente' END,
     intentos=CASE WHEN tiendanube_stock_outbox.estado='revision_manual' THEN tiendanube_stock_outbox.intentos ELSE 0 END,
     proximo_intento=CASE WHEN tiendanube_stock_outbox.estado='revision_manual' THEN tiendanube_stock_outbox.proximo_intento ELSE NOW() END,
     ultimo_error=CASE WHEN tiendanube_stock_outbox.estado='revision_manual' THEN tiendanube_stock_outbox.ultimo_error ELSE NULL END,
     actualizado_at=NOW();
 END IF;
 RETURN NEW;
END $$;
`;
