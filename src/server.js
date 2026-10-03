import 'dotenv/config';
import { migrate } from './db/migrate.js';
import { app } from './app.js';

// Migraciones explícitas por defecto; no alterar la base al arrancar.
if (process.env.MIGRATE_ON_START === 'true') await migrate();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Zilky App corriendo en http://localhost:${PORT}\n`);
});
