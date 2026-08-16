// =============================================================
// Zilky · Frontend (sin build step: JS plano + fetch a /api/*)
// =============================================================

const state = {
  negocios: [],
  negocioActual: null, // null = "Todos los negocios"
  clientesCache: [],
};

// ---------------- Sesión ----------------
const TOKEN_KEY = 'zilky_token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('root').style.display = 'none';
}
function hideAuthScreen() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('root').style.display = '';
}

// ---------------- API helper ----------------
async function api(path, opts = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { /* sin body */ }
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/registro') {
    clearToken();
    showAuthScreen();
  }
  if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
  return body;
}

// ---------------- Formato ----------------
const formatARS = (centavos) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format((centavos || 0) / 100);
const toCentavos = (pesos) => Math.round(Number(pesos || 0) * 100);
const fmtFecha = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const iniciales = (n = '', a = '') => `${(n[0] || '').toUpperCase()}${(a[0] || '').toUpperCase()}` || '?';
const todayISO = () => new Date().toISOString().slice(0, 10);

const ESTADO_LABEL = {
  proxima: 'Próxima', activa: 'Activa', vence_hoy: 'Vence hoy', gracia: 'En gracia',
  mora: 'En mora', pagada: 'Pagada', pagada_anticipada: 'Pagada (anticipada)',
  refinanciada: 'Refinanciada', anulada: 'Anulada', incobrable: 'Incobrable',
};

// ---------------- Toast ----------------
function toast(msg, isError = false) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2800);
}

// ---------------- Sheet (modal inferior) ----------------
function openSheet(html) {
  document.getElementById('sheetRoot').innerHTML = `<div class="sheet" id="activeSheet">${html}</div>`;
  document.getElementById('sheetBackdrop').classList.add('open');
  requestAnimationFrame(() => document.getElementById('activeSheet')?.classList.add('open'));
}
function closeSheet() {
  document.getElementById('activeSheet')?.classList.remove('open');
  document.getElementById('sheetBackdrop').classList.remove('open');
  setTimeout(() => { document.getElementById('sheetRoot').innerHTML = ''; }, 200);
}
document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);

