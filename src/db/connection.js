import pg from 'pg';
import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
const { Pool, types } = pg;
types.setTypeParser(20, (v) => Number(v));
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: true } });
const transactions = new AsyncLocalStorage();
function paramsSql(sql) { let i=0; return sql.replace(/\?/g, () => `$${++i}`); }
export const db = {
  query(sql, params=[]) { return (transactions.getStore() || pool).query(sql, params); },
  prepare(sql) {
    const text=paramsSql(sql);
    return {
      async get(...params) { return (await db.query(text, params)).rows[0]; },
      async all(...params) { return (await db.query(text, params)).rows; },
      async run(...params) { return { changes: (await db.query(text, params)).rowCount }; },
    };
  },
  async exec(sql) { await db.query(sql); },
  async transaction(fn) {
    const current=transactions.getStore();
    if (current) return fn(current);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const result=await transactions.run(client, () => fn(client));
      await client.query('COMMIT'); return result;
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
  // Serializa operaciones que comparten cuotas/saldo a favor, incluso entre créditos.
  async lockClienteNegocio(clienteId, negocioId) {
    if (!transactions.getStore()) throw new Error('El bloqueo requiere una transacción');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([clienteId, negocioId])]);
  },
};
