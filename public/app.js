'use strict';
// Vanilla SPA. All user-supplied text is inserted with textContent (never innerHTML), so it cannot inject markup.

// ---------- tiny helpers ----------
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (Array.isArray(c)) c.forEach(add); else if (c != null && c !== false) el.append(c instanceof Node ? c : String(c)); };
  kids.forEach(add);
  return el;
};
// Native replaceChildren stringifies arrays and null ("[object HTMLDivElement]", "null"); flatten and skip empties instead.
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) { return nativeReplace.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
const app = document.getElementById('app');
const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');
const label = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const badge = (s, kind = 'st') => h('span', { class: `badge ${kind}-${/^[A-Z_]+$/.test(s) ? s : 'X'}` }, label(s));
let toastTimer;
const toast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
};

class ApiErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiErr(0, 'Network problem. Check your connection and try again.'); }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && me && !url.includes('/auth/')) { me = null; renderNav(); go('#/login'); throw new ApiErr(401, 'Please sign in again'); }
  if (!res.ok) throw new ApiErr(res.status, data?.error || 'Something went wrong');
  return data;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

let me = null, meta = null;
const staff = () => me && (me.role === 'officer' || me.role === 'admin');
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// Run an async action on a button with a busy state and an inline error slot.
function act(btn, errBox, fn) {
  return async (e) => {
    e?.preventDefault();
    errBox.textContent = ''; btn.disabled = true;
    try { await fn(); } catch (err) { errBox.textContent = err.message; } finally { btn.disabled = false; }
  };
}
const field = (id, text, input, hint) => h('div', {}, h('label', { for: id }, text), input, hint && h('p', { class: 'hint', id: id + '-hint' }, hint));
const loading = () => { app.replaceChildren(h('div', { class: 'spinner', role: 'status' }, 'Loading…')); };
const fail = (e) => app.replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'err' }, e.message), h('button', { class: 'btn secondary', onclick: route }, 'Try again')));

// ---------- nav ----------
async function renderNav() {
  const nav = document.getElementById('nav');
  const cur = location.hash || '#/';
  const link = (href, text) => h('a', { href, 'aria-current': cur === href || (href !== '#/' && cur.startsWith(href + '/')) ? 'page' : null }, text);
  if (!me) return nav.replaceChildren(link('#/businesses', 'Browse businesses'), h('span', { class: 'spacer' }), link('#/login', 'Sign in'), link('#/register', 'Register'));
  const items = {
    citizen: [link('#/', 'My reports'), link('#/new', 'Report a problem'), link('#/businesses', 'Businesses'), link('#/inquiries', 'My inquiries'), link('#/complaints', 'Complaints')],
    entrepreneur: [link('#/', 'Home'), link('#/my-business', 'My business'), link('#/inquiries', 'Inquiries'), link('#/learn', 'Learn & grow'), link('#/calculator', 'Calculator'), link('#/complaints', 'Support')],
    officer: [link('#/', 'Dashboard'), link('#/reports', 'Reports'), link('#/map', 'Map')],
    admin: [link('#/', 'Dashboard'), link('#/reports', 'Reports'), link('#/map', 'Map'), link('#/admin/businesses', 'Businesses'), link('#/admin/complaints', 'Complaints'),
      link('#/admin/content', 'Content'), link('#/admin/users', 'Users'), link('#/admin/departments', 'Departments'), link('#/admin/categories', 'Categories'), link('#/admin/audit', 'Audit log')],
  }[me.role];
  const bell = h('a', { href: '#/notifications', 'aria-current': cur === '#/notifications' ? 'page' : null }, 'Notifications');
  nav.replaceChildren(...items, h('span', { class: 'spacer' }), bell, link('#/account', me.name),
    h('button', { onclick: async () => { await api('POST', '/api/auth/logout'); me = null; renderNav(); go('#/login'); } }, 'Sign out'));
  try {
    const n = await api('GET', '/api/notifications');
    if (n.unread) bell.textContent = `Notifications (${n.unread})`;
  } catch { /* ignore */ }
}

// ---------- auth ----------
function authView(mode) {
  const reg = mode === 'register';
  const err = h('p', { class: 'err', role: 'alert' });
  const name = h('input', { id: 'name', autocomplete: 'name', required: true });
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true, minlength: 8 });
  const kind = h('select', { id: 'kind' }, h('option', { value: 'citizen' }, 'Citizen / customer (report problems, find local businesses)'), h('option', { value: 'entrepreneur' }, 'Women entrepreneur (list my home business)'));
  const btn = h('button', { class: 'btn', type: 'submit' }, reg ? 'Create account' : 'Sign in');
  const form = h('form', { class: 'card narrow', onsubmit: act(btn, err, async () => {
    const r = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', { name: name.value, email: email.value, password: pw.value, role: reg ? kind.value : undefined });
    me = r.user; await renderNav(); go('#/');
  }) },
    h('h1', {}, reg ? 'Create an account' : 'Sign in'),
    reg && field('kind', 'I am joining as', kind, 'Business profiles are reviewed by an administrator before customers can see them.'),
    reg && field('name', 'Full name', name),
    field('email', 'Email', email),
    field('pw', 'Password', pw, reg ? 'At least 8 characters.' : null),
    reg && h('p', { class: 'hint' }, 'By creating an account you accept the ', h('a', { href: '#/privacy' }, 'privacy notice'), '.'),
    err, btn,
    h('p', {}, reg ? 'Already registered? ' : 'New here? ', h('a', { href: reg ? '#/login' : '#/register' }, reg ? 'Sign in' : 'Create an account')),
    !reg && h('p', {}, meta.channels.email ? h('a', { href: '#/forgot' }, 'Forgot your password?') : 'Forgot your password? Ask an administrator to reset it for you.'));
  app.replaceChildren(form);
  (reg ? name : email).focus();
}

// ---------- shared: report list ----------
function pager(state, total, reload) {
  const pages = Math.max(1, Math.ceil(total / state.limit));
  return h('div', { class: 'pager' },
    h('button', { class: 'btn secondary', disabled: state.page <= 1, onclick: () => { state.page--; reload(); } }, 'Previous'),
    h('span', {}, `Page ${state.page} of ${pages} (${total} reports)`),
    h('button', { class: 'btn secondary', disabled: state.page >= pages, onclick: () => { state.page++; reload(); } }, 'Next'));
}
const place = (r) => r.address || (r.lat != null ? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : '—');

async function reportsView(opts = {}) {
  const state = { page: 1, limit: 20 };
  const f = {};
  const mk = (id, text, input) => { f[id] = input; return field('f-' + id, text, input); };
  const sel = (id, options) => h('select', { id: 'f-' + id }, h('option', { value: '' }, 'All'), options.map(([v, t]) => h('option', { value: v }, t)));
  const filters = [
    mk('q', 'Search', h('input', { id: 'f-q', type: 'search', placeholder: 'Tracking no., title, address' })),
    mk('status', 'Status', sel('status', meta.statuses.map((s) => [s, label(s)]))),
  ];
  if (staff()) {
    filters.push(mk('priority', 'Priority', sel('priority', meta.priorities.map((p) => [p, label(p)]))));
    filters.push(mk('category_id', 'Category', sel('category_id', meta.categories.map((c) => [c.id, c.name]))));
    filters.push(mk('assigned_to', 'Assignment', sel('assigned_to', [['me', 'Assigned to me'], ['unassigned', 'Unassigned']])));
    if (me.role === 'admin') {
      const depts = (await api('GET', '/api/admin/departments')).items;
      filters.push(mk('department_id', 'Department', sel('department_id', depts.map((d) => [d.id, d.name]))));
    }
    filters.push(mk('overdue', 'Overdue only', h('select', { id: 'f-overdue' }, h('option', { value: '' }, 'No'), h('option', { value: '1' }, 'Yes'))));
  }
  filters.push(mk('sort', 'Sort by', h('select', { id: 'f-sort' }, [['created_at', 'Submitted'], ['updated_at', 'Last updated'], ['due_at', 'Due date'], ['priority', 'Priority'], ['status', 'Status']].map(([v, t]) => h('option', { value: v }, t)))));
  filters.push(mk('order', 'Order', h('select', { id: 'f-order' }, h('option', { value: 'desc' }, 'Newest / highest first'), h('option', { value: 'asc' }, 'Oldest / lowest first'))));
  if (opts.preset) for (const [k, v] of Object.entries(opts.preset)) if (f[k]) {
    f[k].value = v;
    if (f[k].value !== v && f[k].tagName === 'SELECT') { f[k].append(h('option', { value: v }, k === 'status' ? v.split(',').map(label).join(' / ') : v)); f[k].value = v; }
  }
  const out = h('div', { 'aria-live': 'polite' });
  async function load() {
    out.replaceChildren(h('div', { class: 'spinner', role: 'status' }, 'Loading…'));
    const q = { page: state.page, limit: state.limit };
    for (const [k, el] of Object.entries(f)) q[k] = el.value;
    try {
      const d = await api('GET', '/api/reports?' + qs(q));
      if (!d.items.length) return out.replaceChildren(h('div', { class: 'card empty' },
        h('p', {}, 'No reports match.'), !staff() && h('a', { class: 'btn', href: '#/new' }, 'Report a problem')));
      const rows = d.items.map((r) => h('tr', { class: r.overdue ? 'overdue' : null },
        h('td', {}, h('a', { href: `#/reports/${r.id}` }, r.tracking_no), r.overdue && h('div', { class: 'err' }, 'Overdue')),
        h('td', {}, r.category), h('td', {}, place(r)), h('td', {}, fmt(r.created_at)), h('td', {}, badge(r.status)),
        h('td', {}, badge(r.priority, 'pr')),
        staff() && h('td', {}, [r.assignee || 'Unassigned', r.department && h('div', { class: 'hint' }, r.department)]), h('td', {}, fmt(r.updated_at))));
      const head = ['Tracking no.', 'Category', 'Location', 'Submitted', 'Status', 'Priority', staff() && 'Assigned', 'Last updated'];
      out.replaceChildren(
        h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('caption', { class: 'hint' }, 'Reports'),
          h('thead', {}, h('tr', {}, head.map((t) => t && h('th', { scope: 'col' }, t)))), h('tbody', {}, rows))),
        h('div', { class: 'cards' }, d.items.map((r) => h('a', { class: 'rcard', href: `#/reports/${r.id}` },
          h('b', {}, r.tracking_no), ' ', badge(r.status), ' ', badge(r.priority, 'pr'), r.overdue && h('span', { class: 'err' }, ' Overdue'),
          h('div', {}, r.title), h('div', { class: 'hint' }, `${r.category} · ${place(r)} · ${fmt(r.created_at)}`)))),
        pager(state, d.total, load));
    } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
  }
  const apply = h('button', { class: 'btn', type: 'submit' }, 'Apply filters');
  app.replaceChildren(
    h('h1', {}, opts.title || (staff() ? 'Reports' : 'My reports')),
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); state.page = 1; load(); } },
      h('div', { class: 'row' }, filters, apply)),
    out);
  load();
}

// ---------- dashboards ----------
const stat = (n, text, alert, href) => h(href ? 'a' : 'div', { class: 'stat' + (alert && n ? ' alert' : ''), href },
  h('b', {}, n ?? '—'), h('span', {}, text));
