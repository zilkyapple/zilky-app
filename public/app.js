// =============================================================
// Zilky · Frontend (sin build step: JS plano + fetch a /api/*)
// =============================================================

const state = {
  negocios: [],
  negocioActual: null, // null = "Todos los negocios"
  cobranzaTab: 'hoy',
  cobranzaVentana: 7,
  clientesTab: 'todos',
  usuario: null,
  calMes: null, // 'YYYY-MM'
};

// ---------------- Sesión ----------------
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setHTML(element, html) {
  if(element) {
    element.innerHTML=DOMPurify.sanitize(html,{USE_PROFILES:{html:true,svg:true},FORBID_TAGS:['style'],FORBID_ATTR:['srcdoc']});
    aplicarPermisosUI(element);
  }
}
function puede(permiso, negocioId=state.negocioActual) {
  if(state.usuario?.rol==='administrador')return true;
  if (['dashboard_financiero.ver', 'comprobantes.ver'].includes(permiso)) return false;
  return (state.usuario?.negocios||[]).some(n=>n.activo===1 && (!negocioId||n.negocio_id===negocioId)
    && parseJsonSeguro(n.permisos)[permiso]===true
    && (permiso!=='cobranzas.ver' || parseJsonSeguro(n.permisos)['clientes.ver']===true));
}
function aplicarPermisosUI(root) {
  const admin=state.usuario?.rol==='administrador';
  const links={'#/productos':'productos.ver','#/comprobantes':'comprobantes.ver','#/ventas/nueva':'ventas.crear','#/clientes':'clientes.ver','#/cobrar':'cobranzas.ver','#/calendario':'cobranzas.ver'};
  root.querySelectorAll('a[href]').forEach(a=>{const href=a.getAttribute('href');if(links[href])a.hidden=!puede(links[href]);if(href?.startsWith('#/ventas/nueva/'))a.hidden=!puede('ventas.crear');if(href==='#/configuracion')a.hidden=!admin;if(href==='#/empleados')a.hidden=!puede('empleados.gestionar',null);});
  const actions={'registrar-pago':'pagos.registrar','editar-cliente':'clientes.editar','editar-seguimiento':'clientes.editar','crear-cliente-inline':'clientes.editar','nueva-venta':'ventas.crear','ir-cobrar':'cobranzas.ver','anular-comprobante':'comprobantes.anular'};
  root.querySelectorAll('[data-action]').forEach(el=>{const action=el.dataset.action;if(actions[action])el.hidden=!puede(actions[action],el.dataset.negocio||state.negocioActual);if(['abrir-crear-negocio','crear-producto'].includes(action))el.hidden=!admin;});
}
const TOKEN_KEY = 'zilky_token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function showAuthScreen() {
  state.usuario = null; state.negocios = []; state.negocioActual = null;
  document.getElementById('negocioNombre').textContent = 'Todos los negocios';
  document.getElementById('brandMark').textContent = 'Z';
  aplicarClaseNegocio();
  setHTML(document.getElementById('view'), '');
  closeSheet();
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
  if (res.status === 401 && token === getToken() && path !== '/auth/login' && path !== '/auth/registro') {
    clearToken();
    showAuthScreen();
  }
  if (!res.ok) throw Object.assign(new Error(body?.error || `Error ${res.status}`), {status:res.status});
  return body;
}

// Otra pestaña puede iniciar sesión con otra cuenta. Retirar de inmediato
// los datos anteriores y recargar permisos conserva la sesión compartida.
window.addEventListener('storage', async (event) => {
  if (event.storageArea !== localStorage || (event.key !== TOKEN_KEY && event.key !== null)) return;
  if (event.oldValue === event.newValue) return;
  showAuthScreen();
  if (getToken()) await arrancarApp();
});

// ---------------- Formato ----------------
const formatARS = (centavos) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format((centavos || 0) / 100);
const toCentavos = (pesos) => Math.round(Number(pesos || 0) * 100);
const fmtFecha = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const iniciales = (n = '', a = '') => `${(n[0] || '').toUpperCase()}${(a[0] || '').toUpperCase()}` || '?';
const todayISO = () => {
  // La fecha operativa debe coincidir con todayAR() del backend, aun de noche.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

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
  // El contenido es una plantilla controlada por la aplicación; sus datos
  // dinámicos ya pasan por esc() y setHTML vuelve a sanitizar todo el markup.
  setHTML(document.getElementById('sheetRoot'), `<div class="sheet" id="activeSheet">${html}</div>`);
  document.getElementById('sheetBackdrop').classList.add('open');
  requestAnimationFrame(() => document.getElementById('activeSheet')?.classList.add('open'));
}
function closeSheet() {
  const closingSheet = document.getElementById('activeSheet');
  closingSheet?.classList.remove('open');
  document.getElementById('sheetBackdrop').classList.remove('open');
  setTimeout(() => { if (document.getElementById('activeSheet') === closingSheet) setHTML(document.getElementById('sheetRoot'), ''); }, 200);
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
      <div class="list-item" data-action="elegir-negocio" data-id="${esc(n.id)}">
        <span class="avatar" style="background:${esc(n.color || 'var(--surface-2)')}22;color:${esc(n.color || 'var(--text-muted)')}">${esc(n.id ? n.nombre[0].toUpperCase() : '✦')}</span>
        <div class="list-item-body"><div class="list-item-title">${esc(n.nombre)}</div></div>
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
        ${['#22D3B6', '#4C9BFF', '#F5A524', '#FB4B62', '#A78BFA'].map((c, i) => `<button type="button" data-color="${esc(c)}" class="${esc(i === 0 ? 'active' : '')}" style="background:${esc(c)}22;color:${esc(c)};border-color:${esc(c)}55">●</button>`).join('')}
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

  // Cada navegación tiene su propio contenedor: una respuesta tardía no
  // puede escribir datos del negocio anterior en la pantalla vigente.
  const view = document.createElement('div');
  document.getElementById('view').replaceChildren(view);
  setHTML(view, '<div class="skeleton">Cargando…</div>');

  const permisosRuta = {
    inicio: 'dashboard_financiero.ver', clientes: 'clientes.ver',
    cobrar: 'cobranzas.ver', calendario: 'cobranzas.ver',
    ventas: 'ventas.crear', productos: 'productos.ver',
    comprobantes: 'comprobantes.ver', empleados: 'empleados.gestionar',
  };
  if (root === 'configuracion' && state.usuario?.rol !== 'administrador') {
    setHTML(view, '<div class="empty-state"><p>Requiere administrador</p></div>');
    return;
  }
  const permisoRuta = root === 'comprobantes' && parts[1] === 'cliente' && parts[2] ? 'clientes.ver' : permisosRuta[root];
  if (permisoRuta && !puede(permisoRuta, root === 'empleados' ? null : state.negocioActual)) {
    setHTML(view, '<div class="empty-state"><p>No tenés permiso para realizar esta acción</p></div>');
    return;
  }

  try {
    if (root === 'inicio') await viewInicio(view);
    else if (root === 'clientes' && parts[1]) await viewClienteDetail(view, parts[1]);
    else if (root === 'clientes') await viewClientes(view);
    else if (root === 'cobrar') await viewCobrar(view);
    else if (root === 'calendario') await viewCalendario(view);
    else if (root === 'ventas') await viewVentaNueva(view, parts[1] === 'nueva' ? parts[2] || null : parts[1] || null);
    else if (root === 'productos') await viewProductos(view);
    else if (root === 'comprobantes') await viewComprobantes(view, parts[1] === 'cliente' ? parts[2] || null : null);
    else if (root === 'configuracion') await viewConfiguracion(view);
    else if (root === 'empleados') await viewEmpleados(view);
    else if (root === 'mas') await viewMas(view);
    else setHTML(view, notFound());
  } catch (err) {
    setHTML(view, `<div class="empty-state"><p>${esc(err.message)}</p></div>`);
  }
}
const notFound = () => '<div class="empty-state"><p>No encontrado.</p></div>';

// ---------------- Vista: Inicio (dashboard) ----------------
async function viewInicio(view) {
  const r = await api(`/dashboard/resumen${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}`);
  if (!view.isConnected) return;
  setHTML(view, `
    <div class="section-title">Resumen ${esc(state.negocioActual ? '· ' + negocioNombre(state.negocioActual) : 'general')}</div>
    <div class="kpi-grid">
      <div class="kpi kpi-wide">
        <div><div class="kpi-label">Vendido (total)</div><div class="kpi-value">${esc(formatARS(r.vendidoTotalCentavos))}</div></div>
        <div style="text-align:right"><div class="kpi-label">Cobrado este mes</div><div class="kpi-value accent">${esc(formatARS(r.cobradoMesCentavos))}</div></div>
      </div>
      <div class="kpi"><div class="kpi-label">Cobrado hoy</div><div class="kpi-value">${esc(formatARS(r.cobradoHoyCentavos))}</div></div>
      <div class="kpi"><div class="kpi-label">Por cobrar hoy</div><div class="kpi-value">${esc(formatARS(r.porCobrarHoyCentavos))}</div></div>
      <div class="kpi"><div class="kpi-label">Saldo pendiente total</div><div class="kpi-value">${esc(formatARS(r.saldoPendienteTotalCentavos))}</div></div>
      <div class="kpi"><div class="kpi-label">Saldo vencido</div><div class="kpi-value ${esc(r.saldoVencidoCentavos > 0 ? 'danger' : '')}">${esc(formatARS(r.saldoVencidoCentavos))}</div></div>
      <div class="kpi"><div class="kpi-label">Clientes en mora</div><div class="kpi-value ${esc(r.clientesEnMora > 0 ? 'danger' : '')}">${esc(r.clientesEnMora)}</div></div>
      <div class="kpi"><div class="kpi-label">Monto en riesgo</div><div class="kpi-value danger">${esc(formatARS(r.montoEnRiesgoCentavos))}</div></div>
      <div class="kpi kpi-wide">
        <div><div class="kpi-label">Ventas activas</div><div class="kpi-value">${esc(r.ventasActivas)}</div></div>
        <div style="text-align:right"><div class="kpi-label">Ventas finalizadas</div><div class="kpi-value">${esc(r.ventasFinalizadas)}</div></div>
      </div>
    </div>
    ${r.porNegocio ? `
      <div class="section-title">Por negocio (cobrado este mes)</div>
      <div class="negocio-split">
        ${r.porNegocio.map((n) => `
          <div class="negocio-chip" data-action="ir-negocio" data-id="${esc(n.negocio_id)}">
            <span class="lbl"><span class="dot" style="background:${esc(n.color)}"></span>${esc(n.nombre)}</span>
            <div class="val">${esc(formatARS(n.cobradoMesCentavos))}</div>
            <div class="lbl" style="margin-top:2px">vendido: ${esc(formatARS(n.vendidoTotalCentavos))}</div>
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
  `);
}

// ---------------- Vista: Clientes (global) ----------------
async function viewClientes(view, q = '') {
  const puedeVerCobranzas = puede('cobranzas.ver');
  if (!puedeVerCobranzas) state.clientesTab = 'todos';
  setHTML(view, `
    <div class="section-title">Clientes</div>
    <div class="search-box">${iconSearch()}<input id="clienteSearch" placeholder="Buscar por nombre, DNI, teléfono o Instagram" value="${esc(q)}" /></div>
    <div class="tabs" id="clientesTabs">
      <button data-tab="todos" class="${esc(state.clientesTab === 'todos' ? 'active' : '')}">Todos</button>
      ${puedeVerCobranzas ? `<button data-tab="deuda" class="${esc(state.clientesTab === 'deuda' ? 'active' : '')}">Con deuda</button>
      <button data-tab="finalizados" class="${esc(state.clientesTab === 'finalizados' ? 'active' : '')}">Finalizados${esc(state.negocioActual ? '' : ' (elegí negocio)')}</button>` : ''}
    </div>
    <div id="clientesList"><div class="skeleton">Buscando…</div></div>
  `);
  const input = document.getElementById('clienteSearch');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let t;
  const list = view.querySelector('#clientesList');
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => renderClientesList(input.value.trim(), list), 220); });
  document.getElementById('clientesTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.clientesTab = b.dataset.tab;
    document.querySelectorAll('#clientesTabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    renderClientesList(input.value.trim(), list);
  });
  await renderClientesList(q, list);
}

const solicitudesClientes = new WeakMap();
async function renderClientesList(q, list = document.getElementById('clientesList')) {
  if (!list?.isConnected) return;
  const solicitud = {};
  solicitudesClientes.set(list, solicitud);
  const vigente = () => list.isConnected && solicitudesClientes.get(list) === solicitud;
  setHTML(list, '<div class="skeleton">Buscando…</div>');
  try {
    if (state.clientesTab === 'finalizados' && !state.negocioActual) {
      setHTML(list, `<div class="empty-state"><p>Elegí un negocio arriba para ver esta lista.</p></div>`);
      return;
    }

    if (state.clientesTab === 'finalizados') {
      const resultado = await api(`/clientes/finalizados?negocio_id=${state.negocioActual}`);
      if (!vigente()) return;
      const busqueda = q.trim().toLowerCase();
      const finalizados = busqueda ? resultado.filter(c =>
        [c.nombre, c.apellido, c.dni, c.telefono, c.instagram].some(valor => String(valor || '').toLowerCase().includes(busqueda))
      ) : resultado;
      setHTML(list, !finalizados.length ? `<div class="empty-state"><p>${busqueda ? 'No hay clientes finalizados que coincidan.' : 'Todavía nadie terminó de pagar acá.'}</p></div>` : finalizados.map((c) => `
        <div class="list-item" data-action="ver-cliente" data-id="${esc(c.id)}">
          <span class="avatar">${esc(iniciales(c.nombre, c.apellido))}</span>
          <div class="list-item-body">
            <div class="list-item-title">${esc(c.nombre)} ${esc(c.apellido || '')}</div>
            <div class="list-item-sub">${esc(c.total_compras)} compra(s) · última: ${esc(fmtFecha(c.ultima_compra))}</div>
          </div>
          <span class="chev">${iconChevron()}</span>
        </div>
      `).join(''));
      return;
    }

    const params=new URLSearchParams();
    if(q)params.set('q',q);
    if(state.negocioActual)params.set('negocio_id',state.negocioActual);
    if(state.clientesTab==='deuda')params.set('con_deuda','1');
    const filtrados=await api(`/clientes?${params}`);
    if (!vigente()) return;

    if (!filtrados.length) {
      setHTML(list, `<div class="empty-state">${iconClientes(40)}<p>No hay clientes${esc(q ? ' que coincidan' : ' todavía')}.</p></div>`);
      return;
    }
    setHTML(list, filtrados.map((c) => `
      <div class="list-item" data-action="ver-cliente" data-id="${esc(c.id)}">
        <span class="avatar">${esc(iniciales(c.nombre, c.apellido))}</span>
        <div class="list-item-body">
          <div class="list-item-title">${esc(c.nombre)} ${esc(c.apellido || '')}</div>
          <div class="list-item-sub">${esc(c.telefono ? '📞 ' + c.telefono : '')}${esc(c.instagram ? ' · ' + c.instagram : '')}</div>
        </div>
        <span class="chev">${iconChevron()}</span>
      </div>
    `).join(''));
  } catch (err) {
    if (vigente()) setHTML(list, `<div class="empty-state"><p>${esc(err.message)}</p></div>`);
  }
}

