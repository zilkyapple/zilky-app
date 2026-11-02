import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { auditar } from '../lib/audit.js';
import { integer, text } from '../lib/validation.js';
import { fail, huella, solicitudId } from '../lib/solicitud.js';
import { nowAR, todayAR } from '../lib/dates.js';
import { resumenCobrosPedido } from '../lib/tiendaCobros.js';

const estados = ['pendiente', 'confirmado', 'cancelado'];
const maxImporte = 2147483647;
function objeto(value, campos, nombre) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !campos.includes(k))) throw fail(`${nombre} inválido`);
}
function total(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  if (values.some(v => !Number.isSafeInteger(v) || v < 0) || !Number.isSafeInteger(sum) || sum > maxImporte) throw fail('El importe o la cantidad del pedido está fuera de rango');
  return sum;
}
export function normalizarTelefonoTienda(value) {
  if (typeof value !== 'string' || value.length > 60 || !/^\+?[\d\s().-]+$/.test(value.trim())) throw fail('Ingresá un celular argentino válido');
  let numero = value.replace(/\D/g, '');
  if (numero.startsWith('00')) numero = numero.slice(2);
  if (numero.startsWith('549')) numero = numero.slice(3);
  else if (numero.startsWith('54')) numero = numero.slice(2);
  if (numero.startsWith('0')) numero = numero.slice(1);
  if (numero.length === 12) numero = numero.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  if (numero.length === 11 && numero.startsWith('9')) numero = numero.slice(1);
  if (!/^[1-9]\d{9}$/.test(numero)) throw fail('Ingresá un celular argentino válido, con código de área');
  return '+549' + numero;
}
function contactoValido(input) {
  objeto(input, ['nombre', 'apellido', 'telefono', 'email'], 'Contacto');
  const nombre = text(input.nombre, 'Nombre', 100), apellido = text(input.apellido, 'Apellido', 100);
  const telefono = normalizarTelefonoTienda(input.telefono);
  const email = input.email == null || input.email === '' ? '' : text(input.email, 'Email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('El email no es válido');
  return { nombre, apellido, telefono, email };
}
function publico(pedido, items) {
  // Es el comprobante de recepción original, no una consulta de estado o datos personales.
  return { id: pedido.id, codigo: pedido.codigo, estado: 'pendiente', total_centavos: pedido.total_centavos,
    items: items.map(i => ({ producto_id: i.producto_web_id, nombre: i.nombre, cantidad: i.cantidad, precio_unitario_centavos: i.precio_unitario_centavos, subtotal_centavos: i.subtotal_centavos, es_encargo: i.es_encargo === true })) };
}
function cantidadesDeItems(items) {
  const resultado = new Map();
  for (const item of items) {
    integer(item.cantidad, 'Cantidad', { min: 1, max: 999 });
    if (!Array.isArray(item.componentes)) throw fail('Los componentes del pedido requieren revisión', 409);
    const piezas = item.componentes.length ? item.componentes : [{ producto_id: item.producto_id, cantidad: 1 }];
    for (const pieza of piezas) {
      if (typeof pieza.producto_id !== 'string' || !pieza.producto_id) throw fail('Un componente del pedido requiere revisión', 409);
      integer(pieza.cantidad, 'Cantidad de componentes', { min: 1 });
      resultado.set(pieza.producto_id, total([resultado.get(pieza.producto_id) || 0, pieza.cantidad * item.cantidad]));
    }
  }
  return resultado;
}
async function productosInventario(n, cantidades, bloquear = false) {
  const productos = [];
  for (const productoId of [...cantidades.keys()].sort()) {
    const producto = await db.prepare('SELECT id,negocio_id,nombre,stock FROM productos WHERE id=? AND negocio_id=?' + (bloquear ? ' FOR UPDATE' : '')).get(productoId, n);
    if (!producto) throw fail('Un producto del pedido ya no está disponible en este negocio', 409);
    productos.push(producto);
  }
  return productos;
}

export async function crearPedidoPublico(slug, input, { antesDeCrear } = {}) {
  objeto(input, ['solicitud_id', 'contacto', 'items', 'nota', 'acepta_contacto', 'total_esperado_centavos'], 'Pedido');
  solicitudId(input.solicitud_id);
  const contacto = contactoValido(input.contacto);
  if (input.acepta_contacto !== true) throw fail('Aceptá que el negocio pueda contactarte sobre el pedido');
  if (input.total_esperado_centavos !== undefined) integer(input.total_esperado_centavos, 'Total esperado');
  const nota = input.nota == null || input.nota === '' ? null : text(input.nota, 'Nota', 1000);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw fail('Elegí entre 1 y 100 productos');
  const vistos = new Set();
  for (const item of input.items) {
    objeto(item, ['producto_id', 'cantidad', 'es_encargo'], 'Producto del pedido');
    if (typeof item.producto_id !== 'string' || !item.producto_id || item.producto_id.length > 100 || vistos.has(item.producto_id)) throw fail('El pedido tiene productos repetidos o inválidos');
    vistos.add(item.producto_id); integer(item.cantidad, 'Cantidad', { min: 1, max: 999 });
    if (item.es_encargo !== undefined && typeof item.es_encargo !== 'boolean') throw fail('Indicá si el producto es un encargo');
  }
  const solicitudHash = huella(input);
  return db.transaction(async () => {
    const inicial = await db.prepare('SELECT negocio_id FROM tiendas_config WHERE slug=?').get(slug);
    if (!inicial) throw fail('Tienda no disponible', 404);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['tienda-pedido:' + inicial.negocio_id + ':' + input.solicitud_id]);
    const anterior = await db.prepare('SELECT * FROM tienda_pedidos WHERE negocio_id=? AND solicitud_id=?').get(inicial.negocio_id, input.solicitud_id);
    if (anterior) {
      if (anterior.solicitud_hash !== solicitudHash) throw fail('La solicitud ya corresponde a otro pedido', 409);
      return publico(anterior, await db.prepare('SELECT * FROM tienda_pedido_items WHERE pedido_id=? ORDER BY id').all(anterior.id));
    }
    if (antesDeCrear) await antesDeCrear();
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalogo:' + inicial.negocio_id]);
    const tienda = await db.prepare('SELECT * FROM tiendas_config WHERE negocio_id=? AND slug=? FOR SHARE').get(inicial.negocio_id, slug);
    if (!tienda?.habilitada) throw fail('Tienda no disponible', 404);
    const items = [];
    for (const inputItem of input.items) {
      const ficha = await db.prepare('SELECT * FROM tienda_productos WHERE id=? AND negocio_id=? AND publicado=TRUE FOR SHARE').get(inputItem.producto_id, tienda.negocio_id);
      if (!ficha) throw fail('Un producto del carrito ya no está publicado. Revisá el catálogo.', 409);
      const inventario = await db.prepare('SELECT id FROM productos WHERE id=? AND negocio_id=?').get(ficha.producto_id, tienda.negocio_id);
      if (!inventario) throw fail('Un producto del carrito no está disponible', 409);
      const componentesDb = await db.prepare(`SELECT c.producto_id,c.cantidad,p.nombre,p.negocio_id FROM producto_combo_componentes c JOIN productos p ON p.id=c.producto_id
        WHERE c.combo_id=? ORDER BY c.producto_id`).all(ficha.producto_id);
      if (componentesDb.some(c => c.negocio_id !== tienda.negocio_id)) throw fail('Los componentes del producto no están disponibles', 409);
      const componentes = componentesDb.map(({ producto_id, cantidad, nombre }) => ({ producto_id, cantidad, nombre }));
      integer(ficha.precio_centavos, 'Precio');
      items.push({ id: id(), producto_web_id: ficha.id, producto_id: ficha.producto_id, nombre: ficha.nombre, descripcion: ficha.descripcion,
        cantidad: inputItem.cantidad, precio_unitario_centavos: ficha.precio_centavos, subtotal_centavos: total([ficha.precio_centavos * inputItem.cantidad]), componentes,
        es_encargo: inputItem.es_encargo === true, opciones: { modelos: ficha.modelos, talle: ficha.talle, color: ficha.color } });
    }
    const cantidades = cantidadesDeItems(items), inventario = await productosInventario(tienda.negocio_id, cantidades);
    const cantidadesNormales = cantidadesDeItems(items.filter(i => !i.es_encargo));
    if (inventario.some(p => (cantidadesNormales.get(p.id) || 0) > 0 && p.stock !== null && p.stock < cantidadesNormales.get(p.id))) throw fail('No hay stock suficiente para el carrito. Actualizá el catálogo.', 409);
    const pedidoId = id(), codigo = 'WEB-' + todayAR().replaceAll('-', '') + '-' + pedidoId.replaceAll('-', '').toUpperCase();
    const importe = total(items.map(i => i.subtotal_centavos));
    if (input.total_esperado_centavos !== undefined && input.total_esperado_centavos !== importe) throw fail('Los precios cambiaron; revisá tu carrito antes de confirmar el pedido.', 409);
    await db.prepare(`INSERT INTO tienda_pedidos(id,negocio_id,codigo,solicitud_id,solicitud_hash,contacto,nota,acepta_contacto,total_centavos)
      VALUES(?,?,?,?,?,?::jsonb,?,TRUE,?)`).run(pedidoId, tienda.negocio_id, codigo, input.solicitud_id, solicitudHash, JSON.stringify(contacto), nota, importe);
    for (const item of items) await db.prepare(`INSERT INTO tienda_pedido_items(id,pedido_id,producto_web_id,producto_id,nombre,descripcion,precio_unitario_centavos,cantidad,subtotal_centavos,componentes,es_encargo,opciones)
      VALUES(?,?,?,?,?,?,?,?,?,?::jsonb,?,?::jsonb)`).run(item.id, pedidoId, item.producto_web_id, item.producto_id, item.nombre, item.descripcion, item.precio_unitario_centavos, item.cantidad, item.subtotal_centavos, JSON.stringify(item.componentes), item.es_encargo, JSON.stringify(item.opciones));
    await db.prepare('INSERT INTO tienda_contactos(id,pedido_id,negocio_id,nombre,apellido,telefono,email,acepta_contacto) VALUES(?,?,?,?,?,?,?,TRUE)').run(id(), pedidoId, tienda.negocio_id, contacto.nombre, contacto.apellido, contacto.telefono, contacto.email);
    const pedido = await db.prepare('SELECT * FROM tienda_pedidos WHERE id=?').get(pedidoId);
    await auditar('tienda_pedido', pedidoId, 'crear', null, { negocio_id: tienda.negocio_id, pedido, items }, null, 'Pedido recibido desde la tienda web; pendiente de confirmación');
    return publico(pedido, items.sort((a, b) => a.id.localeCompare(b.id)));
  });
}