const bars = (rows, key, title) => {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return h('div', { class: 'card' }, h('h2', {}, title), rows.length ? h('div', { class: 'bars' }, rows.map((r) =>
    { const i = h('i'); i.style.width = Math.round((r.n / max) * 100) + '%'; return h('div', {}, h('span', {}, key === 'category' ? r[key] : label(r[key])), i, String(r.n)); })) : h('p', { class: 'hint' }, 'No data yet.'));
};
const hours = (v) => (v == null ? 'No resolved reports yet' : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} days`);

async function dashboardView() {
  loading();
  const d = await api('GET', '/api/dashboard');
  const a = me.role === 'admin' ? await api('GET', '/api/admin/analytics') : null;
  const base = '#/reports?';
  app.replaceChildren(
    h('h1', {}, me.role === 'admin' ? 'Operations overview' : 'Your dashboard'),
    h('div', { class: 'grid' },
      stat(d.assigned_to_me, 'Assigned to me (open)', false, '#/reports?assigned_to=me'),
      stat(d.awaiting_review, 'Awaiting review', false, base + 'status=SUBMITTED,UNDER_REVIEW'),
      stat(d.awaiting_assignment, 'Accepted, unassigned', false, base + 'status=ACCEPTED'),
      stat(d.in_progress, 'In progress', false, base + 'status=ASSIGNED,IN_PROGRESS'),
      stat(d.overdue, 'Overdue', true, base + 'overdue=1'),
      stat(d.resolved, 'Resolved / closed'), stat(d.rejected, 'Rejected'), stat(d.total, 'Total in scope'),
      stat(d.resolution_rate == null ? '—' : Math.round(d.resolution_rate * 100) + '%', 'Resolution rate'),
      stat(hours(d.avg_resolution_hours), 'Avg. time to resolve')),
    h('p', { class: 'hint' }, 'Resolution rate = resolved ÷ (all − rejected). Time to resolve runs from submission to the latest resolution.'),
    h('div', { class: 'grid' }, bars(d.by_category, 'category', 'Reports by category'), bars(d.by_priority, 'priority', 'Open reports by priority')),
    h('div', { class: 'card' }, h('h2', {}, 'Workload'), d.workload.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Officer', 'Open', 'Overdue'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.workload.map((w) => h('tr', {}, h('td', {}, w.name), h('td', {}, String(w.open)), h('td', {}, String(w.overdue))))))) : h('p', { class: 'hint' }, 'No officers to show.')),
    a && h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h2', {}, 'Busiest areas (~1 km grid)'), a.by_area.length ? h('ul', {}, a.by_area.map((x) => h('li', {}, `${x.lat}, ${x.lng}: ${x.n}`))) : h('p', { class: 'hint' }, 'No located reports yet.')),
      h('div', { class: 'card' }, h('h2', {}, 'Repeated reports (same category, ~100 m)'), a.repeated_locations.length ? h('ul', {}, a.repeated_locations.map((x) => h('li', {}, `${x.category} near ${x.lat}, ${x.lng}: ${x.n}`))) : h('p', { class: 'hint' }, 'None detected.')),
      h('div', { class: 'card' }, h('h2', {}, 'Citizen feedback'), h('p', {}, a.feedback.n ? `${a.feedback.avg.toFixed(1)} / 5 from ${a.feedback.n} responses` : 'No feedback yet.'))),
    a && platformCards(a.platform),
    me.role === 'admin' && h('div', { class: 'card' }, h('h2', {}, 'Export'), h('p', { class: 'hint' }, 'Downloads all reports as CSV (recorded in the audit log).'),
      h('a', { class: 'btn secondary', href: '/api/admin/export.csv', download: 'reports.csv' }, 'Download CSV')),
    h('h2', {}, 'Recently updated'),
    d.recent.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, d.recent.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `#/reports/${r.id}` }, r.tracking_no)), h('td', {}, r.title), h('td', {}, badge(r.status)), h('td', {}, fmt(r.updated_at)))))))
      : h('div', { class: 'card empty' }, 'No reports in your scope yet.'));
}

async function citizenHome() { return reportsView({ title: 'My reports' }); }

// ---------- map ----------
let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((res, rej) => {
    const s = h('script', { src: '/vendor/leaflet/leaflet.js' });
    s.onload = () => res(window.L); s.onerror = () => rej(new Error('Map library unavailable'));
    document.head.append(s);
  });
  return leafletPromise;
}
async function makeMap(el, center = [20.59, 78.96], zoom = 5) {
  const L = await loadLeaflet();
  const m = L.map(el).setView(center, zoom);
  L.tileLayer(meta.map.tile_url, { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: meta.map.tile_attribution }).addTo(m);
  return { L, m };
}
async function mapView() {
  const el = h('div', { class: 'map', role: 'application', 'aria-label': 'Map of reports' });
  el.style.height = '65vh';
  const status = h('select', { id: 'm-status', onchange: draw }, h('option', { value: '' }, 'All statuses'), meta.statuses.map((s) => h('option', { value: s }, label(s))));
  const cat = h('select', { id: 'm-cat', 'aria-label': 'Category', onchange: draw }, h('option', { value: '' }, 'All categories'), meta.categories.map((c) => h('option', { value: c.id }, c.name)));
  const note = h('p', { class: 'hint' });
  app.replaceChildren(h('h1', {}, 'Report map'), h('div', { class: 'row' }, field('m-status', 'Status', status), field('m-cat', 'Category', cat)), note, el);
  let L, m, layer;
  try { ({ L, m } = await makeMap(el)); } catch (e) { el.replaceWith(h('p', { class: 'err' }, 'The map could not be loaded. Use the Reports list instead.')); return; }
  async function draw() {
    const d = await api('GET', '/api/reports/markers?' + qs({ status: status.value, category_id: cat.value }));
    layer?.remove();
    layer = L.layerGroup().addTo(m);
    d.items.forEach((r) => {
      const a = h('a', { href: `#/reports/${r.id}` }, r.tracking_no);
      L.marker([r.lat, r.lng]).bindPopup(h('div', {}, a, h('div', {}, r.title), h('div', {}, `${r.category} · ${label(r.status)}`))).addTo(layer);
    });
    note.textContent = d.items.length ? `${d.items.length} located reports` : 'No located reports match.';
    if (d.items.length) m.fitBounds(L.latLngBounds(d.items.map((r) => [r.lat, r.lng])).pad(0.2), { maxZoom: 15 });
  }
  draw().catch((e) => { note.textContent = e.message; });
}

// ---------- new report ----------
function newReportView() {
  const err = h('p', { class: 'err', role: 'alert' });
  const src = h('input', { type: 'hidden', id: 'src', value: 'manual' });
  const cat = h('select', { id: 'cat', required: true }, h('option', { value: '' }, 'Choose a category…'), meta.categories.map((c) => h('option', { value: c.id }, c.name)));
  const title = h('input', { id: 'title', required: true, minlength: 5, maxlength: 120 });
  const desc = h('textarea', { id: 'desc', required: true, minlength: 10, maxlength: 2000 });
  const addr = h('input', { id: 'addr', maxlength: 300, autocomplete: 'street-address' });
  const lat = h('input', { id: 'lat', inputmode: 'decimal', placeholder: 'e.g. 12.9716' });
  const lng = h('input', { id: 'lng', inputmode: 'decimal', placeholder: 'e.g. 77.5946' });
  const photos = h('input', { id: 'photos', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, required: true });
  const locNote = h('p', { class: 'hint', role: 'status' }, 'No coordinates yet. You can describe the place in words instead.');
  const mapEl = h('div', { class: 'map', role: 'application', 'aria-label': 'Map: click to mark the problem location' });
  let marker, map, L;
  const setPoint = (la, ln, source, text) => {
    lat.value = (+la).toFixed(6); lng.value = (+ln).toFixed(6); src.value = source; locNote.textContent = text;
    if (map) { marker ? marker.setLatLng([la, ln]) : (marker = L.marker([la, ln]).addTo(map)); }
  };
  const geoBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => {
    if (!navigator.geolocation) return (locNote.textContent = 'Your browser cannot share its location. Click the map or type the address.');
    locNote.textContent = 'Asking your device for its location…';
    navigator.geolocation.getCurrentPosition(
      (p) => { setPoint(p.coords.latitude, p.coords.longitude, 'device', `Location taken from your device (accuracy about ${Math.round(p.coords.accuracy)} m). This is not verified.`); map?.setView([p.coords.latitude, p.coords.longitude], 17); },
      () => { locNote.textContent = 'Location permission was denied or unavailable. Click the map or type the address instead.'; },
      { enableHighAccuracy: true, timeout: 15000 });
  } }, 'Use my current location');
  const manual = () => { if (lat.value && lng.value) { src.value = 'manual'; locNote.textContent = 'Coordinates entered manually.'; if (marker && map && isFinite(lat.value) && isFinite(lng.value)) marker.setLatLng([+lat.value, +lng.value]); } };
  lat.addEventListener('change', manual); lng.addEventListener('change', manual);
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Submit report');
  const form = h('form', { class: 'card', novalidate: false, onsubmit: act(btn, err, async () => {
    const f = new FormData();
    f.append('category_id', cat.value); f.append('title', title.value); f.append('description', desc.value); f.append('address', addr.value);
    if (lat.value || lng.value) { f.append('lat', lat.value); f.append('lng', lng.value); f.append('location_source', src.value); }
    [...photos.files].slice(0, 3).forEach((p) => f.append('images', p));
    const r = await api('POST', '/api/reports', f);
    toast('Report submitted');
    app.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Thank you. Your report was submitted.'),
      h('p', {}, 'Your tracking number is ', h('b', {}, r.tracking_no), '. Keep it for your records.'),
      h('a', { class: 'btn', href: `#/reports/${r.id}` }, 'View report'), ' ', h('a', { class: 'btn secondary', href: '#/' }, 'My reports')));
  }) },
    h('h1', {}, 'Report a problem'),
    field('cat', 'What kind of problem is it?', cat),
    field('title', 'Short title', title, '5 to 120 characters, for example “Deep pothole outside the school”.'),
    field('desc', 'Describe the problem', desc, 'What is damaged, how big is it, and is it dangerous?'),
    field('photos', 'Photos (1 to 3)', photos, 'JPEG, PNG or WebP. Large files are rejected by the server.'),
    h('h2', {}, 'Where is it?'),
    h('div', { class: 'row' }, geoBtn), locNote, mapEl,
    field('addr', 'Address or landmark', addr, 'Required if you do not mark a point on the map.'),
    h('div', { class: 'row' }, field('lat', 'Latitude (optional)', lat), field('lng', 'Longitude (optional)', lng)),
    src, err, btn);
  app.replaceChildren(form);
  makeMap(mapEl).then((r) => {
    ({ L, m: map } = r);
    map.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng, 'map', 'Location chosen on the map.'));
  }).catch(() => { mapEl.replaceWith(h('p', { class: 'hint' }, 'The map is unavailable. Type the address or coordinates instead.')); });
}

// ---------- report detail ----------
const NEXT = {
  SUBMITTED: 'Waiting for staff to review your report. You can still edit it.',
  UNDER_REVIEW: 'Staff are reviewing your report.',
  ACCEPTED: 'Your report was accepted and is waiting to be assigned to a crew.',
  ASSIGNED: 'A team has been assigned and will start work soon.',
  IN_PROGRESS: 'Work is under way.',
  RESOLVED: 'Marked as fixed. If the problem is still there, you can reopen it, and you can leave feedback.',
  REOPENED: 'You reopened this report. Staff will pick it up again.',
  REJECTED: 'This report was not accepted. See the reason in the history below.',
  CLOSED: 'This report is closed. Thank you.',
};

