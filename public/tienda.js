'use strict';

// This public page only uses the anonymous catalogue and order endpoints.
// Customer contact data is never written to localStorage.
const shop = {
  slug: '', tienda: null, productos: [], category: '', cart: [], pending: null,
  busy: false, success: null, product: null, mediaIndex: 0, toastTimer: null, catalogStale: false,
};
const $ = id => document.getElementById(id);
const normalize = value => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toLocaleLowerCase('es');
const money = cents => new Intl.NumberFormat('es-AR', {style: 'currency', currency: 'ARS', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2}).format(cents / 100);
const cartKey = () => 'zilky-tienda-carrito:' + shop.slug;
const pendingKey = () => 'zilky-tienda-pedido-pendiente:' + shop.slug;
const maxItems = 50;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function safeMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, location.origin);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol !== 'https:' && url.origin !== location.origin) return null;
    return url.href;
  } catch { return null; }
}
function image(url, alt, className) {
  const img = element('img', className);
  img.src = url; img.alt = alt; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    const placeholder = mediaPlaceholder('Imagen no disponible');
    img.replaceWith(placeholder);
  }, {once: true});
  return img;
}
function mediaPlaceholder(text = 'Ver producto') {
  const node = element('div', 'media-placeholder');
  const mark = element('span', '', 'z.'); mark.setAttribute('aria-hidden', 'true');
  node.append(mark, element('span', '', text));
  return node;
}
function mediaFor(product) {
  return (Array.isArray(product.media) ? product.media : [])
    .filter(item => item && ['imagen', 'video'].includes(item.tipo) && safeMediaUrl(item.url)
      && (item.tipo !== 'video' || new URL(safeMediaUrl(item.url)).origin === location.origin))
    .sort((a, b) => Number(a.orden || 0) - Number(b.orden || 0));
}
function thumbnail(product, alt = '') {
  const cover = mediaFor(product).find(item => item.tipo === 'imagen');
  return cover ? image(safeMediaUrl(cover.url), alt) : mediaPlaceholder(mediaFor(product).some(item => item.tipo === 'video') ? 'Video disponible' : 'Ver producto');
}
function available(product) {
  return product?.disponible === true && (product.stock_disponible === null || product.stock_disponible === undefined || Number(product.stock_disponible) > 0);
}
function quantityLimit(product) {
  return Number.isSafeInteger(product?.stock_disponible) ? Math.max(0, Math.min(99, product.stock_disponible)) : 99;
}
function stockLabel(product) {
  if (!available(product)) return 'No disponible';
  const stock = product.stock_disponible;
  return Number.isSafeInteger(stock) ? stock === 1 ? '1 disponible' : stock + ' disponibles' : 'Disponible para pedir';
}
function validProduct(product) {
  return product && typeof product.id === 'string' && product.id && typeof product.nombre === 'string'
    && Number.isSafeInteger(product.precio_centavos) && product.precio_centavos >= 0;
}
function publicProducts(products) {
  return products.filter(validProduct).map(product => ({...product,
    modelos: Array.isArray(product.modelos) ? product.modelos.filter(value => typeof value === 'string') : [],
    categoria: typeof product.categoria === 'string' ? product.categoria : '',
    talle: typeof product.talle === 'string' ? product.talle : '', color: typeof product.color === 'string' ? product.color : '',
    descripcion: typeof product.descripcion === 'string' ? product.descripcion : '',
  }));
}
function variants(product) {
  return [product.talle && 'Talle ' + product.talle, product.color].filter(Boolean).join(' · ');
}
function announce(message) {
  clearTimeout(shop.toastTimer);
  $('shopToast').textContent = message; $('shopToast').classList.add('visible');
  shop.toastTimer = setTimeout(() => $('shopToast').classList.remove('visible'), 3000);
}