async function cargar(n, pedidoId, bloquear = false) {
  const pedido = await db.prepare('SELECT * FROM tienda_pedidos WHERE id=? AND negocio_id=?' + (bloquear ? ' FOR UPDATE' : '')).get(pedidoId, n);
  if (!pedido) throw fail('Pedido no encontrado en este negocio', 404);
  if (bloquear) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalogo:' + n]);
  const items = await db.prepare('SELECT * FROM tienda_pedido_items WHERE pedido_id=? ORDER BY id').all(pedidoId);
  let cantidades = new Map();
  if (pedido.estado === 'pendiente') cantidades = cantidadesDeItems(items);
  else if (pedido.estado === 'confirmado') {
    if (!Array.isArray(pedido.stock_movimientos)) throw fail('El stock descontado del pedido requiere conciliación', 409);
    for (const m of pedido.stock_movimientos) if (m.cantidad > 0) cantidades.set(m.producto_id, total([cantidades.get(m.producto_id) || 0, m.cantidad]));
  }
  const productos = await productosInventario(n, cantidades, bloquear);
  const stock = productos.map(p => {
    const cantidad = cantidades.get(p.id), sumaStock = pedido.estado === 'confirmado' ? cantidad : -cantidad;
    const despues = p.stock === null ? null : p.stock + sumaStock;
    if (despues !== null && (!Number.isSafeInteger(despues) || despues > maxImporte || despues < -2147483648)) throw fail('El stock resultante requiere conciliación', 409);
    return { producto_id: p.id, nombre: p.nombre, cantidad, stock_actual: p.stock, stock_despues: despues, controlado: p.stock !== null, insuficiente: pedido.estado === 'pendiente' && p.stock !== null && p.stock < cantidad };
  });
  const { cobros, resumen_cobros } = await resumenCobrosPedido(pedido);
  const has_encargos = items.some(i => i.es_encargo);
  const version = huella({ pedido, items, stock, cobros, resumen_cobros });
  return { pedido, items, stock, cobros, resumen_cobros, has_encargos, version };
}
function detallePublicable(v) {
  const { solicitud_hash, solicitud_id, ...pedido } = v.pedido;
  return { pedido: { ...pedido, has_encargos: v.has_encargos }, items: v.items, stock: v.stock, cobros: v.cobros, resumen_cobros: v.resumen_cobros, has_encargos: v.has_encargos, version: v.version };
}
export async function listarPedidosTienda(n, { estado, encargos } = {}) {
  if (estado !== undefined && !estados.includes(estado)) throw fail('Estado de pedido inválido');
  if (encargos !== undefined && !['true', 'false'].includes(encargos)) throw fail('Filtro de encargos inválido');
  const tiene = 'EXISTS(SELECT 1 FROM tienda_pedido_items i WHERE i.pedido_id=p.id AND i.es_encargo=TRUE)';
  return (await db.prepare('SELECT p.*,' + tiene + ' AS has_encargos FROM tienda_pedidos p WHERE p.negocio_id=?' + (estado ? ' AND p.estado=?' : '') + (encargos === undefined ? '' : ' AND ' + (encargos === 'false' ? 'NOT ' : '') + tiene) + ' ORDER BY p.created_at DESC,p.id DESC LIMIT 200').all(...[n, ...(estado ? [estado] : [])]))
    .map(({ solicitud_hash, solicitud_id, ...pedido }) => pedido);
}
export async function detallePedidoTienda(n, pedidoId) { return detallePublicable(await cargar(n, pedidoId)); }