// ---------------- Vista: Detalle de cliente ----------------
function accionesClienteHtml(c) {
  return `
    <div class="quick-actions" style="margin-top:14px">
      <a class="btn btn-secondary" href="${esc(waLink(c.whatsapp || c.telefono, mensajeSaludo(c)))}" target="_blank" rel="noopener noreferrer">${iconWhatsapp()}WhatsApp</a>
      <a class="btn btn-secondary" href="tel:${esc(c.telefono || '')}">${iconLlamar()}Llamar</a>
      <a class="btn btn-secondary" href="#/ventas/nueva/${esc(c.id)}">${iconVenta()}Nueva venta</a>
      <button class="btn btn-secondary" data-action="editar-seguimiento" data-id="${esc(c.id)}">${iconNota()}Seguimiento</button>
      <button class="btn btn-secondary" data-action="editar-cliente" data-id="${esc(c.id)}">Editar datos</button>
      ${state.usuario?.rol==='administrador'?`<button class="btn btn-secondary" data-action="eliminar-cliente" data-id="${esc(c.id)}">Eliminar cliente</button>`:''}
      ${state.negocioActual && puede('clientes.ver') ? `<a class="btn btn-secondary" href="#/comprobantes/cliente/${esc(c.id)}">${iconNota()}Comprobantes</a>` : ''}
    </div>
  `;
}

function datosClienteHtml(c) {
  const datos = [
    ['DNI', c.dni], ['Teléfono', c.telefono], ['WhatsApp', c.whatsapp],
    ['Instagram', c.instagram], ['Dirección', c.direccion], ['Ciudad', c.ciudad],
    ['Provincia', c.provincia], ['Nacimiento', c.fecha_nacimiento ? fmtFecha(c.fecha_nacimiento) : ''],
    ['Trabajo', c.trabajo], ['Frecuencia de pago', c.frecuencia_pago], ['Notas', c.notas],
  ].filter(([, valor]) => valor !== null && valor !== undefined && String(valor).trim());
  const estados = { contactado: 'Contactado', no_interesado: 'No interesado', volver_a_contactar: 'Volver a contactar' };
  return `
    <details class="client-section" open>
      <summary>Datos personales</summary>
      ${datos.length ? `<dl class="client-data">${datos.map(([nombre, valor]) => `<div><dt>${esc(nombre)}</dt><dd>${esc(valor)}</dd></div>`).join('')}</dl>` : '<p class="field-hint">Sin datos adicionales registrados.</p>'}
    </details>
    <details class="client-section">
      <summary>Seguimiento comercial${c.seguimiento_estado ? ` · ${esc(estados[c.seguimiento_estado] || c.seguimiento_estado)}` : ''}</summary>
      <p>${esc(c.seguimiento_nota || 'Sin nota de seguimiento.')}</p>
      ${c.seguimiento_fecha ? `<p class="field-hint">Última actualización: ${esc(fmtFecha(c.seguimiento_fecha))}</p>` : ''}
    </details>
  `;
}

async function viewClienteDetail(view, id) {
  const filtro = state.negocioActual ? `?negocio_id=${state.negocioActual}` : '';
  const c = await api(`/clientes/${id}${filtro}`);
  if (!view.isConnected) return;
  const riesgoClass = { bajo: 'riesgo-bajo', medio: 'riesgo-medio', alto: 'riesgo-alto', critico: 'riesgo-critico' }[c.riesgo?.nivel] || 'riesgo-bajo';
  const h = c.historial;
  const cabecera = `
    <a class="btn btn-ghost" href="#/clientes">${iconChevronLeft()}Volver a clientes</a>
    <div class="profile-header">
      <span class="avatar">${esc(iniciales(c.nombre, c.apellido))}</span>
      <div><div class="profile-name">${esc(c.nombre)} ${esc(c.apellido || '')}</div><div class="profile-sub">${esc(c.telefono || 'Sin teléfono')} ${esc(c.instagram ? '· ' + c.instagram : '')}</div></div>
    </div>
    <p class="field-hint">Ficha del cliente · ${esc(state.negocioActual ? negocioNombre(state.negocioActual) : 'Negocios autorizados')}</p>
    <div class="tabs" style="margin-top:14px">
      <button data-action="ver-cliente-negocio" data-id="" class="${esc(!state.negocioActual ? 'active' : '')}">Todos los autorizados</button>
      ${state.negocios.filter(n => puede('clientes.ver', n.id)).map((n) => `<button data-action="ver-cliente-negocio" data-id="${esc(n.id)}" data-cid="${esc(c.id)}" class="${esc(state.negocioActual === n.id ? 'active' : '')}">${esc(n.nombre)}</button>`).join('')}
    </div>
    ${accionesClienteHtml(c)}
    ${datosClienteHtml(c)}
  `;
  if(!h){setHTML(view, `${cabecera}<p>No tenés permiso para ver el historial financiero de este cliente.</p>`);return;}

  setHTML(view, `${cabecera}
    ${gestionCobranzaHtml(c)}
    <div class="debt-hero">
      <div class="lbl">Deuda ${esc(state.negocioActual ? 'en ' + negocioNombre(state.negocioActual) : 'en los negocios autorizados')}</div>
      <div class="amt">${esc(formatARS(c.deudaTotalCentavos))}</div>
      <div class="meta">
        ${vencimientosClienteHtml(c)}
        &nbsp;·&nbsp; <span class="badge badge-${esc(riesgoClass)}">Riesgo ${esc(c.riesgo?.nivel || 'bajo')}</span>
      </div>
    </div>

    <details class="client-section">
    <summary>Historial financiero</summary>
    <div class="card">
      <div class="cuota-row"><div class="cn">Compras</div><div class="amt">${esc(h.cantidadCompras)}</div></div>
      <div class="cuota-row"><div class="cn">Cuotas pagadas a tiempo / tarde</div><div class="amt">${esc(h.cuotasPagadasATiempo)} / ${esc(h.cuotasPagadasTarde)}</div></div>
      ${h.cuotasPagadas > 0 ? `<div class="cuota-row"><div class="cn">Cuotas pagadas a tiempo (%)</div><div class="amt">${esc(Math.round(100*h.cuotasPagadasATiempo/h.cuotasPagadas))}%</div></div>` : ''}
      <div class="cuota-row"><div class="cn">Atraso promedio / máximo</div><div class="amt">${esc(h.atrasoPromedioDias)}d / ${esc(h.atrasoMaximoDias)}d</div></div>
      <div class="cuota-row"><div class="cn">Total cobrado histórico</div><div class="amt">${esc(formatARS(h.totalCobradoCentavos))}</div></div>
      <div class="cuota-row"><div class="cn">Compras finalizadas</div><div class="amt">${esc(h.comprasFinalizadas)}</div></div>
      <div class="cuota-row"><div class="cn">Última compra / último pago</div><div class="amt" style="font-size:12px">${esc(fmtFecha(h.fechaUltimaCompra))} · ${esc(fmtFecha(h.fechaUltimoPago))}</div></div>
    </div>
    </details>

    <details class="client-section" open>
    <summary>Financiaciones y cuotas (${esc(c.creditos.length)})</summary>
    ${c.creditos.length === 0 ? `<div class="empty-state"><p>Todavía no compró nada${esc(state.negocioActual ? ' en ' + negocioNombre(state.negocioActual) : '')}.</p></div>` : c.creditos.map((cr) => creditoCardHtml(cr)).join('')}
    </details>

    <details class="client-section">
    <summary>Historial de pagos (${esc(c.pagos.length)})</summary>
    ${c.pagos.length === 0 ? `<div class="empty-state"><p>Sin pagos registrados.</p></div>` : `
      <div class="card">
        ${c.pagos.map((p) => `
          <div class="hist-row">
            <div><div class="hd">${esc(p.tipo==='entrega_inicial'?'Entrega inicial · ':'Pago de cuota · ')}${esc(p.medio_pago)}${p.anulado ? ' · <span style="color:var(--danger)">ANULADO</span>' : ''}</div><div class="hm">${esc(fmtFecha(p.fecha_hora))} ${esc(p.fecha_hora.slice(11, 16))}</div></div>
            <div class="amt" style="${esc(p.anulado ? 'color:var(--text-faint);text-decoration:line-through' : '')}">+${esc(formatARS(p.monto_centavos))}</div>
          </div>
        `).join('')}
      </div>
    `}
    </details>
  `);
}

function gestionCobranzaHtml(c) {
  const gestiones=c.gestionCobranza||[];
  if(!gestiones.length)return '';
  const admin=state.usuario?.rol==='administrador';
  return `<details class="client-section" ${gestiones.some(g=>g.gestion_especial===1)?'open':''}>
    <summary>Gestión de cobranza y antecedentes</summary>
    ${gestiones.map(g=>`<div class="card"><strong>${esc(negocioNombre(g.negocio_id))} · ${g.gestion_especial===1?'Gestión especial':'Cobranza normal'}</strong>
      <p>Modo: ${esc(modosCobranza[g.modo]||'Revisión')}</p>
      ${puede('clientes.editar',g.negocio_id)&&puede('cobranzas.ver',g.negocio_id)?`<button class="btn btn-secondary" data-action="contactos-cobranza" data-id="${esc(c.id)}" data-negocio="${esc(g.negocio_id)}">Gestionar contactos</button>`:''}
      ${historialContactosHtml(c,g.negocio_id)}
      ${(g.historialModo||[]).length?`<details><summary>Cambios del modo de cobranza</summary>${g.historialModo.map(h=>`<p>${esc(fmtFecha(h.fecha_hora))} · ${esc(h.autor||'Sistema')} · ${esc(modosCobranza[parseJsonSeguro(h.datos_nuevos).modo]||'Revisión')}: ${esc(h.motivo)}</p>`).join('')}</details>`:''}
      ${g.proximo_contacto?`<p>Próximo seguimiento: ${esc(fmtFecha(g.proximo_contacto))}</p>`:''}
      <p class="field-hint">La clasificación es manual. No elimina deuda ni bloquea pagos. Los antecedentes se conservan.</p>
      ${admin?`<button class="btn btn-secondary" data-action="gestion-cliente" data-id="${esc(c.id)}" data-negocio="${esc(g.negocio_id)}" data-tipo="${g.gestion_especial===1?'salida':'entrada'}">${g.gestion_especial===1?'Volver a cobranza normal':'Pasar a Gestión especial'}</button>`:''}
      ${g.gestion_especial===1 && puede('cobranzas.ver',g.negocio_id)?`<button class="btn btn-secondary" data-action="mensaje-especial" data-id="${esc(c.id)}" data-negocio="${esc(g.negocio_id)}">Preparar mensaje</button>`:''}
      ${g.gestion_especial===1 && puede('clientes.editar',g.negocio_id)&&puede('cobranzas.ver',g.negocio_id)?`<button class="btn btn-secondary" data-action="gestion-cliente" data-id="${esc(c.id)}" data-negocio="${esc(g.negocio_id)}" data-tipo="seguimiento">Registrar seguimiento</button>`:''}
      ${(g.historial||[]).length?`<ol>${g.historial.map(e=>`<li><strong>${esc({entrada:'Ingresó a Gestión especial',salida:'Volvió a cobranza normal',seguimiento:'Seguimiento registrado'}[e.accion]||e.accion)}</strong> · ${esc(fmtFecha(e.fecha))} ${esc(e.fecha?.slice(11,16))}
        <p>Por: ${esc(e.usuario_nombre)} · Deuda en ese momento: ${esc(formatARS(e.deuda_centavos))}</p><p>${esc(e.nota)}</p>${e.proximo_contacto?`<p>Próximo contacto previsto: ${esc(fmtFecha(e.proximo_contacto))}</p>`:''}</li>`).join('')}</ol>`:'<p>Sin antecedentes de Gestión especial.</p>'}
    </div>`).join('')}
  </details>`;
}
function proximoMesISO() {
  const [y,m,d]=todayISO().split('-').map(Number),ultimo=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return new Date(Date.UTC(y,m,Math.min(d,ultimo))).toISOString().slice(0,10);
}
function abrirGestionCliente(clienteId,negocioId,accion) {
  const permitido=()=>accion==='seguimiento'?puede('clientes.editar',negocioId)&&puede('cobranzas.ver',negocioId):state.usuario?.rol==='administrador';
  if(!permitido())return toast('No tenés permiso para esta acción',true);
  if(state.negocioActual!==negocioId)return toast('Seleccioná el negocio de esta cuenta',true);
  const token=getToken(),solicitudId=crypto.randomUUID();
  const titulo={entrada:'Pasar a Gestión especial',salida:'Volver a cobranza normal',seguimiento:'Registrar seguimiento'}[accion];
  if(!titulo)return;
  openSheet(`<div class="sheet-title">${esc(titulo)}</div><p>La deuda y los pagos se conservan. Este cambio quedará en el historial del cliente dentro de este negocio.</p>
    <div class="field"><label for="gestionNota">${accion==='seguimiento'?'Resultado del seguimiento':'Motivo'}</label><textarea id="gestionNota" maxlength="2000"></textarea></div>
    ${accion!=='salida'?`<div class="field"><label for="gestionFecha">Próximo contacto</label><input id="gestionFecha" type="date" min="${esc(todayISO())}" value="${esc(proximoMesISO())}"></div><p class="field-hint">Fecha sugerida mensual, editable. No se envían mensajes automáticamente.</p>`:''}
    <div class="sheet-actions"><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button id="gestionGuardar" class="btn btn-primary">Guardar</button></div>`);
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open')&&state.negocioActual===negocioId&&getToken()===token&&permitido();
  let enviado=null;
  sheet.querySelector('#gestionGuardar').addEventListener('click',async(e)=>{
    const button=e.currentTarget;if(button.disabled||!vigente())return;
    const nota=sheet.querySelector('#gestionNota').value.trim(),fecha=sheet.querySelector('#gestionFecha')?.value||null;
    if(!nota || (accion!=='salida'&&!fecha))return toast('Completá motivo y próximo contacto',true);
    enviado||={accion,nota,proximo_contacto:fecha,solicitud_id:solicitudId};
    button.disabled=true;sheet.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
    try {
      await api(`/clientes/${encodeURIComponent(clienteId)}/gestion-especial${accion==='seguimiento'?'/seguimiento':''}?negocio_id=${encodeURIComponent(negocioId)}`,{method:'POST',body:JSON.stringify(enviado)});
      if(vigente()){closeSheet();toast('Gestión guardada en el historial');render();}
    }catch(err){if(vigente()){button.disabled=false;toast(err.message+' · Podés reintentar sin duplicar.',true);}}
  });
}
function gestionEspecialListHtml(items) {
  return `<p class="field-hint">Cuentas seleccionadas manualmente. Conservan su deuda y también aparecen en Todas. Abrí la ficha para registrar pagos o volver a cobranza normal.</p>
    ${!items.length?'<div class="empty-state"><p>No hay cuentas con deuda en Gestión especial.</p></div>':items.map(c=>`<div class="list-item" data-action="ver-cliente" data-id="${esc(c.cliente_id)}">
      <div class="list-item-body"><div class="list-item-title">${esc(c.cliente_nombre)} ${esc(c.cliente_apellido||'')}</div><div class="list-item-sub">${esc(negocioNombre(c.negocio_id))} · ${esc(c.cuotas)} cuota(s) pendiente(s)</div>
        <div class="field-hint">${c.proximo_contacto?`Seguimiento: ${esc(fmtFecha(c.proximo_contacto))}${c.proximo_contacto<=todayISO()?' · Para revisar':''}`:'Sin próximo contacto'}</div></div>
      <div class="list-item-trail"><div class="list-item-amount">${esc(formatARS(c.deudaCentavos))}</div><button class="btn btn-secondary" data-action="mensaje-especial" data-id="${esc(c.cliente_id)}" data-negocio="${esc(c.negocio_id)}" data-stop-propagation="true">Preparar mensaje</button></div></div>`).join('')}`;
}
async function abrirMensajeEspecial(clienteId,negocioId) {
  if(!puede('cobranzas.ver',negocioId))return toast('No tenés permiso de cobranzas',true);
  const token=getToken(),negocioActual=state.negocioActual;
  openSheet('<div class="sheet-title">Mensaje de seguimiento</div><p>Cargando…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open')&&getToken()===token&&state.negocioActual===negocioActual&&puede('cobranzas.ver',negocioId);
  try {
    const c=await api(`/clientes/${encodeURIComponent(clienteId)}?negocio_id=${encodeURIComponent(negocioId)}`);
    if(!vigente())return;
    if(!(c.gestionCobranza||[]).some(g=>g.negocio_id===negocioId&&g.gestion_especial===1))return setHTML(sheet,'<p>Esta cuenta ya no está en Gestión especial. Actualizá la vista.</p>');
    const mensaje=mensajeSaludo(c);
    setHTML(sheet,`<div class="sheet-title">Mensaje de seguimiento</div><p>Revisá y editá el texto antes de abrir WhatsApp. No se envía ni se marca como enviado desde Zilky.</p><div class="field"><label for="gestionMensaje">Mensaje</label><textarea id="gestionMensaje" maxlength="4000">${esc(mensaje)}</textarea></div>
      ${c.whatsapp||c.telefono?'<a id="gestionWhatsapp" class="btn btn-primary" target="_blank" rel="noopener noreferrer">Abrir en WhatsApp</a>':'<p>Este cliente no tiene teléfono registrado. Podés copiar el texto.</p>'}
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cerrar</button>`);
    const actualizar=()=>{const a=sheet.querySelector('#gestionWhatsapp');if(a)a.setAttribute('href',waLink(c.whatsapp||c.telefono,sheet.querySelector('#gestionMensaje').value));};
    sheet.querySelector('#gestionMensaje').addEventListener('input',actualizar);actualizar();
    sheet.querySelector('#gestionWhatsapp')?.addEventListener('click',e=>{if(!vigente())e.preventDefault();});
  }catch(err){if(vigente())setHTML(sheet,`<p>${esc(err.message)}</p><button class="btn btn-secondary" data-action="cerrar-sheet">Cerrar</button>`);}
}