async function request(path, options = {}) {
  const response = await fetch('/api/tienda-publica/' + encodeURIComponent(shop.slug) + path, {
    cache: 'no-store', credentials: 'omit', ...options,
    headers: {Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers},
  });
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('No pudimos confirmar la respuesta del negocio.'), {status: response.ok ? 0 : response.status}); }
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'No pudimos completar esta operación.'), {status: response.status});
  return result;
}
function showState(title, message, retry = false) {
  $('shopState').replaceChildren(element('h1', '', title), element('p', '', message));
  if (retry) {
    const button = element('button', 'button button-pink', 'Volver a intentar'); button.type = 'button';
    button.addEventListener('click', loadStore); $('shopState').append(button);
  }
  $('shopState').hidden = false; $('shopContent').hidden = true;
  $('openCart').disabled = true; $('mobileCart').hidden = true;
}
async function loadStore() {
  const segments = location.pathname.split('/').filter(Boolean);
  try { shop.slug = segments[0] === 'tienda' && segments.length === 2 ? decodeURIComponent(segments[1]) : ''; }
  catch { shop.slug = ''; }
  if (shop.slug.length < 3 || shop.slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shop.slug)) {
    showState('Esta tienda no está disponible', 'Revisá el enlace que te compartió el negocio.'); return;
  }
  showState('Cargando la tienda…', 'Estamos preparando el catálogo.');
  try {
    const data = await request('');
    if (!data.tienda || !Array.isArray(data.productos)) throw new Error('No pudimos cargar el catálogo.');
    shop.tienda = data.tienda; shop.productos = publicProducts(data.productos); shop.catalogStale = false;
    shop.category = ''; shop.pending = readPending(); shop.cart = readCart();
    configureStore(); renderProducts();
    $('shopState').hidden = true; $('shopContent').hidden = false; $('openCart').disabled = false;
    if (shop.pending) {
      const body = shop.pending.request;
      $('orderName').value = body.contacto.nombre || ''; $('orderSurname').value = body.contacto.apellido || '';
      $('orderPhone').value = body.contacto.telefono || ''; $('orderEmail').value = body.contacto.email || '';
      $('orderNote').value = body.nota || ''; $('orderConsent').checked = true;
    }
    renderCart();
    if (shop.pending) announce('Hay un pedido pendiente de confirmar. Revisalo en tu carrito.');
  } catch (error) {
    showState(error.status === 404 ? 'Esta tienda no está disponible' : 'No pudimos abrir la tienda',
      error.status === 404 ? 'El negocio todavía no tiene su catálogo público disponible. Revisá el enlace o consultá con el negocio.' : 'Revisá tu conexión y volvé a intentar.', error.status !== 404);
  }
}
function configureStore() {
  const name = String(shop.tienda.nombre || 'Tienda online');
  document.title = name + ' · Tienda online';
  $('shopBrandName').textContent = name; $('shopTitle').textContent = name; $('footerStoreName').textContent = name;
  $('shopHome').href = '/tienda/' + encodeURIComponent(shop.slug);
  $('shopDescription').textContent = shop.tienda.descripcion || 'Elegí tus favoritos y armá tu pedido. Nosotros coordinamos el resto con vos.';
  $('shopEyebrow').textContent = shop.tienda.tipo === 'iphone' ? 'TU PRÓXIMO IPHONE, ACÁ' : shop.tienda.tipo === 'ropa' ? 'ENCONTRÁ TU ESTILO' : 'EL CATÁLOGO DEL NEGOCIO';
  const whatsapp = String(shop.tienda.whatsapp || '').replace(/\D/g, '');
  $('shopWhatsapp').hidden = !/^\d{8,15}$/.test(whatsapp);
  if (!$('shopWhatsapp').hidden) $('shopWhatsapp').href = 'https://wa.me/' + whatsapp;
  setOptions('modelFilter', shop.productos.flatMap(p => Array.isArray(p.modelos) ? p.modelos : []), 'Todos los modelos');
  setOptions('sizeFilter', shop.productos.map(p => p.talle), 'Todos los talles');
  setOptions('colorFilter', shop.productos.map(p => p.color), 'Todos los colores');
  $('modelField').hidden = shop.tienda.tipo === 'ropa' || $('modelFilter').options.length < 2;
  $('sizeField').hidden = shop.tienda.tipo === 'iphone' || $('sizeFilter').options.length < 2;
  $('colorField').hidden = shop.tienda.tipo === 'iphone' || $('colorFilter').options.length < 2;
  const categories = unique([...(Array.isArray(shop.tienda.secciones) ? shop.tienda.secciones : []), ...shop.productos.map(p => p.categoria)]);
  $('categoryChips').replaceChildren();
  for (const category of ['', ...categories]) {
    const button = element('button', 'category-chip', category || 'Todo'); button.type = 'button'; button.dataset.category = category;
    button.setAttribute('aria-pressed', String(!category));
    button.addEventListener('click', () => {
      shop.category = category;
      for (const chip of $('categoryChips').children) chip.setAttribute('aria-pressed', String(chip === button));
      renderProducts();
    });
    $('categoryChips').append(button);
  }
}
function unique(values) {
  const distinct = new Map();
  for (const value of values) if (typeof value === 'string' && value.trim()) distinct.set(normalize(value), value.trim());
  return [...distinct.values()];
}
function setOptions(id, values, placeholder) {
  const select = $(id); select.replaceChildren(new Option(placeholder, ''));
  for (const value of unique(values)) select.add(new Option(value, value));
}
function filteredProducts() {
  const term = normalize($('productSearch').value), category = normalize(shop.category);
  const model = $('modelField').hidden ? '' : normalize($('modelFilter').value);
  const size = $('sizeField').hidden ? '' : normalize($('sizeFilter').value), color = $('colorField').hidden ? '' : normalize($('colorFilter').value);
  return shop.productos.filter(product => (!category || normalize(product.categoria) === category)
    && (!model || (product.modelos || []).some(value => normalize(value) === model))
    && (!size || normalize(product.talle) === size) && (!color || normalize(product.color) === color)
    && (!term || normalize([product.nombre, product.descripcion, product.categoria, ...(product.modelos || []), product.talle, product.color].filter(Boolean).join(' ')).includes(term)));
}
function renderProducts() {
  const products = filteredProducts(); $('productGrid').replaceChildren();
  $('resultCount').textContent = products.length + (products.length === 1 ? ' producto' : ' productos');
  $('catalogEmpty').hidden = products.length > 0;
  $('emptyTitle').textContent = shop.productos.length ? 'No encontramos productos' : 'Pronto habrá novedades por acá';
  $('emptyDescription').textContent = shop.productos.length ? 'Probá con otra búsqueda o cambiá los filtros.' : 'El negocio está preparando sus productos. Volvé a visitar la tienda.';
  $('clearFilters').hidden = !shop.productos.length;
  for (const product of products) {
    const card = element('article', 'product-card'); card.dataset.product = product.id;
    const open = element('button', 'product-open'); open.type = 'button'; open.setAttribute('aria-label', 'Ver ' + product.nombre);
    const picture = element('div', 'product-picture'); picture.append(thumbnail(product));
    picture.append(element('span', 'product-badge' + (available(product) ? '' : ' unavailable'), stockLabel(product)));
    const info = element('div', 'product-card-info');
    info.append(element('p', 'eyebrow', product.categoria || ''), element('h3', '', product.nombre), element('p', 'product-variant', variants(product)));
    open.append(picture, info); open.addEventListener('click', () => openProduct(product));
    const bottom = element('div', 'product-bottom'), add = element('button', 'button button-pink add-product', '+');
    add.type = 'button'; add.dataset.add = product.id; add.disabled = !available(product) || Boolean(shop.pending);
    add.setAttribute('aria-label', 'Agregar ' + product.nombre + ' al carrito'); add.addEventListener('click', () => addToCart(product.id, 1));
    bottom.append(element('strong', 'product-price', money(product.precio_centavos)), add); card.append(open, bottom); $('productGrid').append(card);
  }
}