async function detailView(id) {
  loading();
  const r = await api('GET', `/api/reports/${id}`);
  const reload = () => detailView(id);
  const A = r.actions;
  const photos = (kind) => r.images.filter((i) => i.kind === kind).map((i) => h('a', { href: i.url, target: '_blank', rel: 'noopener' }, h('img', { src: i.url, alt: `${kind === 'resolution' ? 'Resolution' : 'Report'} photo`, loading: 'lazy' })));
  const mapEl = r.lat != null ? h('div', { class: 'map' }) : null;
  const srcText = { device: 'taken from the reporter’s device (not verified)', map: 'chosen on a map', manual: 'entered manually' }[r.location_source];

  function form(title, buildFields, submitText, onSubmit, cls = '') {
    const err = h('p', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn ' + cls, type: 'submit' }, submitText);
    return h('form', { class: 'card', onsubmit: act(btn, err, async () => { await onSubmit(); reload(); }) }, h('h2', {}, title), buildFields, err, btn);
  }
  const post = (p, body) => api('POST', `/api/reports/${id}/${p}`, body);
  const panels = [];

  if (me.role === 'citizen') {
    if (A.edit) {
      const t = h('input', { id: 'e-title', value: r.title, maxlength: 120 }), d = h('textarea', { id: 'e-desc' }, r.description), a = h('input', { id: 'e-addr', value: r.address, maxlength: 300 });
      panels.push(form('Edit your report', [field('e-title', 'Title', t), field('e-desc', 'Description', d), field('e-addr', 'Address', a)], 'Save changes',
        async () => { await api('PATCH', `/api/reports/${id}`, { title: t.value, description: d.value, address: a.value }); toast('Saved'); }));
    }
    if (A.reopen) {
      const n = h('textarea', { id: 'ro', required: true, maxlength: 1000 });
      panels.push(form('Problem still there?', field('ro', 'Tell us what is still wrong', n), 'Reopen report', async () => { await post('status', { to: 'REOPENED', note: n.value }); toast('Report reopened'); }, 'danger'));
    }
    if (A.feedback) {
      const rt = h('select', { id: 'fb' }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${n} out of 5`)));
      const c = h('textarea', { id: 'fbc', maxlength: 1000 });
      panels.push(form('How did we do?', [field('fb', 'Rating', rt), field('fbc', 'Comments (optional)', c)], 'Send feedback', async () => { await post('feedback', { rating: +rt.value, comment: c.value }); toast('Thank you for your feedback'); }));
    }
  } else {
    if (A.transitions.length) {
      const note = h('textarea', { id: 's-note', maxlength: 1000 });
      const to = h('select', { id: 's-to' }, A.transitions.map((s) => h('option', { value: s }, label(s))));
      panels.push(form('Update status', [field('s-to', 'Move to', to), field('s-note', 'Note shown to the citizen', note, 'Required for Rejected, Resolved and Reopened.')], 'Update status', async () => {
        if (['REJECTED', 'CLOSED'].includes(to.value) && !confirm(`Set this report to ${label(to.value)}? This cannot be undone.`)) throw new Error('Cancelled');
        await post('status', { to: to.value, note: note.value, expected_status: r.status }); toast('Status updated');
      }));
    }
    if (A.assign) {
      const list = (await api('GET', '/api/officers' + (r.department_id ? '?department_id=' + r.department_id : ''))).items;
      const who = h('select', { id: 'as' }, list.map((o) => h('option', { value: o.id }, o.name + (o.department ? ` (${o.department})` : ''))));
      const n = h('input', { id: 'as-n', maxlength: 1000 });
      panels.push(form(r.assignee ? 'Reassign' : 'Assign', [field('as', 'Officer', who), field('as-n', 'Internal note (optional)', n)], 'Assign', async () => { await post('assign', { assignee_id: +who.value, note: n.value }); toast('Assigned'); }));
    }
    if (A.priority) {
      const p = h('select', { id: 'pr' }, meta.priorities.map((x) => h('option', { value: x, selected: x === r.priority }, label(x))));
      panels.push(form('Priority', field('pr', 'Priority', p), 'Set priority', async () => { await api('PATCH', `/api/reports/${id}/priority`, { priority: p.value }); toast('Priority updated'); }));
    }
    if (A.remark) {
      const b = h('textarea', { id: 'rm', required: true, maxlength: 1000 });
      const v = h('select', { id: 'rm-v' }, h('option', { value: 'internal' }, 'Internal remark (staff only)'), h('option', { value: 'public' }, 'Public progress update (citizen sees it)'));
      panels.push(form('Add a remark', [field('rm', 'Text', b), field('rm-v', 'Visibility', v)], 'Add', async () => { await post('remarks', { body: b.value, visibility: v.value }); toast('Added'); }));
    }
    if (A.resolution_image) {
      const fi = h('input', { id: 'ri', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, required: true });
      panels.push(form('Resolution photos', field('ri', 'Photos of the completed work (up to 3 at a time)', fi), 'Upload', async () => {
        const f = new FormData(); [...fi.files].slice(0, 3).forEach((p) => f.append('images', p)); await api('POST', `/api/reports/${id}/images`, f); toast('Uploaded');
      }));
    }
  }

  app.replaceChildren(
    h('p', {}, h('a', { href: staff() ? '#/reports' : '#/' }, '← Back')),
    h('div', { class: 'card' },
      h('h1', {}, r.title), h('p', {}, h('b', {}, r.tracking_no), ' ', badge(r.status), ' ', badge(r.priority, 'pr'), r.overdue && h('span', { class: 'err' }, ' Overdue')),
      me.role === 'citizen' && h('p', { class: 'next' }, NEXT[r.status]),
      h('p', {}, r.description),
      h('dl', {}, [['Category', r.category], ['Department', r.department || 'Not yet routed'], ['Location', r.address || 'See map'],
        r.lat != null && ['Coordinates', `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} (${srcText})`],
        ['Submitted', fmt(r.created_at)], ['Target date', fmt(r.due_at)], ['Last updated', fmt(r.updated_at)], r.resolved_at && ['Resolved', fmt(r.resolved_at)],
        staff() && ['Reporter', r.reporter], staff() && ['Assigned to', r.assignee || 'Unassigned']].filter(Boolean)
        .flatMap(([k, v]) => [h('dt', { class: 'hint' }, k), h('dd', {}, v)])),
      r.resolution_note && h('div', { class: 'next' }, h('b', {}, 'Resolution: '), r.resolution_note)),
    r.images.length ? h('div', { class: 'card' }, h('h2', {}, 'Photos'), h('div', { class: 'photos' }, photos('report')),
      r.images.some((i) => i.kind === 'resolution') && [h('h2', {}, 'Resolution evidence'), h('div', { class: 'photos' }, photos('resolution'))]) : null,
    mapEl,
    ...panels,
    h('div', { class: 'card' }, h('h2', {}, 'History'), h('ol', { class: 'timeline' }, r.events.slice().reverse().map((e) => h('li', { class: e.visibility === 'internal' ? 'internal' : null },
      h('b', {}, e.type === 'status' ? `${e.from_value ? label(e.from_value) + ' → ' : ''}${label(e.to_value)}`
        : e.type === 'assign' ? `Assigned: ${e.from_value || 'nobody'} → ${e.to_value}`
          : e.type === 'priority' ? `Priority: ${label(e.from_value)} → ${label(e.to_value)}` : e.type === 'edit' ? 'Edited' : 'Remark'),
      e.visibility === 'internal' && h('span', { class: 'badge st-UNDER_REVIEW' }, 'Internal'),
      e.note && h('div', {}, e.note), h('small', {}, `${e.actor || 'System'} · ${fmt(e.created_at)}`)))),
    r.feedback && h('p', { class: 'hint' }, `Citizen feedback: ${r.feedback.rating}/5${r.feedback.comment ? ' – ' + r.feedback.comment : ''}`)));
  if (mapEl) makeMap(mapEl, [r.lat, r.lng], 16).then(({ L, m }) => L.marker([r.lat, r.lng]).addTo(m)).catch(() => mapEl.replaceWith(h('p', { class: 'hint' }, 'Map unavailable.')));
}

// ---------- notifications / account ----------
async function notificationsView() {
  loading();
  const d = await api('GET', '/api/notifications');
  const mark = h('button', { class: 'btn secondary', onclick: async () => { await api('POST', '/api/notifications/read-all'); await renderNav(); notificationsView(); } }, 'Mark all as read');
  app.replaceChildren(h('h1', {}, 'Notifications'), d.unread ? mark : null,
    d.items.length ? h('ul', { class: 'timeline' }, d.items.map((n) => h('li', {}, n.read_at ? null : h('b', {}, 'New · '),
      (n.link || n.report_id) ? h('a', { href: n.link || `#/reports/${n.report_id}`, onclick: () => api('POST', `/api/notifications/${n.id}/read`) }, n.message) : n.message, h('br'), h('small', {}, fmt(n.created_at)))))
      : h('div', { class: 'card empty' }, 'No notifications yet.'));
}
function accountView() {
  const err = h('p', { class: 'err', role: 'alert' });
  const name = h('input', { id: 'an', value: me.name }), cur = h('input', { id: 'cp', type: 'password', autocomplete: 'current-password' }), np = h('input', { id: 'np', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const phone = h('input', { id: 'aph', type: 'tel', autocomplete: 'tel', placeholder: '+919876543210', value: me.phone || '' });
  const em = h('input', { id: 'aem', type: 'checkbox', checked: me.notify_email, disabled: !meta.channels.email });
  const sm = h('input', { id: 'asm', type: 'checkbox', checked: me.notify_sms, disabled: !meta.channels.sms });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save');
  app.replaceChildren(h('form', { class: 'card narrow', onsubmit: act(btn, err, async () => {
    const body = { name: name.value, phone: phone.value, notify_email: em.checked, notify_sms: sm.checked };
    if (np.value) { body.new_password = np.value; body.current_password = cur.value; }
    me = (await api('PATCH', '/api/auth/me', body)).user; cur.value = np.value = ''; renderNav(); toast('Profile saved');
  }) }, h('h1', {}, 'My account'), h('p', { class: 'hint' }, `${me.email} · ${label(me.role)}${meta.channels.email ? (me.email_verified ? ' · email verified' : ' · email not verified') : ''}`), field('an', 'Name', name),
  h('h2', {}, 'Notifications'), h('p', { class: 'hint' }, 'In-app notifications are always on.'),
  field('aph', 'Mobile number (international format)', phone, 'Needed only for text messages.'),
  h('div', {}, h('label', { for: 'aem' }, 'Email me about updates'), em, !meta.channels.email && h('p', { class: 'hint' }, 'Email is not enabled on this server yet.')),
  h('div', {}, h('label', { for: 'asm' }, 'Text me about updates'), sm, !meta.channels.sms && h('p', { class: 'hint' }, 'Text messages are not enabled on this server yet.')),
  h('h2', {}, 'Change password'), field('cp', 'Current password', cur), field('np', 'New password', np, 'Changing it signs out your other devices.'), err, btn));
}

// ---------- admin ----------
function table(heads, rows, empty) {
  return rows.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows)))
    : h('div', { class: 'card empty' }, empty);
}
async function usersView() {
  loading();
  const [u, d] = await Promise.all([api('GET', '/api/admin/users?limit=100'), api('GET', '/api/admin/departments')]);
  const deptSel = (id, val) => h('select', { id, 'aria-label': 'Department' }, h('option', { value: '' }, 'No department'), d.items.map((x) => h('option', { value: x.id, selected: x.id === val }, x.name)));
  const err = h('p', { class: 'err', role: 'alert' });
  const f = { name: h('input', { id: 'nu-n', required: true }), email: h('input', { id: 'nu-e', type: 'email', required: true }), pw: h('input', { id: 'nu-p', type: 'text', required: true, minlength: 8, autocomplete: 'off' }),
    role: h('select', { id: 'nu-r' }, ['officer', 'admin', 'citizen', 'entrepreneur'].map((r) => h('option', { value: r }, label(r)))), dept: deptSel('nu-d'), lead: h('input', { id: 'nu-l', type: 'checkbox' }) };
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Create account');
  const save = async (id, body, msg) => { try { await api('PATCH', `/api/admin/users/${id}`, body); toast(msg || 'Saved'); usersView(); } catch (e) { toast(e.message); } };
  app.replaceChildren(h('h1', {}, 'Users'),
    h('form', { class: 'card', onsubmit: act(btn, err, async () => {
      await api('POST', '/api/admin/users', { name: f.name.value, email: f.email.value, password: f.pw.value, role: f.role.value, department_id: f.dept.value || null, can_assign: f.lead.checked });
      toast('Account created'); usersView();
    }) }, h('h2', {}, 'Create staff account'), h('p', { class: 'hint' }, 'Share the temporary password with the person securely; ask them to change it after signing in.'),
    h('div', { class: 'row' }, field('nu-n', 'Name', f.name), field('nu-e', 'Email', f.email), field('nu-p', 'Temporary password', f.pw)),
    h('div', { class: 'row' }, field('nu-r', 'Role', f.role), field('nu-d', 'Department', f.dept), h('div', {}, h('label', { for: 'nu-l' }, 'Team lead (can assign)'), f.lead)), err, btn),
    table(['Name', 'Email', 'Role', 'Department', 'Lead', 'Status', 'Actions'], u.items.map((x) => {
      const isMe = x.id === me.id;
      return h('tr', {}, h('td', {}, x.name), h('td', {}, x.email),
        h('td', {}, h('select', { 'aria-label': `Role for ${x.name}`, disabled: isMe, onchange: (e) => confirm(`Change ${x.name} to ${e.target.value}? Their sessions will end.`) ? save(x.id, { role: e.target.value }) : usersView() },
          ['citizen', 'entrepreneur', 'officer', 'admin'].map((r) => h('option', { value: r, selected: r === x.role }, label(r))))),
        h('td', {}, h('select', { 'aria-label': `Department for ${x.name}`, onchange: (e) => save(x.id, { department_id: e.target.value || null }) }, h('option', { value: '' }, '—'), d.items.map((dd) => h('option', { value: dd.id, selected: dd.id === x.department_id }, dd.name)))),
        h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Team lead: ${x.name}`, checked: x.can_assign, onchange: (e) => save(x.id, { can_assign: e.target.checked }) })),
        h('td', {}, x.active ? 'Active' : h('b', { class: 'err' }, 'Disabled')),
        h('td', {}, isMe ? 'You' : [h('button', { class: 'btn secondary', onclick: () => confirm(`${x.active ? 'Deactivate' : 'Reactivate'} ${x.name}?`) && save(x.id, { active: !x.active }) }, x.active ? 'Deactivate' : 'Reactivate'), ' ',
          h('button', { class: 'btn secondary', onclick: () => { const p = prompt(`New temporary password for ${x.name} (8+ characters):`); if (p) save(x.id, { password: p }, 'Password reset'); } }, 'Reset password')]));
    }), 'No users.'));
}
async function departmentsView() {
  loading();
  const d = await api('GET', '/api/admin/departments');
  const err = h('p', { class: 'err', role: 'alert' }), name = h('input', { id: 'dn', required: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Add department');
  app.replaceChildren(h('h1', {}, 'Departments'),
    h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('POST', '/api/admin/departments', { name: name.value }); toast('Added'); departmentsView(); }) }, field('dn', 'New department name', name), err, btn),
    table(['Name', 'Users', 'Categories', 'Actions'], d.items.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, String(x.users)), h('td', {}, String(x.categories)),
      h('td', {}, h('button', { class: 'btn secondary', onclick: async () => { const n = prompt('Rename department', x.name); if (n) try { await api('PATCH', `/api/admin/departments/${x.id}`, { name: n }); departmentsView(); } catch (e) { toast(e.message); } } }, 'Rename'), ' ',
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete department "${x.name}"?`)) try { await api('DELETE', `/api/admin/departments/${x.id}`); departmentsView(); } catch (e) { toast(e.message); } } }, 'Delete')))),
    'No departments yet. Create one, then assign categories and officers to it so reports are routed.'));
}
async function categoriesView() {
  loading();
  const [c, d] = await Promise.all([api('GET', '/api/admin/categories'), api('GET', '/api/admin/departments')]);
  const err = h('p', { class: 'err', role: 'alert' });
  const name = h('input', { id: 'cn', required: true }), sla = h('input', { id: 'cs', type: 'number', min: 1, max: 8760, value: 72 });
  const dep = h('select', { id: 'cd' }, h('option', { value: '' }, 'None'), d.items.map((x) => h('option', { value: x.id }, x.name)));
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Add category');
  const patch = async (id, body) => { try { await api('PATCH', `/api/admin/categories/${id}`, body); categoriesView(); } catch (e) { toast(e.message); } };
  app.replaceChildren(h('h1', {}, 'Categories'),
    h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('POST', '/api/admin/categories', { name: name.value, department_id: dep.value || null, sla_hours: +sla.value }); categoriesView(); }) },
      h('div', { class: 'row' }, field('cn', 'Name', name), field('cd', 'Handling department', dep), field('cs', 'Target hours to resolve', sla)), err, btn),
    table(['Name', 'Department', 'Target (h)', 'Active'], c.items.map((x) => h('tr', {}, h('td', {}, x.name),
      h('td', {}, h('select', { 'aria-label': `Department for ${x.name}`, onchange: (e) => patch(x.id, { department_id: e.target.value || null }) }, h('option', { value: '' }, '—'), d.items.map((dd) => h('option', { value: dd.id, selected: dd.id === x.department_id }, dd.name)))),
      h('td', {}, h('input', { type: 'number', min: 1, value: x.sla_hours, 'aria-label': `Target hours for ${x.name}`, onchange: (e) => patch(x.id, { sla_hours: +e.target.value }) })),
      h('td', {}, h('input', { type: 'checkbox', checked: x.active, 'aria-label': `Active: ${x.name}`, onchange: (e) => patch(x.id, { active: e.target.checked }) })))), 'No categories.'));
}
async function auditView(page = 1) {
  loading();
  const d = await api('GET', `/api/admin/audit?page=${page}`);
  const st = { page, limit: d.limit };
  app.replaceChildren(h('h1', {}, 'Audit log'), h('p', {}, h('a', { href: '#/admin/deliveries' }, 'Email and SMS delivery log')),
    table(['When', 'Who', 'Action', 'Target', 'Detail'], d.items.map((a) => h('tr', {}, h('td', {}, fmt(a.created_at)), h('td', {}, a.actor || 'System'), h('td', {}, a.action),
      h('td', {}, a.entity ? `${a.entity} #${a.entity_id ?? ''}` : ''), h('td', {}, a.detail || ''))), 'Nothing recorded yet.'),
    pager(st, d.total, () => auditView(st.page)));
}

