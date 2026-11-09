-- Solo lectura. No ejecutar migraciones ni corregir datos desde este archivo.
-- Tablas verificadas en src/db/migrate.js. Ejecutar en transacción READ ONLY
-- sobre el esquema public ya identificado; resultados solo agregados.

SELECT 'negocios' AS tabla, count(*) AS organizacion_null FROM public.negocios WHERE organizacion_id IS NULL
UNION ALL SELECT 'clientes', count(*) FROM public.clientes WHERE organizacion_id IS NULL
UNION ALL SELECT 'productos', count(*) FROM public.productos WHERE organizacion_id IS NULL
UNION ALL SELECT 'ventas', count(*) FROM public.ventas WHERE organizacion_id IS NULL
UNION ALL SELECT 'creditos', count(*) FROM public.creditos WHERE organizacion_id IS NULL
UNION ALL SELECT 'pagos', count(*) FROM public.pagos WHERE organizacion_id IS NULL
UNION ALL SELECT 'comprobantes', count(*) FROM public.comprobantes WHERE organizacion_id IS NULL
UNION ALL SELECT 'auditoria', count(*) FROM public.auditoria WHERE organizacion_id IS NULL;

-- to_jsonb permite verificar también instalaciones antiguas sin columna token
-- o token_hash. Nunca se devuelve el token ni el hash.
WITH invitaciones_preflight AS (
  SELECT to_jsonb(i)->>'token_hash' AS token_hash,
         to_jsonb(i)->>'token' AS token
  FROM public.invitaciones i
), finales AS (
  SELECT token_hash, token,
         COALESCE(token_hash, CASE WHEN token IS NOT NULL
           THEN encode(sha256(convert_to(token, 'UTF8')), 'hex') END) AS hash_final
  FROM invitaciones_preflight
)
SELECT count(*) AS total,
       count(*) FILTER (WHERE token_hash IS NULL) AS hash_null,
       count(*) FILTER (WHERE token_hash IS NULL AND token IS NOT NULL) AS backfill_hash,
       count(*) FILTER (WHERE hash_final IS NULL) AS bloquean_falta_hash_y_token,
       (SELECT count(*) FROM (
         SELECT hash_final FROM finales WHERE hash_final IS NOT NULL
         GROUP BY hash_final HAVING count(*) > 1
       ) duplicados) AS grupos_hash_final_duplicado
FROM finales;

-- Son los pagos incluidos exactamente por idx_entrega_inicial_credito.
-- Los NULL de credito_id no chocan entre sí en ese índice UNIQUE normal.
SELECT count(*) AS creditos_con_entrega_inicial_duplicada,
       COALESCE(sum(cantidad - 1), 0) AS filas_excedentes
FROM (
  SELECT credito_id, count(*) AS cantidad
  FROM public.pagos
  WHERE tipo = 'entrega_inicial' AND anulado = 0 AND credito_id IS NOT NULL
  GROUP BY credito_id HAVING count(*) > 1
) duplicados;

SELECT c.relname AS indice, i.indisunique AS unico,
       i.indisvalid AS valido, i.indisready AS listo,
       pg_get_indexdef(c.oid) AS definicion
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'idx_entrega_inicial_credito';

-- Otros backfills heredados: deben explicarse, no corregirse automáticamente.
SELECT
  (SELECT count(*) FROM public.usuarios WHERE invitacion_completada IS NULL) AS usuarios_invitacion_null,
  (SELECT count(*) FROM public.usuarios u WHERE NOT EXISTS (
    SELECT 1 FROM public.usuario_organizacion uo WHERE uo.usuario_id = u.id
  )) AS usuarios_sin_organizacion,
  (SELECT count(*) FROM (
    SELECT cliente_id, negocio_id FROM public.ventas
    UNION SELECT cliente_id, negocio_id FROM public.creditos
    UNION SELECT cliente_id, negocio_id FROM public.pagos
    EXCEPT SELECT cliente_id, negocio_id FROM public.cliente_negocio
  ) faltantes) AS relaciones_cliente_negocio_faltantes,
  EXISTS(SELECT 1 FROM public.organizaciones WHERE id = 'default') AS organizacion_default_existe;
