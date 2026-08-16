import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authRouter } from './routes/auth.js';
import { negociosRouter } from './routes/negocios.js';
import { clientesRouter } from './routes/clientes.js';
import { productosRouter } from './routes/productos.js';
import { ventasRouter } from './routes/ventas.js';
import { pagosRouter } from './routes/pagos.js';
import { dashboardRouter } from './routes/dashboard.js';
import { requireAuth } from './middleware/requireAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter); // registro/login: público, no requiere sesión

app.use('/api', requireAuth); // todo lo demás exige estar logueado

app.use('/api/negocios', negociosRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/productos', productosRouter);
app.use('/api/ventas', ventasRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/dashboard', dashboardRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Manejador de errores centralizado: los servicios lanzan { status, message }
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});