const dialogFocus = new WeakMap();
function showDialog(dialog, focusTarget, restoreTarget = document.activeElement) {
  dialogFocus.set(dialog, restoreTarget);
  if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
  document.body.classList.add('dialog-open'); focusTarget?.focus();
}
function closeDialog(dialog) {
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
}
for (const dialog of [$('productDialog'), $('cartDialog')]) {
  dialog.addEventListener('close', () => {
    dialog.querySelectorAll('video').forEach(video => video.pause());
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open');
    const target = dialogFocus.get(dialog); if (target?.isConnected) target.focus();
  });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog(dialog);
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && typeof dialog.showModal !== 'function') { event.preventDefault(); closeDialog(dialog); }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('a[href],button,input,select,textarea,video[controls],audio[controls],[tabindex="0"]')].filter(node => !node.disabled && !node.closest('[hidden]') && getComputedStyle(node).display !== 'none');
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === controls[0] || !controls.includes(document.activeElement))) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && (document.activeElement === controls.at(-1) || !controls.includes(document.activeElement))) { event.preventDefault(); controls[0].focus(); }
  });
}
function openProduct(product) {
  shop.product = product; shop.mediaIndex = 0;
  $('productCategory').textContent = product.categoria || ''; $('productTitle').textContent = product.nombre;
  $('productPrice').textContent = money(product.precio_centavos); $('productAvailability').textContent = stockLabel(product);
  $('productDescription').textContent = product.descripcion || 'Consultá con el negocio por más detalles de este producto.';
  $('productAttributes').replaceChildren();
  for (const [label, value] of [['Modelo', (product.modelos || []).join(', ')], ['Talle', product.talle], ['Color', product.color]]) if (value) $('productAttributes').append(element('dt', '', label), element('dd', '', value));
  $('detailQuantity').value = '1'; $('detailQuantity').max = String(quantityLimit(product)); $('detailQuantity').disabled = !available(product) || Boolean(shop.pending);
  $('addDetailProduct').disabled = !available(product) || Boolean(shop.pending);
  renderGallery(); showDialog($('productDialog'), $('productTitle'));
}
function renderGallery() {
  $('galleryStage').querySelectorAll('video').forEach(video => video.pause());
  const media = mediaFor(shop.product), current = media[shop.mediaIndex];
  $('galleryStage').replaceChildren(); $('galleryThumbs').replaceChildren();
  if (!current) $('galleryStage').append(mediaPlaceholder('Sin fotos disponibles'));
  else if (current.tipo === 'imagen') $('galleryStage').append(image(safeMediaUrl(current.url), shop.product.nombre));
  else {
    const video = element('video'); video.controls = true; video.preload = 'none'; video.playsInline = true;
    video.src = safeMediaUrl(current.url); video.setAttribute('aria-label', 'Video de ' + shop.product.nombre); $('galleryStage').append(video);
  }
  $('galleryThumbs').hidden = media.length < 2;
  media.forEach((item, index) => {
    const button = element('button', 'gallery-thumb'); button.type = 'button'; button.setAttribute('aria-label', 'Ver ' + (item.tipo === 'video' ? 'video ' : 'imagen ') + (index + 1));
    button.setAttribute('aria-pressed', String(index === shop.mediaIndex));
    if (item.tipo === 'imagen') button.append(image(safeMediaUrl(item.url), '')); else button.textContent = '▷';
    button.addEventListener('click', () => { shop.mediaIndex = index; renderGallery(); $('galleryThumbs').children[index]?.focus(); });
    $('galleryThumbs').append(button);
  });
}

