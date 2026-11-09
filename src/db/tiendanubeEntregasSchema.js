// Additive only. A reservation is not a sale; this link is written atomically
// only when an authorized operator confirms actual delivery. No remote PII.
export const tiendanubeEntregasSchema = `
CREATE TABLE IF NOT EXISTS tiendanube_entregas (
 store_id TEXT NOT NULL,
 order_hash TEXT NOT NULL CHECK(order_hash ~ '^[a-f0-9]{64}$'),
 negocio_id TEXT NOT NULL REFERENCES negocios(id),
 venta_id TEXT NOT NULL UNIQUE REFERENCES ventas(id),
 credito_id TEXT NOT NULL UNIQUE REFERENCES creditos(id),
 pago_inicial_id TEXT UNIQUE REFERENCES pagos(id),
 confirmado_por TEXT NOT NULL REFERENCES usuarios(id),
 vendedor_id TEXT NOT NULL REFERENCES usuarios(id),
 solicitud_id TEXT NOT NULL,
 solicitud_hash TEXT NOT NULL CHECK(solicitud_hash ~ '^[a-f0-9]{64}$'),
 condicion_precio TEXT NOT NULL CHECK(condicion_precio IN ('contado','30_dias')),
 fecha_entrega TEXT NOT NULL,
 fecha_limite TEXT,
 fecha_hora_cobro TEXT,
 medio_pago TEXT CHECK(medio_pago IN ('efectivo','transferencia')),
 precio_publicado_centavos INTEGER NOT NULL CHECK(precio_publicado_centavos>0),
 descuento_centavos INTEGER NOT NULL CHECK(descuento_centavos>=0),
 descuento_origen TEXT NOT NULL CHECK(descuento_origen IN ('ninguno','local','remoto')),
 total_centavos INTEGER NOT NULL CHECK(total_centavos>0),
 entrega_inicial_centavos INTEGER NOT NULL CHECK(entrega_inicial_centavos>=0 AND entrega_inicial_centavos<=total_centavos),
 confirmado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(store_id,order_hash),
 UNIQUE(negocio_id,confirmado_por,solicitud_id),
 CHECK(precio_publicado_centavos-descuento_centavos=total_centavos),
 CHECK((entrega_inicial_centavos=0 AND pago_inicial_id IS NULL AND fecha_hora_cobro IS NULL AND medio_pago IS NULL)
    OR (entrega_inicial_centavos>0 AND pago_inicial_id IS NOT NULL AND fecha_hora_cobro IS NOT NULL AND medio_pago IS NOT NULL)),
 CHECK(condicion_precio<>'contado' OR entrega_inicial_centavos=total_centavos)
);
CREATE TABLE IF NOT EXISTS tiendanube_entrega_items (
 store_id TEXT NOT NULL,
 order_hash TEXT NOT NULL,
 posicion INTEGER NOT NULL CHECK(posicion>=0),
 producto_id TEXT NOT NULL REFERENCES productos(id),
 variant_id TEXT NOT NULL,
 cantidad INTEGER NOT NULL CHECK(cantidad>0),
 precio_publicado_centavos INTEGER NOT NULL CHECK(precio_publicado_centavos>0),
 descuento_unitario_centavos INTEGER NOT NULL CHECK(descuento_unitario_centavos>=0),
 precio_unitario_centavos INTEGER NOT NULL CHECK(precio_unitario_centavos>0),
 PRIMARY KEY(store_id,order_hash,posicion),
 FOREIGN KEY(store_id,order_hash) REFERENCES tiendanube_entregas(store_id,order_hash),
 CHECK(precio_publicado_centavos-descuento_unitario_centavos=precio_unitario_centavos)
);
`;
