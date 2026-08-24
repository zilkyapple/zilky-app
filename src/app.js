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
import { comprobantesRouter } from './routes/comprobantes.js';
import { usuariosRouter } from './routes/usuarios.js';
import { invitacionesRouter } from './routes/invitaciones.js';
import { cargarUsuario, requireAuth } from './middleware/authorize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(cors());
app.use(express.json());

// Cargar usuario en todas las rutas /api (puede ser null si no hay token)
app.use('/api', cargarUsuario);

app.use('/api/auth', authRouter);
app.use('/api', requireAuth); // a partir de acá todo requiere token válido

app.use('/api/negocios', negociosRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/productos', productosRouter);
app.use('/api/ventas', ventasRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/comprobantes', comprobantesRouter);
app.use('/api/usuarios', usuariosRouter);
app.use('/api/invitaciones', invitacionesRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});