function creditoCardHtml(cr) {
  const negocio = state.negocios.find((n) => n.id === cr.negocio_id);
  const pendientes = cr.cuotas.filter(c => (c.saldo_pendiente_centavos > 0 || c.moraPendiente > 0) && !c.estado_manual);
  const pendiente = pendientes.length > 0;
  const estadoOperacion = !pendiente ? cr.estado : pendientes.some(c => c.diasAtraso > 0) ? 'atrasada' : 'al_dia';
  const atrasos = cr.cuotas.filter(c => c.diasAtraso > 0 || c.dias_atraso_al_pagar > 0);
  return `
    <div class="card credito-card">
      <div class="credito-top">
        <div>
          <div class="credito-modalidad"><span class="cred-negocio-tag">${esc(negocio?.nombre || '')}</span> · ${esc({ libre: 'Pago libre', cuotas: 'Cuotas mensuales', unico: 'Pago único' }[cr.modalidad] || cr.modalidad)}</div>
          <div style="font-weight:700;margin-top:6px">${esc(formatARS(cr.saldo_financiado_centavos))} financiados</div>
        </div>
        <span class="badge badge-${esc(cr.estado === 'finalizado' ? 'pagada' : estadoOperacion === 'atrasada' ? 'mora' : 'activa')}">${esc(estadoOperacion.replaceAll('_', ' '))}</span>
      </div>
      <div class="field-hint">Compra: ${esc(fmtFecha(cr.fecha_inicio))} · Total: ${esc(formatARS(cr.monto_total_centavos))} · Entrega inicial: ${esc(formatARS(cr.entrega_inicial_centavos))}</div>
      ${cr.producto_descripcion ? `<p>Producto/equipo corregido: ${esc(cr.producto_descripcion)}</p>` : ''}${cr.condiciones ? `<p>Condiciones: ${esc(cr.condiciones)}</p>` : ''}
      ${(cr.items || []).length ? `<ul>${cr.items.map(it => `<li>${esc(it.descripcion || it.producto_nombre || 'Producto')} · Cantidad: ${esc(it.cantidad)}${it.producto_variante ? ` · ${esc(it.producto_variante)}` : ''}${it.producto_imei ? ` · IMEI: ${esc(it.producto_imei)}` : ''}</li>`).join('')}</ul>` : '<p class="field-hint">Sin detalle de producto registrado.</p>'}
      <p class="field-hint">Cuotas pagadas: ${esc(cr.cuotas.filter(c => c.saldo_pendiente_centavos <= 0 && !c.estado_manual).length)}/${esc(cr.cuotas.length)} · Saldo pendiente: ${esc(formatARS(pendientes.reduce((s,c) => s+c.saldo_pendiente_centavos+(c.moraPendiente || 0),0)))}</p>
      ${cr.cuotas.map((cu) => `
        <div class="cuota-row">
          <div class="cn">Cuota ${esc(cu.numero)}/${esc(cr.cuotas.length)} · vence ${esc(fmtFecha(cu.fecha_vencimiento))}
            <div class="field-hint">Valor: ${esc(formatARS(cu.monto_centavos))}${cu.saldo_pendiente_centavos > 0 && !cu.estado_manual && Number.isFinite(cu.diasHasta) ? ` · ${cu.diasHasta < 0 ? `${esc(-cu.diasHasta)} días de atraso` : cu.diasHasta === 0 ? 'Vence hoy' : `Vence en ${esc(cu.diasHasta)} días`}` : cu.fecha_saldada ? ` · Pagada: ${esc(fmtFecha(cu.fecha_saldada))}` : ''}${cu.moraGenerada > 0 ? ` · Mora generada: ${esc(formatARS(cu.moraGenerada))} · Pendiente: ${esc(formatARS(cu.moraPendiente))} · Cobrada: ${esc(formatARS(cu.moraCobrada))} · Perdonada: ${esc(formatARS(cu.moraPerdonada))}` : ''}</div>
          </div>
          ${cu.moraPendiente > 0 && state.usuario?.rol === 'administrador' ? `<button class="btn btn-secondary" data-action="perdonar-mora" data-cuota="${esc(cu.id)}" data-negocio="${esc(cr.negocio_id)}">Perdonar mora</button>` : ''}
          <div class="cr"><span class="amt">${esc(formatARS(cu.saldo_pendiente_centavos))}</span><span class="badge badge-${esc(cu.estado)}">${esc(ESTADO_LABEL[cu.estado] || cu.estado)}</span></div>
        </div>
      `).join('')}
      ${atrasos.length ? `<details><summary>Historial de atrasos (${esc(atrasos.length)})</summary>${atrasos.map(c => `<p>Cuota ${esc(c.numero)} · Vencimiento: ${esc(fmtFecha(c.fecha_vencimiento))} · ${c.saldo_pendiente_centavos <= 0 ? `Regularizada el ${esc(fmtFecha(c.fecha_saldada))} tras ${esc(c.dias_atraso_al_pagar)} días de atraso` : `${esc(c.diasAtraso)} días de atraso actual`}</p>`).join('')}</details>` : ''}
      ${(cr.correcciones||[]).length ? `<details><summary>Correcciones de financiación</summary>${cr.correcciones.map(e=>`<p>${esc(e.fecha_hora)} · ${esc(e.autor||'Administrador')} · ${esc(e.motivo)}</p>`).join('')}</details>` : ''}
      ${(cr.moraHistorial||[]).length ? `<details><summary>Decisiones de mora</summary>${cr.moraHistorial.map(e=>`<p>Cuota ${esc(e.numero)} · ${esc(e.fecha_hora)} · ${esc(e.autor||'Administrador')} · ${esc(e.motivo)}</p>`).join('')}</details>` : ''}
      ${incidenciasHtml(cr)}
      ${state.usuario?.rol==='administrador' ? `<button class="btn btn-secondary" data-action="corregir-financiacion" data-credito="${esc(cr.id)}" data-negocio="${esc(cr.negocio_id)}">Corregir financiación</button>` : ''}
      ${pendiente ? `<button class="btn btn-primary btn-block" style="margin-top:12px" data-action="registrar-pago" data-negocio="${esc(cr.negocio_id)}" data-credito="${esc(cr.id)}">${iconCobrar()}Registrar pago</button>` : ''}
    </div>
  `;
}

function incidenciasHtml(cr) {
  const nombres={al_dia:'Al día',atrasada:'Atrasada',regularizada:'Regularizada',finalizada_correctamente:'Finalizada correctamente',cancelada_anticipadamente:'Cancelada anticipadamente',equipo_entregado:'Equipo entregado voluntariamente',equipo_retirado:'Equipo retirado por falta de pago',pago_anulado:'Pago anulado'};
  return `<details><summary>Historial de incidencias (${esc((cr.incidencias||[]).length)})</summary>
    ${(cr.incidencias||[]).length ? `<ol>${cr.incidencias.map(e=>`<li><strong>${esc(nombres[e.tipo]||e.tipo)}</strong> · ${esc(fmtFecha(e.fecha))}${e.motivo?`<p>${esc(e.motivo)}</p>`:''}</li>`).join('')}</ol>` : '<p class="field-hint">Sin incidencias registradas. No se reconstruyen hechos que no fueron guardados.</p>'}
    ${cr.seguimientoEquipos && state.usuario?.rol==='administrador' ? `<button class="btn btn-secondary" data-action="incidencia-equipo" data-credito="${esc(cr.id)}" data-id="${esc(cr.cliente_id)}" data-negocio="${esc(cr.negocio_id)}">Registrar entrega o retiro de equipo</button>` : ''}
  </details>`;
}

function abrirIncidenciaEquipo(clienteId,creditoId,negocioId) {
  if(state.usuario?.rol!=='administrador')return toast('Requiere administrador',true);
  if(state.negocioActual!==negocioId)return toast('Seleccioná el negocio de esta operación',true);
  const token=getToken(),solicitudId=crypto.randomUUID();
  openSheet(`<div class="sheet-title">Entrega o retiro de equipo</div>
    <p class="sheet-sub">Registra el hecho en el historial. No modifica deuda, cuotas ni stock.</p>
    <div class="field"><label for="incTipo">Hecho</label><select id="incTipo"><option value="equipo_entregado">Entrega voluntaria del cliente</option><option value="equipo_retirado">Retiro por falta de pago</option></select></div>
    <div class="field"><label for="incFecha">Fecha</label><input id="incFecha" type="date" value="${esc(todayISO())}" /></div>
    <div class="field"><label for="incMotivo">Motivo</label><textarea id="incMotivo" maxlength="2000"></textarea></div>
    <div class="sheet-actions"><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button id="incGuardar" class="btn btn-primary">Guardar incidencia</button></div>`);
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected && document.getElementById('activeSheet')===sheet && document.getElementById('sheetBackdrop').classList.contains('open') && state.negocioActual===negocioId && getToken()===token && state.usuario?.rol==='administrador';
  let enviado=null;
  sheet.querySelector('#incGuardar').addEventListener('click',async(event)=>{
    const button=event.currentTarget;
    if(button.disabled || !vigente())return;
    const motivo=sheet.querySelector('#incMotivo').value.trim(),fecha=sheet.querySelector('#incFecha').value;
    if(!motivo||!fecha)return toast('Completá fecha y motivo',true);
    // En una respuesta incierta se reintenta exactamente el mismo hecho y clave.
    enviado ||= {tipo:sheet.querySelector('#incTipo').value,fecha,motivo,solicitud_id:solicitudId};
    button.disabled=true;
    sheet.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=true);
    try {
      await api(`/clientes/${encodeURIComponent(clienteId)}/creditos/${encodeURIComponent(creditoId)}/incidencias?negocio_id=${encodeURIComponent(negocioId)}`,{method:'POST',body:JSON.stringify(enviado)});
      if(vigente()){closeSheet();toast('Incidencia registrada');render();}
    } catch(error) { if(vigente()){button.disabled=false;toast(error.message+' · Podés reintentar o cancelar.',true);} }
  });
}