// ---------- marketplace: shared bits ----------
// Renders admin-authored text safely: blank-line separated paragraphs, and "- " lines as bullet lists.
function richText(body) {
  const out = [];
  let list = null;
  for (const line of String(body).split('\n')) {
    if (line.startsWith('- ')) { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', {}, line.slice(2))); }
    else { list = null; if (line.trim()) out.push(h('p', {}, line)); }
  }
  return out;
}
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const ratingText = (avg, count) => (count ? `${stars(Math.round(avg))} ${avg} (${count})` : 'No ratings yet');

// Map + "use my location" + manual coordinates. Call init() after the element is in the page.
function locationPicker(la, ln) {
  const lat = h('input', { id: 'blat', inputmode: 'decimal', value: la ?? '' }), lng = h('input', { id: 'blng', inputmode: 'decimal', value: ln ?? '' });
  const note = h('p', { class: 'hint', role: 'status' }, 'Optional. Lets customers find you with "near me" search. Choose a nearby point rather than your front door: it is stored to about 100 m.');
  const mapEl = h('div', { class: 'map', role: 'application', 'aria-label': 'Map: click to set your business area' });
  let map, marker, L;
  const set = (a, b, text) => {
    lat.value = (+a).toFixed(5); lng.value = (+b).toFixed(5); if (text) note.textContent = text;
    if (map) { if (marker) marker.setLatLng([a, b]); else marker = L.marker([a, b]).addTo(map); }
  };
  const geoBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => {
    if (!navigator.geolocation) return (note.textContent = 'Your browser cannot share its location. Click the map or type coordinates.');
    navigator.geolocation.getCurrentPosition(
      (p) => { set(p.coords.latitude, p.coords.longitude, 'Location taken from your device. You can adjust it on the map.'); map?.setView([p.coords.latitude, p.coords.longitude], 14); },
      () => { note.textContent = 'Location permission was denied. Click the map or type coordinates instead.'; }, { timeout: 15000 });
  } }, 'Use my current location');
  const clear = h('button', { class: 'btn secondary', type: 'button', onclick: () => { lat.value = ''; lng.value = ''; marker?.remove(); marker = null; note.textContent = 'Location cleared. You will not appear in "near me" searches.'; } }, 'Clear location');
  return {
    lat, lng,
    el: h('div', {}, h('h2', {}, 'Location on the map'), note, h('div', { class: 'row' }, geoBtn, clear), mapEl,
      h('div', { class: 'row' }, field('blat', 'Latitude', lat), field('blng', 'Longitude', lng))),
    init: () => makeMap(mapEl, la != null ? [la, ln] : undefined, la != null ? 14 : 5).then((r) => {
      ({ L, m: map } = r);
      if (la != null) marker = L.marker([la, ln]).addTo(map);
      map.on('click', (e) => set(e.latlng.lat, e.latlng.lng, 'Location chosen on the map.'));
    }).catch(() => mapEl.replaceWith(h('p', { class: 'hint' }, 'The map is unavailable. Type coordinates instead, or leave them empty.'))),
  };
}
const money = (n) => (n == null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n));
const verifiedBadge = () => h('span', { class: 'badge st-APPROVED' }, '✓ Verified');
const statusNote = (b) => ({
  PENDING: 'Waiting for an administrator to review your profile. Customers cannot see it yet.',
  APPROVED: 'Approved. Customers can find your business.',
  REJECTED: 'Not approved yet. Read the reason below, update your profile and save to resubmit.',
  SUSPENDED: 'Suspended by an administrator. Customers cannot see it.',
}[b.status]);

