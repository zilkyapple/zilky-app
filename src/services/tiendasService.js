import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { integer, text } from '../lib/validation.js';
import { fail, huella, solicitudId } from '../lib/solicitud.js';
import { auditar } from '../lib/audit.js';
import { nuevoProducto } from './productosService.js';

const MAX_PRODUCTOS = 500;
const camposProducto = ['nombre', 'descripcion', 'categoria', 'modelos', 'talle', 'color', 'publicado', 'precio_centavos', 'orden'];
const lockCatalogo = n => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalogo:' + n]);
function objeto(b) { if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('Datos inválidos'); }
function soloCampos(b, campos) { objeto(b); if (Object.keys(b).some(k => !campos.includes(k))) throw fail('Campo no permitido'); }
function cadena(v, campo, max, requerida = false) {
  if (requerida) return text(v, campo, max);
  if (typeof v !== 'string' || v.length > max) throw fail(`${campo} inválido`);
  return v.trim();
}
function textos(v, campo) {
  if (!Array.isArray(v) || v.length > 40) throw fail(`${campo} debe ser una lista de hasta 40 opciones`);
  const out = [], seen = new Set();
  for (const x of v) { const value = text(x, campo, 120), key = value.toLocaleLowerCase('es-AR'); if (!seen.has(key)) { seen.add(key); out.push(value); } }
  return out;
}
async function negocioExistente(n) {
  if (typeof n !== 'string' || !n) throw fail('Seleccioná un negocio');
  const negocio = await db.prepare('SELECT id,nombre FROM negocios WHERE id=?').get(n);
  if (!negocio) throw fail('Negocio no encontrado', 404);
  return negocio;
}
export async function configTienda(n) {
  const negocio = await negocioExistente(n);
  const guardada = await db.prepare('SELECT * FROM tiendas_config WHERE negocio_id=?').get(n);
  return guardada || { negocio_id: n, habilitada: false, slug: '', nombre: negocio.nombre, descripcion: '', tipo: 'general', whatsapp: '', secciones: [] };
}
export async function vistaTienda(n) {
  const config = await configTienda(n);
  const stats = await db.prepare(`SELECT count(*)::int productos,count(*) FILTER(WHERE publicado)::int publicados FROM tienda_productos WHERE negocio_id=?`).get(n);
  const pedidos = await db.prepare("SELECT count(*)::int cantidad FROM tienda_pedidos WHERE negocio_id=? AND estado='pendiente'").get(n);
  return { config, estadisticas: { ...stats, pedidos_pendientes: pedidos.cantidad } };
}
async function reintento(n, accion, b, actor) {
  const log = await db.prepare(`SELECT * FROM auditoria WHERE entidad='tienda' AND entidad_id=? AND accion=? AND datos_nuevos::jsonb->>'solicitud_id'=? LIMIT 1`).get(n, accion, b.solicitud_id);
  if (!log) return null;
  const datos = JSON.parse(log.datos_nuevos);
  if (datos.huella !== huella(b) || log.empleado !== actor) throw fail('La solicitud ya se usó con otros datos', 409);
  return datos.respuesta;
}
async function registrar(n, accion, b, actor, anterior, respuesta) {
  await auditar('tienda', n, accion, anterior, { solicitud_id: b.solicitud_id, huella: huella(b), respuesta }, actor);
  return respuesta;
}
export async function guardarConfigTienda(n, b, actor) {
  soloCampos(b, ['negocio_id', 'solicitud_id', 'habilitada', 'slug', 'nombre', 'descripcion', 'tipo', 'whatsapp', 'secciones']);
  solicitudId(b.solicitud_id);
  return db.transaction(async () => {
    await lockCatalogo(n);
    const previo = await reintento(n, 'configurar', b, actor); if (previo) return previo;
    const old = await configTienda(n), next = { ...old };
    if ('habilitada' in b) { if (typeof b.habilitada !== 'boolean') throw fail('Estado de tienda inválido'); next.habilitada = b.habilitada; }
    if ('slug' in b) {
      const slug = cadena(b.slug, 'Dirección de tienda', 60).toLowerCase();
      if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw fail('La dirección sólo admite letras sin acentos, números y guiones');
      if (slug && slug.length < 3) throw fail('La dirección requiere al menos 3 caracteres');
      next.slug = slug || null;
    }
    if ('nombre' in b) next.nombre = cadena(b.nombre, 'Nombre de tienda', 180, true);
    if ('descripcion' in b) next.descripcion = cadena(b.descripcion, 'Descripción', 4000);
    if ('tipo' in b) { if (!['iphone', 'ropa', 'general'].includes(b.tipo)) throw fail('Tipo de tienda inválido'); next.tipo = b.tipo; }
    if ('whatsapp' in b) {
      const value = cadena(b.whatsapp, 'WhatsApp', 40), digits = value.replace(/\D/g, '');
      if (value && (!/^[+\d\s()-]+$/.test(value) || digits.length < 7 || digits.length > 18)) throw fail('WhatsApp inválido');
      next.whatsapp = digits;
    }
    if ('secciones' in b) next.secciones = textos(b.secciones, 'Secciones');
    if (next.habilitada && !next.slug) throw fail('Elegí una dirección para habilitar la tienda');
    if (next.slug && await db.prepare('SELECT negocio_id FROM tiendas_config WHERE slug=? AND negocio_id<>?').get(next.slug, n)) throw fail('Esa dirección ya pertenece a otra tienda', 409);
    try {
      await db.prepare(`INSERT INTO tiendas_config(negocio_id,habilitada,slug,nombre,descripcion,tipo,whatsapp,secciones) VALUES(?,?,?,?,?,?,?,?::jsonb)
        ON CONFLICT(negocio_id) DO UPDATE SET habilitada=excluded.habilitada,slug=excluded.slug,nombre=excluded.nombre,descripcion=excluded.descripcion,tipo=excluded.tipo,whatsapp=excluded.whatsapp,secciones=excluded.secciones,updated_at=now()`)
        .run(n, next.habilitada, next.slug || null, next.nombre, next.descripcion, next.tipo, next.whatsapp, JSON.stringify(next.secciones));
    } catch (error) { if (error.code === '23505') throw fail('Esa dirección ya pertenece a otra tienda', 409); throw error; }
    return registrar(n, 'configurar', b, actor, old, await vistaTienda(n));
  });
}
function camposListado(b) {
  const out = {};
  if ('nombre' in b) out.nombre = cadena(b.nombre, 'Nombre', 180, true);
  for (const [campo, max] of [['descripcion', 4000], ['categoria', 120], ['talle', 80], ['color', 80]]) if (campo in b) out[campo] = cadena(b[campo], campo, max);
  if ('modelos' in b) out.modelos = textos(b.modelos, 'Modelos');
  if ('publicado' in b) { if (typeof b.publicado !== 'boolean') throw fail('Publicación inválida'); out.publicado = b.publicado; }
  if ('precio_centavos' in b) out.precio_centavos = integer(b.precio_centavos, 'Precio', { min: 0, max: 2147483647 });
  if ('orden' in b) out.orden = integer(b.orden, 'Orden', { min: 0, max: 1000000 });
  return out;
}
const versionProducto = p => huella(Object.fromEntries(['id', 'negocio_id', 'producto_id', ...camposProducto, 'revision'].map(k => [k, p[k]])));
async function mediaPorProductos(ids) {
  const result = new Map(); if (!ids.length) return result;
  const medios = await db.prepare('SELECT id,tienda_producto_id,tipo,orden FROM tienda_media WHERE tienda_producto_id=ANY(?::text[]) ORDER BY orden,id').all(ids);
  for (const m of medios) { if (!result.has(m.tienda_producto_id)) result.set(m.tienda_producto_id, []); result.get(m.tienda_producto_id).push({ id: m.id, tipo: m.tipo, url: '/api/tienda-media/' + encodeURIComponent(m.id), orden: m.orden }); }
  return result;
}
async function enriquecer(rows, publico = false) {
  const media = await mediaPorProductos(rows.map(p => p.id));
  const componentes = rows.length ? await db.prepare(`SELECT c.combo_id,c.cantidad,p.stock FROM producto_combo_componentes c JOIN productos p ON p.id=c.producto_id WHERE c.combo_id=ANY(?::text[])`).all(rows.map(p => p.producto_id)) : [];
  return rows.map(p => {
    const parts = componentes.filter(c => c.combo_id === p.producto_id);
    const stocks = parts.length ? parts.filter(c => c.stock !== null).map(c => Math.floor(c.stock / c.cantidad)) : p.stock === null ? [] : [p.stock];
    const stock = stocks.length ? Math.max(0, Math.min(...stocks)) : null;
    const base = { id: p.id, nombre: p.nombre, descripcion: p.descripcion, categoria: p.categoria, modelos: p.modelos, talle: p.talle, color: p.color,
      precio_centavos: p.precio_centavos, disponible: stock === null || stock > 0, stock_disponible: stock, media: media.get(p.id) || [] };
    return publico ? base : { ...p, ...base, stock: p.stock, version: versionProducto(p) };
  });
}
export async function listarProductosTienda(n) {
  await negocioExistente(n);
  return enriquecer(await db.prepare(`SELECT t.*,p.stock FROM tienda_productos t JOIN productos p ON p.id=t.producto_id AND p.negocio_id=t.negocio_id WHERE t.negocio_id=? ORDER BY t.orden,t.nombre,t.id LIMIT ?`).all(n, MAX_PRODUCTOS));
}
async function productoTienda(n, webId) {
  const row = await db.prepare('SELECT t.*,p.stock FROM tienda_productos t JOIN productos p ON p.id=t.producto_id AND p.negocio_id=t.negocio_id WHERE t.id=? AND t.negocio_id=?').get(webId, n);
  if (!row) throw fail('Producto de tienda no encontrado', 404);
  return (await enriquecer([row]))[0];
}
export async function catalogoExistenteTienda(n) {
  await negocioExistente(n);
  return db.prepare(`SELECT p.id,p.nombre,p.categoria,p.variante,p.precio_contado_centavos,p.precio_financiado_centavos,p.stock,p.foto_url,
    EXISTS(SELECT 1 FROM producto_combo_componentes c WHERE c.combo_id=p.id) combo FROM productos p WHERE p.negocio_id=? ORDER BY p.nombre,p.id LIMIT ?`).all(n, MAX_PRODUCTOS);
}
export async function crearProductoTienda(n, b, actor) {
  soloCampos(b, ['negocio_id', 'solicitud_id', 'producto_id', 'stock', ...camposProducto]);
  solicitudId(b.solicitud_id);
  const campos = camposListado(b);
  if ('producto_id' in b && (typeof b.producto_id !== 'string' || !b.producto_id)) throw fail('Producto de inventario inválido');
  if (b.producto_id && 'stock' in b) throw fail('El stock existente se administra desde Productos');
  if ('stock' in b) integer(b.stock, 'Stock inicial', { min: 0 });
  return db.transaction(async () => {
    await lockCatalogo(n);
    const previo = await reintento(n, 'crear_producto', b, actor); if (previo) return previo;
    await negocioExistente(n);
    const count = await db.prepare('SELECT count(*)::int cantidad FROM tienda_productos WHERE negocio_id=?').get(n);
    if (count.cantidad >= MAX_PRODUCTOS) throw fail('La tienda admite hasta 500 productos', 409);
    let producto;
    if (b.producto_id) {
      producto = await db.prepare('SELECT id,nombre,categoria,precio_contado_centavos FROM productos WHERE id=? AND negocio_id=?').get(b.producto_id, n);
      if (!producto) throw fail('Producto no encontrado en este negocio', 404);
      if (await db.prepare('SELECT id FROM tienda_productos WHERE negocio_id=? AND producto_id=?').get(n, producto.id)) throw fail('Este producto ya está en la tienda', 409);
    } else {
      if (!campos.nombre || campos.precio_centavos === undefined) throw fail('Indicá nombre y precio para crear un producto');
      producto = await nuevoProducto({ negocio_id: n, nombre: campos.nombre, categoria: campos.categoria || '',
        variante: [campos.talle, campos.color].filter(Boolean).join(' · '), precio_contado_centavos: campos.precio_centavos,
        precio_financiado_centavos: campos.precio_centavos, stock: b.stock ?? 0 }, actor);
    }
    const values = { nombre: producto.nombre, descripcion: '', categoria: producto.categoria || '', modelos: [], talle: '', color: '',
      publicado: false, precio_centavos: producto.precio_contado_centavos, orden: 0, ...campos };
    const webId = id();
    await db.prepare(`INSERT INTO tienda_productos(id,negocio_id,producto_id,nombre,descripcion,categoria,modelos,talle,color,publicado,precio_centavos,orden) VALUES(?,?,?,?,?,?,?::jsonb,?,?,?,?,?)`)
      .run(webId, n, producto.id, values.nombre, values.descripcion, values.categoria, JSON.stringify(values.modelos), values.talle, values.color, values.publicado, values.precio_centavos, values.orden);
    return registrar(n, 'crear_producto', b, actor, null, await productoTienda(n, webId));
  });
}
export async function editarProductoTienda(n, webId, b, actor) {
  soloCampos(b, ['negocio_id', 'solicitud_id', 'version', ...camposProducto]);
  solicitudId(b.solicitud_id);
  if (typeof b.version !== 'string' || !/^[a-f0-9]{64}$/.test(b.version)) throw fail('Volvé a abrir el producto antes de guardar');
  const campos = camposListado(b); if (!Object.keys(campos).length) throw fail('No hay cambios');
  return db.transaction(async () => {
    await lockCatalogo(n);
    const solicitud = { ...b, producto_web_id: webId };
    const previo = await reintento(n, 'editar_producto', solicitud, actor); if (previo) return previo;
    const old = await productoTienda(n, webId);
    if (versionProducto(old) !== b.version) throw fail('El producto cambió. Volvé a abrirlo antes de guardar.', 409);
    const keys = Object.keys(campos);
    await db.prepare(`UPDATE tienda_productos SET ${keys.map(k => k + '=?' + (k === 'modelos' ? '::jsonb' : '')).join(',')},revision=revision+1,updated_at=now() WHERE id=? AND negocio_id=?`)
      .run(...keys.map(k => k === 'modelos' ? JSON.stringify(campos[k]) : campos[k]), webId, n);
    return registrar(n, 'editar_producto', solicitud, actor, old, await productoTienda(n, webId));
  });
}
export async function tiendaPublica(slug) {
  if (typeof slug !== 'string' || slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw fail('Tienda no encontrada', 404);
  const config = await db.prepare('SELECT * FROM tiendas_config WHERE slug=? AND habilitada').get(slug);
  if (!config) throw fail('Tienda no encontrada', 404);
  const rows = await db.prepare(`SELECT t.*,p.stock FROM tienda_productos t JOIN productos p ON p.id=t.producto_id AND p.negocio_id=t.negocio_id WHERE t.negocio_id=? AND t.publicado ORDER BY t.orden,t.nombre,t.id LIMIT ?`).all(config.negocio_id, MAX_PRODUCTOS);
  return { tienda: Object.fromEntries(['slug', 'nombre', 'descripcion', 'tipo', 'whatsapp', 'secciones'].map(k => [k, config[k]])), productos: await enriquecer(rows, true) };
}
