// =============================================================
// Zilky · Frontend (sin build step: JS plano + fetch a /api/*)
// =============================================================

const state = {
  negocios: [],
  negocioActual: null, // null = "Todos los negocios"
  cobranzaTab: 'hoy',
  cobranzaVentana: 7,
  clientesTab: 'todos',
  calMes: null, // 'YYYY-MM'
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
function setNegocio(negId) {
  state.negocioActual = negId;
  document.getElementById('negocioNombre').textContent = negocioNombre(negId);
  document.getElementById('brandMark').textContent = negId ? negocioNombre(negId)[0].toUpperCase() : 'Z';
  aplicarClaseNegocio();
  render();
}
function abrirSelectorNegocio() {
  const opciones = [{ id: '', nombre: 'Todos los negocios' }, ...state.negocios];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Cambiar de negocio</div>
    <div class="sheet-sub">El dashboard, cobranza y calendario se filtran automáticamente.</div>
    ${opciones.map((n) => `
      <div class="list-item" data-action="elegir-negocio" data-id="${n.id}">
        <span class="avatar" style="background:${n.color || 'var(--surface-2)'}22;color:${n.color || 'var(--text-muted)'}">${n.id ? n.nombre[0].toUpperCase() : '✦'}</span>
        <div class="list-item-body"><div class="list-item-title">${n.nombre}</div></div>
        ${(n.id || '') === (state.negocioActual || '') ? '<span class="badge badge-pagada">Activo</span>' : ''}
      </div>
    `).join('')}
    <button class="btn btn-secondary btn-block" style="margin-top:12px" data-action="abrir-crear-negocio">+ Crear negocio nuevo</button>
  `);
}
function abrirCrearNegocio() {
  closeSheet();
  setTimeout(() => openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Negocio nuevo</div>
    <div class="field"><label>Nombre</label><input id="nnNombre" placeholder="Ej: Zilky Reparaciones" /></div>
    <div class="field">
      <label>Color</label>
      <div class="tabs" id="nnColores">
        ${['#22D3B6', '#4C9BFF', '#F5A524', '#FB4B62', '#A78BFA'].map((c, i) => `<button type="button" data-color="${c}" class="${i === 0 ? 'active' : ''}" style="background:${c}22;color:${c};border-color:${c}55">●</button>`).join('')}
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Días de gracia</label><input type="number" id="nnGracia" value="7" /></div>
      <div class="field"><label>Mora (% por semana)</label><input type="number" id="nnMora" value="2" /></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarNegocio">Crear</button>
    </div>
  `), 210);
  setTimeout(() => {
    let colorElegido = '#22D3B6';
    document.getElementById('nnColores')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#nnColores button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); colorElegido = b.dataset.color;
    });
    document.getElementById('btnGuardarNegocio')?.addEventListener('click', async () => {
      const nombre = document.getElementById('nnNombre').value.trim();
      if (!nombre) return toast('Ponele un nombre', true);
      try {
        const n = await api('/negocios', {
          method: 'POST',
          body: JSON.stringify({
            nombre, color: colorElegido,
            dias_gracia: Number(document.getElementById('nnGracia').value || 7),
            mora_valor: Number(document.getElementById('nnMora').value || 2),
          }),
        });
        state.negocios.push(n);
        closeSheet();
        toast(`"${nombre}" creado ✓`);
        setNegocio(n.id);
      } catch (err) { toast(err.message, true); }
    });
  }, 250);
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
    else if (root === 'calendario') await viewCalendario(view);
    else if (root === 'ventas') await viewVentaNueva(view, parts[1] || null);
    else if (root === 'productos') await viewProductos(view);
    else if (root === 'comprobantes') await viewComprobantes(view);
    else if (root === 'configuracion') await viewConfiguracion(view);
    else if (root === 'empleados') await viewEmpleados(view);
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
      <div class="kpi kpi-wide">
        <div><div class="kpi-label">Vendido (total)</div><div class="kpi-value">${formatARS(r.vendidoTotalCentavos)}</div></div>
        <div style="text-align:right"><div class="kpi-label">Cobrado este mes</div><div class="kpi-value accent">${formatARS(r.cobradoMesCentavos)}</div></div>
      </div>
      <div class="kpi"><div class="kpi-label">Cobrado hoy</div><div class="kpi-value">${formatARS(r.cobradoHoyCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Por cobrar hoy</div><div class="kpi-value">${formatARS(r.porCobrarHoyCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Saldo pendiente total</div><div class="kpi-value">${formatARS(r.saldoPendienteTotalCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Saldo vencido</div><div class="kpi-value ${r.saldoVencidoCentavos > 0 ? 'danger' : ''}">${formatARS(r.saldoVencidoCentavos)}</div></div>
      <div class="kpi"><div class="kpi-label">Clientes en mora</div><div class="kpi-value ${r.clientesEnMora > 0 ? 'danger' : ''}">${r.clientesEnMora}</div></div>
      <div class="kpi"><div class="kpi-label">Monto en riesgo</div><div class="kpi-value danger">${formatARS(r.montoEnRiesgoCentavos)}</div></div>
      <div class="kpi kpi-wide">
        <div><div class="kpi-label">Ventas activas</div><div class="kpi-value">${r.ventasActivas}</div></div>
        <div style="text-align:right"><div class="kpi-label">Ventas finalizadas</div><div class="kpi-value">${r.ventasFinalizadas}</div></div>
      </div>
    </div>
    ${r.porNegocio ? `
      <div class="section-title">Por negocio (cobrado este mes)</div>
      <div class="negocio-split">
        ${r.porNegocio.map((n) => `
          <div class="negocio-chip" data-action="ir-negocio" data-id="${n.negocio_id}">
            <span class="lbl"><span class="dot" style="background:${n.color}"></span>${n.nombre}</span>
            <div class="val">${formatARS(n.cobradoMesCentavos)}</div>
            <div class="lbl" style="margin-top:2px">vendido: ${formatARS(n.vendidoTotalCentavos)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <div class="section-title">Accesos rápidos</div>
    <div class="quick-actions">
      <a class="btn btn-secondary" href="#/cobrar">${iconCobrar()}Cobrar</a>
      <a class="btn btn-secondary" href="#/calendario">${iconCalendario()}Calendario</a>
      <a class="btn btn-secondary" href="#/ventas/nueva">${iconVenta()}Nueva venta</a>
      <a class="btn btn-secondary" href="#/clientes">${iconClientes()}Clientes</a>
    </div>
  `;
}

// ---------------- Vista: Clientes (global) ----------------
async function viewClientes(view, q = '') {
  view.innerHTML = `
    <div class="section-title">Clientes</div>
    <div class="search-box">${iconSearch()}<input id="clienteSearch" placeholder="Buscar por nombre, DNI, teléfono o Instagram" value="${q}" /></div>
    <div class="tabs" id="clientesTabs">
      <button data-tab="todos" class="${state.clientesTab === 'todos' ? 'active' : ''}">Todos</button>
      <button data-tab="deuda" class="${state.clientesTab === 'deuda' ? 'active' : ''}">Con deuda${state.negocioActual ? '' : ' (elegí negocio)'}</button>
      <button data-tab="finalizados" class="${state.clientesTab === 'finalizados' ? 'active' : ''}">Finalizados${state.negocioActual ? '' : ' (elegí negocio)'}</button>
    </div>
    <div id="clientesList"><div class="skeleton">Buscando…</div></div>
  `;
  const input = document.getElementById('clienteSearch');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => renderClientesList(input.value.trim()), 220); });
  document.getElementById('clientesTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.clientesTab = b.dataset.tab;
    document.querySelectorAll('#clientesTabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    renderClientesList(input.value.trim());
  });
  await renderClientesList(q);
}

async function renderClientesList(q) {
  const list = document.getElementById('clientesList');

  if (state.clientesTab !== 'todos' && !state.negocioActual) {
    list.innerHTML = `<div class="empty-state"><p>Elegí un negocio arriba para ver esta lista.</p></div>`;
    return;
  }

  if (state.clientesTab === 'finalizados') {
    const finalizados = await api(`/clientes/finalizados?negocio_id=${state.negocioActual}`);
    list.innerHTML = !finalizados.length ? `<div class="empty-state"><p>Todavía nadie terminó de pagar acá.</p></div>` : finalizados.map((c) => `
      <div class="list-item" data-action="ver-cliente" data-id="${c.id}">
        <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
        <div class="list-item-body">
          <div class="list-item-title">${c.nombre} ${c.apellido || ''}</div>
          <div class="list-item-sub">${c.total_compras} compra(s) · última: ${fmtFecha(c.ultima_compra)}</div>
        </div>
        <span class="chev">${iconChevron()}</span>
      </div>
    `).join('');
    return;
  }

  const clientes = await api(`/clientes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  let filtrados = clientes;
  if (state.clientesTab === 'deuda') {
    // Trae deuda real consultando el detalle sería caro; usamos la búsqueda con negocio_id
    // (clientes que compraron en este negocio) y dejamos que el detalle confirme la deuda.
    filtrados = await api(`/clientes?negocio_id=${state.negocioActual}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  }

  if (!filtrados.length) {
    list.innerHTML = `<div class="empty-state">${iconClientes(40)}<p>No hay clientes${q ? ' que coincidan' : ' todavía'}.</p></div>`;
    return;
  }
  list.innerHTML = filtrados.map((c) => `
    <div class="list-item" data-action="ver-cliente" data-id="${c.id}">
      <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
      <div class="list-item-body">
        <div class="list-item-title">${c.nombre} ${c.apellido || ''}</div>
        <div class="list-item-sub">${c.telefono ? '📞 ' + c.telefono : ''}${c.instagram ? ' · ' + c.instagram : ''}</div>
      </div>
      <span class="chev">${iconChevron()}</span>
    </div>
  `).join('');
}

// ---------------- Vista: Detalle de cliente ----------------
async function viewClienteDetail(view, id) {
  const filtro = state.negocioActual ? `?negocio_id=${state.negocioActual}` : '';
  const c = await api(`/clientes/${id}${filtro}`);
  const riesgoClass = { bajo: 'riesgo-bajo', medio: 'riesgo-medio', alto: 'riesgo-alto', critico: 'riesgo-critico' }[c.riesgo?.nivel] || 'riesgo-bajo';
  const h = c.historial;

  view.innerHTML = `
    <div class="profile-header">
      <span class="avatar">${iniciales(c.nombre, c.apellido)}</span>
      <div><div class="profile-name">${c.nombre} ${c.apellido || ''}</div><div class="profile-sub">${c.telefono || 'Sin teléfono'} ${c.instagram ? '· ' + c.instagram : ''}</div></div>
    </div>

    <div class="tabs" style="margin-top:14px">
      <button data-action="ver-cliente-negocio" data-id="" class="${!state.negocioActual ? 'active' : ''}">Todos los negocios</button>
      ${state.negocios.map((n) => `<button data-action="ver-cliente-negocio" data-id="${n.id}" data-cid="${c.id}" class="${state.negocioActual === n.id ? 'active' : ''}">${n.nombre}</button>`).join('')}
    </div>

    <div class="debt-hero">
      <div class="lbl">Deuda ${state.negocioActual ? 'en ' + negocioNombre(state.negocioActual) : 'total (todos los negocios)'}</div>
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
      <button class="btn btn-secondary" data-action="editar-seguimiento" data-id="${c.id}">${iconNota()}Seguimiento</button>
    </div>

    <div class="section-title">Historial financiero</div>
    <div class="card">
      <div class="cuota-row"><div class="cn">Compras</div><div class="amt">${h.cantidadCompras}</div></div>
      <div class="cuota-row"><div class="cn">Cuotas pagadas a tiempo / tarde</div><div class="amt">${h.cuotasPagadasATiempo} / ${h.cuotasPagadasTarde}</div></div>
      <div class="cuota-row"><div class="cn">Atraso promedio / máximo</div><div class="amt">${h.atrasoPromedioDias}d / ${h.atrasoMaximoDias}d</div></div>
      <div class="cuota-row"><div class="cn">Total cobrado histórico</div><div class="amt">${formatARS(h.totalCobradoCentavos)}</div></div>
      <div class="cuota-row"><div class="cn">Compras finalizadas</div><div class="amt">${h.comprasFinalizadas}</div></div>
      <div class="cuota-row"><div class="cn">Última compra / último pago</div><div class="amt" style="font-size:12px">${fmtFecha(h.fechaUltimaCompra)} · ${fmtFecha(h.fechaUltimoPago)}</div></div>
    </div>

    <div class="section-title">Créditos</div>
    ${c.creditos.length === 0 ? `<div class="empty-state"><p>Todavía no compró nada${state.negocioActual ? ' en ' + negocioNombre(state.negocioActual) : ''}.</p></div>` : c.creditos.map((cr) => creditoCardHtml(cr)).join('')}

    <div class="section-title">Historial de pagos</div>
    ${c.pagos.length === 0 ? `<div class="empty-state"><p>Sin pagos registrados.</p></div>` : `
      <div class="card">
        ${c.pagos.slice(0, 12).map((p) => `
          <div class="hist-row">
            <div><div class="hd">${p.medio_pago}${p.anulado ? ' · <span style="color:var(--danger)">ANULADO</span>' : ''}</div><div class="hm">${fmtFecha(p.fecha_hora)} ${p.fecha_hora.slice(11, 16)}</div></div>
            <div class="amt" style="${p.anulado ? 'color:var(--text-faint);text-decoration:line-through' : ''}">+${formatARS(p.monto_centavos)}</div>
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
          <div class="credito-modalidad"><span class="cred-negocio-tag">${negocio?.nombre || ''}</span> · ${{ libre: 'Pago libre', cuotas: 'Cuotas mensuales', unico: 'Pago único' }[cr.modalidad] || cr.modalidad}</div>
          <div style="font-weight:700;margin-top:6px">${formatARS(cr.saldo_financiado_centavos)} financiados</div>
        </div>
        <span class="badge badge-${cr.estado === 'finalizado' ? 'pagada' : cr.estado === 'en_mora' ? 'mora' : cr.estado === 'en_gracia' ? 'gracia' : 'activa'}">${cr.estado.replace('_', ' ')}</span>
      </div>
      ${cr.cuotas.map((cu) => `
        <div class="cuota-row">
          <div class="cn">Cuota ${cu.numero}/${cr.cuotas.length} · vence ${fmtFecha(cu.fecha_vencimiento)}</div>
          <div class="cr"><span class="amt">${formatARS(cu.saldo_pendiente_centavos)}</span><span class="badge badge-${cu.estado}">${ESTADO_LABEL[cu.estado] || cu.estado}</span></div>
        </div>
      `).join('')}
      ${pendiente ? `<button class="btn btn-primary btn-block" style="margin-top:12px" data-action="registrar-pago" data-credito="${cr.id}">${iconCobrar()}Registrar pago</button>` : ''}
    </div>
  `;
}

function abrirEditarSeguimiento(clienteId) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Seguimiento comercial</div>
    <div class="field">
      <label>Estado</label>
      <select id="segEstado">
        <option value="">Sin marcar</option>
        <option value="contactado">Contactado</option>
        <option value="no_interesado">No interesado</option>
        <option value="volver_a_contactar">Volver a contactar</option>
      </select>
    </div>
    <div class="field"><label>Nota (opcional)</label><input id="segNota" placeholder="Ej: pidió que lo llame la semana que viene" /></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarSeguimiento">Guardar</button>
    </div>
  `);
  document.getElementById('btnGuardarSeguimiento').addEventListener('click', async () => {
    try {
      await api(`/clientes/${clienteId}/seguimiento`, {
        method: 'PATCH',
        body: JSON.stringify({
          seguimiento_estado: document.getElementById('segEstado').value || null,
          seguimiento_nota: document.getElementById('segNota').value || null,
          seguimiento_fecha: todayISO(),
        }),
      });
      closeSheet(); toast('Guardado ✓'); render();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------- Sheet: registrar pago ----------------
async function abrirRegistrarPago(creditoId, montoSugerido = null) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Registrar pago</div>
    <div class="sheet-sub">Se aplica automáticamente: primero mora vencida, después capital de la cuota más antigua. Genera comprobante.</div>
    <div class="field"><label>Monto entregado</label><input type="number" inputmode="decimal" id="pagoMonto" placeholder="0" value="${montoSugerido ?? ''}" autofocus /></div>
    <div class="field-row">
      <div class="field">
        <label>Medio de pago</label>
        <select id="pagoMedio"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="mercado_pago">Mercado Pago</option><option value="otro">Otro</option></select>
      </div>
      <div class="field"><label>Fecha</label><input type="date" id="pagoFecha" value="${todayISO()}" /></div>
    </div>
    <div class="field"><label>Nota (opcional)</label><input type="text" id="pagoNota" placeholder="Ej: entrega parcial" /></div>
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
      const r = await api('/pagos', {
        method: 'POST',
        body: JSON.stringify({
          credito_id: creditoId, monto_centavos: monto,
          medio_pago: document.getElementById('pagoMedio').value,
          fecha_hora: `${fecha}T${new Date().toTimeString().slice(0, 8)}-03:00`,
          nota: document.getElementById('pagoNota').value || null,
        }),
      });
      closeSheet();
      toast(`Pago registrado ✓ Comprobante ${r.comprobante.numero}`);
      render();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------- Vista: Cobrar ----------------
async function viewCobrar(view) {
  const b = await api(`/dashboard/cobranza${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}&ventana_dias=${state.cobranzaVentana}`);
  const recordatorios = await api(`/dashboard/recordatorios${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}`);

  view.innerHTML = `
    ${recordatorios.length ? `
      <div class="reminder-banner">
        <div class="rb-title">${iconWhatsapp()} ${recordatorios.length} cliente(s) para recordar hoy</div>
        <div class="field-hint" style="margin:6px 0 10px">Según los días configurados en el negocio.</div>
        ${recordatorios.map((c) => `
          <div class="list-item" style="background:var(--bg-elevated)" data-action="ver-cliente" data-id="${c.cliente_id}">
            <span class="avatar">${iniciales(c.cliente_nombre, c.cliente_apellido)}</span>
            <div class="list-item-body"><div class="list-item-title">${c.cliente_nombre} ${c.cliente_apellido || ''}</div><div class="list-item-sub">${c.diasAntes === 0 ? 'Vence hoy' : `Vence en ${c.diasAntes} días`}</div></div>
            <a class="btn btn-primary" style="padding:8px 12px;font-size:12px" href="${waLink(c.cliente_telefono, mensajeRecordatorio(c))}" target="_blank" onclick="event.stopPropagation()">Avisar</a>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="section-title">Cobranza</div>
    <div class="tabs" id="cobranzaTabs">
      <button data-tab="hoy" class="${state.cobranzaTab === 'hoy' ? 'active' : ''}">Hoy (${b.hoy.length})</button>
      <button data-tab="proximas" class="${state.cobranzaTab === 'proximas' ? 'active' : ''}">Próximas (${b.proximas.length})</button>
      <button data-tab="vencidas" class="${state.cobranzaTab === 'vencidas' ? 'active' : ''}">Vencidas (${b.vencidas.length})</button>
      <button data-tab="todas" class="${state.cobranzaTab === 'todas' ? 'active' : ''}">Todas (${b.todas.length})</button>
    </div>
    ${state.cobranzaTab === 'proximas' ? `
      <div class="tabs">
        ${[3, 5, 7].map((d) => `<button data-ventana="${d}" class="${state.cobranzaVentana === d ? 'active' : ''}">Próximos ${d} días</button>`).join('')}
      </div>
    ` : ''}
    <div id="cobranzaList">${cobranzaListHtml(b[state.cobranzaTab])}</div>
  `;

  document.getElementById('cobranzaTabs').addEventListener('click', (e) => {
    const b2 = e.target.closest('button'); if (!b2) return;
    state.cobranzaTab = b2.dataset.tab;
    render();
  });
  view.querySelectorAll('[data-ventana]').forEach((btn) => {
    btn.addEventListener('click', () => { state.cobranzaVentana = Number(btn.dataset.ventana); render(); });
  });
}

function cobranzaListHtml(items) {
  if (!items || !items.length) return `<div class="empty-state">${iconCobrar(40)}<p>Nada por acá. 🎉</p></div>`;
  return items.map((c) => `
    <div class="list-item" data-action="ver-cliente" data-id="${c.cliente_id}">
      <span class="avatar">${iniciales(c.cliente_nombre, c.cliente_apellido)}</span>
      <div class="list-item-body">
        <div class="list-item-title">${c.cliente_nombre} ${c.cliente_apellido || ''}</div>
        <div class="list-item-sub">
          ${!state.negocioActual ? `<span class="cred-negocio-tag">${negocioNombre(c.negocio_id)}</span>` : ''}
          <span class="badge badge-${c.estado}">${ESTADO_LABEL[c.estado] || c.estado}</span>
          Cuota ${c.numero}/${c.total_cuotas} ${c.diasAtraso > 0 ? `· ${c.diasAtraso}d de atraso` : `· vence ${fmtFecha(c.fecha_vencimiento)}`}
        </div>
      </div>
      <div class="list-item-trail">
        <div class="list-item-amount">${formatARS(c.saldo_pendiente_centavos + (c.moraPendiente || 0))}</div>
        <button class="btn btn-primary" style="margin-top:6px;padding:8px 12px;font-size:12.5px" data-action="registrar-pago" data-credito="${c.credito_id}" data-monto="${(c.saldo_pendiente_centavos + (c.moraPendiente || 0)) / 100}" onclick="event.stopPropagation()">Cobrar</button>
      </div>
    </div>
  `).join('');
}

// ---------------- Vista: Calendario ----------------
async function viewCalendario(view) {
  if (!state.calMes) state.calMes = todayISO().slice(0, 7);
  if (!state.negocioActual) {
    view.innerHTML = `<div class="section-title">Calendario</div><div class="empty-state"><p>Elegí un negocio arriba para ver su calendario de vencimientos.</p></div>`;
    return;
  }
  const dias = await api(`/dashboard/calendario?negocio_id=${state.negocioActual}&mes=${state.calMes}`);
  const porFecha = Object.fromEntries(dias.map((d) => [d.fecha, d]));
  const [y, m] = state.calMes.split('-').map(Number);
  const primerDia = new Date(Date.UTC(y, m - 1, 1));
  const diasEnMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = primerDia.getUTCDay(); // 0=domingo
  const nombreMes = primerDia.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  let celdas = '';
  for (let i = 0; i < offset; i++) celdas += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= diasEnMes; d++) {
    const fecha = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const info = porFecha[fecha];
    const esHoy = fecha === todayISO();
    celdas += `
      <div class="cal-day ${info ? 'has-events' : ''} ${esHoy ? 'today' : ''}" ${info ? `data-action="ver-dia-calendario" data-fecha="${fecha}"` : ''}>
        <span>${d}</span>
        ${info ? `<span class="dot-count">${info.cantidad}</span>` : ''}
      </div>`;
  }

  view.innerHTML = `
    <div class="section-title">Calendario · ${negocioNombre(state.negocioActual)}</div>
    <div class="cal-header">
      <div class="cal-month">${nombreMes}</div>
      <div class="cal-nav">
        <button data-action="cal-mes" data-delta="-1">${iconChevronLeft()}</button>
        <button data-action="cal-mes" data-delta="1">${iconChevron()}</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['D', 'L', 'M', 'M', 'J', 'V', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${celdas}
    </div>
    <div class="field-hint" style="margin-top:14px">Tocá un día con vencimientos para ver el detalle.</div>
  `;
}

async function abrirDiaCalendario(fecha) {
  const cuotas = await api(`/dashboard/calendario/dia?negocio_id=${state.negocioActual}&fecha=${fecha}`);
  const total = cuotas.reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">${fmtFecha(fecha)}</div>
    <div class="sheet-sub">${cuotas.length} vencimiento(s) · ${formatARS(total)} por cobrar</div>
    ${cuotas.map((c) => `
      <div class="list-item" data-action="ver-cliente" data-id="${c.cliente_id}">
        <span class="avatar">${iniciales(c.cliente_nombre, c.cliente_apellido)}</span>
        <div class="list-item-body"><div class="list-item-title">${c.cliente_nombre} ${c.cliente_apellido || ''}</div><div class="list-item-sub">Cuota ${c.numero}/${c.total_cuotas} · <span class="badge badge-${c.estado}">${ESTADO_LABEL[c.estado] || c.estado}</span></div></div>
        <div class="list-item-trail">
          <div class="list-item-amount">${formatARS(c.saldo_pendiente_centavos)}</div>
          <button class="btn btn-primary" style="margin-top:6px;padding:8px 12px;font-size:12px" data-action="registrar-pago" data-credito="${c.credito_id}" data-monto="${c.saldo_pendiente_centavos / 100}">Cobrar</button>
        </div>
      </div>
    `).join('')}
  `);
}

// ---------------- Vista: Nueva venta ----------------
async function viewVentaNueva(view, clientePreId) {
  if (!state.negocios.length) { view.innerHTML = `<div class="empty-state"><p>Primero creá un negocio (arriba, "Cambiar" → "Crear negocio nuevo").</p></div>`; return; }
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
        <input id="vClienteBuscar" placeholder="Buscar cliente (o crear uno nuevo)" value="${clientePre ? clientePre.nombre + ' ' + (clientePre.apellido || '') : ''}" />
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
        <div class="field"><label>Monto total</label><input type="number" id="vMontoTotal" placeholder="0" /></div>
        <div class="field"><label>Entrega inicial</label><input type="number" id="vEntrega" placeholder="0" value="0" /></div>
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
  document.getElementById('vNegocio').addEventListener('change', () => render());

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
    box.innerHTML = `<div class="field"><label>Fecha límite de pago</label><input type="date" id="vFechaLimite" /></div><div class="field-hint">Si no elegís una fecha, se usan 30 días desde hoy por defecto.</div>`;
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
    const r = await api('/ventas', { method: 'POST', body: JSON.stringify(body) });
    if (r.advertencias?.length) toast(r.advertencias.join(' '));
    else toast('Venta creada ✓');
    location.hash = `#/clientes/${cliente_id}`;
  } catch (err) { toast(err.message, true); }
}

// ---------------- Vista: Productos ----------------
async function viewProductos(view) {
  if (!state.negocioActual) { view.innerHTML = `<div class="empty-state"><p>Elegí un negocio arriba para ver su catálogo.</p></div>`; return; }
  const productos = await api(`/productos?negocio_id=${state.negocioActual}`);
  view.innerHTML = `
    <div class="section-title">Productos · ${negocioNombre(state.negocioActual)}</div>
    ${productos.length === 0 ? '<div class="empty-state"><p>Sin productos cargados.</p></div>' : productos.map((p) => `
      <div class="list-item">
        <span class="avatar">${p.nombre[0]}</span>
        <div class="list-item-body">
          <div class="list-item-title">${p.nombre}</div>
          <div class="list-item-sub">${p.variante || p.categoria || ''} · Stock: ${p.stock === null ? 'sin control' : p.stock}${p.stock !== null && p.stock <= p.stock_minimo ? ' ⚠️' : ''}</div>
        </div>
        <div class="list-item-trail"><div class="list-item-amount">${formatARS(p.precio_financiado_centavos)}</div></div>
      </div>
    `).join('')}
  `;
}

// ---------------- Vista: Comprobantes ----------------
async function viewComprobantes(view) {
  if (!state.negocioActual) { view.innerHTML = `<div class="empty-state"><p>Elegí un negocio arriba para ver sus comprobantes.</p></div>`; return; }
  const comprobantes = await api(`/comprobantes?negocio_id=${state.negocioActual}`);
  view.innerHTML = `
    <div class="section-title">Comprobantes · ${negocioNombre(state.negocioActual)}</div>
    ${comprobantes.length === 0 ? '<div class="empty-state"><p>Todavía no hay comprobantes.</p></div>' : comprobantes.map((c) => `
      <div class="list-item" style="cursor:default">
        <span class="avatar">${c.estado === 'anulado' ? '✕' : '✓'}</span>
        <div class="list-item-body">
          <div class="list-item-title">${c.numero}${c.estado === 'anulado' ? ' <span class="badge badge-mora">Anulado</span>' : ''}</div>
          <div class="list-item-sub">${fmtFecha(c.fecha_hora)} · ${c.medio_pago || ''}</div>
        </div>
        <div class="list-item-trail">
          <div class="list-item-amount" style="${c.estado === 'anulado' ? 'text-decoration:line-through;color:var(--text-faint)' : ''}">${formatARS(c.monto_centavos)}</div>
          ${c.estado !== 'anulado' ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;margin-top:4px" data-action="anular-comprobante" data-id="${c.id}">Anular</button>` : ''}
        </div>
      </div>
    `).join('')}
  `;
}

function abrirAnularComprobante(comprobanteId) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Anular comprobante</div>
    <div class="sheet-sub">No se borra: queda marcado como anulado y el saldo vuelve a quedar pendiente.</div>
    <div class="field"><label>Motivo</label><input id="anMotivo" placeholder="Ej: se cargó por error" /></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-danger" id="btnConfirmarAnular">Anular</button>
    </div>
  `);
  document.getElementById('btnConfirmarAnular').addEventListener('click', async () => {
    const motivo = document.getElementById('anMotivo').value.trim();
    if (!motivo) return toast('Contá el motivo', true);
    try {
      await api(`/comprobantes/${comprobanteId}/anular`, { method: 'POST', body: JSON.stringify({ motivo }) });
      closeSheet(); toast('Comprobante anulado'); render();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------- Vista: Configuración del negocio ----------------
async function viewConfiguracion(view) {
  if (!state.negocioActual) { view.innerHTML = `<div class="empty-state"><p>Elegí un negocio arriba para configurarlo.</p></div>`; return; }
  const n = await api(`/negocios/${state.negocioActual}`);
  const reglas = JSON.parse(n.recordatorio_dias || '[]');
  const opcionesRecordatorio = [7, 5, 3, 2, 1, 0];

  view.innerHTML = `
    <div class="section-title">Configuración · ${n.nombre}</div>
    <div class="card">
      <div class="field-row">
        <div class="field"><label>Días de gracia</label><input type="number" id="cfGracia" value="${n.dias_gracia}" /></div>
        <div class="field"><label>Mora (%)</label><input type="number" id="cfMoraValor" value="${n.mora_valor}" /></div>
      </div>
      <div class="field">
        <label>Mora calculada por</label>
        <select id="cfMoraPeriodo">
          <option value="dia" ${n.mora_periodo === 'dia' ? 'selected' : ''}>Día</option>
          <option value="semana" ${n.mora_periodo === 'semana' ? 'selected' : ''}>Semana</option>
          <option value="mes" ${n.mora_periodo === 'mes' ? 'selected' : ''}>Mes</option>
        </select>
      </div>
    </div>
    <div class="section-title">Recordatorios de WhatsApp</div>
    <div class="field-hint" style="margin-bottom:10px">Elegí con cuántos días de anticipación aparece el cliente en la lista de "para recordar hoy".</div>
    <div>
      ${opcionesRecordatorio.map((d) => `
        <button type="button" class="chip-toggle ${reglas.includes(d) ? 'active' : ''}" data-dia="${d}">${d === 0 ? 'El mismo día' : `${d} día(s) antes`}</button>
      `).join('')}
    </div>
    <button class="btn btn-primary btn-block btn-lg" id="btnGuardarConfig" style="margin-top:20px">Guardar</button>
  `;

  const reglasActuales = new Set(reglas);
  view.querySelectorAll('.chip-toggle').forEach((chip) => {
    chip.addEventListener('click', () => {
      const d = Number(chip.dataset.dia);
      if (reglasActuales.has(d)) { reglasActuales.delete(d); chip.classList.remove('active'); }
      else { reglasActuales.add(d); chip.classList.add('active'); }
    });
  });

  document.getElementById('btnGuardarConfig').addEventListener('click', async () => {
    try {
      await api(`/negocios/${state.negocioActual}`, {
        method: 'PATCH',
        body: JSON.stringify({
          dias_gracia: Number(document.getElementById('cfGracia').value),
          mora_valor: Number(document.getElementById('cfMoraValor').value),
          mora_periodo: document.getElementById('cfMoraPeriodo').value,
          recordatorio_dias: Array.from(reglasActuales).sort((a, b) => b - a),
        }),
      });
      toast('Configuración guardada ✓');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------- Vista: Más ----------------
async function viewMas(view) {
  view.innerHTML = `
    <div class="section-title">Más</div>
    <a class="list-item" href="#/productos"><span class="avatar">${iconProductos()}</span><div class="list-item-body"><div class="list-item-title">Productos y stock</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/comprobantes"><span class="avatar">🧾</span><div class="list-item-body"><div class="list-item-title">Comprobantes</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/configuracion"><span class="avatar">⚙️</span><div class="list-item-body"><div class="list-item-title">Configuración del negocio</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/empleados"><span class="avatar">👥</span><div class="list-item-body"><div class="list-item-title">Empleados y permisos</div></div><span class="chev">${iconChevron()}</span></a>
    ${['Contratos', 'Caja', 'Exportaciones'].map((n) => `
      <div class="list-item" style="opacity:.55"><span class="avatar">✦</span><div class="list-item-body"><div class="list-item-title">${n}</div><div class="list-item-sub">Próxima etapa</div></div></div>
    `).join('')}
    <div class="section-title">Cuenta</div>
    <div class="list-item" data-action="logout"><span class="avatar">⎋</span><div class="list-item-body"><div class="list-item-title">Cerrar sesión</div></div></div>
  `;
}

// ---------------- Empleados y permisos ----------------
const PERMISOS_EMPLEADO = ['clientes.ver','clientes.editar','ventas.crear','pagos.registrar','productos.ver','cobranzas.ver','dashboard_financiero.ver'];
function parseJsonSeguro(v, fallback = {}) { if (v && typeof v === 'object') return v; try { return JSON.parse(v || ''); } catch { return fallback; } }

async function viewEmpleados(view) {
  const [usuarios, invitaciones, negocios] = await Promise.all([api('/usuarios'), api('/invitaciones'), api('/negocios')]);
  const negocioMap = Object.fromEntries(negocios.map((n) => [n.id, n]));
  const empleados = usuarios.filter((u) => u.rol !== 'administrador');
  let html = `<div class="section-title">Empleados y permisos</div>`;
  html += `<div class="card"><div class="section-title">Empleados</div>`;
  if (!empleados.length) html += `<p style="color:var(--muted)">No hay empleados registrados.</p>`;
  for (const u of empleados) {
    const nombres = (u.negocios || []).filter((n) => n.activo).map((n) => negocioMap[n.negocio_id]?.nombre || n.negocio_id).join(', ');
    html += `<div class="list-item"><span class="avatar">${(u.nombre || u.email || '?').slice(0,1).toUpperCase()}</span><div class="list-item-body"><div class="list-item-title">${u.nombre || 'Sin nombre'}</div><div class="list-item-sub">${u.email} · ${u.activo ? 'Activo' : 'Inactivo'}<br>Negocios: ${nombres || 'Ninguno'}</div></div><div style="display:flex;gap:6px;flex-direction:column"><button class="btn btn-secondary" onclick="toggleEmpleado('${u.id}',${u.activo ? 'false' : 'true'})">${u.activo ? 'Desactivar' : 'Activar'}</button><button class="btn btn-secondary" onclick="editarEmpleado('${u.id}')">Permisos</button></div></div>`;
  }
  html += `</div><div class="card" style="margin-top:14px"><div class="section-title">Invitar empleado</div><div class="field"><label>Email</label><input id="invEmail" type="email" placeholder="empleado@email.com"></div><div class="field"><label>Nombre</label><input id="invNombreEmpleado" placeholder="Nombre (opcional)"></div><div class="field"><label>Negocios y permisos</label>`;
  for (const n of negocios) html += bloquePermisos(n, 'inv', {}, false);
  html += `</div><button class="btn btn-primary btn-block" onclick="enviarInvitacion()">Crear invitación</button></div>`;
  const pendientes = invitaciones.filter((i) => i.estado === 'pendiente');
  html += `<div class="card" style="margin-top:14px"><div class="section-title">Invitaciones pendientes</div>`;
  if (!pendientes.length) html += `<p style="color:var(--muted)">No hay invitaciones pendientes.</p>`;
  for (const inv of pendientes) {
    const asignaciones = parseJsonSeguro(inv.negocios, []);
    const nombres = asignaciones.map((a) => negocioMap[a.negocio_id]?.nombre || a.negocio_id).join(', ');
    html += `<div class="list-item"><div class="list-item-body"><div class="list-item-title">${inv.email}</div><div class="list-item-sub">Expira: ${fmtFecha(inv.expira_en)} · ${nombres}</div></div><div style="display:flex;gap:6px;flex-direction:column"><button class="btn btn-secondary" onclick="regenerarInvitacion('${inv.id}')">Regenerar</button><button class="btn btn-secondary" onclick="revocarInvitacion('${inv.id}')">Revocar</button></div></div>`;
  }
  html += `</div>`;
  view.innerHTML = html;
}
function bloquePermisos(n, prefijo, permisos, activo) {
  return `<div style="margin:8px 0;padding:10px;border:1px solid var(--border);border-radius:10px"><label style="font-weight:600"><input type="checkbox" class="${prefijo}-negocio-check" data-id="${n.id}" ${activo ? 'checked' : ''}> ${n.nombre}</label><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">${PERMISOS_EMPLEADO.map((p) => `<label style="font-size:12px"><input type="checkbox" class="${prefijo}-permiso-check" data-negocio="${n.id}" data-permiso="${p}" ${permisos[p] ? 'checked' : ''}> ${p}</label>`).join('')}</div></div>`;
}
function recogerAsignaciones(prefijo) {
  const negocios = [];
  document.querySelectorAll(`.${prefijo}-negocio-check:checked`).forEach((cb) => {
    const permisos = {};
    document.querySelectorAll(`.${prefijo}-permiso-check[data-negocio="${cb.dataset.id}"]:checked`).forEach((p) => { permisos[p.dataset.permiso] = true; });
    negocios.push({ negocio_id: cb.dataset.id, permisos });
  });
  return negocios;
}
async function toggleEmpleado(id, activo) { try { await api(`/usuarios/${id}`, { method:'PATCH', body:JSON.stringify({ activo: activo ? 1 : 0 }) }); toast('Empleado actualizado ✓'); render(); } catch(e){ toast(e.message,true); } }
async function editarEmpleado(id) {
  try {
    const [u, negocios] = await Promise.all([api(`/usuarios/${id}`), api('/negocios')]);
    let html = `<div class="sheet-handle"></div><div class="sheet-title">Permisos · ${u.nombre || u.email}</div>`;
    for (const n of negocios) { const a=(u.negocios||[]).find((x)=>x.negocio_id===n.id); html += bloquePermisos(n,'edit',parseJsonSeguro(a?.permisos,{}),!!a?.activo); }
    html += `<div class="sheet-actions"><button class="btn btn-secondary" onclick="closeSheet()">Cancelar</button><button class="btn btn-primary" onclick="guardarEmpleado('${id}')">Guardar</button></div>`;
    openSheet(html);
  } catch(e){ toast(e.message,true); }
}
async function guardarEmpleado(id) { try { await api(`/usuarios/${id}`, {method:'PATCH', body:JSON.stringify({negocios:recogerAsignaciones('edit')})}); closeSheet(); toast('Permisos guardados ✓'); render(); } catch(e){ toast(e.message,true); } }
async function copiarLinkInvitacion(token) {
  const link = `${location.origin}${location.pathname}?token=${encodeURIComponent(token)}`;
  try { await navigator.clipboard.writeText(link); toast('Link de invitación copiado ✓'); } catch { window.prompt('Copiá este link de invitación:', link); }
}
async function enviarInvitacion() {
  const email=document.getElementById('invEmail').value.trim(), nombre=document.getElementById('invNombreEmpleado').value.trim(), negocios=recogerAsignaciones('inv');
  if(!email) return toast('Email es obligatorio',true); if(!negocios.length) return toast('Seleccioná al menos un negocio',true);
  try { const r=await api('/invitaciones',{method:'POST',body:JSON.stringify({email,nombre,negocios})}); await copiarLinkInvitacion(r.token); render(); } catch(e){toast(e.message,true);}
}
async function revocarInvitacion(id){ if(!confirm('¿Revocar esta invitación?'))return; try{await api(`/invitaciones/${id}/revocar`,{method:'POST'});toast('Invitación revocada');render();}catch(e){toast(e.message,true);} }
async function regenerarInvitacion(id){ if(!confirm('¿Regenerar la invitación?'))return; try{const r=await api(`/invitaciones/${id}/regenerar`,{method:'POST'});await copiarLinkInvitacion(r.token);render();}catch(e){toast(e.message,true);} }

async function renderAceptarInvitacion() {
  const token = new URLSearchParams(location.search).get('token');
  document.getElementById('authScreen').style.display='none'; document.getElementById('root').style.display='none'; document.getElementById('invitacionScreen').style.display='flex';
  const btn=document.getElementById('btnAceptarInvitacion');
  btn.onclick=async()=>{ const nombre=document.getElementById('invNombre').value.trim(), password=document.getElementById('invPassword').value, password2=document.getElementById('invPassword2').value, err=document.getElementById('invError'); err.style.display='none';
    if(password.length<6){err.textContent='La contraseña debe tener al menos 6 caracteres';err.style.display='block';return;} if(password!==password2){err.textContent='Las contraseñas no coinciden';err.style.display='block';return;}
    try{const data=await api('/auth/invitacion/aceptar',{method:'POST',body:JSON.stringify({token,password,nombre})});setToken(data.token);history.replaceState({},'',location.pathname+'#/inicio');document.getElementById('invitacionScreen').style.display='none';await arrancarApp();}catch(e){err.textContent=e.message;err.style.display='block';}
  };
}

// ---------------- WhatsApp helpers ----------------
function normalizePhone(tel) {
  const digits = (tel || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('54') ? digits : `54${digits}`;
}
function waLink(tel, texto) { if (!tel) return '#'; return `https://wa.me/${normalizePhone(tel)}?text=${encodeURIComponent(texto)}`; }
function mensajeSaludo(c) {
  if (c.proximoVencimiento && c.diasHastaVencimiento >= 0) return `Hola ${c.nombre}! Te recordamos que tu próximo vencimiento es el ${fmtFecha(c.proximoVencimiento)}.`;
  if (c.deudaTotalCentavos > 0) return `Hola ${c.nombre}! Tenés un saldo pendiente de ${formatARS(c.deudaTotalCentavos)}. Cualquier consulta, escribinos.`;
  return `Hola ${c.nombre}! ¿Cómo estás?`;
}
function mensajeRecordatorio(c) {
  if (c.diasAntes === 0) return `Hola ${c.cliente_nombre}! Tu cuota vence hoy. El saldo es de ${formatARS(c.saldo_pendiente_centavos)}.`;
  return `Hola ${c.cliente_nombre}! Te recordamos que tu cuota vence el ${fmtFecha(c.fecha_vencimiento)} (en ${c.diasAntes} día${c.diasAntes === 1 ? '' : 's'}). El saldo es de ${formatARS(c.saldo_pendiente_centavos)}.`;
}

// ---------------- Iconos ----------------
function iconSearch() { return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconChevron() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconChevronLeft() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="m15 6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconCobrar(s = 20) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M7 14.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconVenta() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 8h16l-1.4 10.1a2 2 0 0 1-2 1.9H7.4a2 2 0 0 1-2-1.9L4 8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8V6a4 4 0 1 1 8 0v2" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconClientes(s = 20) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 20c.8-3.4 3-5.2 5.5-5.2S13.7 16.6 14.5 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconProductos() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 7l9-4 9 4-9 4-9-4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 7v10l9 4 9-4V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`; }
function iconWhatsapp() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.6 13.8L3 21l4.4-1.4A9 9 0 1 0 12 3Z" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconLlamar() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`; }
function iconNota() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l3 3v15H6V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 10h6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`; }
function iconCalendario() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }

// ---------------- Delegación de eventos global ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, credito, monto, nombre, fecha, delta } = el.dataset;

  if (action === 'ver-cliente') location.hash = `#/clientes/${id}`;
  else if (action === 'elegir-negocio') { setNegocio(id || null); closeSheet(); }
  else if (action === 'ir-negocio') { setNegocio(id); location.hash = '#/inicio'; }
  else if (action === 'abrir-crear-negocio') abrirCrearNegocio();
  else if (action === 'cerrar-sheet') closeSheet();
  else if (action === 'registrar-pago') abrirRegistrarPago(credito, monto ? Number(monto) : null);
  else if (action === 'ver-cliente-negocio') { setNegocio(id || null); const parts = parseHash(); if (parts[1]) render(); }
  else if (action === 'editar-seguimiento') abrirEditarSeguimiento(id);
  else if (action === 'anular-comprobante') abrirAnularComprobante(id);
  else if (action === 'cal-mes') {
    const [y, m] = state.calMes.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + Number(delta), 1));
    state.calMes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    render();
  }
  else if (action === 'ver-dia-calendario') abrirDiaCalendario(fecha);
  else if (action === 'elegir-cliente-venta') {
    document.getElementById('vClienteId').value = id;
    document.getElementById('vClienteBuscar').value = nombre;
    document.getElementById('vClienteResultados').innerHTML = '';
  }
  else if (action === 'crear-cliente-inline') abrirCrearCliente();
  else if (action === 'logout') { clearToken(); showAuthScreen(); }
});

document.getElementById('btnNegocioSwitch').addEventListener('click', abrirSelectorNegocio);
document.getElementById('fabButton').addEventListener('click', abrirMenuRapido);

function abrirMenuRapido() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Crear</div>
    <div class="quick-sheet-grid">
      <div class="quick-sheet-item" onclick="abrirCrearCliente()">${iconClientes()}Cliente nuevo</div>
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
    <div class="sheet-sub">Es global: podrá comprar en cualquiera de tus negocios.</div>
    <div class="field-row">
      <div class="field"><label>Nombre *</label><input id="ncNombre" /></div>
      <div class="field"><label>Apellido *</label><input id="ncApellido" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Teléfono / WhatsApp</label><input id="ncTelefono" /></div>
      <div class="field"><label>DNI</label><input id="ncDni" /></div>
    </div>
    <div class="field"><label>Instagram</label><input id="ncInstagram" placeholder="@usuario" /></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarCliente">Guardar</button>
    </div>
  `), 210);
  setTimeout(() => {
    document.getElementById('btnGuardarCliente')?.addEventListener('click', async () => {
      const nombre = document.getElementById('ncNombre').value.trim();
      const apellido = document.getElementById('ncApellido').value.trim();
      if (!nombre || !apellido) return toast('Nombre y apellido son obligatorios', true);
      try {
        const c = await api('/clientes', {
          method: 'POST',
          body: JSON.stringify({
            nombre, apellido,
            telefono: document.getElementById('ncTelefono').value,
            dni: document.getElementById('ncDni').value,
            instagram: document.getElementById('ncInstagram').value,
          }),
        });
        closeSheet(); toast('Cliente creado ✓');
        location.hash = `#/clientes/${c.id}`;
      } catch (err) { toast(err.message, true); }
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
    <div class="field"><label>Stock (dejalo vacío si no querés controlarlo)</label><input type="number" id="npStock" placeholder="Sin control" /></div>
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
            stock: document.getElementById('npStock').value === '' ? null : Number(document.getElementById('npStock').value),
          }),
        });
        closeSheet(); toast('Producto creado ✓'); render();
      } catch (err) { toast(err.message, true); }
    });
  }, 250);
}

// ---------------- Auth ----------------
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
    if (!email || !password) { errBox.textContent = 'Completá email y contraseña.'; errBox.style.display = 'block'; return; }
    try {
      const body = authMode === 'registro' ? { email, password, nombre } : { email, password };
      const data = await api(`/auth/${authMode === 'registro' ? 'registro' : 'login'}`, { method: 'POST', body: JSON.stringify(body) });
      setToken(data.token);
      await arrancarApp();
    } catch (err) { errBox.textContent = err.message; errBox.style.display = 'block'; }
  });
}

async function arrancarApp() {
  try { state.negocios = await api('/negocios'); } catch { return; }
  hideAuthScreen();
  render();
}

(async function init() {
  wireAuthScreen();
  if (new URLSearchParams(location.search).get('token')) { await renderAceptarInvitacion(); return; }
  if (!getToken()) { showAuthScreen(); return; }
  await arrancarApp();
})();