// ---------- customers: browse ----------
async function businessesView() {
  const [cats, cities] = await Promise.all([api('GET', '/api/business-categories'), api('GET', '/api/businesses/cities')]);
  const state = { page: 1, limit: 12 };
  let near = null;
  const f = {
    q: h('input', { id: 'b-q', type: 'search', placeholder: 'Business or service name' }),
    category_id: h('select', { id: 'b-c' }, h('option', { value: '' }, 'All categories'), cats.items.map((c) => h('option', { value: c.id }, c.name))),
    city: h('select', { id: 'b-city' }, h('option', { value: '' }, 'All locations'), cities.items.map((c) => h('option', { value: c }, c))),
    available: h('select', { id: 'b-av' }, h('option', { value: '' }, 'Any'), h('option', { value: '1' }, 'Accepting requests now')),
    sort: h('select', { id: 'b-sort' }, h('option', { value: '' }, 'Best match'), h('option', { value: 'rating' }, 'Highest rated'), h('option', { value: 'newest' }, 'Recently updated')),
  };
  const radius = h('select', { id: 'b-rad', 'aria-label': 'Distance' }, [5, 10, 25, 50, 100].map((k) => h('option', { value: k, selected: k === 10 }, `within ${k} km`)));
  const nearNote = h('p', { class: 'hint', role: 'status' }, 'Or find businesses close to you.');
  const out = h('div', { 'aria-live': 'polite' });
  async function load() {
    out.replaceChildren(h('div', { class: 'spinner', role: 'status' }, 'Loading…'));
    try {
      const q = { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])), page: state.page, limit: state.limit };
      if (near) Object.assign(q, { near_lat: near.lat, near_lng: near.lng, radius_km: radius.value });
      const d = await api('GET', '/api/businesses?' + qs(q));
      if (!d.items.length) return out.replaceChildren(h('div', { class: 'card empty' }, h('p', {}, 'No verified businesses match your search yet.'), h('p', { class: 'hint' }, 'Try a different category, location or a wider distance.')));
      out.replaceChildren(h('div', { class: 'bgrid' }, d.items.map((b) => h('a', { class: 'bcard', href: `#/businesses/${b.id}` },
        b.cover_image_id ? h('img', { src: `/api/business-images/${b.cover_image_id}`, alt: '', loading: 'lazy' }) : h('div', { class: 'noimg', 'aria-hidden': 'true' }, '🏠'),
        h('div', { class: 'pad' }, h('h2', {}, b.name), verifiedBadge(), h('p', { class: 'hint' }, `${b.category} · ${b.city}${b.distance_km != null ? ` · ${b.distance_km} km away` : ''}`),
          h('p', { class: 'hint' }, ratingText(b.rating_avg, b.rating_count)), h('p', {}, b.description),
          h('p', {}, b.from_price == null ? 'Pricing on request' : `From ${money(b.from_price)}`, ' · ', b.accepting_orders ? 'Accepting requests' : 'Not accepting requests now'))))),
      pager(state, d.total, load));
    } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
  }
  const nearBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => {
    if (!navigator.geolocation) return (nearNote.textContent = 'Your browser cannot share its location. Pick a city instead.');
    nearNote.textContent = 'Asking your device for its location…';
    navigator.geolocation.getCurrentPosition(
      (p) => { near = { lat: p.coords.latitude, lng: p.coords.longitude }; nearNote.textContent = 'Showing businesses near your location, nearest first.'; state.page = 1; load(); },
      () => { nearNote.textContent = 'Location permission was denied. Choose a city instead.'; }, { timeout: 15000 });
  } }, 'Near me');
  const clearNear = h('button', { class: 'btn secondary', type: 'button', onclick: () => { near = null; nearNote.textContent = 'Or find businesses close to you.'; state.page = 1; load(); } }, 'Clear distance');
  app.replaceChildren(h('h1', {}, 'Local women-led home businesses'),
    h('p', { class: 'hint' }, 'Every business shown here has been reviewed and approved by an administrator.'),
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); state.page = 1; load(); } },
      h('div', { class: 'row' }, field('b-q', 'Search', f.q), field('b-c', 'Category', f.category_id), field('b-city', 'Location', f.city), field('b-av', 'Availability', f.available), field('b-sort', 'Sort by', f.sort),
        h('button', { class: 'btn', type: 'submit' }, 'Search')),
      h('div', { class: 'row' }, nearBtn, h('div', {}, h('label', { for: 'b-rad' }, 'Distance'), radius), clearNear), nearNote), out);
  load();
}