function readCart() {
  try {
    const data = JSON.parse(localStorage.getItem(cartKey()) || '[]');
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    return data.slice(0, maxItems).filter(item => {
      if (!item || typeof item.id !== 'string' || seen.has(item.id) || !shop.productos.some(p => p.id === item.id) || !Number.isSafeInteger(item.cantidad) || item.cantidad < 1 || item.cantidad > 99) return false;
      seen.add(item.id); return true;
    }).map(({id, cantidad}) => ({id, cantidad}));
  } catch { return []; }
}
function saveCart() { try { localStorage.setItem(cartKey(), JSON.stringify(shop.cart.map(({id, cantidad}) => ({id, cantidad})))); } catch { /* An in-memory cart remains usable without local storage. */ } }
function addToCart(id, cantidad) {
  if (shop.pending || shop.busy) return announce('Primero comprobá el pedido pendiente en tu carrito.');
  const product = shop.productos.find(p => p.id === id), current = shop.cart.find(item => item.id === id);
  if (!available(product)) return announce('Este producto no está disponible para pedir.');
  if (!Number.isSafeInteger(cantidad) || cantidad < 1 || cantidad + (current?.cantidad || 0) > quantityLimit(product)) return announce('Revisá la cantidad disponible para este producto.');
  if (!current && shop.cart.length >= maxItems) return announce('Podés incluir hasta 50 productos distintos por pedido.');
  if (current) current.cantidad += cantidad; else shop.cart.push({id, cantidad});
  shop.success = null; saveCart(); renderCart(); announce('Agregaste ' + product.nombre + ' al carrito.');
}
function changeQuantity(id, delta) {
  if (shop.pending || shop.busy) return;
  const item = shop.cart.find(row => row.id === id), product = shop.productos.find(p => p.id === id);
  if (!item || !product) return;
  const next = item.cantidad + delta;
  if (next < 1 || (delta > 0 && next > quantityLimit(product))) return;
  item.cantidad = next; saveCart(); renderCart();
  [...$('cartItems').children].find(row => row.dataset.cartItem === id)?.querySelector('[data-quantity="' + delta + '"]')?.focus();
}
function removeItem(id) {
  if (shop.pending || shop.busy) return;
  shop.cart = shop.cart.filter(item => item.id !== id); saveCart(); renderCart(); $('cartTitle').focus();
}
function cartRows() {
  if (shop.pending) return shop.pending.resumen;
  return shop.cart.map(item => {
    const product = shop.productos.find(p => p.id === item.id);
    return {id: item.id, cantidad: item.cantidad, nombre: product?.nombre || 'Producto no disponible', precio_centavos: product?.precio_centavos || 0, product};
  });
}
function renderCart() {
  const rows = cartRows(), total = rows.reduce((sum, row) => sum + row.cantidad * row.precio_centavos, 0), count = rows.reduce((sum, row) => sum + row.cantidad, 0);
  const blocked = Boolean(shop.pending) || shop.busy;
  $('cartCount').textContent = String(count); $('mobileCartCount').textContent = '(' + count + ')'; $('mobileCartTotal').textContent = money(total);
  $('openCart').setAttribute('aria-label', 'Abrir carrito, ' + count + (count === 1 ? ' producto' : ' productos'));
  $('cartTitle').textContent = shop.success ? 'Tu pedido' : 'Tu carrito';
  $('mobileCart').hidden = !count || !$('shopState').hidden;
  $('cartContent').hidden = Boolean(shop.success); $('orderSuccess').hidden = !shop.success;
  $('cartEmpty').hidden = count > 0; $('cartWithItems').hidden = !count; $('pendingNotice').hidden = !shop.pending;
  $('cartItems').replaceChildren(); $('cartTotal').textContent = money(total);
  for (const row of rows) {
    const product = row.product || shop.productos.find(p => p.id === row.id), item = element('article', 'cart-item'); item.dataset.cartItem = row.id;
    const cover = element('div', 'cart-item-image'); cover.append(product ? thumbnail(product) : element('span', '', 'z.'));
    const copy = element('div'); copy.append(element('h3', '', row.nombre));
    if (product && variants(product)) copy.append(element('p', 'product-variant', variants(product)));
    if (!shop.pending && !available(product)) copy.append(element('p', 'product-variant', 'Ya no está disponible. Quitalo del carrito.'));
    const controls = element('div', 'cart-item-controls');
    for (const [delta, text, label] of [[-1, '−', 'Restar una unidad de '], [1, '+', 'Sumar una unidad de ']]) {
      const button = element('button', 'quantity-step', text); button.type = 'button'; button.dataset.quantity = String(delta); button.setAttribute('aria-label', label + row.nombre);
      button.disabled = blocked || (delta < 0 ? row.cantidad <= 1 : row.cantidad >= quantityLimit(product)); button.addEventListener('click', () => changeQuantity(row.id, delta));
      if (delta > 0) controls.append(element('span', 'quantity-value', String(row.cantidad)));
      controls.append(button);
    }
    const remove = element('button', 'remove-item', 'Quitar'); remove.type = 'button'; remove.disabled = blocked; remove.setAttribute('aria-label', 'Quitar ' + row.nombre); remove.addEventListener('click', () => removeItem(row.id));
    controls.append(remove); copy.append(controls); item.append(cover, copy, element('strong', 'cart-item-price', money(row.precio_centavos * row.cantidad))); $('cartItems').append(item);
  }
  for (const input of $('checkoutForm').querySelectorAll('input,textarea')) input.disabled = blocked;
  $('submitOrder').disabled = shop.busy || shop.catalogStale || (!shop.pending && (!count || rows.some(row => !available(row.product) || row.cantidad > quantityLimit(row.product))));
  const arrow = element('span', 'shop-arrow'); arrow.setAttribute('aria-hidden', 'true');
  $('submitOrder').replaceChildren(document.createTextNode(shop.busy ? 'Comprobando pedido…' : shop.pending ? 'Comprobar pedido pendiente' : 'Enviar pedido'), arrow);
  for (const button of document.querySelectorAll('[data-add]')) button.disabled = blocked || !available(shop.productos.find(p => p.id === button.dataset.add));
}
function showCart() {
  closeDialog($('productDialog')); renderCart();
  showDialog($('cartDialog'), shop.success ? $('orderSuccess') : $('cartTitle'), $('openCart'));
}
function readPending() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null'), body = pending?.request;
    if (!body || !/^[a-f0-9-]{36}$/i.test(body.solicitud_id) || !body.contacto || !Array.isArray(body.items) || !body.items.length || body.items.length > maxItems || body.acepta_contacto !== true || !Array.isArray(pending.resumen)) return null;
    if (!body.items.every(item => typeof item.producto_id === 'string' && Number.isSafeInteger(item.cantidad) && item.cantidad > 0 && item.cantidad <= 99)) return null;
    const resumen = pending.resumen.filter(row => typeof row.id === 'string' && typeof row.nombre === 'string' && Number.isSafeInteger(row.precio_centavos) && row.precio_centavos >= 0 && Number.isSafeInteger(row.cantidad) && row.cantidad > 0 && row.cantidad <= 99);
    if (resumen.length !== body.items.length || !body.items.every(item => resumen.some(row => row.id === item.producto_id && row.cantidad === item.cantidad))) return null;
    return {request: body, resumen};
  } catch { return null; }
}
function savePending(pending) {
  try {
    const serialized = JSON.stringify(pending); sessionStorage.setItem(pendingKey(), serialized);
    if (sessionStorage.getItem(pendingKey()) !== serialized) throw new Error();
  } catch { throw new Error('No pudimos guardar el pedido para reintentarlo de forma segura. Habilitá el almacenamiento de esta sesión y volvé a intentar. Todavía no se envió el pedido.'); }
}
function clearPending() { try { sessionStorage.removeItem(pendingKey()); } catch { /* Retrying a retained request uses the same identifier. */ } shop.pending = null; }
function normalizePhone(value) {
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (/^549\d{10}$/.test(digits)) return '+' + digits;
  if (/^54\d{10}$/.test(digits)) return '+549' + digits.slice(2);
  return /^\d{10}$/.test(digits) ? '+549' + digits : null;
}
function checkoutError(message) { $('checkoutError').textContent = message; $('checkoutError').hidden = false; }
async function refreshCatalog() {
  const data = await request('');
  if (!data.tienda || !Array.isArray(data.productos)) throw new Error('No pudimos actualizar el catálogo.');
  shop.productos = publicProducts(data.productos); shop.catalogStale = false;
  renderProducts(); renderCart();
}
async function submitOrder(event) {
  event.preventDefault(); if (shop.busy || shop.success) return;
  $('checkoutError').hidden = true;
  if (!shop.pending) {
    if (!$('checkoutForm').reportValidity()) return;
    const telefono = normalizePhone($('orderPhone').value);
    if (!telefono) { checkoutError('Ingresá un celular argentino de 10 dígitos con código de área, sin 0 ni 15.'); $('orderPhone').focus(); return; }
    if (!shop.cart.length || shop.cart.some(item => { const product = shop.productos.find(p => p.id === item.id); return !available(product) || item.cantidad > quantityLimit(product); })) return checkoutError('Revisá la disponibilidad y las cantidades de tu carrito.');
    const contacto = {nombre: $('orderName').value.trim(), apellido: $('orderSurname').value.trim(), telefono, email: $('orderEmail').value.trim()};
    if (!contacto.nombre || !contacto.apellido) return checkoutError('Completá tu nombre y apellido.');
    const total = cartRows().reduce((sum, row) => sum + row.cantidad * row.precio_centavos, 0);
    const pending = {request: {solicitud_id: crypto.randomUUID(), contacto, items: shop.cart.map(item => ({producto_id: item.id, cantidad: item.cantidad})), nota: $('orderNote').value.trim(), acepta_contacto: true, total_esperado_centavos: total},
      resumen: cartRows().map(({id, cantidad, nombre, precio_centavos}) => ({id, cantidad, nombre, precio_centavos}))};
    try { savePending(pending); shop.pending = pending; }
    catch (error) { checkoutError(error.message); return; }
  }
  shop.busy = true; renderCart();
  try {
    const result = await request('/pedidos', {method: 'POST', body: JSON.stringify(shop.pending.request)});
    if (!result || typeof result.codigo !== 'string' || !Number.isSafeInteger(result.total_centavos) || !Array.isArray(result.items)) throw new Error('No pudimos confirmar el resultado.');
    clearPending(); shop.cart = []; saveCart(); $('checkoutForm').reset(); shop.success = result;
    renderSuccess(result); renderCart(); $('orderSuccess').focus();
  } catch (error) {
    const rejected = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    if (rejected) clearPending();
    if (error.status === 409) {
      shop.catalogStale = true;
      try {
        await refreshCatalog();
        checkoutError(error.message + ' Actualizamos el carrito. Revisá los productos y el total antes de volver a enviar el pedido.');
      } catch {
        checkoutError('Los precios o la disponibilidad cambiaron y no pudimos actualizar el carrito. Revisá tu conexión y tocá Actualizar carrito.');
        $('refreshCart').hidden = false;
      }
    } else checkoutError(rejected ? error.message : 'No pudimos confirmar el resultado. Comprobá el mismo pedido con el botón de abajo para evitar duplicarlo.');
  } finally { shop.busy = false; renderCart(); }
}
function renderSuccess(result) {
  $('orderCode').textContent = 'Pedido ' + result.codigo; $('successTotal').textContent = money(result.total_centavos); $('successItems').replaceChildren();
  for (const item of result.items) {
    const row = element('div', 'success-item'); row.append(element('span', '', item.cantidad + ' × ' + item.nombre), element('strong', '', money(item.subtotal_centavos))); $('successItems').append(row);
  }
}