async function abrirEditarSeguimiento(clienteId) {
  const negocioId = state.negocioActual;
  if (!negocioId) return toast('Seleccioná el negocio del seguimiento', true);
  openSheet('<div class="sheet-title">Seguimiento comercial</div><p>Cargando…</p>');
  const sheet = document.getElementById('activeSheet');
  const vigente = () => sheet.isConnected && document.getElementById('activeSheet') === sheet
    && document.getElementById('sheetBackdrop').classList.contains('open') && state.negocioActual === negocioId;
  let cliente;
  try {
    cliente = await api(`/clientes/${clienteId}?negocio_id=${encodeURIComponent(negocioId)}`);
  } catch (err) {
    if (vigente()) setHTML(sheet, `<div class="sheet-title">Seguimiento comercial</div><p>${esc(err.message)}</p><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>`);
    return;
  }
  if (!vigente()) return;
  setHTML(sheet, `
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
  sheet.querySelector('#segEstado').value = cliente.seguimiento_estado || '';
  sheet.querySelector('#segNota').value = cliente.seguimiento_nota || '';
  sheet.querySelector('#btnGuardarSeguimiento').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!vigente() || button.disabled) return;
    button.disabled = true;
    try {
      await api(`/clientes/${clienteId}/seguimiento?negocio_id=${encodeURIComponent(negocioId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          seguimiento_estado: sheet.querySelector('#segEstado').value || null,
          seguimiento_nota: sheet.querySelector('#segNota').value || null,
          seguimiento_fecha: todayISO(),
        }),
      });
      if (vigente()) { closeSheet(); toast('Guardado ✓'); render(); }
    } catch (err) {
      button.disabled = false;
      if (vigente()) toast(err.message, true);
    }
  });
}

// ---------------- Sheet: registrar pago ----------------
async function abrirRegistrarPago(creditoId, montoSugerido = null) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Registrar pago</div>
    <div class="sheet-sub">Se aplica automáticamente: primero mora vencida, después capital de la cuota más antigua. Genera comprobante.</div>
    <div class="field"><label>Monto entregado</label><input type="number" inputmode="decimal" id="pagoMonto" placeholder="0" value="${esc(montoSugerido ?? '')}" autofocus /></div>
    <div class="field-row">
      <div class="field">
        <label>Medio de pago</label>
        <select id="pagoMedio"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="mercado_pago">Mercado Pago</option><option value="otro">Otro</option></select>
      </div>
      <div class="field"><label>Fecha</label><input type="date" id="pagoFecha" value="${esc(todayISO())}" /></div>
    </div>
    <div class="field"><label>Nota (opcional)</label><input type="text" id="pagoNota" placeholder="Ej: entrega parcial" /></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmarPago">Confirmar</button>
    </div>
  `);
  document.getElementById('btnConfirmarPago').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const monto = toCentavos(document.getElementById('pagoMonto').value);
    if (!monto || monto <= 0) return toast('Ingresá un monto válido', true);
    const fecha = document.getElementById('pagoFecha').value || todayISO();
    button.disabled = true;
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
    } catch (err) { button.disabled = false; toast(err.message, true); }
  });
}

// ---------------- Vista: Cobrar ----------------
async function viewCobrar(view) {
  const b = await api(`/dashboard/cobranza?ventana_dias=${state.cobranzaVentana}${state.negocioActual ? `&negocio_id=${state.negocioActual}` : ''}`);
  if (!view.isConnected) return;
  const recordatorios = await api(`/dashboard/recordatorios${state.negocioActual ? `?negocio_id=${state.negocioActual}` : ''}`);
  if (!view.isConnected) return;

  setHTML(view, `
    ${recordatorios.length ? `
      <div class="reminder-banner">
        <div class="rb-title">${iconWhatsapp()} ${esc(recordatorios.length)} cliente(s) para recordar hoy</div>
        <div class="field-hint" style="margin:6px 0 10px">Según los días configurados en el negocio.</div>
        ${recordatorios.map((c) => `
          <div class="list-item" style="background:var(--bg-elevated)" data-action="ver-cliente" data-id="${esc(c.cliente_id)}">
            <span class="avatar">${esc(iniciales(c.cliente_nombre, c.cliente_apellido))}</span>
            <div class="list-item-body"><div class="list-item-title">${esc(c.cliente_nombre)} ${esc(c.cliente_apellido || '')}</div><div class="list-item-sub">${c.diasAntes === 0 ? 'Vence hoy' : `Vence en ${c.diasAntes} días`}</div></div>
            <a class="btn btn-primary" style="padding:8px 12px;font-size:12px" href="${esc(waLink(c.cliente_telefono, mensajeRecordatorio(c)))}" target="_blank" data-stop-propagation="true">Avisar</a>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${(b.contactos||[]).length?`<details class="client-section" open><summary>Contactos programados (${b.contactos.length})</summary>${b.contactos.map(r=>`<div class="list-item" data-action="ver-cliente" data-id="${esc(r.cliente_id)}"><div class="list-item-body"><strong>${esc(r.cliente_nombre)} ${esc(r.cliente_apellido||'')}</strong><p>Contacto: ${esc(fmtFecha(r.fecha_contacto))}${r.fecha_contacto<=todayISO()?' · Para revisar':''} · ${esc(modosCobranza[r.modo]||'Revisión')}</p><p>Cuota ${esc(r.numero)} · vence ${esc(fmtFecha(r.fecha_vencimiento))} · ${esc(negocioNombre(r.negocio_id))}</p></div></div>`).join('')}</details>`:''}
    <div class="section-title">Cobranza</div>
    <div class="tabs" id="cobranzaTabs">
      <button data-tab="hoy" class="${esc(state.cobranzaTab === 'hoy' ? 'active' : '')}">Hoy (${esc(b.hoy.length)})</button>
      <button data-tab="proximas" class="${esc(state.cobranzaTab === 'proximas' ? 'active' : '')}">Próximas (${esc(b.proximas.length)})</button>
      <button data-tab="vencidas" class="${esc(state.cobranzaTab === 'vencidas' ? 'active' : '')}">Vencidas (${esc(b.vencidas.length)})</button>
      <button data-tab="especial" class="${esc(state.cobranzaTab === 'especial' ? 'active' : '')}">Gestión especial (${esc((b.especial||[]).length)})</button>
      <button data-tab="todas" class="${esc(state.cobranzaTab === 'todas' ? 'active' : '')}">Todas (${esc(b.todas.length)})</button>
    </div>
    ${state.cobranzaTab === 'proximas' ? `
      <div class="tabs">
        ${[3, 5, 7].map((d) => `<button data-ventana="${esc(d)}" class="${esc(state.cobranzaVentana === d ? 'active' : '')}">Próximos ${esc(d)} días</button>`).join('')}
      </div>
    ` : ''}
    <div id="cobranzaList">${state.cobranzaTab==='especial'?gestionEspecialListHtml(b.especial||[]):cobranzaListHtml(b[state.cobranzaTab])}</div>
  `);

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
    <div class="list-item" data-action="ver-cliente" data-id="${esc(c.cliente_id)}">
      <span class="avatar">${esc(iniciales(c.cliente_nombre, c.cliente_apellido))}</span>
      <div class="list-item-body">
        <div class="list-item-title">${esc(c.cliente_nombre)} ${esc(c.cliente_apellido || '')}</div>
        <div class="list-item-sub">
          ${!state.negocioActual ? `<span class="cred-negocio-tag">${esc(negocioNombre(c.negocio_id))}</span>` : ''}
          <span class="badge badge-${esc(c.estado)}">${esc(ESTADO_LABEL[c.estado] || c.estado)}</span>
          ${c.gestion_especial===1?'<span class="badge">Gestión especial</span>':''} Cuota ${esc(c.numero)}/${esc(c.total_cuotas)} ${c.diasAtraso > 0 ? `· ${c.diasAtraso}d de atraso` : `· vence ${fmtFecha(c.fecha_vencimiento)}`}
        </div>
      </div>
      <div class="list-item-trail">
        <div class="list-item-amount">${esc(formatARS(c.saldo_pendiente_centavos + (c.moraPendiente || 0)))}</div>
        <button class="btn btn-primary" style="margin-top:6px;padding:8px 12px;font-size:12.5px" data-action="registrar-pago" data-negocio="${esc(c.negocio_id)}" data-credito="${esc(c.credito_id)}" data-monto="${esc((c.saldo_pendiente_centavos + (c.moraPendiente || 0)) / 100)}" data-stop-propagation="true">Cobrar</button>
      </div>
    </div>
  `).join('');
}

// ---------------- Vista: Calendario ----------------
async function viewCalendario(view) {
  if (!state.calMes) state.calMes = todayISO().slice(0, 7);
  if (!state.negocioActual) {
    setHTML(view, `<div class="section-title">Calendario</div><div class="empty-state"><p>Elegí un negocio arriba para ver su calendario de vencimientos.</p></div>`);
    return;
  }
  const dias = await api(`/dashboard/calendario?negocio_id=${state.negocioActual}&mes=${state.calMes}`);
  if (!view.isConnected) return;
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
      <div class="cal-day ${esc(info ? 'has-events' : '')} ${esc(esHoy ? 'today' : '')}" ${info ? `data-action="ver-dia-calendario" data-fecha="${fecha}"` : ''}>
        <span>${esc(d)}</span>
        ${info ? `<span class="dot-count">${esc(info.cantidad)}</span>` : ''}
      </div>`;
  }

  setHTML(view, `
    <div class="section-title">Calendario · ${esc(negocioNombre(state.negocioActual))}</div>
    <div class="cal-header">
      <div class="cal-month">${esc(nombreMes)}</div>
      <div class="cal-nav">
        <button data-action="cal-mes" data-delta="-1">${iconChevronLeft()}</button>
        <button data-action="cal-mes" data-delta="1">${iconChevron()}</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['D', 'L', 'M', 'M', 'J', 'V', 'S'].map((d) => `<div class="cal-dow">${esc(d)}</div>`).join('')}
      ${celdas}
    </div>
    <div class="field-hint" style="margin-top:14px">Tocá un día con vencimientos para ver el detalle.</div>
  `);
}

async function abrirDiaCalendario(fecha) {
  const cuotas = await api(`/dashboard/calendario/dia?negocio_id=${state.negocioActual}&fecha=${fecha}`);
  const total = cuotas.reduce((a, c) => a + c.saldo_pendiente_centavos, 0);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">${esc(fmtFecha(fecha))}</div>
    <div class="sheet-sub">${esc(cuotas.length)} vencimiento(s)${puede('dashboard_financiero.ver') ? ` · ${esc(formatARS(total))} por cobrar` : ''}</div>
    ${cuotas.map((c) => `
      <div class="list-item" data-action="ver-cliente" data-id="${esc(c.cliente_id)}">
        <span class="avatar">${esc(iniciales(c.cliente_nombre, c.cliente_apellido))}</span>
        <div class="list-item-body"><div class="list-item-title">${esc(c.cliente_nombre)} ${esc(c.cliente_apellido || '')}</div><div class="list-item-sub">Cuota ${esc(c.numero)}/${esc(c.total_cuotas)} · <span class="badge badge-${esc(c.estado)}">${esc(ESTADO_LABEL[c.estado] || c.estado)}</span></div></div>
        <div class="list-item-trail">
          <div class="list-item-amount">${esc(formatARS(c.saldo_pendiente_centavos))}</div>
          <button class="btn btn-primary" style="margin-top:6px;padding:8px 12px;font-size:12px" data-action="registrar-pago" data-negocio="${esc(c.negocio_id)}" data-credito="${esc(c.credito_id)}" data-monto="${esc(c.saldo_pendiente_centavos / 100)}">Cobrar</button>
        </div>
      </div>
    `).join('')}
  `);
}