async function businessDetailView(id) {
  loading();
  const b = await api('GET', `/api/businesses/${id}`);
  const mapEl = b.lat != null ? h('div', { class: 'map' }) : null;
  const err = h('p', { class: 'err', role: 'alert' });
  let inquiry = null;
  if (me && me.role === 'citizen' && b.verified) {
    const svc = h('select', { id: 'q-s' }, h('option', { value: '' }, 'General question (no specific service)'), b.services.filter((s) => s.available).map((s) => h('option', { value: s.id }, `${s.title} – ${money(s.price)} ${s.price_unit}`)));
    const type = h('select', { id: 'q-t' }, h('option', { value: 'inquiry' }, 'Ask a question'), b.accepting_orders && h('option', { value: 'order' }, 'Request this service'));
    const msg = h('textarea', { id: 'q-m', required: true, minlength: 5, maxlength: 2000, placeholder: 'Tell the business what you need and when.' });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Send');
    inquiry = h('form', { class: 'card', onsubmit: act(btn, err, async () => {
      const r = await api('POST', `/api/businesses/${id}/inquiries`, { type: type.value, service_id: svc.value || undefined, message: msg.value });
      toast('Sent'); go(`#/inquiries/${r.id}`);
    }) }, h('h2', {}, 'Contact this business'), field('q-t', 'I want to', type), field('q-s', 'Service', svc), field('q-m', 'Message', msg), err, btn);
  } else if (!me) {
    inquiry = h('div', { class: 'card' }, h('p', {}, h('a', { href: '#/login' }, 'Sign in'), ' or ', h('a', { href: '#/register' }, 'create a free account'), ' to contact this business.'));
  }
  app.replaceChildren(h('p', {}, h('a', { href: '#/businesses' }, '← All businesses')),
    h('div', { class: 'card' },
      h('h1', {}, b.name), b.verified ? verifiedBadge() : h('span', { class: 'badge st-PENDING' }, label(b.status)),
      b.status && b.status !== 'APPROVED' && h('p', { class: 'next' }, statusNote(b)),
      h('p', { class: 'hint' }, `${b.category} · ${b.city}${b.address ? ' · ' + b.address : ''} · run by ${b.owner_name}`),
      h('p', {}, h('b', {}, ratingText(b.rating_avg, b.rating_count))),
      h('p', {}, b.description),
      h('dl', {}, [['Availability', b.availability_text || 'Not specified'], ['Accepting requests', b.accepting_orders ? 'Yes' : 'Not right now'], ['Pricing', b.pricing_info || '—'], b.contact_phone && ['Phone', b.contact_phone]]
        .filter(Boolean).flatMap(([k, v]) => [h('dt', { class: 'hint' }, k), h('dd', {}, v)]))),
    b.images.length ? h('div', { class: 'card' }, h('h2', {}, 'Photos'), h('div', { class: 'photos' }, b.images.map((i) => h('a', { href: i.url, target: '_blank', rel: 'noopener' }, h('img', { src: i.url, alt: `Photo of ${b.name}`, loading: 'lazy' }))))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Services and prices'), b.services.length ? table(['Service', 'Details', 'Price', 'Availability'], b.services.map((s) => h('tr', {}, h('td', {}, s.title), h('td', {}, s.description), h('td', {}, `${money(s.price)} ${s.price_unit}`), h('td', {}, s.available ? 'Available' : 'Unavailable'))), '') : h('p', { class: 'hint' }, 'No services listed yet.')),
    b.lat != null ? h('div', { class: 'card' }, h('h2', {}, 'Approximate area'), h('p', { class: 'hint' }, 'The owner shares only an approximate location (about 100 m).'), mapEl) : null,
    b.rating_count ? h('div', { class: 'card' }, h('h2', {}, 'Customer reviews'), h('ul', { class: 'timeline' }, b.reviews.map((r) => h('li', {}, h('b', {}, stars(r.rating)), ' ', r.reviewer,
      r.comment && h('div', {}, r.comment), h('small', {}, fmt(r.created_at)),
      me && me.role === 'admin' && h('div', {}, h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove this review?')) { await api('DELETE', `/api/admin/reviews/${r.id}`); businessDetailView(id); } } }, 'Remove review')))))) : null,
    inquiry,
    me && me.role === 'citizen' && b.verified && h('p', {}, h('a', { href: `#/complaints?business=${b.id}` }, 'Report a problem with this business')));
  if (mapEl) makeMap(mapEl, [b.lat, b.lng], 14).then(({ L, m }) => L.circle([b.lat, b.lng], { radius: 150 }).addTo(m)).catch(() => mapEl.replaceWith(h('p', { class: 'hint' }, 'Map unavailable.')));
}

// ---------- entrepreneur ----------
async function entrepreneurHome() {
  loading();
  const [{ business }, inq] = await Promise.all([api('GET', '/api/my/business'), api('GET', '/api/inquiries')]);
  const count = (...s) => inq.items.filter((i) => s.includes(i.status)).length;
  app.replaceChildren(h('h1', {}, `Welcome, ${me.name}`),
    business ? h('div', { class: 'card' }, h('h2', {}, business.name), h('span', { class: `badge st-${business.status}` }, label(business.status)), h('p', {}, statusNote(business)),
      business.review_note && h('p', { class: 'next' }, `Administrator note: ${business.review_note}`), h('a', { class: 'btn secondary', href: '#/my-business' }, 'Manage my business'))
      : h('div', { class: 'card' }, h('h2', {}, 'Set up your business profile'), h('p', {}, 'Add your business details, services, prices and photos. An administrator reviews it before customers can see it.'), h('a', { class: 'btn', href: '#/my-business' }, 'Create profile')),
    h('div', { class: 'grid' }, stat(count('NEW'), 'New inquiries', false, '#/inquiries'), stat(count('REPLIED', 'ACCEPTED'), 'In conversation / accepted', false, '#/inquiries'), stat(count('COMPLETED'), 'Completed')),
    h('div', { class: 'card' }, h('h2', {}, 'Grow your business'), h('p', {}, h('a', { href: '#/learn' }, 'Setup guidance, pricing, licensing and marketing tips'), ' · ', h('a', { href: '#/calculator' }, 'Cost and profit calculator'))));
}

async function myBusinessView() {
  loading();
  const [{ business: b }, cats] = await Promise.all([api('GET', '/api/my/business'), api('GET', '/api/business-categories')]);
  const err = h('p', { class: 'err', role: 'alert' });
  const v = (k) => (b ? b[k] : '');
  const picker = locationPicker(b ? b.lat : null, b ? b.lng : null);
  const f = {
    name: h('input', { id: 'bn', required: true, maxlength: 100, value: v('name') }),
    category_id: h('select', { id: 'bc', required: true }, h('option', { value: '' }, 'Choose…'), cats.items.map((c) => h('option', { value: c.id, selected: b && c.id === b.category_id }, c.name))),
    description: h('textarea', { id: 'bd', required: true, minlength: 20, maxlength: 2000 }, v('description')),
    city: h('input', { id: 'bcity', required: true, maxlength: 100, value: v('city') }),
    address: h('input', { id: 'badr', maxlength: 300, value: v('address') }),
    contact_phone: h('input', { id: 'bph', type: 'tel', maxlength: 30, value: v('contact_phone') }),
    pricing_info: h('textarea', { id: 'bpi', maxlength: 1000 }, v('pricing_info')),
    availability_text: h('input', { id: 'bav', maxlength: 300, value: v('availability_text'), placeholder: 'e.g. Mon–Sat, 8am–6pm' }),
    accepting: h('input', { id: 'bacc', type: 'checkbox', checked: b ? b.accepting_orders : true }),
  };
  const btn = h('button', { class: 'btn', type: 'submit' }, b ? 'Save changes' : 'Create profile');
  const profileForm = h('form', { class: 'card', onsubmit: act(btn, err, async () => {
    await api('PUT', '/api/my/business', { name: f.name.value, category_id: +f.category_id.value, description: f.description.value, city: f.city.value, address: f.address.value,
      contact_phone: f.contact_phone.value, pricing_info: f.pricing_info.value, availability_text: f.availability_text.value, accepting_orders: f.accepting.checked,
      lat: picker.lat.value || null, lng: picker.lng.value || null });
    toast(b ? 'Saved' : 'Profile created and sent for review'); myBusinessView();
  }) }, h('h2', {}, 'Business profile'),
  field('bn', 'Business name', f.name), field('bc', 'Category', f.category_id), field('bd', 'About your business', f.description, 'At least 20 characters. Describe what you offer and what makes it special.'),
  h('div', { class: 'row' }, field('bcity', 'City / location', f.city), field('badr', 'Area or address (optional)', f.address), field('bph', 'Phone shown to customers (optional)', f.contact_phone)),
  field('bpi', 'Pricing information', f.pricing_info, 'For example: weekly plans, minimum order, delivery charges.'),
  field('bav', 'Availability', f.availability_text), picker.el,
  h('div', {}, h('label', { for: 'bacc' }, 'Accepting new requests'), f.accepting), err, btn);

  const parts = [h('h1', {}, 'My business')];
  if (b) {
    parts.push(h('div', { class: 'card' }, h('span', { class: `badge st-${b.status}` }, label(b.status)), ' ', h('span', {}, statusNote(b)),
      b.review_note && h('p', { class: 'next' }, `Administrator note: ${b.review_note}`), h('p', {}, h('a', { href: `#/businesses/${b.id}` }, 'Preview my public page'))));
  }
  parts.push(profileForm);
  if (b) {
    const se = h('p', { class: 'err', role: 'alert' });
    const st = h('input', { id: 'st', required: true, maxlength: 100 }), sd = h('input', { id: 'sd', maxlength: 1000 });
    const sp = h('input', { id: 'sp', type: 'number', min: 0, step: '0.01', required: true }), su = h('input', { id: 'su', maxlength: 40, placeholder: 'per box, per piece, per hour…' });
    const sb = h('button', { class: 'btn', type: 'submit' }, 'Add service');
    const patch = async (s, body) => { try { await api('PATCH', `/api/my/business/services/${s.id}`, body); myBusinessView(); } catch (e) { toast(e.message); } };
    parts.push(h('div', { class: 'card' }, h('h2', {}, 'Services, prices and availability'),
      b.services.length ? table(['Service', 'Price', 'Available', ''], b.services.map((s) => h('tr', {}, h('td', {}, h('b', {}, s.title), h('div', { class: 'hint' }, s.description)),
        h('td', {}, h('input', { type: 'number', min: 0, step: '0.01', value: s.price, 'aria-label': `Price for ${s.title}`, onchange: (e) => patch(s, { price: e.target.value }) }), h('div', { class: 'hint' }, s.price_unit)),
        h('td', {}, h('input', { type: 'checkbox', checked: s.available, 'aria-label': `Available: ${s.title}`, onchange: (e) => patch(s, { available: e.target.checked }) })),
        h('td', {}, h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${s.title}"?`)) { await api('DELETE', `/api/my/business/services/${s.id}`); myBusinessView(); } } }, 'Delete')))), '') : h('p', { class: 'hint' }, 'No services yet. Add your first one below.'),
      h('form', { onsubmit: act(sb, se, async () => { await api('POST', '/api/my/business/services', { title: st.value, description: sd.value, price: sp.value, price_unit: su.value }); myBusinessView(); }) },
        h('h2', {}, 'Add a service'), h('div', { class: 'row' }, field('st', 'Title', st), field('sp', 'Price', sp), field('su', 'Unit', su)), field('sd', 'Details (optional)', sd), se, sb)));
    const pe = h('p', { class: 'err', role: 'alert' });
    const fi = h('input', { id: 'bi', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, required: true });
    const pb = h('button', { class: 'btn', type: 'submit' }, 'Upload');
    parts.push(h('div', { class: 'card' }, h('h2', {}, `Photos (${b.images.length} of 6)`),
      b.images.length ? h('div', { class: 'photos' }, b.images.map((i) => h('figure', {}, h('img', { src: i.url, alt: 'Business photo', loading: 'lazy' }),
        h('figcaption', {}, h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove this photo?')) { await api('DELETE', `/api/my/business/images/${i.id}`); myBusinessView(); } } }, 'Remove'))))) : h('p', { class: 'hint' }, 'Add clear photos of your real work.'),
      h('form', { onsubmit: act(pb, pe, async () => { const fd = new FormData(); [...fi.files].slice(0, 3).forEach((p) => fd.append('images', p)); await api('POST', '/api/my/business/images', fd); myBusinessView(); }) },
        field('bi', 'Add photos (up to 3 at a time)', fi, 'JPEG, PNG or WebP.'), pe, pb)));
  }
  app.replaceChildren(...parts);
  picker.init();
}

// ---------- inquiries (customer + entrepreneur) ----------
async function inquiriesView() {
  loading();
  const d = await api('GET', '/api/inquiries');
  const owner = me.role === 'entrepreneur';
  app.replaceChildren(h('h1', {}, owner ? 'Customer inquiries and requests' : 'My inquiries'),
    d.items.length ? table([owner ? 'Customer' : 'Business', 'Type', 'Service', 'Last message', 'Status', 'Updated'], d.items.map((i) => h('tr', {},
      h('td', {}, h('a', { href: `#/inquiries/${i.id}` }, owner ? i.customer_name : i.business_name)), h('td', {}, i.type === 'order' ? 'Service request' : 'Inquiry'), h('td', {}, i.service_title || '—'),
      h('td', {}, (i.last_message || '').slice(0, 60)), h('td', {}, h('span', { class: `badge st-${i.status}` }, label(i.status))), h('td', {}, fmt(i.updated_at)))), '')
      : h('div', { class: 'card empty' }, h('p', {}, owner ? 'No inquiries yet. Complete your profile and get it approved so customers can find you.' : 'You have not contacted any business yet.'), !owner && h('a', { class: 'btn', href: '#/businesses' }, 'Browse businesses')));
}
async function inquiryDetailView(id) {
  loading();
  const q = await api('GET', `/api/inquiries/${id}`);
  const err = h('p', { class: 'err', role: 'alert' });
  const msg = h('textarea', { id: 'im', required: true, maxlength: 2000 });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Send message');
  const closed = !['NEW', 'REPLIED', 'ACCEPTED'].includes(q.status);
  const move = (to) => async () => {
    if (['DECLINED', 'CANCELLED'].includes(to) && !confirm(`Mark this as ${label(to)}? This cannot be undone.`)) return;
    try { await api('POST', `/api/inquiries/${id}/status`, { to }); inquiryDetailView(id); } catch (e) { toast(e.message); }
  };
  const rate = h('select', { id: 'rv-r' }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${stars(n)}  ${n} out of 5`))), rc = h('textarea', { id: 'rv-c', maxlength: 1000 });
  const rb = h('button', { class: 'btn', type: 'submit' }, 'Submit rating'), re = h('p', { class: 'err', role: 'alert' });
  const reviewForm = q.can_review ? h('form', { class: 'card', onsubmit: act(rb, re, async () => { await api('POST', `/api/inquiries/${id}/review`, { rating: +rate.value, comment: rc.value }); toast('Thank you for your rating'); inquiryDetailView(id); }) },
    h('h2', {}, 'Rate this business'), field('rv-r', 'Rating', rate), field('rv-c', 'Comment (optional)', rc), re, rb) : null;
  app.replaceChildren(h('p', {}, h('a', { href: '#/inquiries' }, '← All inquiries')),
    h('div', { class: 'card' }, h('h1', {}, q.business_name), h('span', { class: `badge st-${q.status}` }, label(q.status)),
      h('p', { class: 'hint' }, `${q.type === 'order' ? 'Service request' : 'Inquiry'}${q.service_title ? ' · ' + q.service_title : ''} · from ${q.customer_name} · ${fmt(q.created_at)}`),
      q.allowed.length ? h('div', { class: 'row' }, q.allowed.map((to) => h('button', { class: 'btn ' + (['DECLINED', 'CANCELLED'].includes(to) ? 'danger' : 'secondary'), onclick: move(to) },
        { ACCEPTED: 'Accept', DECLINED: 'Decline', COMPLETED: 'Mark completed', CANCELLED: 'Cancel request' }[to]))) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Conversation'), h('ol', { class: 'thread' }, q.messages.map((m) => h('li', { class: m.mine ? 'mine' : null }, h('div', {}, m.body), h('small', {}, `${m.mine ? 'You' : m.sender} · ${fmt(m.created_at)}`))))),
    q.review ? h('p', { class: 'next' }, `Your rating: ${stars(q.review.rating)}${q.review.comment ? ' – ' + q.review.comment : ''}`) : null,
    reviewForm,
    closed ? h('p', { class: 'hint' }, 'This conversation is closed.') : h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('POST', `/api/inquiries/${id}/messages`, { body: msg.value }); inquiryDetailView(id); }) },
      field('im', 'Reply', msg), err, btn));
}

// ---------- complaints (customer / entrepreneur) ----------
async function complaintsView(params) {
  loading();
  const mine = await api('GET', '/api/complaints/mine');
  const err = h('p', { class: 'err', role: 'alert' });
  const subj = h('input', { id: 'cs', required: true, minlength: 3, maxlength: 120 }), body = h('textarea', { id: 'cb', required: true, minlength: 10, maxlength: 2000 });
  const biz = h('input', { id: 'cbiz', type: 'hidden', value: params.business || '' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Submit complaint');
  app.replaceChildren(h('h1', {}, me.role === 'citizen' ? 'Complaints' : 'Support'),
    h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('POST', '/api/complaints', { subject: subj.value, body: body.value, business_id: biz.value || undefined }); toast('Complaint sent to the administrators'); complaintsView({}); }) },
      h('h2', {}, 'Raise a complaint or report an issue'), params.business && h('p', { class: 'next' }, 'This complaint will be linked to the business you came from.'),
      field('cs', 'Subject', subj), field('cb', 'What happened?', body), biz, err, btn),
    h('h2', {}, 'My complaints'),
    mine.items.length ? table(['Subject', 'Business', 'Status', 'Response', 'Date'], mine.items.map((c) => h('tr', {}, h('td', {}, c.subject), h('td', {}, c.business_name || '—'), h('td', {}, h('span', { class: `badge st-${c.status}` }, label(c.status))), h('td', {}, c.admin_note || '—'), h('td', {}, fmt(c.created_at)))), '') : h('div', { class: 'card empty' }, 'No complaints.'));
}

// ---------- learning content + calculator ----------
async function learnView() {
  loading();
  const d = await api('GET', '/api/content');
  const sections = [['guide', 'Business setup guidance (step by step)'], ['marketing', 'Marketing tips'], ['learning', 'Learning resources and growth']];
  app.replaceChildren(h('h1', {}, 'Learn and grow'),
    h('p', {}, 'Try the ', h('a', { href: '#/calculator' }, 'cost and profit calculator'), ' to test a price before you publish it.'),
    sections.map(([kind, title]) => {
      const items = d.items.filter((c) => c.kind === kind);
      return h('div', { class: 'card' }, h('h2', {}, title), items.length ? items.map((c, i) => h('details', { open: kind === 'guide' && i === 0 }, h('summary', {}, c.title), h('div', { class: 'article' }, richText(c.body)))) : h('p', { class: 'hint' }, 'Nothing here yet.'));
    }));
}
function calculatorView() {
  const num = (id, text, val, hint, step = '0.01') => [h('label', { for: id }, text), h('input', { id, type: 'number', min: 0, step, value: val, inputmode: 'decimal' }), hint && h('p', { class: 'hint' }, hint)];
  const out = h('div', { class: 'card', 'aria-live': 'polite' });
  const form = h('form', { class: 'card', onsubmit: (e) => e.preventDefault(), oninput: calc },
    h('h2', {}, 'Your numbers'),
    num('c-price', 'Selling price per unit', 100, 'One tiffin, one blouse, one product…'),
    num('c-mat', 'Materials / ingredients per unit', 40), num('c-oth', 'Packaging, delivery and fees per unit', 10),
    num('c-units', 'Units you expect to sell per month', 120, null, '1'),
    num('c-fixed', 'Fixed costs per month', 3000, 'Equipment, rent share, phone and internet, licences, marketing.'),
    num('c-hours', 'Hours you work per month on this', 100, null, '1'), num('c-wage', 'What you want to earn per hour', 80, 'Pay yourself, otherwise the profit is overstated.'),
    num('c-margin', 'Target profit margin (%)', 25, 'Used to suggest a price.', '1'));
  function calc() {
    const g = (id) => Math.max(0, parseFloat(document.getElementById(id).value) || 0);
    const price = g('c-price'), varc = g('c-mat') + g('c-oth'), units = g('c-units'), fixed = g('c-fixed'), own = g('c-hours') * g('c-wage'), m = Math.min(g('c-margin'), 90) / 100;
    const unitProfit = price - varc, revenue = price * units, totalCost = varc * units + fixed, profit = revenue - totalCost, afterPay = profit - own;
    const breakEven = unitProfit > 0 ? Math.ceil(fixed / unitProfit) : null;
    const suggested = units > 0 ? (varc + (fixed + own) / units) / (1 - m) : null;
    const rows = [['Profit per unit (before fixed costs)', money(unitProfit)], ['Break-even units per month', breakEven == null ? 'Not reachable at this price' : `${breakEven} units`],
      ['Monthly revenue', money(revenue)], ['Monthly profit before paying yourself', money(profit)], ['Value of your own time', money(own)],
      ['Monthly profit after paying yourself', money(afterPay)], ['Profit margin (before paying yourself)', revenue > 0 ? `${((profit / revenue) * 100).toFixed(1)}%` : '—'],
      ['Suggested price for your target margin', suggested == null ? 'Enter expected units' : money(suggested)]];
    out.replaceChildren(h('h2', {}, 'Results'), unitProfit <= 0 ? h('p', { class: 'err' }, 'Your price does not cover materials and per-unit costs. Raise the price or cut costs.') : null,
      h('dl', { class: 'calc' }, rows.flatMap(([k, v]) => [h('dt', { class: 'hint' }, k), h('dd', {}, h('b', {}, v))])),
      h('p', { class: 'hint' }, 'Planning estimate only. It does not include tax.'));
  }
  app.replaceChildren(h('h1', {}, 'Cost and profit calculator'), h('div', { class: 'grid2' }, form, out));
  calc();
}

// ---------- admin: marketplace ----------
function platformCards(p) {
  const kv = (o) => Object.entries(o || {}).map(([k, n]) => ({ k, n }));
  const list = (title, o, fmtK = label) => h('div', { class: 'card' }, h('h2', {}, title), kv(o).length ? h('ul', {}, kv(o).map(({ k, n }) => h('li', {}, `${fmtK(k)}: ${n}`))) : h('p', { class: 'hint' }, 'None yet.'));
  return [h('h2', {}, 'Platform activity'), h('div', { class: 'grid' }, list('Users by role', p.users_by_role), list('Business profiles', p.businesses_by_status), list('Inquiries / requests', p.inquiries_by_status), list('Complaints', p.complaints_by_status)),
    bars(p.businesses_by_category, 'category', 'Approved businesses by category')];
}
async function deliveriesView() {
  loading();
  const d = await api('GET', '/api/admin/deliveries?limit=100');
  const line = d.summary.length ? d.summary.map((x) => `${label(x.channel)} ${x.status}: ${x.n}`).join(' · ') : 'No emails or texts have been attempted.';
  app.replaceChildren(h('p', {}, h('a', { href: '#/admin/audit' }, '← Audit log')), h('h1', {}, 'Email and SMS delivery log'),
    !meta.channels.email && !meta.channels.sms ? h('p', { class: 'next' }, 'No email or SMS provider is configured on this server (see the README). Only in-app notifications are sent.') : null,
    h('p', {}, line),
    table(['When', 'Channel', 'Recipient', 'Type', 'Status', 'Error'], d.items.map((x) => h('tr', {}, h('td', {}, fmt(x.created_at)), h('td', {}, label(x.channel)), h('td', {}, x.recipient), h('td', {}, x.type),
      h('td', {}, h('span', { class: 'badge ' + (x.status === 'sent' ? 'st-APPROVED' : x.status === 'failed' ? 'st-DECLINED' : 'st-PENDING') }, label(x.status))), h('td', {}, x.error || ''))), 'Nothing here yet.'));
}
async function adminBusinessesView() {
  loading();
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const d = await api('GET', '/api/admin/businesses?' + qs({ status, limit: 100 }));
  const filter = h('select', { id: 'ab-f', 'aria-label': 'Filter by status', onchange: (e) => go('#/admin/businesses' + (e.target.value ? '?status=' + e.target.value : '')) },
    h('option', { value: '' }, 'All'), ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].map((s) => h('option', { value: s, selected: s === status }, label(s))));
  const review = (b, decision) => async () => {
    let note = '';
    if (decision !== 'APPROVED') { note = prompt(`Reason for ${decision.toLowerCase()} (shown to the owner):`); if (!note) return; }
    try { await api('POST', `/api/admin/businesses/${b.id}/review`, { decision, note }); toast('Done'); adminBusinessesView(); } catch (e) { toast(e.message); }
  };
  app.replaceChildren(h('h1', {}, 'Business profiles'), h('div', { class: 'row' }, field('ab-f', 'Show', filter), h('a', { class: 'btn secondary', href: '#/admin/business-categories' }, 'Manage business categories')),
    table(['Business', 'Owner', 'Category', 'City', 'Status', 'Updated', 'Actions'], d.items.map((b) => h('tr', {},
      h('td', {}, h('a', { href: `#/businesses/${b.id}` }, b.name), b.review_note && h('div', { class: 'hint' }, b.review_note)), h('td', {}, b.owner_name, h('div', { class: 'hint' }, b.owner_email)), h('td', {}, b.category), h('td', {}, b.city),
      h('td', {}, h('span', { class: `badge st-${b.status}` }, label(b.status))), h('td', {}, fmt(b.updated_at)),
      h('td', {}, b.status !== 'APPROVED' && h('button', { class: 'btn', onclick: review(b, 'APPROVED') }, 'Approve'), ' ', b.status === 'PENDING' && h('button', { class: 'btn secondary', onclick: review(b, 'REJECTED') }, 'Reject'),
        b.status === 'APPROVED' && h('button', { class: 'btn danger', onclick: review(b, 'SUSPENDED') }, 'Suspend')))), 'No business profiles.'));
}
async function bizCategoriesView() {
  loading();
  const d = await api('GET', '/api/admin/business-categories');
  const err = h('p', { class: 'err', role: 'alert' }), name = h('input', { id: 'bcn', required: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Add category');
  app.replaceChildren(h('p', {}, h('a', { href: '#/admin/businesses' }, '← Business profiles')), h('h1', {}, 'Business categories'),
    h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('POST', '/api/admin/business-categories', { name: name.value }); bizCategoriesView(); }) }, field('bcn', 'New category', name), err, btn),
    table(['Name', 'Businesses', 'Active', ''], d.items.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, String(c.businesses)),
      h('td', {}, h('input', { type: 'checkbox', checked: c.active, 'aria-label': `Active: ${c.name}`, onchange: async (e) => { try { await api('PATCH', `/api/admin/business-categories/${c.id}`, { active: e.target.checked }); } catch (x) { toast(x.message); } } })),
      h('td', {}, h('button', { class: 'btn secondary', onclick: async () => { const n = prompt('Rename category', c.name); if (n) try { await api('PATCH', `/api/admin/business-categories/${c.id}`, { name: n }); bizCategoriesView(); } catch (x) { toast(x.message); } } }, 'Rename')))), ''));
}
async function adminComplaintsView() {
  loading();
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const d = await api('GET', '/api/admin/complaints?' + qs({ status, limit: 100 }));
  const filter = h('select', { id: 'ac-f', onchange: (e) => go('#/admin/complaints' + (e.target.value ? '?status=' + e.target.value : '')) }, h('option', { value: '' }, 'All'),
    ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'].map((s) => h('option', { value: s, selected: s === status }, label(s))));
  app.replaceChildren(h('h1', {}, 'Complaints'), field('ac-f', 'Show', filter),
    d.items.length ? d.items.map((c) => {
      const sel = h('select', { id: `cs-${c.id}` }, ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'].map((s) => h('option', { value: s, selected: s === c.status }, label(s))));
      const note = h('textarea', { id: `cn-${c.id}`, maxlength: 1000 }, c.admin_note || ''), err = h('p', { class: 'err', role: 'alert' });
      const btn = h('button', { class: 'btn', type: 'submit' }, 'Save');
      return h('form', { class: 'card', onsubmit: act(btn, err, async () => { await api('PATCH', `/api/admin/complaints/${c.id}`, { status: sel.value, admin_note: note.value }); toast('Updated'); adminComplaintsView(); }) },
        h('h2', {}, c.subject), h('span', { class: `badge st-${c.status}` }, label(c.status)),
        h('p', { class: 'hint' }, `From ${c.complainant} (${c.complainant_role}) · ${fmt(c.created_at)}${c.business_name ? ' · about ' + c.business_name : ''}`),
        c.business_id && h('p', {}, h('a', { href: `#/businesses/${c.business_id}` }, 'View business')), h('p', {}, c.body),
        h('div', { class: 'row' }, field(`cs-${c.id}`, 'Status', sel), field(`cn-${c.id}`, 'Response to the complainant (required to resolve or dismiss)', note)), err, btn);
    }) : h('div', { class: 'card empty' }, 'No complaints.'));
}
async function contentView() {
  loading();
  const d = await api('GET', '/api/content?all=1');
  let editing = null;
  const err = h('p', { class: 'err', role: 'alert' });
  const kind = h('select', { id: 'ck' }, [['guide', 'Setup guidance'], ['marketing', 'Marketing tip'], ['learning', 'Learning resource']].map(([v, t]) => h('option', { value: v }, t)));
  const title = h('input', { id: 'ct', required: true, minlength: 3, maxlength: 150 }), body = h('textarea', { id: 'cbody', required: true, minlength: 10, rows: 8 });
  const order = h('input', { id: 'co', type: 'number', value: 0 }), pub = h('input', { id: 'cp', type: 'checkbox', checked: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save article');
  const formEl = h('form', { class: 'card', onsubmit: act(btn, err, async () => {
    const payload = { kind: kind.value, title: title.value, body: body.value, sort_order: +order.value, published: pub.checked };
    if (editing) await api('PATCH', `/api/admin/content/${editing}`, payload); else await api('POST', '/api/admin/content', payload);
    toast('Saved'); contentView();
  }) }, h('h2', {}, 'Add or edit an article'), h('p', { class: 'hint' }, 'Separate paragraphs with a blank line. Start a line with "- " for a bullet.'),
  h('div', { class: 'row' }, field('ck', 'Type', kind), field('ct', 'Title', title), field('co', 'Order', order)), field('cbody', 'Text', body), h('div', {}, h('label', { for: 'cp' }, 'Published (visible to entrepreneurs)'), pub), err, btn);
  app.replaceChildren(h('h1', {}, 'Guidance and learning content'), formEl,
    table(['Type', 'Title', 'Order', 'Published', ''], d.items.map((c) => h('tr', {}, h('td', {}, label(c.kind)), h('td', {}, c.title), h('td', {}, String(c.sort_order)), h('td', {}, c.published ? 'Yes' : 'Draft'),
      h('td', {}, h('button', { class: 'btn secondary', onclick: () => { editing = c.id; kind.value = c.kind; title.value = c.title; body.value = c.body; order.value = c.sort_order; pub.checked = c.published; formEl.scrollIntoView(); title.focus(); } }, 'Edit'), ' ',
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${c.title}"?`)) { await api('DELETE', `/api/admin/content/${c.id}`); contentView(); } } }, 'Delete')))), 'No content yet.'));
}

// ---------- privacy notice ----------
function privacyView() {
  const sec = (title, ...items) => h('div', { class: 'card' }, h('h2', {}, title), h('ul', {}, items.map((t) => h('li', {}, t))));
  app.replaceChildren(h('h1', {}, 'Privacy notice'),
    h('p', { class: 'hint' }, 'This is a demonstration project. This notice describes what the application actually does; an organisation running it for real use should review and adapt it with its own legal advice.'),
    sec('What we store',
      'Account: your name, email address and password (stored only as a salted hash). A mobile number only if you add one.',
      'Infrastructure reports: category, title, description, photos, the location you give (device-reported coordinates, a map point or a typed address, labelled as such), and the status history.',
      'Business profiles: business name, description, city, an approximate location (rounded to about 100 m), services, prices, photos, and a phone number only if you enter one, which is then shown publicly.',
      'Messages between customers and businesses, complaints, ratings and reviews, and notifications about your activity.',
      'A sign-in cookie that keeps you logged in. It is strictly necessary, and there are no advertising or analytics cookies.'),
    sec('Who can see it',
      'Your infrastructure reports: you, the officers of the responsible department, and administrators. Internal staff notes are never shown to you or the public.',
      'Approved business profiles, their photos and reviews: anyone. Reviewers appear as first name and last initial.',
      'Inquiries and messages: only the customer and the business owner. Complaints: administrators.',
      'Email or text notifications are sent only if the service has those channels enabled and you have not turned them off. Texts also need a mobile number you added.'),
    sec('Photos',
      'Photos may contain hidden location data added by your phone (EXIF). This version does not remove it. Turn off location tagging in your camera settings if you do not want it shared.'),
    sec('Keeping and deleting data',
      'Data is kept while the service runs. An administrator can deactivate your account at any time. Permanent deletion of an account and its reports is not available in this version: contact the service administrator to ask what can be done.'),
    sec('Security',
      'Passwords are hashed, sessions can be revoked, sign-in and reset requests are rate limited, uploads are checked, and administrators’ actions are logged.'),
    h('p', {}, h('a', { href: '#/' }, '← Back')));
}

// ---------- forgot / reset password, verify email ----------
function forgotView() {
  const err = h('p', { class: 'err', role: 'alert' }), email = h('input', { id: 'fe', type: 'email', required: true, autocomplete: 'email' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Send reset link');
  const card = h('form', { class: 'card narrow', onsubmit: act(btn, err, async () => {
    const r = await api('POST', '/api/auth/forgot', { email: email.value });
    card.replaceChildren(h('h1', {}, 'Check your email'), h('p', {}, r.message), h('p', { class: 'hint' }, 'The link works for one hour. Not there? Look in your spam folder.'), h('a', { href: '#/login' }, 'Back to sign in'));
  }) }, h('h1', {}, 'Reset your password'), meta.channels.email ? h('p', { class: 'hint' }, 'Enter your account email and we will send you a link to choose a new password.')
    : h('p', { class: 'next' }, 'Password reset by email is not available on this server. Please ask an administrator to reset your password.'),
  field('fe', 'Email', email), err, meta.channels.email && btn, h('p', {}, h('a', { href: '#/login' }, 'Back to sign in')));
  app.replaceChildren(card);
  email.focus();
}
function resetView(token) {
  history.replaceState(null, '', '#/reset'); // keep the secret out of the address bar and history
  const err = h('p', { class: 'err', role: 'alert' });
  const pw = h('input', { id: 'rp', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), pw2 = h('input', { id: 'rp2', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Set new password');
  const card = h('form', { class: 'card narrow', onsubmit: act(btn, err, async () => {
    if (pw.value !== pw2.value) throw new Error('The two passwords do not match');
    await api('POST', '/api/auth/reset', { token, password: pw.value });
    me = null; renderNav();
    card.replaceChildren(h('h1', {}, 'Password changed'), h('p', {}, 'You have been signed out everywhere. Sign in with your new password.'), h('a', { class: 'btn', href: '#/login' }, 'Sign in'));
  }) }, h('h1', {}, 'Choose a new password'), !token && h('p', { class: 'err' }, 'This page needs the link from your email. Request a new one from the sign-in page.'),
  field('rp', 'New password', pw, 'At least 8 characters.'), field('rp2', 'Repeat new password', pw2), err, btn);
  app.replaceChildren(card);
  pw.focus();
}
async function verifyView(token) {
  history.replaceState(null, '', '#/verify');
  loading();
  try {
    await api('POST', '/api/auth/verify', { token });
    if (me) { me = (await api('GET', '/api/auth/me')).user; renderNav(); }
    app.replaceChildren(h('div', { class: 'card narrow' }, h('h1', {}, 'Email verified'), h('p', {}, 'Thank you. Your email address is confirmed.'), h('a', { class: 'btn', href: me ? '#/' : '#/login' }, me ? 'Continue' : 'Sign in')));
  } catch (e) {
    app.replaceChildren(h('div', { class: 'card narrow' }, h('h1', {}, 'This link did not work'), h('p', { class: 'err' }, e.message),
      me && !me.email_verified ? h('p', {}, 'Use the banner at the top of any page to send a new verification email.') : h('a', { href: '#/login' }, 'Sign in')));
  }
}
function verifyBanner() {
  const btn = h('button', { class: 'btn secondary', onclick: async () => {
    btn.disabled = true;
    try { await api('POST', '/api/auth/verify/request'); toast('Verification email sent. Check your inbox.'); } catch (e) { toast(e.message); }
    btn.disabled = false;
  } }, 'Send verification email');
  return h('div', { class: 'card next', role: 'status' }, h('b', {}, 'Please verify your email address. '),
    'You can browse, but reporting problems, contacting businesses and editing a business profile need a verified address. ', btn);
}

// ---------- router ----------
async function routeInner() {
  const hash = location.hash || '#/';
  const [path, query] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  renderNav();
  const publicPage = ['businesses', 'forgot', 'reset', 'verify', 'privacy'].includes(parts[0]);
  if (!me && !publicPage) return authView(parts[0] === 'register' ? 'register' : 'login');
  if (me && ['login', 'register'].includes(parts[0])) return go('#/');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  try {
    if (parts[0] === 'businesses') return parts[1] ? await businessDetailView(parts[1]) : await businessesView();
    if (parts[0] === 'privacy') return privacyView();
    if (parts[0] === 'forgot') return forgotView();
    if (parts[0] === 'reset') return resetView(params.token);
    if (parts[0] === 'verify') return await verifyView(params.token);
    if (!me) return authView('login');
    if (!parts.length) return me.role === 'citizen' ? await citizenHome() : me.role === 'entrepreneur' ? await entrepreneurHome() : await dashboardView();
    if (parts[0] === 'my-business' && me.role === 'entrepreneur') return await myBusinessView();
    if (parts[0] === 'inquiries' && ['citizen', 'entrepreneur'].includes(me.role)) return parts[1] ? await inquiryDetailView(parts[1]) : await inquiriesView();
    if (parts[0] === 'learn' && me.role === 'entrepreneur') return await learnView();
    if (parts[0] === 'calculator' && me.role === 'entrepreneur') return calculatorView();
    if (parts[0] === 'complaints' && ['citizen', 'entrepreneur'].includes(me.role)) return await complaintsView(params);
    if (parts[0] === 'new' && me.role === 'citizen') return newReportView();
    if (parts[0] === 'reports' && parts[1]) return await detailView(parts[1]);
    if (parts[0] === 'reports' && staff()) {
      const preset = Object.fromEntries(new URLSearchParams(query || ''));
      return await reportsView({ preset: Object.keys(preset).length ? preset : null });
    }
    if (parts[0] === 'map' && staff()) return await mapView();
    if (parts[0] === 'notifications') return await notificationsView();
    if (parts[0] === 'account') return accountView();
    if (parts[0] === 'admin' && me.role === 'admin') {
      const v = { users: usersView, departments: departmentsView, categories: categoriesView, audit: () => auditView(1), businesses: adminBusinessesView,
        'business-categories': bizCategoriesView, complaints: adminComplaintsView, content: contentView, deliveries: deliveriesView }[parts[1]];
      if (v) return await v();
    }
    app.replaceChildren(h('div', { class: 'card empty' }, h('h1', {}, 'Page not found'), h('a', { href: '#/' }, 'Go home')));
  } catch (e) { if (e.status !== 401) fail(e); }
  app.focus({ preventScroll: true });
}

async function route() {
  await routeInner();
  const section = (location.hash || '#/').split(/[/?]/)[1];
  if (me && meta.channels.email && !me.email_verified && section !== 'verify') app.prepend(verifyBanner());
}

(async function init() {
  loading();
  try {
    meta = await api('GET', '/api/meta');
    try { me = (await api('GET', '/api/auth/me')).user; } catch { me = null; }
  } catch (e) { return fail(e); }
  window.addEventListener('hashchange', route);
  route();
})();