$('filterForm').addEventListener('submit', event => event.preventDefault());
$('productSearch').addEventListener('input', renderProducts);
for (const id of ['modelFilter', 'sizeFilter', 'colorFilter']) $(id).addEventListener('change', renderProducts);
$('clearFilters').addEventListener('click', () => {
  $('filterForm').reset(); shop.category = '';
  for (const chip of $('categoryChips').children) chip.setAttribute('aria-pressed', String(!chip.dataset.category));
  renderProducts(); $('productSearch').focus();
});
$('addDetailProduct').addEventListener('click', () => addToCart(shop.product.id, Number($('detailQuantity').value)));
$('closeProduct').addEventListener('click', () => closeDialog($('productDialog')));
for (const id of ['openCart', 'openMobileCart']) $(id).addEventListener('click', showCart);
for (const id of ['closeCart', 'continueShopping', 'successContinue']) $(id).addEventListener('click', () => closeDialog($('cartDialog')));
$('checkoutForm').addEventListener('submit', submitOrder);
const refreshButton = element('button', 'button button-outline', 'Actualizar carrito'); refreshButton.type = 'button'; refreshButton.id = 'refreshCart'; refreshButton.hidden = true;
$('checkoutError').after(refreshButton);
refreshButton.addEventListener('click', async () => {
  if (shop.busy) return;
  refreshButton.disabled = true;
  try { await refreshCatalog(); refreshButton.hidden = true; checkoutError('Carrito actualizado. Revisá los productos y el total antes de volver a enviar el pedido.'); }
  catch { checkoutError('Todavía no pudimos actualizar el carrito. Revisá tu conexión y volvé a intentar.'); }
  finally { refreshButton.disabled = false; }
});
loadStore();
