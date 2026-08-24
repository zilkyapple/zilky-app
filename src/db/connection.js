import pg from 'pg';
import 'dotenv/config';

const { Pool, types } = pg;

types.setTypeParser(20, (val) => parseInt(val, 10)); // bigint (SUM/COUNT) como número, no string

if (!process.env.DATABASE_URL) {
  console.error('\n✗ Falta DATABASE_URL en el .env (string de conexión a Postgres). Ver .env.example.\n');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

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
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
