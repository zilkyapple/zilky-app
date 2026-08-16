import pg from 'pg';
import 'dotenv/config';

const { Pool, types } = pg;

// Por defecto, node-postgres devuelve BIGINT (ej: resultado de SUM/COUNT) como STRING
// para no perder precisión en números gigantes. Acá nunca vamos a mover cifras que se
// acerquen a ese límite (son pesos argentinos en centavos), así que lo parseamos como
// número normal para poder sumarlo/restarlo en JS sin bugs de concatenación de string.
types.setTypeParser(20, (val) => parseInt(val, 10)); // OID 20 = int8/bigint

if (!process.env.DATABASE_URL) {
  console.error('\n✗ Falta DATABASE_URL en el .env (string de conexión a Postgres). Ver .env.example.\n');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Convierte los `?` posicionales (estilo SQLite) a `$1, $2...` (estilo Postgres),
// para no tener que reescribir a mano cada una de las queries del proyecto.
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Shim que imita la forma de node:sqlite (db.prepare(sql).get/.all/.run)
 * pero async y contra Postgres real. Así el resto del código (repositorios)
 * casi no cambia de forma: sólo se le agrega `await`.
 */
export const db = {
  prepare(sql) {
    const pgSql = toPgParams(sql);
    return {
      async get(...params) {
        const { rows } = await pool.query(pgSql, params);
        return rows[0] || undefined;
      },
      async all(...params) {
        const { rows } = await pool.query(pgSql, params);
        return rows;
      },
      async run(...params) {
        await pool.query(pgSql, params);
        return { changes: 1 };
      },
    };
  },
  async exec(sql) {
    await pool.query(sql);
  },
};