// ---------------- Negocio activo ----------------
function negocioNombre(id) {
  if (!id) return 'Todos los negocios';
  return state.negocios.find((n) => n.id === id)?.nombre || '—';
}
function aplicarClaseNegocio() {
  document.body.classList.remove('negocio-apple', 'negocio-indumentaria');
  const n = state.negocios.find((x) => x.id === state.negocioActual);
  if (n && /apple/i.test(n.nombre)) document.body.classList.add('negocio-apple');
  else if (n && /indument/i.test(n.nombre)) document.body.classList.add('negocio-indumentaria');
}
function setNegocio(id) {
  state.negocioActual = id;
  document.getElementById('negocioNombre').textContent = negocioNombre(id);
  document.getElementById('brandMark').textContent = id ? negocioNombre(id)[0].toUpperCase() : 'Z';
  aplicarClaseNegocio();
  render();
}
function abrirSelectorNegocio() {
  const opciones = [{ id: '', nombre: 'Todos los negocios' }, ...state.negocios];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Cambiar de negocio</div>
    <div class="sheet-sub">El resto de la app se filtra automáticamente.</div>
    ${opciones.map((n) => `
      <div class="list-item" data-action="elegir-negocio" data-id="${n.id}">
        <span class="avatar" style="background:${n.color || 'var(--surface-2)'}22;color:${n.color || 'var(--text-muted)'}">${n.id ? n.nombre[0].toUpperCase() : '✦'}</span>
        <div class="list-item-body"><div class="list-item-title">${n.nombre}</div></div>
        ${(n.id || '') === (state.negocioActual || '') ? '<span class="badge badge-pagada">Activo</span>' : ''}
      </div>
    `).join('')}
  `);
}

// ---------------- Router ----------------
function parseHash() {
  const h = location.hash.replace(/^#\//, '') || 'inicio';
  return h.split('/').filter(Boolean);
}
window.addEventListener('hashchange', render);

async function render() {
  const parts = parseHash();
  const root = parts[0] || 'inicio';
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === root));

  const view = document.getElementById('view');
  view.innerHTML = '<div class="skeleton">Cargando…</div>';

  try {
    if (root === 'inicio') await viewInicio(view);
    else if (root === 'clientes' && parts[1]) await viewClienteDetail(view, parts[1]);
    else if (root === 'clientes') await viewClientes(view);
    else if (root === 'cobrar') await viewCobrar(view);
    else if (root === 'ventas') await viewVentaNueva(view, parts[1] || null);
    else if (root === 'productos') await viewProductos(view);
    else if (root === 'mas') await viewMas(view);
    else view.innerHTML = notFound();
  } catch (err) {
    view.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}
const notFound = () => '<div class="empty-state"><p>No encontrado.</p></div>';

// ---------------- Vista: Inicio (dashboard) ----------------
async function viewInicio(view) {
  const r = await api(`/dashboard/resumen${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}`);
  view.innerHTML = `
    <div class="section-title">Resumen ${state.negocioActual ? '· ' + negocioNombre(state.negocioActual) : 'general'}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">A ingresar este mes</div><div class="kpi-value accent">${formatARS(r.porIngresarMesCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Cobrado hoy</div><div class="kpi-value">${formatARS(r.cobradoHoyCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Cobrado este mes</div><div class="kpi-value">${formatARS(r.cobradoMesCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Saldo vencido</div><div class="kpi-value ${r.saldoVencidoCentavos > 0 ? 'danger' : ''}">${formatARS(r.saldoVencidoCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Clientes en mora</div><div class="kpi-value ${r.clientesEnMora > 0 ? 'danger' : ''}">${r.clientesEnMora}</div></div>
      <div class="kpi"><div class="kpi-label">Monto en riesgo</div><div class="kpi-value danger">${formatARS(r.montoEnRiesgoCentavos)}</div></div>
      <div class="kpi kpi-wide">
        <div><div class="kpi-label">Saldo pendiente total</div><div class="kpi-value">${formatARS(r.saldoPendienteTotalCentavos)}</div></div>
        <div style="text-align:right"><div class="kpi-label">Capital colocado</div><div class="kpi-value">${formatARS(r.capitalColocadoCentavos)}</div></div>
      </div>
    </div>
    ${r.porNegocio ? `
      <div class="section-title">Por negocio</div>
      <div class="negocio-split">
        ${r.porNegocio.map((n) => `
          <div class="negocio-chip" data-action="ir-negocio" data-id="${n.negocio_id}">
            <span class="lbl"><span class="dot" style="background:${n.color}"></span>${n.nombre}</span>
            <div class="val">${formatARS(n.porIngresarMesCentavos)}</div>
            <div class="lbl" style="margin-top:2px">a ingresar este mes</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <div class="section-title">Accesos rápidos</div>
    <div class="quick-actions">
      <a class="btn btn-secondary" href="#/cobrar">${iconCobrar()}Cobrar</a>
      <a class="btn btn-secondary" href="#/ventas/nueva">${iconVenta()}Nueva venta</a>
      <a class="btn btn-secondary" href="#/clientes">${iconClientes()}Clientes</a>
      <a class="btn btn-secondary" href="#/productos">${iconProductos()}Productos</a>
    </div>
  `;
}

// ---------------- Vista: Clientes ----------------
async function viewClientes(view, q = '') {
  view.innerHTML = `
    <div class="section-title">Clientes</div>
    <div class="search-box">
      ${iconSearch()}
      <input id="clienteSearch" placeholder="Buscar por nombre, DNI o teléfono" value="${q}" />
    </div>
    <div id="clientesList"><div class="skeleton">Buscando…</div></div>
  `;
  const input = document.getElementById('clienteSearch');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => renderClientesList(input.value.trim()), 220);
  });
  await renderClientesList(q);
}

async function renderClientesList(q) {
  const list = document.getElementById('clientesList');
  const clientes = await api(`/clientes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (!clientes.length) {
    list.innerHTML = `<div class="empty-state">${iconClientes(40)}<p>No hay clientes${q ? ' que coincidan' : ' todavía'}.</p></div>`;
    return;
  }
  list.innerHTML = clientes.map((c) => `
    <div class="list-item" data-action="ver-cliente" data-id="${c.id}">
      <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
      <div class="list-item-body">
        <div class="list-item-title">${c.nombre} ${c.apellido || ''}</div>
        <div class="list-item-sub">${c.telefono ? '📞 ' + c.telefono : ''}${c.ciudad ? ' · ' + c.ciudad : ''}</div>
      </div>
      <span class="chev">${iconChevron()}</span>
    </div>
  `).join('');
}

// ---------------- Vista: Detalle de cliente ----------------
async function viewClienteDetail(view, id) {
  const c = await api(`/clientes/${id}`);
  const riesgoClass = { bajo: 'riesgo-bajo', medio: 'riesgo-medio', alto: 'riesgo-alto', critico: 'riesgo-critico' }[c.riesgo?.nivel] || 'riesgo-bajo';

  view.innerHTML = `
    <div class="profile-header">
      <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
      <div>
        <div class="profile-name">${c.nombre} ${c.apellido || ''}</div>
        <div class="profile-sub">${c.telefono || 'Sin teléfono'} ${c.ciudad ? '· ' + c.ciudad : ''}</div>
      </div>
    </div>

    <div class="debt-hero">
      <div class="lbl">Deuda total (todos los negocios)</div>
      <div class="amt">${formatARS(c.deudaTotalCentavos)}</div>
      <div class="meta">
        ${c.proximoVencimiento ? `Próximo vencimiento: ${fmtFecha(c.proximoVencimiento)} (${c.diasHastaVencimiento >= 0 ? `en ${c.diasHastaVencimiento} días` : `hace ${-c.diasHastaVencimiento} días`})` : 'Sin obligaciones pendientes'}
        &nbsp;·&nbsp; <span class="badge badge-${riesgoClass}">Riesgo ${c.riesgo?.nivel || 'bajo'}</span>
      </div>
    </div>

    <div class="quick-actions" style="margin-top:14px">
      <a class="btn btn-secondary" href="${waLink(c.telefono, mensajeSaludo(c))}" target="_blank">${iconWhatsapp()}WhatsApp</a>
      <a class="btn btn-secondary" href="tel:${c.telefono || ''}">${iconLlamar()}Llamar</a>
      <a class="btn btn-secondary" href="#/ventas/nueva/${c.id}">${iconVenta()}Nueva venta</a>
      <button class="btn btn-secondary" data-action="nota-cliente" data-id="${c.id}">${iconNota()}Nota</button>
    </div>

    ${c.riesgo?.notas?.length ? `<div class="field-hint" style="margin-top:10px">${c.riesgo.notas.join(' ')}</div>` : ''}

    <div class="section-title">Créditos</div>
    ${c.creditos.length === 0 ? `<div class="empty-state"><p>Todavía no compró nada.</p></div>` : c.creditos.map((cr) => creditoCardHtml(cr)).join('')}

    <div class="section-title">Historial de pagos</div>
    ${c.pagos.length === 0 ? `<div class="empty-state"><p>Sin pagos registrados.</p></div>` : `
      <div class="card">
        ${c.pagos.slice(0, 12).map((p) => `
          <div class="hist-row">
            <div><div class="hd">${p.medio_pago}${p.nota ? ' · ' + p.nota : ''}</div><div class="hm">${fmtFecha(p.fecha_hora)} ${p.fecha_hora.slice(11, 16)}</div></div>
            <div class="amt">+${formatARS(p.monto_centavos)}</div>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

function creditoCardHtml(cr) {
  const negocio = state.negocios.find((n) => n.id === cr.negocio_id);
  const pendiente = cr.cuotas.some((c) => c.saldo_pendiente_centavos > 0);
  return `
    <div class="card credito-card">
      <div class="credito-top">
        <div>
          <div class="credito-modalidad">${negocio?.nombre || ''} · ${{ libre: 'Pago libre', cuotas: 'Cuotas mensuales', unico: 'Pago único' }[cr.modalidad] || cr.modalidad}</div>
          <div style="font-weight:700;margin-top:4px">${formatARS(cr.saldo_financiado_centavos)} financiados</div>
        </div>
        <span class="badge badge-${cr.estado === 'finalizado' ? 'pagada' : cr.estado === 'en_mora' ? 'mora' : cr.estado === 'en_gracia' ? 'gracia' : 'activa'}">${cr.estado.replace('_', ' ')}</span>
      </div>
      ${cr.cuotas.map((cu) => `
        <div class="cuota-row">
          <div class="cn">Cuota ${cu.numero} · vence ${fmtFecha(cu.fecha_vencimiento)}</div>
          <div class="cr">
            <span class="amt">${formatARS(cu.saldo_pendiente_centavos)}</span>
            <span class="badge badge-${cu.estado}">${ESTADO_LABEL[cu.estado] || cu.estado}</span>
          </div>
        </div>
      `).join('')}
      ${pendiente ? `<button class="btn btn-primary btn-block" style="margin-top:12px" data-action="registrar-pago" data-credito="${cr.id}" data-cliente="${cr.cliente_id}">${iconCobrar()}Registrar pago</button>` : ''}
    </div>
  `;
}

// ---------------- Sheet: registrar pago ----------------
async function abrirRegistrarPago(creditoId, clienteId, montoSugerido = null) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Registrar pago</div>
    <div class="sheet-sub">Se aplica automáticamente: primero mora vencida, después capital de la cuota más antigua.</div>
    <div class="field">
      <label>Monto entregado</label>
      <input type="number" inputmode="decimal" id="pagoMonto" placeholder="0" value="${montoSugerido ?? ''}" autofocus />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Medio de pago</label>
        <select id="pagoMedio">
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="mercado_pago">Mercado Pago</option>
          <option value="otro">Otro</option>
        </select>
      </div>
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="pagoFecha" value="${todayISO()}" />
      </div>
    </div>
    <div class="field">
      <label>Nota (opcional)</label>
      <input type="text" id="pagoNota" placeholder="Ej: entrega parcial" />
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmarPago">Confirmar</button>
    </div>
  `);
  document.getElementById('btnConfirmarPago').addEventListener('click', async () => {
    const monto = toCentavos(document.getElementById('pagoMonto').value);
    if (!monto || monto <= 0) return toast('Ingresá un monto válido', true);
    const fecha = document.getElementById('pagoFecha').value || todayISO();
    try {
      await api('/pagos', {
        method: 'POST',
        body: JSON.stringify({
          credito_id: creditoId,
          monto_centavos: monto,
          medio_pago: document.getElementById('pagoMedio').value,
          fecha_hora: `${fecha}T${new Date().toTimeString().slice(0, 8)}-03:00`,
          nota: document.getElementById('pagoNota').value || null,
        }),
      });
      closeSheet();
      toast('Pago registrado ✓');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------- Vista: Cobrar ----------------
async function viewCobrar(view) {
  const b = await api(`/dashboard/cobranza${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}`);
  const secciones = [
    ['vencenHoy', 'Vencen hoy'], ['vencenManana', 'Vencen mañana'], ['estaSemana', 'Esta semana'], ['esteMes', 'Este mes'],
    ['atrasados', 'Atrasados'], ['mas30', 'Más de 30 días'], ['mas60', 'Más de 60 días'], ['mas90', 'Más de 90 días'],
  ];
  const conDatos = secciones.filter(([k]) => b[k]?.length);
  if (!conDatos.length) {
    view.innerHTML = `<div class="empty-state">${iconCobrar(40)}<p>No hay cobros pendientes por ahora. 🎉</p></div>`;
    return;
  }
  view.innerHTML = conDatos.map(([k, label]) => `
    <div class="bucket-header"><div class="section-title">${label}</div><span class="bucket-count">${b[k].length}</span></div>
    ${b[k].map((c) => `
      <div class="list-item" data-action="ver-cliente" data-id="${c.cliente_id}">
        <span class="avatar">${iniciales(c.cliente_nombre, c.cliente_apellido)}</span>
        <div class="list-item-body">
          <div class="list-item-title">${c.cliente_nombre} ${c.cliente_apellido || ''}</div>
          <div class="list-item-sub">
            <span class="badge badge-${c.estado}">${ESTADO_LABEL[c.estado] || c.estado}</span>
            ${c.diasAtraso > 0 ? `${c.diasAtraso}d de atraso` : `vence ${fmtFecha(c.fecha_vencimiento)}`}
          </div>
        </div>
        <div class="list-item-trail">
          <div class="list-item-amount">${formatARS(c.saldo_pendiente_centavos + (c.moraPendiente || 0))}</div>
          <button class="btn btn-primary" style="margin-top:6px;padding:8px 12px;font-size:12.5px" data-action="registrar-pago" data-credito="${c.credito_id}" data-cliente="${c.cliente_id}" data-monto="${(c.saldo_pendiente_centavos + (c.moraPendiente || 0)) / 100}" onclick="event.stopPropagation()">Cobrar</button>
        </div>
      </div>
    `).join('')}
  `).join('');
}

// ---------------- Vista: Nueva venta ----------------
async function viewVentaNueva(view, clientePreId) {
  if (!state.negocios.length) { view.innerHTML = notFound(); return; }
  const negocioSel = state.negocioActual || state.negocios[0].id;
  let clientePre = null;
  if (clientePreId) { try { clientePre = await api(`/clientes/${clientePreId}`); } catch { /* ignora */ } }
  const productos = await api(`/productos?negocio_id=${negocioSel}`);

  view.innerHTML = `
    <div class="section-title">Nueva venta</div>
    <div class="card">
      <div class="field">
        <label>Negocio</label>
        <select id="vNegocio">${state.negocios.map((n) => `<option value="${n.id}" ${n.id === negocioSel ? 'selected' : ''}>${n.nombre}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Cliente</label>
        <input id="vClienteBuscar" placeholder="Buscar cliente por nombre o DNI" value="${clientePre ? clientePre.nombre + ' ' + (clientePre.apellido || '') : ''}" />
        <input type="hidden" id="vClienteId" value="${clientePre?.id || ''}" />
        <div id="vClienteResultados"></div>
      </div>

      <div class="field">
        <label>Producto (opcional)</label>
        <select id="vProducto">
          <option value="">— Ingresar monto manualmente —</option>
          ${productos.map((p) => `<option value="${p.id}" data-precio="${p.precio_financiado_centavos}">${p.nombre} ${p.variante ? '(' + p.variante + ')' : ''} · ${formatARS(p.precio_financiado_centavos)}</option>`).join('')}
        </select>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Monto total</label>
          <input type="number" id="vMontoTotal" placeholder="0" />
        </div>
        <div class="field">
          <label>Entrega inicial</label>
          <input type="number" id="vEntrega" placeholder="0" value="0" />
        </div>
      </div>

      <div class="field">
        <label>Modalidad de pago</label>
        <div class="segmented" id="vModalidad">
          <button type="button" class="active" data-val="libre">Pago libre</button>
          <button type="button" data-val="cuotas">Cuotas</button>
          <button type="button" data-val="unico">Único</button>
        </div>
      </div>

      <div id="vCamposModalidad"></div>

      <button class="btn btn-primary btn-block btn-lg" id="btnCrearVenta" style="margin-top:8px">Confirmar venta</button>
    </div>
  `;

  renderCamposModalidad('libre');
  document.getElementById('vModalidad').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    document.querySelectorAll('#vModalidad button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderCamposModalidad(btn.dataset.val);
  });

  document.getElementById('vProducto').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt?.dataset.precio) document.getElementById('vMontoTotal').value = Number(opt.dataset.precio) / 100;
  });

  document.getElementById('vNegocio').addEventListener('change', () => render()); // recarga productos del negocio elegido -> simplificado: refresca vista completa
  // (para no perder la selección de negocio del formulario, la recarga simple es aceptable en esta etapa)

  let tBuscar;
  document.getElementById('vClienteBuscar').addEventListener('input', (e) => {
    clearTimeout(tBuscar);
    const q = e.target.value.trim();
    document.getElementById('vClienteId').value = '';
    if (q.length < 2) { document.getElementById('vClienteResultados').innerHTML = ''; return; }
    tBuscar = setTimeout(async () => {
      const res = await api(`/clientes?q=${encodeURIComponent(q)}`);
      document.getElementById('vClienteResultados').innerHTML = res.slice(0, 5).map((c) => `
        <div class="list-item" style="margin-top:6px" data-action="elegir-cliente-venta" data-id="${c.id}" data-nombre="${c.nombre} ${c.apellido || ''}">
          <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
          <div class="list-item-body"><div class="list-item-title">${c.nombre} ${c.apellido || ''}</div><div class="list-item-sub">${c.telefono || ''}</div></div>
        </div>
      `).join('') || `<div class="field-hint">Sin resultados. <span data-action="crear-cliente-inline" style="color:var(--accent);cursor:pointer">Crear cliente nuevo →</span></div>`;
    }, 220);
  });

  document.getElementById('btnCrearVenta').addEventListener('click', () => submitVenta());
}

function renderCamposModalidad(modalidad) {
  const box = document.getElementById('vCamposModalidad');
  if (modalidad === 'cuotas') {
    box.innerHTML = `
      <div class="field-row">
        <div class="field"><label>Cantidad de cuotas</label><input type="number" id="vCantCuotas" placeholder="6" /></div>
        <div class="field"><label>Valor de cada cuota</label><input type="number" id="vValorCuota" placeholder="0" /></div>
      </div>
      <div class="field"><label>Fecha de la primera cuota</label><input type="date" id="vFechaPrimera" value="${todayISO()}" /></div>
    `;
  } else {
    box.innerHTML = `
      <div class="field"><label>Fecha límite de pago</label><input type="date" id="vFechaLimite" /></div>
      <div class="field-hint">Si no elegís una fecha, se usan 30 días desde hoy por defecto.</div>
    `;
  }
}

async function submitVenta() {
  const negocio_id = document.getElementById('vNegocio').value;
  const cliente_id = document.getElementById('vClienteId').value;
  if (!cliente_id) return toast('Elegí un cliente de la lista', true);
  const monto_total_centavos = toCentavos(document.getElementById('vMontoTotal').value);
  const entrega_inicial_centavos = toCentavos(document.getElementById('vEntrega').value);
  if (!monto_total_centavos) return toast('Ingresá el monto total', true);
  const modalidad = document.querySelector('#vModalidad button.active').dataset.val;
  const productoSel = document.getElementById('vProducto');
  const productoOpt = productoSel.selectedOptions[0];

  const body = {
    negocio_id, cliente_id, modalidad, monto_total_centavos, entrega_inicial_centavos,
    items: productoSel.value ? [{ producto_id: productoSel.value, cantidad: 1, precio_unitario_centavos: monto_total_centavos }] : [],
    plan: {},
  };
  if (modalidad === 'cuotas') {
    body.plan = {
      cantidad_cuotas: Number(document.getElementById('vCantCuotas').value || 0),
      valor_cuota_centavos: toCentavos(document.getElementById('vValorCuota').value),
      fecha_primera_cuota: document.getElementById('vFechaPrimera').value,
      intervalo_dias: 30,
    };
  } else {
    const f = document.getElementById('vFechaLimite').value;
    if (f) body.plan.fecha_limite = f;
  }

  try {
    await api('/ventas', { method: 'POST', body: JSON.stringify(body) });
    toast('Venta creada ✓');
    location.hash = `#/clientes/${cliente_id}`;
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- Vista: Productos ----------------
async function viewProductos(view) {
  if (!state.negocioActual) {
    view.innerHTML = `<div class="empty-state"><p>Elegí un negocio arriba para ver su catálogo.</p></div>`;
    return;
  }
  const productos = await api(`/productos?negocio_id=${state.negocioActual}`);
  view.innerHTML = `
    <div class="section-title">Productos · ${negocioNombre(state.negocioActual)}</div>
    ${productos.length === 0 ? '<div class="empty-state"><p>Sin productos cargados.</p></div>' : productos.map((p) => `
      <div class="list-item">
        <span class="avatar">${p.nombre[0]}</span>
        <div class="list-item-body">
          <div class="list-item-title">${p.nombre}</div>
          <div class="list-item-sub">${p.variante || p.categoria || ''} · Stock: ${p.stock}${p.stock <= p.stock_minimo ? ' ⚠️' : ''}</div>
        </div>
        <div class="list-item-trail"><div class="list-item-amount">${formatARS(p.precio_financiado_centavos)}</div></div>
      </div>
    `).join('')}
  `;
}

// ---------------- Vista: Más ----------------
async function viewMas(view) {
  view.innerHTML = `
    <div class="section-title">Más</div>
    <a class="list-item" href="#/productos"><span class="avatar">${iconProductos()}</span><div class="list-item-body"><div class="list-item-title">Productos y stock</div></div><span class="chev">${iconChevron()}</span></a>
    ${['Contratos', 'Caja', 'Estado del negocio', 'Empleados y permisos', 'Exportaciones'].map((n) => `
      <div class="list-item" style="opacity:.55">
        <span class="avatar">✦</span>
        <div class="list-item-body"><div class="list-item-title">${n}</div><div class="list-item-sub">Próxima etapa</div></div>
      </div>
    `).join('')}
    <div class="section-title">Cuenta</div>
    <div class="list-item" data-action="logout">
      <span class="avatar">⎋</span>
      <div class="list-item-body"><div class="list-item-title">Cerrar sesión</div></div>
    </div>
  `;
}

// ---------------- WhatsApp helpers (sección 15) ----------------
function normalizePhone(tel) {
  const digits = (tel || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('54') ? digits : `54${digits}`;
}
function waLink(tel, texto) {
  if (!tel) return '#';
  return `https://wa.me/${normalizePhone(tel)}?text=${encodeURIComponent(texto)}`;
}
function mensajeSaludo(c) {
  if (c.proximoVencimiento && c.diasHastaVencimiento >= 0) {
    return `Hola ${c.nombre}! Te recordamos que tu próximo vencimiento es el ${fmtFecha(c.proximoVencimiento)}.`;
  }
  if (c.deudaTotalCentavos > 0) {
    return `Hola ${c.nombre}! Tenés un saldo pendiente de ${formatARS(c.deudaTotalCentavos)}. Cualquier consulta, escribinos.`;
  }
  return `Hola ${c.nombre}! ¿Cómo estás?`;
}

// ---------------- Iconos (inline SVG, sin dependencias) ----------------
function iconSearch() { return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconChevron() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconCobrar(s = 20) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M7 14.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconVenta() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 8h16l-1.4 10.1a2 2 0 0 1-2 1.9H7.4a2 2 0 0 1-2-1.9L4 8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8V6a4 4 0 1 1 8 0v2" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconClientes(s = 20) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 20c.8-3.4 3-5.2 5.5-5.2S13.7 16.6 14.5 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconProductos() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 7l9-4 9 4-9 4-9-4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 7v10l9 4 9-4V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`; }
function iconWhatsapp() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.6 13.8L3 21l4.4-1.4A9 9 0 1 0 12 3Z" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconLlamar() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`; }
function iconNota() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l3 3v15H6V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 10h6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`; }

// ---------------- Delegación de eventos global ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, credito, cliente, monto, nombre } = el.dataset;

  if (action === 'ver-cliente') location.hash = `#/clientes/${id}`;
  else if (action === 'elegir-negocio') { setNegocio(id || null); closeSheet(); }
  else if (action === 'ir-negocio') { setNegocio(id); location.hash = '#/inicio'; }
  else if (action === 'cerrar-sheet') closeSheet();
  else if (action === 'registrar-pago') abrirRegistrarPago(credito, cliente, monto ? Number(monto) : null);
  else if (action === 'elegir-cliente-venta') {
    document.getElementById('vClienteId').value = id;
    document.getElementById('vClienteBuscar').value = nombre;
    document.getElementById('vClienteResultados').innerHTML = '';
  } else if (action === 'crear-cliente-inline') abrirCrearCliente();
  else if (action === 'nota-cliente') toast('La edición de notas llega en la próxima etapa');
  else if (action === 'logout') { clearToken(); showAuthScreen(); }
});

document.getElementById('btnNegocioSwitch').addEventListener('click', abrirSelectorNegocio);
document.getElementById('fabButton').addEventListener('click', abrirMenuRapido);

function abrirMenuRapido() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Crear</div>
    <div class="quick-sheet-grid">
      <div class="quick-sheet-item" data-action="cerrar-sheet" onclick="abrirCrearCliente()">${iconClientes()}Cliente nuevo</div>
      <div class="quick-sheet-item" onclick="closeSheet(); location.hash='#/ventas/nueva'">${iconVenta()}Nueva venta</div>
      <div class="quick-sheet-item" onclick="closeSheet(); location.hash='#/cobrar'">${iconCobrar()}Registrar pago</div>
      <div class="quick-sheet-item" onclick="closeSheet(); abrirCrearProducto()">${iconProductos()}Producto nuevo</div>
    </div>
  `);
}

function abrirCrearCliente() {
  closeSheet();
  setTimeout(() => openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Cliente nuevo</div>
    <div class="field-row">
      <div class="field"><label>Nombre</label><input id="ncNombre" /></div>
      <div class="field"><label>Apellido</label><input id="ncApellido" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Teléfono / WhatsApp</label><input id="ncTelefono" /></div>
      <div class="field"><label>DNI</label><input id="ncDni" /></div>
    </div>
    <div class="field">
      <label>Negocio</label>
      <select id="ncNegocio">${state.negocios.map((n) => `<option value="${n.id}">${n.nombre}</option>`).join('')}</select>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarCliente">Guardar</button>
    </div>
  `), 210);
  setTimeout(() => {
    document.getElementById('btnGuardarCliente')?.addEventListener('click', async () => {
      const nombre = document.getElementById('ncNombre').value.trim();
      if (!nombre) return toast('El nombre es obligatorio', true);
      try {
        const c = await api('/clientes', {
          method: 'POST',
          body: JSON.stringify({
            nombre, apellido: document.getElementById('ncApellido').value,
            telefono: document.getElementById('ncTelefono').value,
            dni: document.getElementById('ncDni').value,
            negocio_id: document.getElementById('ncNegocio').value,
          }),
        });
        closeSheet();
        toast('Cliente creado ✓');
        location.hash = `#/clientes/${c.id}`;
      } catch (err) {
        toast(err.message, true);
      }
    });
  }, 250);
}

function abrirCrearProducto() {
  setTimeout(() => openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Producto nuevo</div>
    <div class="field"><label>Negocio</label><select id="npNegocio">${state.negocios.map((n) => `<option value="${n.id}">${n.nombre}</option>`).join('')}</select></div>
    <div class="field"><label>Nombre</label><input id="npNombre" placeholder="Ej: iPhone 13 128GB" /></div>
    <div class="field-row">
      <div class="field"><label>Categoría</label><input id="npCategoria" /></div>
      <div class="field"><label>Variante</label><input id="npVariante" placeholder="Talle / color / IMEI" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Precio contado</label><input type="number" id="npContado" /></div>
      <div class="field"><label>Precio financiado</label><input type="number" id="npFinanciado" /></div>
    </div>
    <div class="field"><label>Stock</label><input type="number" id="npStock" value="1" /></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarProducto">Guardar</button>
    </div>
  `), 210);
  setTimeout(() => {
    document.getElementById('btnGuardarProducto')?.addEventListener('click', async () => {
      const nombre = document.getElementById('npNombre').value.trim();
      if (!nombre) return toast('El nombre es obligatorio', true);
      try {
        await api('/productos', {
          method: 'POST',
          body: JSON.stringify({
            negocio_id: document.getElementById('npNegocio').value, nombre,
            categoria: document.getElementById('npCategoria').value,
            variante: document.getElementById('npVariante').value,
            precio_contado_centavos: toCentavos(document.getElementById('npContado').value),
            precio_financiado_centavos: toCentavos(document.getElementById('npFinanciado').value),
            stock: Number(document.getElementById('npStock').value || 1),
          }),
        });
        closeSheet();
        toast('Producto creado ✓');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }, 250);
}

// ---------------- Init ----------------
let authMode = 'login';

function wireAuthScreen() {
  document.getElementById('authTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    authMode = btn.dataset.mode;
    document.querySelectorAll('#authTabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('authNombreField').style.display = authMode === 'registro' ? 'block' : 'none';
    document.getElementById('authSubmit').textContent = authMode === 'registro' ? 'Crear cuenta' : 'Entrar';
    document.getElementById('authError').style.display = 'none';
  });

  document.getElementById('authSubmit').addEventListener('click', async () => {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const nombre = document.getElementById('authNombre').value.trim();
    const errBox = document.getElementById('authError');
    errBox.style.display = 'none';
    if (!email || !password) {
      errBox.textContent = 'Completá email y contraseña.';
      errBox.style.display = 'block';
      return;
    }
    try {
      const body = authMode === 'registro' ? { email, password, nombre } : { email, password };
      const data = await api(`/auth/${authMode === 'registro' ? 'registro' : 'login'}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      setToken(data.token);
      await arrancarApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });
}

async function arrancarApp() {
  try {
    state.negocios = await api('/negocios');
  } catch (err) {
    return; // si el token no era válido, api() ya mostró la pantalla de login de nuevo
  }
  hideAuthScreen();
  render();
}

(async function init() {
  wireAuthScreen();
  if (!getToken()) { showAuthScreen(); return; }
  await arrancarApp();
})();
