import 'dotenv/config';
import { migrate } from './db/migrate.js';
import { app } from './app.js';
import { db } from './db/connection.js';
import { iniciarTiendanubeWorker } from './services/tiendanubeWorker.js';

// Migraciones explícitas por defecto; no alterar la base al arrancar.
if (process.env.MIGRATE_ON_START === 'true') {
  if (process.env.EDICION === 'saas') await (await import('./plataforma/esquema.js')).migrarPlataforma();
  else await migrate();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Zilky App corriendo en http://localhost:${PORT}\n`);
});
// En la edición de venta Tiendanube queda apagado hasta reconstruirlo por cuenta.
if (process.env.EDICION !== 'saas') iniciarTiendanubeWorker({db,onError:codigo=>console.warn(codigo)});
