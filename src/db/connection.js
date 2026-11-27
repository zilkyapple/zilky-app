import pg from 'pg';
import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
const { Pool, types } = pg;
types.setTypeParser(20, (v) => Number(v));
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: true } });
const transactions = new AsyncLocalStorage();
// Edición de venta: cada cuenta tiene su propio esquema de Postgres con las
// mismas tablas. Mientras dura una petición, todas las consultas usan una
// conexión cuyo search_path apunta SOLO a ese esquema (sin public), así una
// cuenta no puede leer ni escribir tablas de otra aunque un permiso falle.
const cuentas = new AsyncLocalStorage();
export const ESQUEMA_CUENTA = /^t_[a-z0-9]{16,40}$/;
export function esquemaActual() { return cuentas.getStore()?.esquema || null; }
function clienteCuenta() {
  const store=cuentas.getStore();
  if (!store) return null;
  if (store.cerrado) throw new Error('La conexión de la cuenta ya fue liberada');
  return store.client;
}
async function abrirCuenta(esquema) {
  if (!ESQUEMA_CUENTA.test(esquema||'')) throw Object.assign(new Error('Cuenta inválida'),{status:401});
  const client=await pool.connect();
  try { await client.query(`SET search_path TO "${esquema}"`); }
  catch (error) { client.release(error); throw error; }
  const store={esquema,client,cerrado:false};
  const cerrar=async()=>{
    if (store.cerrado) return; store.cerrado=true;
    try { await client.query('RESET search_path'); client.release(); } catch (error) { client.release(error); }
  };
  return {store,cerrar};
}
// Para tareas fuera de una petición (migraciones, alta de cuentas, webhooks).
export async function conCuenta(esquema, fn) {
  const {store,cerrar}=await abrirCuenta(esquema);
  try { return await cuentas.run(store, fn); } finally { await cerrar(); }
}
// Para una petición HTTP: la conexión vive hasta que termina la respuesta.
export async function entrarCuentaEnPeticion(res, esquema, next) {
  const {store,cerrar}=await abrirCuenta(esquema);
  res.once('finish', cerrar); res.once('close', cerrar);
  return cuentas.run(store, next);
}
function paramsSql(sql) { let i=0; return sql.replace(/\?/g, () => `$${++i}`); }
export const db = {
  query(sql, params=[]) { return (transactions.getStore() || clienteCuenta() || pool).query(sql, params); },
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
    const propio=clienteCuenta();
    const client=propio || await pool.connect();
    try {
      await client.query('BEGIN');
      const result=await transactions.run(client, () => fn(client));
      await client.query('COMMIT'); return result;
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { if (!propio) client.release(); }
  },
  // Serializa operaciones que comparten cuotas/saldo a favor, incluso entre créditos.
  async lockClienteNegocio(clienteId, negocioId) {
    if (!transactions.getStore()) throw new Error('El bloqueo requiere una transacción');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([clienteId, negocioId])]);
  },
};
