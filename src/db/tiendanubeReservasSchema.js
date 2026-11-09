// Internal, additive preparation only. No stock changes or activation here.
// A token never expires into permission to retry POST /orders: its outcome can
// be unknown. It blocks worker/setup/reauthorization until explicitly resolved.
export const tiendanubeReservasSchema = `
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_reserva_token TEXT;
ALTER TABLE tiendanube_conexiones ADD COLUMN IF NOT EXISTS sync_reserva_iniciada_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS tiendanube_reserva_intentos (
 id TEXT PRIMARY KEY,
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 usuario_id TEXT NOT NULL REFERENCES usuarios(id),
 solicitud_id TEXT NOT NULL,
 solicitud_hash TEXT NOT NULL,
 store_id TEXT NOT NULL,
 instalacion_hash TEXT NOT NULL,
 estado TEXT NOT NULL CHECK(estado IN ('enviando','reservada','rechazada','revision_manual')),
 order_hash TEXT,
 items JSONB NOT NULL,
 total_centavos INTEGER NOT NULL CHECK(total_centavos>0),
 codigo TEXT,
 creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 finalizada_at TIMESTAMPTZ,
 UNIQUE(negocio_id,solicitud_id),
 UNIQUE(store_id,order_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_reserva_un_intento_en_curso
 ON tiendanube_reserva_intentos(negocio_id) WHERE estado IN ('enviando','revision_manual');
-- Clear order IDs remain solely in the existing privacy-redactable summary.
-- The durable intent keeps a pseudonymous order hash, never customer contact.
ALTER TABLE tiendanube_pedidos ADD COLUMN IF NOT EXISTS reserva_intento_id TEXT
 REFERENCES tiendanube_reserva_intentos(id);
CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_pedido_por_reserva
 ON tiendanube_pedidos(reserva_intento_id) WHERE reserva_intento_id IS NOT NULL;
`;