// ---------------- Vista: Nueva venta ----------------
async function viewVentaNueva(view, clientePreId) {
  if (!state.negocios.length) { setHTML(view, `<div class="empty-state"><p>Primero creá un negocio (arriba, "Cambiar" → "Crear negocio nuevo").</p></div>`); return; }
  const negociosVenta = state.negocios.filter(n => puede('ventas.crear', n.id));
  const negocioSel = state.negocioActual || negociosVenta[0]?.id;
  if (!negocioSel || !negociosVenta.some(n => n.id === negocioSel)) { setHTML(view, '<div class="empty-state"><p>No tenés permiso para vender en este negocio.</p></div>'); return; }
  let clientePre = null;
  if (clientePreId) { try { clientePre = await api(`/clientes/${encodeURIComponent(clientePreId)}?negocio_id=${encodeURIComponent(negocioSel)}`); } catch { /* La búsqueda permite elegir otro cliente autorizado. */ } }
  if (!view.isConnected) return;
  const productos = puede('productos.ver', negocioSel) ? await api(`/productos?negocio_id=${encodeURIComponent(negocioSel)}`) : [];
  if (!view.isConnected) return;

  setHTML(view, `
    <div class="section-title">Nueva venta</div>
    <div class="card">
      <div class="field">
        <label>Negocio</label>
        <select id="vNegocio">${negociosVenta.map((n) => `<option value="${esc(n.id)}" ${esc(n.id === negocioSel ? 'selected' : '')}>${esc(n.nombre)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Cliente</label>
        <input id="vClienteBuscar" placeholder="Buscar cliente (o crear uno nuevo)" value="${esc(clientePre ? clientePre.nombre + ' ' + (clientePre.apellido || '') : '')}" />
        <input type="hidden" id="vClienteId" value="${esc(clientePre?.id || '')}" />
        <div id="vClienteResultados"></div>
      </div>
      <div class="field">
        <label>Producto (opcional)</label>
        <select id="vProducto">
          <option value="">— Ingresar monto manualmente —</option>
          ${productos.map((p) => `<option value="${esc(p.id)}" data-precio="${esc(p.precio_financiado_centavos)}">${esc(p.nombre)} ${esc(p.variante ? '(' + p.variante + ')' : '')} · ${esc(formatARS(p.precio_financiado_centavos))}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field"><label>Monto total</label><input type="number" id="vMontoTotal" placeholder="0" /></div>
        <div class="field"><label>Entrega inicial</label><input type="number" id="vEntrega" placeholder="0" value="0" /></div>
      </div>
      <div class="field"><label>Medio de la entrega inicial</label><select id="vMedioEntrega"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="mercado_pago">Mercado Pago</option><option value="otro">Otro</option></select></div>
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
  `);

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
  document.getElementById('vNegocio').addEventListener('change', e => setNegocio(e.target.value));

  let tBuscar, busquedaActual = 0;
  const clienteBuscar = view.querySelector('#vClienteBuscar');
  const clienteResultados = view.querySelector('#vClienteResultados');
  clienteBuscar.addEventListener('input', (e) => {
    clearTimeout(tBuscar);
    const q = e.target.value.trim(), busqueda = ++busquedaActual;
    view.querySelector('#vClienteId').value = '';
    setHTML(clienteResultados, '');
    if (q.length < 2) return;
    tBuscar = setTimeout(async () => {
      if (!view.isConnected) return;
      try {
        const res = await api(`/clientes?q=${encodeURIComponent(q)}&negocio_id=${encodeURIComponent(negocioSel)}`);
        if (!view.isConnected || busqueda !== busquedaActual) return;
        setHTML(clienteResultados, res.slice(0, 5).map((c) => `
          <div class="list-item" style="margin-top:6px" data-action="elegir-cliente-venta" data-id="${esc(c.id)}" data-nombre="${esc(c.nombre)} ${esc(c.apellido || '')}">
            <span class="avatar">${esc(iniciales(c.nombre, c.apellido))}</span>
            <div class="list-item-body"><div class="list-item-title">${esc(c.nombre)} ${esc(c.apellido || '')}</div><div class="list-item-sub">${esc(c.telefono || '')}</div></div>
          </div>
        `).join('') || `<div class="field-hint">Sin resultados. <span data-action="crear-cliente-inline" style="color:var(--accent);cursor:pointer">Crear cliente nuevo →</span></div>`);
      } catch (err) {
        if (view.isConnected && busqueda === busquedaActual) setHTML(clienteResultados, `<div class="field-hint">${esc(err.message)}</div>`);
      }
    }, 220);
  });

  document.getElementById('btnCrearVenta').addEventListener('click', () => submitVenta());
}

function renderCamposModalidad(modalidad) {
  const box = document.getElementById('vCamposModalidad');
  if (modalidad === 'cuotas') {
    setHTML(box, `
      <div class="field-row">
        <div class="field"><label>Cantidad de cuotas</label><input type="number" id="vCantCuotas" placeholder="6" /></div>
        <div class="field"><label>Valor de cada cuota</label><input type="number" id="vValorCuota" placeholder="0" /></div>
      </div>
      <div class="field"><label>Fecha de la primera cuota</label><input type="date" id="vFechaPrimera" value="${esc(todayISO())}" /></div>
    `);
  } else {
    setHTML(box, `<div class="field"><label>Fecha límite de pago</label><input type="date" id="vFechaLimite" /></div><div class="field-hint">Si no elegís una fecha, se usan 30 días desde hoy por defecto.</div>`);
  }
}

async function submitVenta() {
  const button = document.getElementById('btnCrearVenta');
  if (!button || button.disabled) return;
  const negocio_id = document.getElementById('vNegocio').value;
  const cliente_id = document.getElementById('vClienteId').value;
  if (!cliente_id) return toast('Elegí un cliente de la lista', true);
  const monto_total_centavos = toCentavos(document.getElementById('vMontoTotal').value);
  const entrega_inicial_centavos = toCentavos(document.getElementById('vEntrega').value);
  if (!monto_total_centavos) return toast('Ingresá el monto total', true);
  const modalidad = document.querySelector('#vModalidad button.active').dataset.val;
  const productoSel = document.getElementById('vProducto');

  const body = {
    negocio_id, cliente_id, modalidad, monto_total_centavos, entrega_inicial_centavos, medio_pago_entrega:document.getElementById('vMedioEntrega').value,
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

  button.disabled = true;
  try {
    const r = await api('/ventas', { method: 'POST', body: JSON.stringify(body) });
    if (r.advertencias?.length) toast(r.advertencias.join(' '));
    else toast('Venta creada ✓');
    location.hash = `#/clientes/${cliente_id}`;
  } catch (err) { button.disabled = false; toast(err.message, true); }
}

// ---------------- Vista: Productos ----------------
async function viewProductos(view) {
  if (!state.negocioActual) { setHTML(view, `<div class="empty-state"><p>Elegí un negocio arriba para ver su catálogo.</p></div>`); return; }
  const productos = await api(`/productos?negocio_id=${state.negocioActual}`);
  if (!view.isConnected) return;
  setHTML(view, `
    <div class="section-title">Productos · ${esc(negocioNombre(state.negocioActual))}</div>
    ${productos.length === 0 ? '<div class="empty-state"><p>Sin productos cargados.</p></div>' : productos.map((p) => `
      <div class="list-item">
        <span class="avatar">${esc(p.nombre[0])}</span>
        <div class="list-item-body">
          <div class="list-item-title">${esc(p.nombre)}</div>
          <div class="list-item-sub">${esc(p.variante || p.categoria || '')} · Stock: ${esc(p.stock === null ? 'sin control' : p.stock)}${esc(p.stock !== null && p.stock <= p.stock_minimo ? ' ⚠️' : '')}</div>
        </div>
        <div class="list-item-trail"><div class="list-item-amount">${esc(formatARS(p.precio_financiado_centavos))}</div></div>
      </div>
    `).join('')}
  `);
}

// ---------------- Vista: Comprobantes ----------------
async function viewComprobantes(view, clienteId = null) {
  if (!state.negocioActual) { setHTML(view, `<div class="empty-state"><p>Elegí un negocio arriba para ver sus comprobantes.</p></div>`); return; }
  if ((clienteId && !puede('clientes.ver')) || (!clienteId && state.usuario?.rol !== 'administrador')) {
    setHTML(view, '<div class="empty-state"><p>No tenés permiso para ver los comprobantes de este cliente en este negocio.</p></div>'); return;
  }
  const comprobantes = await api(`/comprobantes?negocio_id=${encodeURIComponent(state.negocioActual)}${clienteId ? `&cliente_id=${encodeURIComponent(clienteId)}` : ''}`);
  if (!view.isConnected) return;
  setHTML(view, `
    ${clienteId ? `<a class="btn btn-ghost" href="#/clientes/${esc(clienteId)}">${iconChevronLeft()}Volver a la ficha</a><p class="field-hint">Solo comprobantes de este cliente en el negocio seleccionado.</p>` : ''}
    <div class="section-title">Comprobantes · ${esc(negocioNombre(state.negocioActual))}</div>
    ${comprobantes.length === 0 ? '<div class="empty-state"><p>Todavía no hay comprobantes.</p></div>' : comprobantes.map((c) => `
      <div class="list-item" style="cursor:default">
        <span class="avatar">${esc(c.estado === 'anulado' ? '✕' : '✓')}</span>
        <div class="list-item-body">
          <div class="list-item-title">${esc(c.numero)}${c.estado === 'anulado' ? ' <span class="badge badge-mora">Anulado</span>' : ''}</div>
          <div class="list-item-sub">${esc(c.tipo_pago==='entrega_inicial'?'Entrega inicial':'Pago de cuota')} · ${esc(fmtFecha(c.fecha_hora))} · ${esc(c.medio_pago || '')}</div>
        </div>
        <div class="list-item-trail">
          <div class="list-item-amount" style="${esc(c.estado === 'anulado' ? 'text-decoration:line-through;color:var(--text-faint)' : '')}">${esc(formatARS(c.monto_centavos))}</div>
          ${c.estado !== 'anulado' && c.tipo_pago !== 'entrega_inicial' && puede('comprobantes.anular',state.negocioActual) ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;margin-top:4px" data-action="anular-comprobante" data-id="${esc(c.id)}">Anular</button>` : ''}
        </div>
      </div>
    `).join('')}
  `);
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
  if (!state.negocioActual) { setHTML(view, `<div class="empty-state"><p>Elegí un negocio arriba para configurarlo.</p></div>`); return; }
  const n = await api(`/negocios/${state.negocioActual}`);
  if (!view.isConnected) return;
  const reglas = JSON.parse(n.recordatorio_dias || '[]');
  const opcionesRecordatorio = [7, 5, 3, 2, 1, 0];

  setHTML(view, `
    <div class="section-title">Configuración · ${esc(n.nombre)}</div>
    <div class="card">
      <div class="field-row">
        <div class="field"><label>Días de gracia</label><input type="number" id="cfGracia" value="${esc(n.dias_gracia)}" /></div>
        <div class="field"><label>Mora (%)</label><input type="number" id="cfMoraValor" value="${esc(n.mora_valor)}" /></div>
      </div>
      <div class="field">
        <label>Mora calculada por</label>
        <select id="cfMoraPeriodo">
          <option value="dia" ${esc(n.mora_periodo === 'dia' ? 'selected' : '')}>Día</option>
          <option value="semana" ${esc(n.mora_periodo === 'semana' ? 'selected' : '')}>Semana</option>
          <option value="mes" ${esc(n.mora_periodo === 'mes' ? 'selected' : '')}>Mes</option>
        </select>
      </div>
    </div>
    <div class="section-title">Recordatorios de WhatsApp</div>
    <div class="card"><label><input id="cfEquipos" type="checkbox" ${n.seguimiento_equipos===1?'checked':''} /> Registrar entregas y retiros de equipos</label><p class="field-hint">Activá esta opción solo en los negocios que necesiten seguimiento de equipos. Las modalidades de pago se eligen en cada venta.</p></div>
    <div class="field-hint" style="margin-bottom:10px">Elegí con cuántos días de anticipación aparece el cliente en la lista de "para recordar hoy".</div>
    <div>
      ${opcionesRecordatorio.map((d) => `
        <button type="button" class="chip-toggle ${esc(reglas.includes(d) ? 'active' : '')}" data-dia="${esc(d)}">${d === 0 ? 'El mismo día' : `${d} día(s) antes`}</button>
      `).join('')}
    </div>
    <button class="btn btn-primary btn-block btn-lg" id="btnGuardarConfig" style="margin-top:20px">Guardar</button>
  `);

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
          seguimiento_equipos: document.getElementById('cfEquipos').checked ? 1 : 0,
        }),
      });
      toast('Configuración guardada ✓');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------- Vista: Más ----------------
async function viewMas(view) {
  setHTML(view, `
    <div class="section-title">Más</div>
    <a class="list-item" href="#/productos"><span class="avatar">${iconProductos()}</span><div class="list-item-body"><div class="list-item-title">Productos y stock</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/comprobantes"><span class="avatar">🧾</span><div class="list-item-body"><div class="list-item-title">Comprobantes</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/configuracion"><span class="avatar">⚙️</span><div class="list-item-body"><div class="list-item-title">Configuración del negocio</div></div><span class="chev">${iconChevron()}</span></a>
    <a class="list-item" href="#/empleados"><span class="avatar">👥</span><div class="list-item-body"><div class="list-item-title">Empleados y permisos</div></div><span class="chev">${iconChevron()}</span></a>
    ${['Contratos', 'Caja', 'Exportaciones'].map((n) => `
      <div class="list-item" style="opacity:.55"><span class="avatar">✦</span><div class="list-item-body"><div class="list-item-title">${esc(n)}</div><div class="list-item-sub">Próxima etapa</div></div></div>
    `).join('')}
    <div class="section-title">Cuenta</div>
    <div class="list-item" data-action="logout"><span class="avatar">⎋</span><div class="list-item-body"><div class="list-item-title">Cerrar sesión</div></div></div>
  `);
}

// ---------------- Empleados y permisos ----------------
const PERMISOS_EMPLEADO = ['clientes.ver','clientes.editar','ventas.crear','pagos.registrar','productos.ver','cobranzas.ver','costos.ver','comprobantes.anular','empleados.gestionar'];
function parseJsonSeguro(v, fallback = {}) { if (v && typeof v === 'object') return v; try { return JSON.parse(v || ''); } catch { return fallback; } }
function resumenAsignaciones(asignaciones, negocioMap) {
  return asignaciones.filter(a => a.activo !== 0).map(a => `<details><summary>${esc(negocioMap[a.negocio_id]?.nombre || a.negocio_id)}</summary><p>${esc(Object.entries(parseJsonSeguro(a.permisos)).filter(([,v])=>v===true).map(([p])=>p).join(' · ') || 'Sin permisos habilitados')}</p></details>`).join('') || 'Sin negocios asignados';
}
async function viewEmpleados(view) {
  const admin = state.usuario?.rol === 'administrador';
  const [usuarios, invitaciones, negocios] = await Promise.all([api('/usuarios'), admin ? api('/invitaciones') : [], api('/negocios')]);
  if (!view.isConnected) return;
  const negocioMap = Object.fromEntries(negocios.map(n => [n.id, n]));
  const empleados = usuarios.filter(u => u.rol !== 'administrador');
  let html = `<div class="section-title">Empleados y permisos</div><div class="card"><div class="section-title">Empleados</div><p>Los permisos se aplican por negocio. Abrí un negocio para consultar sus permisos.</p>`;
  if (!empleados.length) html += `<p>No hay empleados que puedas administrar.</p>`;
  for (const u of empleados) {
    html += `<div class="list-item"><div class="list-item-body"><div class="list-item-title">${esc(u.nombre || 'Sin nombre')} · ${u.activo ? 'Activo' : 'Inactivo'}</div><div class="list-item-sub">${esc(u.email)}</div>${resumenAsignaciones(u.negocios || [], negocioMap)}</div><div class="employee-actions"><button class="btn btn-secondary" data-action="toggle-empleado" data-id="${esc(u.id)}" data-activo="${u.activo ? '0' : '1'}">${u.activo ? 'Desactivar' : 'Activar'}</button><button class="btn btn-secondary" data-action="editar-empleado" data-id="${esc(u.id)}">Editar permisos</button></div></div>`;
  }
  html += `</div>`;
  if (admin) {
    html += `<div class="card" style="margin-top:14px"><div class="section-title">Invitar empleado</div><p>Seleccioná negocios y configurá los permisos de cada uno. El enlace vence en 7 días.</p><div class="field"><label for="invEmail">Email</label><input id="invEmail" type="email" maxlength="254" placeholder="empleado@email.com"></div><div class="field"><label for="invNombreEmpleado">Nombre</label><input id="invNombreEmpleado" maxlength="200" placeholder="Nombre (opcional)"></div>`;
    for (const n of negocios) html += bloquePermisos(n, 'inv', {}, false);
    html += `<button class="btn btn-primary btn-block" data-action="enviar-invitacion" ${negocios.length ? '' : 'disabled'}>Invitar y enviar email</button>${negocios.length ? '' : '<p>Primero creá un negocio para poder asignarlo.</p>'}</div><div class="card" style="margin-top:14px"><div class="section-title">Historial de invitaciones</div>`;
    if (!invitaciones.length) html += `<p>No hay invitaciones.</p>`;
    for (const inv of invitaciones) {
      const estado = inv.estado === 'pendiente' && new Date(inv.expira_en).getTime() <= Date.now() ? 'vencida' : inv.estado;
      const usada = estado === 'usada';
      const cuentaExiste = empleados.some(u => u.email.toLowerCase() === inv.email.toLowerCase());
      html += `<div class="list-item" data-invitacion-estado="${esc(estado)}"><div class="list-item-body"><div class="list-item-title">${esc(inv.email)}</div><div class="list-item-sub">${esc(({pendiente:'Pendiente',usada:'Usada',vencida:'Vencida',revocada:'Revocada'})[estado] || estado)} · Vencimiento: ${esc(fmtFecha(inv.expira_en))}</div>${resumenAsignaciones(parseJsonSeguro(inv.negocios, []), negocioMap)}</div><div class="employee-actions">${!usada && !cuentaExiste ? `<button class="btn btn-secondary" data-action="regenerar-invitacion" data-id="${esc(inv.id)}">Regenerar y reenviar</button>` : ''}${estado === 'pendiente' ? `<button class="btn btn-secondary" data-action="revocar-invitacion" data-id="${esc(inv.id)}">Revocar</button>` : ''}</div></div>`;
    }
    html += `</div>`;
  }
  setHTML(view, html);
}
function bloquePermisos(n, prefijo, permisos, activo) {
  return `<fieldset class="employee-business"><legend><label><input type="checkbox" class="${esc(prefijo)}-negocio-check" data-id="${esc(n.id)}" ${activo ? 'checked' : ''}> ${esc(n.nombre)}</label></legend><div class="employee-permissions">${PERMISOS_EMPLEADO.map(p => `<label><input type="checkbox" class="${esc(prefijo)}-permiso-check" data-negocio="${esc(n.id)}" data-permiso="${esc(p)}" ${permisos[p] === true ? 'checked' : ''} ${activo ? '' : 'disabled'}> ${esc(p)}</label>`).join('')}</div></fieldset>`;
}
document.addEventListener('change', e => {
  if (e.target.matches('.inv-negocio-check,.edit-negocio-check')) {
    e.target.closest('fieldset').querySelectorAll('[data-permiso]').forEach(cb => { cb.disabled = !e.target.checked; });
  }
});
function recogerAsignaciones(prefijo) {
  return [...document.querySelectorAll(`.${prefijo}-negocio-check:checked`)].map(cb => {
    const permisos = {};
    cb.closest('fieldset').querySelectorAll('[data-permiso]').forEach(p => { permisos[p.dataset.permiso] = p.checked; });
    return { negocio_id: cb.dataset.id, permisos };
  });
}
async function accionEmpleado(selector, action) {
  const btn = typeof selector === 'string' ? document.querySelector(selector) : [...document.querySelectorAll('[data-action]')].find(el=>el.dataset.action===selector.action && el.dataset.id===selector.id);
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await action(); } catch(e) { toast(e.message, true); }
  finally { if (btn) btn.disabled = false; }
}
async function toggleEmpleado(id, activo) {
  if (!activo && !confirm('¿Desactivar al empleado? Perderá acceso inmediatamente.')) return;
  return accionEmpleado({action:'toggle-empleado',id}, async () => {
    await api(`/usuarios/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({ activo: activo ? 1 : 0 }) });
    toast('Empleado actualizado ✓'); await render();
  });
}
async function editarEmpleado(id) {
  try {
    const [u, todos] = await Promise.all([api(`/usuarios/${encodeURIComponent(id)}`), api('/negocios')]);
    const negocios = todos.filter(n => puede('empleados.gestionar', n.id));
    let html = `<div class="sheet-handle"></div><div class="sheet-title">Editar empleado</div><p>${esc(u.email)}</p><div class="field"><label for="editNombreEmpleado">Nombre</label><input id="editNombreEmpleado" maxlength="200" value="${esc(u.nombre || '')}"></div><p>Desmarcar un negocio revoca el acceso a ese negocio.</p>`;
    for (const n of negocios) { const a=(u.negocios||[]).find(x=>x.negocio_id===n.id); html += bloquePermisos(n,'edit',parseJsonSeguro(a?.permisos,{}),a?.activo===1); }
    html += `<div class="sheet-actions"><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button class="btn btn-primary" data-action="guardar-empleado" data-id="${esc(id)}">Guardar</button></div>`;
    openSheet(html);
  } catch(e){ toast(e.message,true); }
}
async function guardarEmpleado(id) {
  return accionEmpleado('[data-action="guardar-empleado"]', async () => {
    await api(`/usuarios/${encodeURIComponent(id)}`, {method:'PATCH', body:JSON.stringify({nombre:document.getElementById('editNombreEmpleado').value.trim(),negocios:recogerAsignaciones('edit')})});
    closeSheet(); toast('Empleado y permisos guardados ✓'); await render();
  });
}
function mostrarResultadoInvitacion(r) {
  const link = `${location.origin}${location.pathname}?token=${encodeURIComponent(r.token)}`;
  openSheet(`<div class="sheet-handle"></div><div class="sheet-title">Invitación creada</div><p>${esc(r.emailEnviado ? 'El proveedor aceptó el email para su envío.' : r.emailError || 'No se pudo enviar el email.')}</p><p>Compartí este enlace únicamente con la persona invitada. Se utiliza una sola vez y vence en 7 días.</p><div class="field"><label for="invLinkResultado">Enlace de invitación</label><input id="invLinkResultado" readonly value="${esc(link)}"></div><div class="sheet-actions"><button class="btn btn-secondary" data-action="copiar-invitacion">Copiar enlace</button><button class="btn btn-primary" data-action="cerrar-sheet">Listo</button></div>`);
}
async function enviarInvitacion() {
  const input = document.getElementById('invEmail');
  const email=input.value.trim(), nombre=document.getElementById('invNombreEmpleado').value.trim(), negocios=recogerAsignaciones('inv');
  if(!email || !input.checkValidity()) return toast('Ingresá un email válido',true);
  if(!negocios.length) return toast('Seleccioná al menos un negocio',true);
  return accionEmpleado('[data-action="enviar-invitacion"]', async () => {
    const r=await api('/invitaciones',{method:'POST',body:JSON.stringify({email,nombre,negocios})}); await render(); mostrarResultadoInvitacion(r);
  });
}
async function revocarInvitacion(id) {
  if(!confirm('¿Revocar esta invitación? Su enlace dejará de funcionar.'))return;
  return accionEmpleado({action:'revocar-invitacion',id}, async()=>{await api(`/invitaciones/${encodeURIComponent(id)}/revocar`,{method:'POST'});toast('Invitación revocada');await render();});
}
async function regenerarInvitacion(id) {
  if(!confirm('¿Regenerar y reenviar? Todos los enlaces anteriores de este email dejarán de funcionar.'))return;
  return accionEmpleado({action:'regenerar-invitacion',id}, async()=>{const r=await api(`/invitaciones/${encodeURIComponent(id)}/regenerar`,{method:'POST'});await render();mostrarResultadoInvitacion(r);});
}
async function renderAceptarInvitacion() {
  const token = new URLSearchParams(location.search).get('token');
  document.getElementById('authScreen').style.display='none'; document.getElementById('root').style.display='none'; document.getElementById('invitacionScreen').style.display='flex';
  const btn=document.getElementById('btnAceptarInvitacion'), err=document.getElementById('invError'), info=document.getElementById('invitacionInfo');
  const fields=['invNombre','invPassword','invPassword2'].map(id=>document.getElementById(id));
  btn.disabled=true; btn.onclick=null; info.textContent='Verificando invitación…';
  try {
    const inv=await api('/auth/invitacion/consultar',{method:'POST',body:JSON.stringify({token}),headers:{'Content-Type':'application/json'}});
    info.textContent=`Invitación para ${inv.email}. Negocios: ${inv.negocios.map(n=>n.nombre).join(', ')}. Vence el ${fmtFecha(inv.expira_en)}.`;
    fields[0].value=inv.nombre || ''; fields.forEach(el=>el.disabled=false); btn.disabled=false;
  } catch(e) { info.textContent=e.message; fields.forEach(el=>el.disabled=true); return; }
  btn.onclick=async()=>{
    if(btn.disabled)return;
    const nombre=fields[0].value.trim(),password=fields[1].value,password2=fields[2].value;err.style.display='none';
    if(password.length<6){err.textContent='La contraseña debe tener al menos 6 caracteres';err.style.display='block';return;}
    if(password!==password2){err.textContent='Las contraseñas no coinciden';err.style.display='block';return;}
    btn.disabled=true;
    try {
      const data=await api('/auth/invitacion/aceptar',{method:'POST',body:JSON.stringify({token,password,nombre}),headers:{'Content-Type':'application/json'}});
      setToken(data.token); fields[1].value='';fields[2].value='';history.replaceState({},'',location.pathname+'#/inicio');document.getElementById('invitacionScreen').style.display='none';await arrancarApp();
    } catch(e) { err.textContent=e.message;err.style.display='block';btn.disabled=false; }
  };
}

// ---------------- WhatsApp helpers ----------------
function normalizePhone(tel) {
  const digits = (tel || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('54') ? digits : `54${digits}`;
}
function waLink(tel, texto) { if (!tel) return '#'; return `https://wa.me/${normalizePhone(tel)}?text=${encodeURIComponent(texto)}`; }
function vencimientosClienteHtml(c) {
  const vencido = c.vencimientoVencido || (c.diasHastaVencimiento < 0 ? c.proximoVencimiento : null);
  const atraso = c.diasAtrasoVencimiento ?? -c.diasHastaVencimiento;
  const lineas = [];
  if (vencido) lineas.push(`Cuota vencida: ${esc(fmtFecha(vencido))} · ${esc(atraso)} días de atraso`);
  if (c.cuotasVencenHoy > 0 || (c.proximoVencimiento && c.diasHastaVencimiento === 0)) lineas.push('Cuota con vencimiento hoy');
  if (c.proximoVencimiento && c.diasHastaVencimiento > 0) lineas.push(`Próximo vencimiento: ${esc(fmtFecha(c.proximoVencimiento))} (en ${esc(c.diasHastaVencimiento)} días)`);
  return lineas.length ? lineas.join('<br>') : c.deudaTotalCentavos > 0 ? 'Revisá el detalle de las cuotas pendientes' : 'Sin obligaciones pendientes';
}
const importeMensaje = centavos => '$'+new Intl.NumberFormat('es-AR', {maximumFractionDigits:0}).format(centavos/100);
function mensajeSaludo(c) {
  const saludo = `${c.nombre}, cómo estás?`;
  // Nunca usar deudaTotalCentavos: incluye cuotas futuras no exigibles.
  if (Number.isSafeInteger(c.saldoExigibleCentavos) && c.saldoExigibleCentavos > 0) {
    const concepto = c.cuotasVencidas > 0
      ? c.cuotasVencenHoy > 0 ? 'tus cuotas vencidas y con vencimiento hoy' : c.cuotasVencidas === 1 ? 'tu cuota vencida' : 'tus cuotas vencidas'
      : c.cuotasVencenHoy === 1 ? 'tu cuota con vencimiento hoy' : 'tus cuotas con vencimiento hoy';
    return `${saludo}\nTenés un saldo pendiente de ${importeMensaje(c.saldoExigibleCentavos)}, correspondiente a ${concepto}.\nMantenenos al tanto.`;
  }
  if (c.proximoVencimiento && c.diasHastaVencimiento > 0) return `${saludo}\nTe recordamos que tu próxima cuota vence el ${fmtFecha(c.proximoVencimiento)}.\nMantenenos al tanto.`;
  return saludo;
}
function mensajeRecordatorio(c) {
  if (c.diasAntes <= 0) return mensajeSaludo({nombre:c.cliente_nombre, saldoExigibleCentavos:c.saldo_pendiente_centavos + (c.moraPendiente || 0), cuotasVencidas:c.diasAntes < 0 ? 1 : 0, cuotasVencenHoy:c.diasAntes === 0 ? 1 : 0});
  return `${c.cliente_nombre}, cómo estás?\nTe recordamos que tu cuota vence el ${fmtFecha(c.fecha_vencimiento)} (en ${c.diasAntes} día${c.diasAntes === 1 ? '' : 's'}). El importe de esa cuota es ${importeMensaje(c.saldo_pendiente_centavos)}.\nMantenenos al tanto.`;
}

// ---------------- Iconos ----------------
function iconSearch() { return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconChevron() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconChevronLeft() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="m15 6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconCobrar(s = 20) { return `<svg width="${esc(s)}" height="${esc(s)}" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M7 14.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconVenta() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 8h16l-1.4 10.1a2 2 0 0 1-2 1.9H7.4a2 2 0 0 1-2-1.9L4 8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8V6a4 4 0 1 1 8 0v2" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconClientes(s = 20) { return `<svg width="${esc(s)}" height="${esc(s)}" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 20c.8-3.4 3-5.2 5.5-5.2S13.7 16.6 14.5 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }
function iconProductos() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 7l9-4 9 4-9 4-9-4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 7v10l9 4 9-4V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`; }
function iconWhatsapp() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.6 13.8L3 21l4.4-1.4A9 9 0 1 0 12 3Z" stroke="currentColor" stroke-width="1.8"/></svg>`; }
function iconLlamar() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`; }
function iconNota() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l3 3v15H6V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 10h6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`; }
function iconCalendario() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`; }

// ---------------- Delegación de eventos global ----------------
document.addEventListener('click', async (e) => {
  if(e.target.closest('[data-stop-propagation]') && !e.target.closest('button[data-action]'))return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, credito, monto, nombre, fecha, delta } = el.dataset;

  if(action==='copiar-invitacion'){const input=document.getElementById('invLinkResultado');try{await navigator.clipboard.writeText(input.value);toast('Enlace copiado');}catch{input.focus();input.select();toast('Seleccioná y copiá el enlace');}return;}
  if(action==='volver-login'){history.replaceState({},'',location.pathname);document.getElementById('invitacionScreen').style.display='none';showAuthScreen();return;}
  if(action==='toggle-empleado')return toggleEmpleado(id,el.dataset.activo==='1');
  if(action==='editar-empleado')return editarEmpleado(id);
  if(action==='enviar-invitacion')return enviarInvitacion();
  if(action==='regenerar-invitacion')return regenerarInvitacion(id);
  if(action==='revocar-invitacion')return revocarInvitacion(id);
  if(action==='guardar-empleado')return guardarEmpleado(id);
  if(action==='nueva-venta'){closeSheet();location.hash='#/ventas/nueva';return;}
  if(action==='ir-cobrar'){closeSheet();location.hash='#/cobrar';return;}
  if(action==='crear-producto'){closeSheet();abrirCrearProducto();return;}
  if (action === 'ver-cliente') { closeSheet(); location.hash = `#/clientes/${id}`; }
  else if (action === 'elegir-negocio') { setNegocio(id || null); closeSheet(); }
  else if (action === 'ir-negocio') { setNegocio(id); location.hash = '#/inicio'; }
  else if (action === 'abrir-crear-negocio') abrirCrearNegocio();
  else if (action === 'cerrar-sheet') closeSheet();
  else if (action === 'registrar-pago') abrirRegistrarPago(credito, monto ? Number(monto) : null);
  else if (action === 'ver-cliente-negocio') { setNegocio(id || null); const parts = parseHash(); if (parts[1]) render(); }
  else if (action === 'editar-seguimiento') abrirEditarSeguimiento(id);
  else if (action === 'corregir-financiacion') abrirCorreccionFinanciacion(credito,el.dataset.negocio);
  else if (action === 'perdonar-mora') abrirPerdonarMora(el.dataset.cuota,el.dataset.negocio);
  else if (action === 'editar-cliente') abrirEditarCliente(id);
  else if (action === 'eliminar-cliente') abrirEliminarCliente(id);
  else if (action === 'gestion-cliente') abrirGestionCliente(id,el.dataset.negocio,el.dataset.tipo);
  else if (action === 'contactos-cobranza') abrirContactosCobranza(id,el.dataset.negocio);
  else if (action === 'mensaje-especial') abrirMensajeEspecial(id,el.dataset.negocio);
  else if (action === 'incidencia-equipo') abrirIncidenciaEquipo(id,credito,el.dataset.negocio);
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
    setHTML(document.getElementById('vClienteResultados'), '');
  }
  else if (action === 'crear-cliente-inline') abrirCrearCliente();
  else if (action === 'logout') { clearToken();state.usuario=null;state.negocios=[];state.negocioActual=null;closeSheet();showAuthScreen(); }
});

document.getElementById('btnNegocioSwitch').addEventListener('click', abrirSelectorNegocio);
document.getElementById('fabButton').addEventListener('click', abrirMenuRapido);

function abrirMenuRapido() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Crear</div>
    <div class="quick-sheet-grid">
      <div class="quick-sheet-item" data-action="crear-cliente-inline">${iconClientes()}Cliente nuevo</div>
      <div class="quick-sheet-item" data-action="nueva-venta">${iconVenta()}Nueva venta</div>
      <div class="quick-sheet-item" data-action="ir-cobrar">${iconCobrar()}Ver cobranzas</div>
      <div class="quick-sheet-item" data-action="crear-producto">${iconProductos()}Producto nuevo</div>
    </div>
  `);
}

async function abrirEditarCliente(clienteId) {
  if (!puede('clientes.editar') || !puede('clientes.ver')) return toast('No tenés permiso para editar este cliente',true);
  const negocioId=state.negocioActual, token=getToken();
  const filtro=negocioId ? `?negocio_id=${encodeURIComponent(negocioId)}` : '';
  openSheet('<div class="sheet-title">Editar datos del cliente</div><p>Cargando…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected && document.getElementById('activeSheet')===sheet && document.getElementById('sheetBackdrop').classList.contains('open') && state.negocioActual===negocioId && getToken()===token && puede('clientes.editar') && puede('clientes.ver');
  try {
    const ficha=await api(`/clientes/${encodeURIComponent(clienteId)}/datos${filtro}`);
    if (!vigente()) return;
    const campos=[['nombre','Nombre'],['apellido','Apellido'],['telefono','Teléfono'],['whatsapp','WhatsApp'],['dni','DNI'],['instagram','Instagram'],['direccion','Dirección'],['ciudad','Ciudad'],['provincia','Provincia'],['fecha_nacimiento','Fecha de nacimiento'],['trabajo','Trabajo'],['frecuencia_pago','Frecuencia de pago'],['foto_url','URL de foto'],['notas','Observaciones']];
    setHTML(sheet, `<div class="sheet-title">Editar datos del cliente</div><p>Se conservará quién hizo la corrección y los datos anteriores. No modifica ventas, cuotas ni pagos.</p>
      ${campos.map(([k,label])=>`<div class="field"><label for="ec_${k}">${esc(label)}</label>${k==='notas'?`<textarea id="ec_${k}" maxlength="10000">${esc(ficha.datos[k])}</textarea>`:`<input id="ec_${k}" type="${k==='fecha_nacimiento'?'date':'text'}" maxlength="1000" value="${esc(ficha.datos[k])}">`}</div>`).join('')}
      <div class="field"><label for="ec_motivo">Motivo de la corrección</label><textarea id="ec_motivo" maxlength="2000"></textarea></div>
      <div class="sheet-actions"><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button><button id="ec_guardar" class="btn btn-primary">Guardar corrección</button></div>`);
    let enviado=null;
    sheet.querySelector('#ec_guardar').addEventListener('click',async event=>{
      const button=event.currentTarget;
      if (button.disabled || !vigente()) return;
      const datos=Object.fromEntries(campos.map(([k])=>[k,sheet.querySelector('#ec_'+k).value.trim()]));
      const motivo=sheet.querySelector('#ec_motivo').value.trim();
      if (!datos.nombre || !motivo) return toast('Completá nombre y motivo de la corrección',true);
      enviado ||= {datos,motivo,version:ficha.version};
      button.disabled=true; sheet.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
      try {
        await api(`/clientes/${encodeURIComponent(clienteId)}/datos${filtro}`,{method:'PATCH',body:JSON.stringify(enviado)});
        if (vigente()) {closeSheet();toast('Datos corregidos; historial conservado');render();}
      } catch(error) {if(vigente()){
        button.disabled=false;
        // Un rechazo de validación permite corregir campos; una respuesta incierta
        // conserva el mismo payload para que el reintento no duplique cambios.
        if(error.status===400){enviado=null;sheet.querySelectorAll('input,textarea').forEach(el=>el.disabled=false);}
        toast(error.message,true);
      }}
    });
  } catch(error) {if(vigente())setHTML(sheet,`<p>${esc(error.message)}</p><button class="btn btn-secondary" data-action="cerrar-sheet">Cerrar</button>`);}
}

async function abrirEliminarCliente(clienteId) {
  if(state.usuario?.rol!=='administrador')return toast('Requiere administrador',true);
  const token=getToken(),negocioId=state.negocioActual,solicitudId=crypto.randomUUID();
  const filtro=negocioId?`?negocio_id=${encodeURIComponent(negocioId)}`:'';
  openSheet('<div class="sheet-title">Revisar eliminación del cliente</div><p>Cargando relaciones…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open')&&getToken()===token&&state.negocioActual===negocioId&&state.usuario?.rol==='administrador';
  try {
    const r=await api(`/clientes/${encodeURIComponent(clienteId)}/eliminacion${filtro}`);
    if(!vigente())return;
    const etiquetas={operaciones:'Operaciones',financiaciones:'Financiaciones',cuotas:'Cuotas',pagos:'Pagos (incluidos anulados)',comprobantes:'Comprobantes',contratos:'Contratos',recordatorios:'Recordatorios',gestiones:'Antecedentes de cobranza',configuraciones_cobranza:'Configuraciones de cobranza',saldos_favor:'Saldos a favor',correcciones:'Correcciones de datos (se conservan)'};
    setHTML(sheet,`<div class="sheet-title">Eliminar ${esc(r.nombre)}</div>
      <p>La ficha está vinculada a ${esc(r.negocios)} negocio(s). Esta acción afecta la ficha completa.</p>
      <ul>${Object.entries(etiquetas).map(([k,v])=>`<li>${esc(v)}: ${esc(r.actividad[k]||0)}</li>`).join('')}<li>Seguimiento comercial: ${r.seguimiento?'Sí':'No'}</li></ul>
      ${r.permitido?`<p>Solo se permite eliminar fichas sin actividad. Sus datos y vínculos quedarán guardados en la auditoría junto con tu usuario y el motivo.</p>
        <div class="field"><label for="el_motivo">Motivo de la eliminación</label><textarea id="el_motivo" maxlength="2000"></textarea></div>
        <div class="field"><label for="el_confirmacion">Escribí ELIMINAR para confirmar</label><input id="el_confirmacion" autocomplete="off"></div>`:'<p><strong>No se puede eliminar: tiene operaciones o historial asociado.</strong> La ficha, sus pagos, comprobantes y antecedentes se conservan. Podés corregir sus datos básicos.</p>'}
      <div class="sheet-actions"><button class="btn btn-secondary" data-action="cerrar-sheet">Cancelar</button>${r.permitido?'<button id="el_guardar" class="btn btn-primary" disabled>Eliminar ficha sin actividad</button>':''}</div>`);
    if(!r.permitido)return;
    const button=sheet.querySelector('#el_guardar'),motivo=sheet.querySelector('#el_motivo'),confirmacion=sheet.querySelector('#el_confirmacion');
    let enviado=null;
    const habilitar=()=>{if(!enviado)button.disabled=!motivo.value.trim()||confirmacion.value!=='ELIMINAR';};
    motivo.addEventListener('input',habilitar);confirmacion.addEventListener('input',habilitar);
    button.addEventListener('click',async()=>{
      if(button.disabled||!vigente())return;
      if(!enviado&&(!motivo.value.trim()||confirmacion.value!=='ELIMINAR'))return;
      enviado||={version:r.version,motivo:motivo.value.trim(),confirmacion:confirmacion.value,solicitud_id:solicitudId};
      button.disabled=true;motivo.disabled=true;confirmacion.disabled=true;
      try {
        await api(`/clientes/${encodeURIComponent(clienteId)}`,{method:'DELETE',body:JSON.stringify(enviado)});
        if(vigente()){closeSheet();toast('Ficha sin actividad eliminada; auditoría conservada');location.hash='#/clientes';}
      }catch(error){if(vigente()){
        if(error.status===400){enviado=null;motivo.disabled=false;confirmacion.disabled=false;habilitar();}
        else button.disabled=[403,404,409].includes(error.status);
        toast(error.message+(error.status===409?' Volvé a abrir la confirmación.':''),true);
      }}
    });
  }catch(error){if(vigente())setHTML(sheet,`<p>${esc(error.message)}</p><button class="btn btn-secondary" data-action="cerrar-sheet">Cerrar</button>`);}
}

function abrirCrearCliente() {
  if(!state.negocioActual) return toast('Seleccioná el negocio donde vas a crear el cliente',true);
  if(!puede('clientes.editar')) return toast('No tenés permiso para crear clientes en este negocio',true);
  const negocioId = state.negocioActual;
  const sesion = getToken();
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Cliente nuevo</div>
    <div class="sheet-sub">Se vinculará a ${esc(negocioNombre(negocioId))}.</div>
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
  `);
  const sheet = document.getElementById('activeSheet');
  const button = sheet.querySelector('#btnGuardarCliente');
  const vigente = () => sheet.isConnected && document.getElementById('activeSheet') === sheet
    && document.getElementById('sheetBackdrop').classList.contains('open')
    && state.negocioActual === negocioId && getToken() === sesion;
  button.addEventListener('click', async () => {
      if (button.disabled) return;
      if (!vigente()) return toast('El contexto cambió. Abrí nuevamente Cliente nuevo.', true);
      if (!puede('clientes.editar', negocioId)) return toast('No tenés permiso para crear clientes en este negocio', true);
      const nombre = sheet.querySelector('#ncNombre').value.trim();
      const apellido = sheet.querySelector('#ncApellido').value.trim();
      if (!nombre || !apellido) return toast('Nombre y apellido son obligatorios', true);
      button.disabled = true;
      try {
        const c = await api('/clientes', {
          method: 'POST',
          body: JSON.stringify({
            nombre, apellido, negocio_id: negocioId,
            telefono: sheet.querySelector('#ncTelefono').value,
            dni: sheet.querySelector('#ncDni').value,
            instagram: sheet.querySelector('#ncInstagram').value,
          }),
        });
        if (!vigente()) return;
        closeSheet(); toast('Cliente creado ✓');
        location.hash = `#/clientes/${c.id}`;
      } catch (err) {
        if (vigente()) { button.disabled = false; toast(err.message, true); }
      }
  });
}

