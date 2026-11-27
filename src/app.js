import {exportacionesRouter} from './routes/exportaciones.js';
import {comisionesRouter} from './routes/comisiones.js';
import {contratosRouter} from './routes/contratos.js';
import {cajasRouter} from './routes/cajas.js';
import { tiendasRouter, tiendaPublicaRouter } from './routes/tiendas.js';
import { tiendaPedidosRouter, tiendaPedidosPublicosRouter } from './routes/tiendaPedidos.js';
import { tiendaCobrosRouter } from './routes/tiendaCobros.js';
import { tiendaMediaRouter, tiendaMediaPublicaRouter } from './routes/tiendaMedia.js';
import { tiendanubeAdminRouter, tiendanubePublicaRouter } from './routes/tiendanube.js';
import { tiendanubePedidosRouter } from './routes/tiendanubePedidos.js';
import { tiendanubeBaselineRouter } from './routes/tiendanubeBaseline.js';
import { tiendanubePrivacidadRouter } from './routes/tiendanubePrivacidad.js';
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
import { plataformaPublicaRouter, suscripcionRouter, plataformaAdminRouter } from './routes/plataforma.js';
import { modoSaaS } from './plataforma/config.js';
import { precioActualCentavos } from './plataforma/precio.js';
import { readFile } from 'node:fs/promises';
import { resolverCuenta, exigirSuscripcionActiva, exigirFuncion, noDisponibleEnSaaS } from './plataforma/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.set('trust proxy', 1);
app.set('query parser', 'simple');

app.use((req,res,next)=>{
  // En la edición de venta se permite el formulario seguro de tarjetas de Mercado Pago.
  const mpSrc = modoSaaS() ? ' https://sdk.mercadopago.com https://*.mercadopago.com https://*.mercadopago.com.ar https://*.mercadolibre.com https://*.mlstatic.com' : '';
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${mpSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${mpSrc}; font-src 'self' https://fonts.gstatic.com${mpSrc}; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'${mpSrc}; frame-src 'self'${mpSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.path.startsWith('/api'))res.setHeader('Cache-Control','no-store');
  else if(['/', '/index.html', '/app.js', '/styles.css', '/tienda.html', '/tienda.js', '/tienda.css', '/tiendaAdmin.js', '/tiendaAdmin.css', '/tiendanubeAdmin.js', '/tiendanubePedidos.js', '/tiendanubeBaseline.js', '/tiendanubePrivacidad.js'].includes(req.path)||req.path.startsWith('/tienda/'))res.setHeader('Cache-Control','no-cache');
  next();
});
// Tiendanube exige HMAC sobre los bytes originales: esta ruta debe ir antes
// del parser JSON global. Ninguna ruta antigua cambia su comportamiento.
app.use('/api/tiendanube/webhook', express.raw({type:'application/json',limit:'100kb',inflate:false}));
app.use('/api/tiendanube/privacy', express.raw({type:'application/json',limit:'100kb',inflate:false}));
app.use(express.json({inflate:false}));
// Edición de venta: las rutas públicas de tienda y Tiendanube no tienen
// cuenta asociada todavía, así que ahí no existen.
app.use(['/api/tienda-publica','/api/tienda-media'], noDisponibleEnSaaS);
app.use('/api/tiendanube',(req,res,next)=>modoSaaS()?next():tiendanubePublicaRouter(req,res,next));

// El catálogo y los pedidos de clientes se abren sin una cuenta de empleado.
app.use('/api/tienda-publica', tiendaPublicaRouter);
app.use('/api/tienda-publica', tiendaPedidosPublicosRouter);
app.use('/api/tienda-media', tiendaMediaPublicaRouter);
// Alta de cuentas y avisos de Mercado Pago (sin sesión).
app.use('/api/plataforma', plataformaPublicaRouter);
// Edición de venta: la cuenta del token define el esquema de la base.
app.use('/api', resolverCuenta);

// Cargar usuario en todas las rutas /api (puede ser null si no hay token)
app.use('/api', cargarUsuario);

app.use('/api/auth', authRouter);
app.use('/api', requireAuth); // a partir de acá todo requiere token válido
app.use('/api/suscripcion', suscripcionRouter);
app.use('/api/plataforma-admin', plataformaAdminRouter);
// Edición de venta: sin suscripción al día no se puede usar el resto de la app.
app.use('/api', exigirSuscripcionActiva);
app.use('/api/tiendas', exigirFuncion('tienda'));
app.use('/api/tiendanube', exigirFuncion('tiendanube'));

app.use('/api/tiendas', tiendaMediaRouter);
app.use('/api/tiendas', tiendaCobrosRouter);
app.use('/api/tiendas', tiendaPedidosRouter);
app.use('/api/tiendas', tiendasRouter);

app.use('/api/cajas', cajasRouter);
app.use('/api/exportaciones',exportacionesRouter);
app.use('/api/comisiones', comisionesRouter);
app.use('/api/contratos', contratosRouter);
app.use('/api/negocios', negociosRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/productos', productosRouter);
app.use('/api/tiendanube', tiendanubePedidosRouter);
app.use('/api/tiendanube', tiendanubeBaselineRouter);
app.use('/api/tiendanube/privacidad-gestion', tiendanubePrivacidadRouter);
app.use('/api/tiendanube', tiendanubeAdminRouter);
app.use('/api/ventas', ventasRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/comprobantes', comprobantesRouter);
app.use('/api/usuarios', usuariosRouter);
app.use('/api/invitaciones', invitacionesRouter);

// Edición de venta: la página de venta va en "/" y la app en "/app".
// Los enlaces de invitación (/?token=...) siguen abriendo la app.
const archivoPublico = (nombre) => path.join(__dirname, '..', 'public', nombre);
let plantillaVenta = null;
async function paginaDeVenta() {
  plantillaVenta ??= await readFile(archivoPublico('landing.html'), 'utf8');
  const centavos = await precioActualCentavos();
  const precio = centavos ? new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(centavos / 100) : 'un precio fijo';
  const contacto = (process.env.PLATAFORMA_CONTACTO || '').trim();
  const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return plantillaVenta.replaceAll('{{PRECIO}}', esc(precio)).replace('{{CONTACTO}}', contacto ? `<span>Contacto: ${esc(contacto)}</span>` : '');
}
app.get('/', async (req, res, next) => {
  if (!modoSaaS() || req.query.token) return next();
  try { res.set('Cache-Control', 'no-cache').type('html').send(await paginaDeVenta()); } catch (e) { next(e); }
});
app.get('/landing.html', (req, res) => res.redirect(301, '/'));
app.get('/app', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(archivoPublico('index.html')); });
// Edición activa para el frontend, sin un pedido extra al arrancar.
app.get('/plataforma-config.js', (req,res)=>{res.type('application/javascript').set('Cache-Control','no-cache').send(`window.ZILKY_EDICION=${JSON.stringify(modoSaaS()?'saas':'propia')};`);});
app.get('/tienda/:slug', (req,res)=>res.sendFile(path.join(__dirname,'..','public','tienda.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if(!err.status || err.status>=500) console.error(err);
  res.status(err.status || 500).json({ error: (err.status && err.status<500) || err.publico ? err.message : 'Error interno' });
});
