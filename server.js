import 'dotenv/config';
import { migrate } from './db/migrate.js';
import { app } from './app.js';

await migrate();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Zilky App corriendo en http://localhost:${PORT}\n`);
});