function abrirCrearProducto() {
  setTimeout(() => openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-title">Producto nuevo</div>
    <div class="field"><label>Negocio</label><select id="npNegocio">${state.negocios.map((n) => `<option value="${esc(n.id)}">${esc(n.nombre)}</option>`).join('')}</select></div>
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
  const token = getToken();
  try {
    const usuario = await api('/auth/yo');
    if (token !== getToken()) return;
    const negocios = await api('/negocios');
    if (token !== getToken()) return;
    state.usuario = usuario; state.negocios = negocios;
  } catch { return; }
  if(state.negocioActual && !state.negocios.some(n=>n.id===state.negocioActual))state.negocioActual=null;
  document.querySelectorAll('.nav-item').forEach(a=>{ const p={inicio:'dashboard_financiero.ver',clientes:'clientes.ver',cobrar:'cobranzas.ver',calendario:'cobranzas.ver'}[a.dataset.route];a.hidden=!!p&&!puede(p,null); });
  if(!location.hash || location.hash==='#/inicio') { if(!puede('dashboard_financiero.ver',null)) location.hash=puede('clientes.ver',null)?'#/clientes':puede('cobranzas.ver',null)?'#/cobrar':'#/mas'; }
  hideAuthScreen();
  render();
}

(async function init() {
  wireAuthScreen();
  if (new URLSearchParams(location.search).get('token')) { await renderAceptarInvitacion(); return; }
  if (!getToken()) { showAuthScreen(); return; }
  await arrancarApp();
})();

async function abrirPerdonarMora(cuotaId, negocioId) {
  if(state.usuario?.rol!=='administrador') return toast('Requiere administrador',true);
  const token=getToken(),scope=state.negocioActual,solicitud=crypto.randomUUID();
  openSheet('<div class="sheet-title">Perdonar mora</div><p>Cargando…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&getToken()===token&&state.negocioActual===scope&&document.getElementById('sheetBackdrop').classList.contains('open')&&state.usuario?.rol==='administrador';
  try {
    const data=await api(`/pagos/cuotas/${encodeURIComponent(cuotaId)}/mora?negocio_id=${encodeURIComponent(negocioId)}`);
    if(!vigente())return;
    setHTML(sheet,`<div class="sheet-title">Perdonar mora</div><p>Mora pendiente: <strong>${esc(formatARS(data.mora.pendiente))}</strong></p><p>Se perdona únicamente este importe. El atraso y la mora generada quedan en el historial. Nuevos atrasos pueden generar más mora.</p><div class="field"><label>Motivo</label><textarea id="motivoMora" maxlength="2000"></textarea></div><button id="confirmarMora" class="btn btn-primary">Confirmar perdón</button>`);
    let busy=false,payload=null;
    sheet.querySelector('#confirmarMora').addEventListener('click',async()=>{
      if(busy||!vigente())return;
      const motivo=sheet.querySelector('#motivoMora').value.trim();if(!motivo)return toast('Indicá el motivo',true);
      payload ||= {version:data.version,motivo,solicitud_id:solicitud,negocio_id:negocioId};
      busy=true;sheet.querySelector('#confirmarMora').disabled=true;sheet.querySelector('#motivoMora').disabled=true;
      try { await api(`/pagos/cuotas/${encodeURIComponent(cuotaId)}/perdonar-mora`,{method:'POST',body:JSON.stringify(payload)});if(vigente()){closeSheet();toast('Mora perdonada; historial conservado');render();} }
      catch(e){if(vigente()){toast(e.message,true);if(e.status===409)setHTML(sheet,'<p>La cuota cambió. Cerrá y abrí nuevamente para revisar el importe.</p>');else{sheet.querySelector('#confirmarMora').disabled=false;if(e.status===400){payload=null;sheet.querySelector('#motivoMora').disabled=false;}}}}
      finally{busy=false;}
    });
  }catch(e){if(vigente())setHTML(sheet,`<p>${esc(e.message)}</p>`);}
}

async function abrirCorreccionFinanciacion(creditoId,negocioId) {
  if(state.usuario?.rol!=='administrador')return toast('Requiere administrador',true);
  const token=getToken(),scope=state.negocioActual,solicitud=crypto.randomUUID();
  openSheet('<div class="sheet-title">Corregir financiación</div><p>Cargando…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open')&&getToken()===token&&state.negocioActual===scope&&state.usuario?.rol==='administrador';
  try {
    const v=await api(`/ventas/creditos/${encodeURIComponent(creditoId)}/correccion?negocio_id=${encodeURIComponent(negocioId)}`);
    if(!vigente())return;
    const cr=v.credito;
    setHTML(sheet,`<div class="sheet-title">Corregir financiación</div><p>Los cambios quedan auditados con motivo y responsable. Los pagos de cuotas se conservan. Las cuotas saldadas no se modifican.</p>
      <div class="field"><label>Importe de la operación ($)</label><input id="corTotal" type="number" min="0" step="0.01" value="${esc(cr.monto_total_centavos/100)}"></div>
      <div class="field"><label>Entrega inicial ($)</label><input id="corEntrega" type="number" min="0" step="0.01" value="${esc(cr.entrega_inicial_centavos/100)}"></div>
      <p>Si corregís la entrega, el comprobante anterior quedará anulado y se emitirá el corregido. Es una corrección de carga, no un nuevo cobro ni una devolución.</p>
      <div class="field"><label>Fecha de compra</label><input id="corFecha" type="date" value="${esc(cr.fecha_inicio)}"></div>
      <div class="field"><label>Descripción correcta del producto/equipo</label><input id="corProducto" maxlength="4000" value="${esc(cr.producto_descripcion||'')}"></div>
      <div class="field"><label>Condiciones de financiación</label><textarea id="corCondiciones" maxlength="4000">${esc(cr.condiciones||'')}</textarea></div>
      <p>Cuotas: podés agregar, corregir importes y vencimientos, o quitar cuotas sin pagos ni mora. Revisá el plan completo antes de guardar.</p><div id="corCuotas"></div><button id="corAgregar" class="btn btn-secondary">Agregar cuota</button>
      <div class="field"><label>Motivo de la corrección</label><textarea id="corMotivo" maxlength="2000"></textarea></div>
      ${v.pagos.length?'<label><input type="checkbox" id="corConfirmar"> Revisé los pagos existentes y confirmo esta corrección de carga.</label>':''}
      <button id="corGuardar" class="btn btn-primary">Guardar corrección</button>`);
    const lista=sheet.querySelector('#corCuotas');
    function add(q={}) {
      const row=document.createElement('div');row.className='field';row.dataset.id=q.id||'';
      setHTML(row,`<label>Cuota · importe ($) y vencimiento</label><input class="corMonto" type="number" min="0.01" step="0.01" value="${esc((q.monto_centavos||0)/100)}"><input class="corVence" type="date" value="${esc(q.fecha_vencimiento||'')}"><button class="btn btn-secondary corQuitar">Quitar cuota</button>`);
      row.querySelector('.corQuitar').addEventListener('click',()=>{if(vigente()&&!row.querySelector('button').disabled)row.remove();});lista.appendChild(row);
    }
    v.cuotas.forEach(add);sheet.querySelector('#corAgregar').addEventListener('click',()=>{if(vigente())add();});
    let busy=false,payload=null;
    sheet.querySelector('#corGuardar').addEventListener('click',async()=>{
      if(busy||!vigente())return;
      const read=id=>sheet.querySelector('#'+id).value;
      const datos={monto_total_centavos:Math.round(Number(read('corTotal'))*100),entrega_inicial_centavos:Math.round(Number(read('corEntrega'))*100),fecha_inicio:read('corFecha'),producto_descripcion:read('corProducto'),condiciones:read('corCondiciones'),cuotas:[...lista.children].map(row=>({id:row.dataset.id||undefined,monto_centavos:Math.round(Number(row.querySelector('.corMonto').value)*100),fecha_vencimiento:row.querySelector('.corVence').value}))};
      const motivo=read('corMotivo').trim();if(!motivo)return toast('Indicá el motivo',true);
      payload ||= {version:v.version,solicitud_id:solicitud,motivo,datos,negocio_id:negocioId,confirmar_correccion_pagos:sheet.querySelector('#corConfirmar')?.checked===true};
      busy=true;sheet.querySelectorAll('input,textarea,button').forEach(el=>el.disabled=true);
      try{await api(`/ventas/creditos/${encodeURIComponent(creditoId)}/correccion`,{method:'PATCH',body:JSON.stringify(payload)});if(vigente()){closeSheet();toast('Corrección registrada con historial');render();}}
      catch(e){if(vigente()){toast(e.message,true);if(e.status===409)setHTML(sheet,`<p>${esc(e.message)}</p><p>Cerrá y abrí nuevamente para revisar la operación.</p>`);else {sheet.querySelector('#corGuardar').disabled=false;if(e.status===400){payload=null;sheet.querySelectorAll('input,textarea,button').forEach(el=>el.disabled=false);}}}}
      finally{busy=false;}
    });
  }catch(e){if(vigente())setHTML(sheet,`<p>${esc(e.message)}</p>`);}
}

// Contactos operativos: la fecha de seguimiento nunca modifica el vencimiento de la cuota.
const modosCobranza = {automatico:'Automática',revisar:'Revisión',pausada:'Pausada'};
async function abrirContactosCobranza(clienteId,negocioId) {
  const permitido=()=>puede('clientes.ver',negocioId)&&puede('clientes.editar',negocioId)&&puede('cobranzas.ver',negocioId);
  if(!permitido())return toast('No tenés permiso para gestionar contactos',true);
  const token=getToken(),negocioActual=state.negocioActual;
  openSheet('<div class="sheet-title">Contactos de cobranza</div><p>Cargando…</p>');
  const sheet=document.getElementById('activeSheet');
  const vigente=()=>sheet.isConnected&&document.getElementById('activeSheet')===sheet&&document.getElementById('sheetBackdrop').classList.contains('open')&&getToken()===token&&state.negocioActual===negocioActual&&permitido();
  try {
    const c=await api(`/clientes/${encodeURIComponent(clienteId)}?negocio_id=${encodeURIComponent(negocioId)}`);
    if(!vigente())return;
    const contactos=(c.contactosCobranza||[]).filter(r=>r.negocio_id===negocioId);
    const pendientes=contactos.filter(r=>r.estado==='pendiente');
    const cuotas=(c.creditos||[]).filter(cr=>cr.negocio_id===negocioId).flatMap(cr=>cr.cuotas||[]).filter(q=>!q.estado_manual&&(q.saldo_pendiente_centavos>0||q.moraPendiente>0)&&!pendientes.some(r=>r.cuota_id===q.id));
    const g=(c.gestionCobranza||[]).find(g=>g.negocio_id===negocioId);
    setHTML(sheet,`<div class="sheet-title">Contactos de cobranza · ${esc(negocioNombre(negocioId))}</div>
      <p>Programar un contacto no cambia la fecha de vencimiento ni perdona mora. No se envían mensajes automáticamente.</p>
      ${state.usuario?.rol==='administrador'?`<div class="field"><label for="contactoModo">Modo de cobranza</label><select id="contactoModo">${Object.entries(modosCobranza).map(([v,n])=>`<option value="${v}" ${v===(g?.modo||'revisar')?'selected':''}>${n}</option>`).join('')}</select></div><div class="field"><label for="contactoModoNota">Motivo del cambio de modo</label><textarea id="contactoModoNota" maxlength="2000"></textarea></div><button class="btn btn-secondary" id="guardarContactoModo">Guardar modo</button><p class="field-hint">Automática deja preparada la preferencia para la integración de WhatsApp. Revisión requiere intervención humana. Pausada suspende los avisos sugeridos; la deuda y los contactos permanecen visibles.</p>`:''}
      <div class="field"><label for="contactoDestino">Cuota o contacto</label><select id="contactoDestino">${pendientes.map(r=>`<option value="r:${esc(r.id)}">Revisar contacto ${esc(fmtFecha(r.fecha_contacto))} · cuota ${esc(r.numero)}</option>`).join('')}${cuotas.map(q=>`<option value="q:${esc(q.id)}">Programar cuota ${esc(q.numero)} · vence ${esc(fmtFecha(q.fecha_vencimiento))}</option>`).join('')}</select></div>
      <div class="field"><label for="contactoAccion">Acción sobre un contacto existente</label><select id="contactoAccion"><option value="reprogramar">Reprogramar</option><option value="realizado">Registrar contacto realizado</option><option value="cancelar">Cancelar contacto</option></select></div>
      <div class="field"><label for="contactoFecha">Próximo contacto</label><input id="contactoFecha" type="date" min="${todayISO()}" value="${todayISO()}" /></div>
      <div class="field"><label for="contactoNota">Resultado, compromiso acordado u observaciones</label><textarea id="contactoNota" maxlength="2000"></textarea></div>
      <button class="btn btn-primary" id="guardarContacto" ${!pendientes.length&&!cuotas.length?'disabled':''}>Guardar contacto</button>
      <p>“Realizado” registra tu declaración de contacto; abrir WhatsApp no lo marca como enviado.</p>`);
    let busy=false,payload=null,requestTarget=null;
    const guardar=sheet.querySelector('#guardarContacto');
    guardar.addEventListener('click',async()=>{
      if(busy||!vigente())return;
      const destino=sheet.querySelector('#contactoDestino').value;
      const r=pendientes.find(r=>'r:'+r.id===destino);
      requestTarget||={suffix:r?'/'+encodeURIComponent(r.id):'',method:r?'PATCH':'POST'};
      payload||=r?{accion:sheet.querySelector('#contactoAccion').value,fecha:sheet.querySelector('#contactoFecha').value,nota:sheet.querySelector('#contactoNota').value,version:JSON.stringify([r.fecha_contacto,r.reprogramado_fecha,r.nota])}:{cuota_id:destino.slice(2),fecha:sheet.querySelector('#contactoFecha').value,nota:sheet.querySelector('#contactoNota').value,solicitud_id:crypto.randomUUID()};
      busy=true;guardar.disabled=true;
      try {await api(`/clientes/${encodeURIComponent(clienteId)}/contactos${requestTarget.suffix}?negocio_id=${encodeURIComponent(negocioId)}`,{method:requestTarget.method,body:JSON.stringify(payload)});if(vigente()){closeSheet();toast('Contacto guardado');render();}}
      catch(e){if(vigente()){toast(e.message,true);guardar.disabled=false;}if(e.status&&e.status<500){payload=null;requestTarget=null;}}finally{busy=false;}
    });
    sheet.querySelector('#guardarContactoModo')?.addEventListener('click',async e=>{
      if(busy||!vigente())return;busy=true;e.target.disabled=true;
      try{await api(`/clientes/${encodeURIComponent(clienteId)}/cobranza-modo?negocio_id=${encodeURIComponent(negocioId)}`,{method:'POST',body:JSON.stringify({modo:sheet.querySelector('#contactoModo').value,anterior:g?.modo||'revisar',nota:sheet.querySelector('#contactoModoNota').value})});if(vigente()){closeSheet();toast('Modo guardado');render();}}
      catch(err){if(vigente()){toast(err.message,true);e.target.disabled=false;}}finally{busy=false;}
    });
  }catch(e){if(vigente())setHTML(sheet,`<p>${esc(e.message)}</p>`);}
}
function historialContactosHtml(c,negocioId) {
  const rows=(c.contactosCobranza||[]).filter(r=>r.negocio_id===negocioId);
  if(!rows.length)return '';
  return `<details><summary>Contactos y compromisos (${rows.length})</summary>${rows.map(r=>`<div class="card"><strong>Cuota ${esc(r.numero)} · ${esc({pendiente:'Pendiente',realizado:'Realizado',cancelado:'Cancelado',cancelado_pago:'Cancelado por pago'}[r.estado]||r.estado)}</strong><p>Contacto: ${esc(fmtFecha(r.fecha_contacto))} · Vencimiento: ${esc(fmtFecha(r.vencimiento_actual||r.fecha_vencimiento_real))}</p><p>${esc(r.nota)}</p>${(r.historial||[]).map(h=>`<p>${esc(fmtFecha(h.fecha_hora))} · ${esc(h.autor||'Sistema')} · ${esc({programar:'Programado',reprogramar:'Reprogramado',realizado:'Contacto realizado',cancelar:'Cancelado',cancelado_pago:'Cuota saldada'}[h.accion]||h.accion)}: ${esc(h.motivo)}${h.accion==='reprogramar'?` · ${esc(fmtFecha(parseJsonSeguro(h.datos_anteriores).fecha_contacto))} → ${esc(fmtFecha(parseJsonSeguro(h.datos_nuevos).fecha_contacto))}`:''}</p>`).join('')}</div>`).join('')}</details>`;
}