async function cambiarEstado(n, pedidoId, input, actor, cancelar) {
  objeto(input, ['negocio_id', 'solicitud_id', 'version', ...(cancelar ? ['motivo'] : [])], 'Solicitud');
  if (input.negocio_id !== undefined && input.negocio_id !== n) throw fail('El negocio no coincide con el pedido');
  solicitudId(input.solicitud_id);
  if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw fail('Volvé a revisar el pedido antes de continuar');
  const motivo = cancelar ? text(input.motivo, 'Motivo de cancelación', 1000) : 'Pedido web confirmado: salida de stock';
  const accion = cancelar ? 'cancelar' : 'confirmar', requestHash = huella({ n, pedidoId, accion, version: input.version, motivo });
  return db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['tienda-pedido-accion:' + input.solicitud_id]);
    const anterior = await db.prepare("SELECT entidad_id,empleado,datos_nuevos FROM auditoria WHERE entidad='tienda_pedido' AND accion IN ('confirmar','cancelar') AND datos_nuevos::jsonb->>'solicitud_id'=? LIMIT 1").get(input.solicitud_id);
    if (anterior) {
      const datos = JSON.parse(anterior.datos_nuevos);
      if (anterior.entidad_id !== pedidoId || anterior.empleado !== actor || datos.requestHash !== requestHash) throw fail('La solicitud ya se utilizó con otros datos', 409);
      return datos.resultado;
    }
    const antes = await cargar(n, pedidoId, true);
    if (antes.version !== input.version) throw fail('El pedido o el stock cambiaron. Volvé a revisar antes de continuar.', 409);
    if (antes.pedido.estado === 'cancelado') throw fail('El pedido ya está cancelado y no se puede reabrir', 409);
    if (!cancelar && antes.pedido.estado !== 'pendiente') throw fail('El pedido ya fue confirmado', 409);
    if (!cancelar && antes.stock.some(p => p.insuficiente)) throw fail('No hay stock suficiente para confirmar el pedido', 409);
    const movimientos = [];
    for (const p of cancelar && antes.pedido.estado === 'pendiente' ? [] : antes.stock) {
      const cantidad = p.stock_actual === null ? 0 : p.cantidad;
      movimientos.push({ producto_id: p.producto_id, nombre: p.nombre, cantidad, cantidad_solicitada: p.cantidad, stock_anterior: p.stock_actual, stock_nuevo: p.stock_despues });
      if (!cantidad) continue;
      await db.prepare('UPDATE productos SET stock=? WHERE id=? AND negocio_id=?').run(p.stock_despues, p.producto_id, n);
      await db.prepare(`INSERT INTO producto_historial(id,producto_id,negocio_id,tipo,stock_anterior,stock_nuevo,motivo,usuario_id,solicitud_id,detalles)
        VALUES(?,?,?,?,?,?,?,?,?,?::jsonb)`).run(id(), p.producto_id, n, cancelar ? 'cancelar_pedido_web' : 'pedido_web', p.stock_actual, p.stock_despues, motivo, actor, input.solicitud_id,
        JSON.stringify({ pedido_id: pedidoId, codigo: antes.pedido.codigo, cantidad }));
    }
    if (cancelar) await db.prepare("UPDATE tienda_pedidos SET estado='cancelado',stock_reposiciones=?::jsonb,cancelado_por=?,cancelado_fecha=?,motivo_cancelacion=? WHERE id=?").run(JSON.stringify(antes.pedido.estado === 'confirmado' ? movimientos : []), actor, nowAR(), motivo, pedidoId);
    else await db.prepare("UPDATE tienda_pedidos SET estado='confirmado',stock_movimientos=?::jsonb,confirmado_por=?,confirmado_fecha=? WHERE id=?").run(JSON.stringify(movimientos), actor, nowAR(), pedidoId);
    const resultado = detallePublicable(await cargar(n, pedidoId));
    await auditar('tienda_pedido', pedidoId, accion, antes, { negocio_id: n, solicitud_id: input.solicitud_id, requestHash, despues: resultado, resultado }, actor, motivo);
    return resultado;
  });
}
export async function confirmarPedidoTienda(n, pedidoId, input, actor) { return cambiarEstado(n, pedidoId, input, actor, false); }
export async function cancelarPedidoTienda(n, pedidoId, input, actor) { return cambiarEstado(n, pedidoId, input, actor, true); }

export async function exportarContactosTienda(n) {
  const rows = await db.prepare('SELECT c.nombre,c.apellido,c.telefono,c.email,c.acepta_contacto,p.codigo,p.estado,c.created_at FROM tienda_contactos c JOIN tienda_pedidos p ON p.id=c.pedido_id WHERE c.negocio_id=? AND p.negocio_id=? ORDER BY c.created_at DESC,c.id').all(n, n);
  const columnas = ['nombre', 'apellido', 'telefono', 'email', 'acepta_contacto', 'codigo', 'estado', 'created_at'];
  const celda = value => {
    let s = value instanceof Date ? value.toISOString() : String(value ?? '');
    if (/^\s*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [columnas.map(celda).join(';'), ...rows.map(row => columnas.map(k => celda(row[k])).join(';'))].join('\r\n');
}
