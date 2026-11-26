import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links/lib/addon-web-links.mjs';
import * as saved from '/saved.js';
import * as tools from '/tools.js';
import * as launcher from '/launcher.js';

const $ = s => document.querySelector(s);
const terms = new Map();     // name -> { term, fit, el, ws, retry, closedByUs }
let sessions = [];
let current = null;          // sesión del panel enfocado
let home = '';
let host = '';
let leaving = false;         // true cuando salimos a propósito (no preguntar al cerrar)
const prevBusy = new Map();
const lastSeen = JSON.parse(localStorage.getItem('hermes.lastSeen') || '{}');
const recentDirs = JSON.parse(localStorage.getItem('hermes.recentDirs') || '[]');
const enc = new TextEncoder();

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);
const THEME = {
  background: '#000000', foreground: '#d6dbe4', cursor: '#d97757', selectionBackground: '#3a4458',
  black: '#1c2230', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
  magenta: '#bc8cff', cyan: '#39c5cf', white: '#d6dbe4', brightBlack: '#6e7681',
  brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
};

// ---------- layouts (grilla de paneles) ----------
const LAYOUTS = {
  single: { n: 1, label: 'Una sesión' },
  rows2:  { n: 2, label: 'Dos, una arriba de otra' },
  cols2:  { n: 2, label: 'Dos, lado a lado' },
  tri:    { n: 3, label: 'Tres: dos arriba y una abajo' },
  grid4:  { n: 4, label: 'Grilla 2×2' },
};
const savedLayout = JSON.parse(localStorage.getItem('hermes.layout') || '{}');
if (savedLayout.layout === 'cols3') savedLayout.layout = 'tri'; // nombre anterior
let layout = LAYOUTS[savedLayout.layout] && !matchMedia('(max-width: 700px)').matches ? savedLayout.layout : 'single';
let panes = Array.isArray(savedLayout.panes) ? savedLayout.panes : [];
let focused = Number.isInteger(savedLayout.focused) ? savedLayout.focused : 0;
let zoomed = false;
let view = 'terms';          // 'terms' | 'saved'
const paneEls = [];          // [{ root, head, body, name, cwd, size, dot }]

const saveLayout = () => localStorage.setItem('hermes.layout', JSON.stringify({ layout, panes, focused }));
const visibleNames = () => new Set(zoomed ? [panes[focused]].filter(Boolean) : panes.filter(Boolean));

// ---------- estado de una sesión ----------
const stateOf = s => s.state || (SHELLS.has(s.command) ? 'shell' : 'idle');
const STATE_LABEL = { busy: 'trabajando', idle: 'esperando', ask: 'pide permiso', dead: 'terminada' };
const prettyPath = p => (home && p?.startsWith(home) ? '~' + p.slice(home.length) : p || '');
const cleanTitle = t => (t || '').replace(/^[⠀-⣿✳*·\s]+/, '').trim();
// "esperando · 3m · $1.20 · Título o carpeta" (barra lateral y lanzador)
function describe(s) {
  const title = cleanTitle(s.title);
  const what = s.saved ? (s.saved.title || s.saved.name)
    : title && !/^(claude( code)?|zsh|bash)$/i.test(title) ? title : prettyPath(s.cwd);
  return `${STATE_LABEL[stateOf(s)] || s.command} · ${ago(s.activity)}${s.cost ? ` · $${s.cost.toFixed(2)}` : ''} · ${what}`;
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------- lista ----------
let firstLoad = true;
async function refresh() {
  try {
    // le dice al servidor qué sesiones se están mirando (para no mandar avisos al celular)
    const seen = document.hidden ? '' : [...visibleNames()].join(',');
    const r = await fetch('/api/sessions' + (seen ? '?seen=' + encodeURIComponent(seen) : ''));
    if (r.status === 401) { leaving = true; location.replace('/login' + location.hash); return; }
    const data = await r.json();
    home = data.home;
    if (data.host && host !== data.host) { host = data.host; $('#host').textContent = '@ ' + host; }
    sessions = data.sessions;
  } catch { return; }

  const exists = n => sessions.some(s => s.name === n);
  // sesiones que ya no existen: liberar su panel y su terminal
  let changed = false;
  panes = panes.map(n => { if (n && !exists(n)) { changed = true; return null; } return n; });
  for (const name of [...terms.keys()]) if (!exists(name)) destroyTerm(name);
  if (firstLoad) { firstLoad = false; fillEmptyPanes(); changed = true; }
  if (changed) placeTerms();

  const visible = visibleNames();
  for (const s of sessions) {
    const st = stateOf(s);
    const prev = prevBusy.get(s.name);
    if (prev && prev !== st && (document.hidden || !visible.has(s.name))) {
      if (st === 'idle' && prev === 'busy') notify(s.name, `Terminó: ${cleanTitle(s.title) || 'espera tu respuesta'}`);
      if (st === 'ask') notify(s.name, 'Claude está pidiendo permiso');
    }
    prevBusy.set(s.name, st);
    if (visible.has(s.name) && !document.hidden) lastSeen[s.name] = Date.now();
  }
  localStorage.setItem('hermes.lastSeen', JSON.stringify(lastSeen));
  render();
}

function render() {
  const visible = visibleNames();
  $('#n-live').textContent = sessions.length || '';
  const ul = $('#sessions');
  ul.innerHTML = '';
  sessions.forEach((s, i) => {
    const li = document.createElement('li');
    const st = stateOf(s);
    const paneIdx = panes.indexOf(s.name);
    li.className = [
      s.name === current ? 'active' : '',
      s.name !== current && paneIdx >= 0 && LAYOUTS[layout].n > 1 ? 'shown' : '',
      !visible.has(s.name) && s.activity > (lastSeen[s.name] || 0) ? 'unseen' : '',
    ].join(' ');
    li.title = `${s.cwd}\nComando: ${s.command}\nCreada hace ${ago(s.created)}`;
    li.innerHTML = `<span class="dot ${st}"></span><span class="name"></span><span class="key">${i < 9 ? 'Alt+' + (i + 1) : ''}</span><span class="sub"></span>`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.sub').textContent = describe(s);
    if (s.saved) li.querySelector('.name').insertAdjacentHTML('beforeend', ' <span class="saved-mark" title="Guardada en el catálogo">★</span>');
    li.onclick = () => { if (view !== 'terms') setView('terms'); select(s.name); if (phone.matches) setSidebar(true); };
    ul.appendChild(li);
  });

  // cabeceras de los paneles
  paneEls.forEach((p, i) => {
    const s = sessions.find(x => x.name === panes[i]);
    p.root.classList.toggle('focused', i === focused);
    p.root.classList.toggle('vacant', !s);
    p.name.textContent = s ? s.name : 'vacío';
    p.cwd.textContent = s ? prettyPath(s.cwd) : '';
    p.dot.className = 'dot ' + (s ? stateOf(s) : '');
    p.dot.title = s ? STATE_LABEL[stateOf(s)] || s.command : '';
    if (!s) renderPicker(p, i);
  });

  const s = sessions.find(x => x.name === current);
  $('#cur-name').textContent = s ? s.name : '—';
  $('#cur-cwd').textContent = s ? prettyPath(s.cwd) : '';
  for (const b of ['#btn-upload', '#btn-diff', '#btn-copy', '#btn-rename', '#btn-kill']) $(b).disabled = !s;
  tools.updateQuickbar();
  const sv = $('#btn-save-live');
  sv.disabled = !s || (!s.uuid && !s.saved);
  sv.innerHTML = `★<span class="lbl"> ${s?.saved ? 'Ficha' : 'Guardar'}</span>`;
  sv.title = s?.saved ? `Ver la ficha de «${s.saved.name}»`
    : s?.uuid ? 'Guardar esta sesión en el catálogo (con su ID de conversación)'
    : 'Solo se pueden guardar conversaciones nuevas abiertas desde HermesWeb o hcw (su ID se conoce)';
  $('#empty').style.display = sessions.length ? 'none' : 'flex';
  document.querySelectorAll('#layouts button[data-layout]').forEach(b => b.classList.toggle('on', b.dataset.layout === layout));
  $('#btn-zoom').classList.toggle('on', zoomed);
  $('#btn-zoom').disabled = LAYOUTS[layout].n === 1;
  document.title = (sessions.some(x => !visible.has(x.name) && x.activity > (lastSeen[x.name] || 0)) ? '● ' : '') +
    (host ? `${host} · HermesWeb` : 'HermesWeb');
}

// Panel vacío: lista para elegir qué sesión mostrar
function renderPicker(p, i) {
  const free = sessions.filter(s => !panes.includes(s.name));
  const key = free.map(s => s.name).join('|');
  if (p.picker.dataset.key === key) return;
  p.picker.dataset.key = key;
  p.picker.innerHTML = '';
  const label = document.createElement('p');
  label.textContent = free.length ? 'Elige una sesión para este panel' : 'Todas las sesiones ya están a la vista';
  p.picker.appendChild(label);
  for (const s of free) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="dot ${stateOf(s)}"></span>`;
    b.append(s.name);
    b.onclick = e => { e.stopPropagation(); assign(i, s.name); };
    p.picker.appendChild(b);
  }
  const nb = document.createElement('button');
  nb.textContent = '+ Nueva sesión';
  nb.className = 'ghost';
  nb.onclick = e => { e.stopPropagation(); focusPane(i); openNew(); };
  p.picker.appendChild(nb);
}

// ---------- grilla ----------
function buildGrid() {
  const n = LAYOUTS[layout].n;
  panes = Array.from({ length: n }, (_, i) => panes[i] ?? null);
  if (focused >= n) focused = 0;
  if (n === 1) zoomed = false;
  const grid = $('#grid');
  grid.className = `l-${layout}${zoomed ? ' zoomed' : ''}`;
  while (paneEls.length > n) { const p = paneEls.pop(); p.ro.disconnect(); p.root.remove(); }
  while (paneEls.length < n) {
    const i = paneEls.length;
    const root = document.createElement('section');
    root.className = 'pane';
    root.innerHTML = `
      <header class="pane-head">
        <span class="dot"></span><strong class="p-name"></strong><span class="p-cwd"></span>
        <span class="p-size"></span>
        <button class="p-close" title="Quitar del panel (la sesión sigue corriendo)">×</button>
      </header>
      <div class="pane-body"><div class="picker"></div></div>`;
    grid.appendChild(root);
    const p = {
      root, head: root.querySelector('.pane-head'), body: root.querySelector('.pane-body'),
      name: root.querySelector('.p-name'), cwd: root.querySelector('.p-cwd'),
      size: root.querySelector('.p-size'), dot: root.querySelector('.dot'), picker: root.querySelector('.picker'),
    };
    root.addEventListener('mousedown', () => { if (focused !== i) focusPane(i, false); });
    root.addEventListener('focusin', () => { if (focused !== i) focusPane(i, false); });
    p.head.addEventListener('dblclick', () => toggleZoom());
    root.querySelector('.p-close').onclick = e => { e.stopPropagation(); assign(i, null); };
    p.ro = new ResizeObserver(() => fitPane(i));
    p.ro.observe(p.body);
    paneEls.push(p);
  }
  placeTerms();
}

function fillEmptyPanes() {
  const free = sessions.map(s => s.name).filter(n => !panes.includes(n));
  panes = panes.map(n => n ?? free.shift() ?? null);
}

// mueve cada terminal a su panel; las que no están a la vista quedan en reserva (siguen conectadas)
function placeTerms() {
  const pool = $('#pool');
  const shown = new Set();
  panes.forEach((name, i) => {
    const p = paneEls[i];
    if (!p) return;
    if (!name) { for (const el of p.body.querySelectorAll('.term')) pool.appendChild(el); return; }
    const t = terms.get(name) || makeTerm(name, p.body);
    for (const el of p.body.querySelectorAll('.term')) if (el !== t.el) pool.appendChild(el);
    if (t.el.parentNode !== p.body) p.body.appendChild(t.el);
    shown.add(name);
  });
  for (const t of terms.values()) if (!shown.has(t.name) && t.el.parentNode !== pool) pool.appendChild(t.el);
  current = panes[focused] ?? null;
  $('#grid').className = `l-${layout}${zoomed ? ' zoomed' : ''}`;
  applySplit();
  saveLayout();
  requestAnimationFrame(() => paneEls.forEach((_, i) => fitPane(i)));
  render();
}

function fitPane(i) {
  const p = paneEls[i], t = terms.get(panes[i]);
  if (!p || !t || !p.body.offsetWidth || !p.body.offsetHeight) return;
  const before = `${t.term.cols}x${t.term.rows}`;
  try { t.fit.fit(); } catch { return; }
  p.size.textContent = `${t.term.cols}×${t.term.rows}`;
  if (`${t.term.cols}x${t.term.rows}` !== before) sendResize(t);
}

function focusPane(i, focusTerm = true) {
  focused = i;
  current = panes[i] ?? null;
  if (view === 'terms') history.replaceState(null, '', current ? '#' + encodeURIComponent(current) : location.pathname);
  const t = terms.get(current);
  if (t) {
    lastSeen[current] = Date.now();
    showConn(t);
    if (focusTerm) requestAnimationFrame(() => t.term.focus());
  } else {
    $('#conn').textContent = '';
  }
  saveLayout();
  render();
}

function assign(i, name) {
  if (name) {
    const j = panes.indexOf(name);
    if (j >= 0 && j !== i) panes[j] = panes[i];   // intercambiar si ya estaba en otro panel
  }
  panes[i] = name;
  placeTerms();
  focusPane(i);
}

// Elegir una sesión (barra lateral, Alt+número, nueva sesión, notificación)
function select(name) {
  if (!name) return focusPane(focused);
  const j = panes.indexOf(name);
  if (j >= 0) { if (zoomed && j !== focused) { zoomed = false; placeTerms(); } return focusPane(j); }
  assign(focused, name);
}

function setLayout(l) {
  if (!LAYOUTS[l]) return;
  layout = l;
  zoomed = false;
  buildGrid();
  fillEmptyPanes();
  placeTerms();
  focusPane(Math.min(focused, LAYOUTS[l].n - 1));
}

function toggleZoom() {
  if (LAYOUTS[layout].n === 1) return;
  zoomed = !zoomed;
  placeTerms();
  focusPane(focused);
}

// Alt+Shift+flechas: mover el foco al panel en esa dirección
function moveFocus(dir) {
  if (zoomed || paneEls.length < 2) return;
  const r0 = paneEls[focused].root.getBoundingClientRect();
  const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
  let best = -1, bestD = Infinity;
  paneEls.forEach((p, i) => {
    if (i === focused) return;
    const r = p.root.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dx = c.x - c0.x, dy = c.y - c0.y;
    const ok = { left: dx < -10, right: dx > 10, up: dy < -10, down: dy > 10 }[dir];
    if (!ok) return;
    const d = Math.abs(dx) + Math.abs(dy) * (dir === 'left' || dir === 'right' ? 2 : 0.5);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) focusPane(best);
}

// ---------- paneles redimensionables ----------
// Proporciones por distribución: r = alto de la fila de arriba, c = ancho de la columna izquierda
const SPLITS = { rows2: ['r'], cols2: ['c'], tri: ['r', 'c'], grid4: ['r', 'c'] };
const split = JSON.parse(localStorage.getItem('hermes.split') || '{}');
const ratio = (k) => split[layout]?.[k] ?? 0.5;

function applySplit() {
  const g = $('#grid');
  const axes = (!zoomed && SPLITS[layout]) || [];
  g.style.gridTemplateRows = axes.includes('r') ? `${ratio('r')}fr ${1 - ratio('r')}fr` : '';
  g.style.gridTemplateColumns = axes.includes('c') ? `${ratio('c')}fr ${1 - ratio('c')}fr` : '';
  requestAnimationFrame(placeSplitters);
}

function placeSplitters() {
  const box = $('#splitters');
  const axes = (!zoomed && view === 'terms' && SPLITS[layout]) || [];
  // reutilizar los divisores existentes (recrearlos cortaría un arrastre en curso)
  if (box.dataset.key !== `${layout}:${axes.join('')}`) {
    box.dataset.key = `${layout}:${axes.join('')}`;
    box.innerHTML = '';
    for (const k of axes) {
      const el = document.createElement('div');
      el.className = 'splitter ' + (k === 'c' ? 'v' : 'h');
      el.dataset.k = k;
      el.title = 'Arrastra para cambiar el tamaño · doble clic: mitad y mitad';
      el.addEventListener('pointerdown', e => startDrag(e, k, el));
      el.addEventListener('dblclick', () => { (split[layout] ||= {})[k] = 0.5; saveSplit(); applySplit(); });
      box.appendChild(el);
    }
  }
  if (!axes.length || !paneEls[0]) return;
  const base = $('#terminals').getBoundingClientRect();
  const a = paneEls[0].root.getBoundingClientRect();
  const g = $('#grid').getBoundingClientRect();
  for (const el of box.children) {
    if (el.dataset.k === 'c') {   // vertical: entre las columnas (en "tri" solo en la fila de arriba)
      Object.assign(el.style, { left: `${a.right - base.left - 3}px`, top: `${a.top - base.top}px`,
        height: `${layout === 'tri' ? a.height : g.height}px` });
    } else {                      // horizontal: entre las filas
      Object.assign(el.style, { top: `${a.bottom - base.top - 3}px`, left: `${g.left - base.left}px`, width: `${g.width}px` });
    }
  }
}

function startDrag(e, k, el) {
  e.preventDefault();
  try { el.setPointerCapture(e.pointerId); } catch {}
  el.classList.add('dragging');
  document.body.classList.add(k === 'c' ? 'resizing-v' : 'resizing-h');
  const g = $('#grid').getBoundingClientRect();
  const move = ev => {
    const v = k === 'c' ? (ev.clientX - g.left) / g.width : (ev.clientY - g.top) / g.height;
    (split[layout] ||= {})[k] = Math.round(Math.max(0.15, Math.min(0.85, v)) * 1000) / 1000;
    applySplit();
  };
  let done = false;
  const up = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', up);
    document.body.classList.remove('resizing-v', 'resizing-h');
    saveSplit();
    applySplit();
  };
  // en window (no solo en el divisor): el divisor se reubica mientras se arrastra
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}
const saveSplit = () => localStorage.setItem('hermes.split', JSON.stringify(split));
new ResizeObserver(() => requestAnimationFrame(placeSplitters)).observe($('#terminals'));

// ---------- terminales ----------
function makeTerm(name, parent) {
  const el = document.createElement('div');
  el.className = 'term';
  parent.appendChild(el);   // abrir xterm en un contenedor visible (necesita medir la fuente)
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, "DejaVu Sans Mono", monospace',
    fontSize: 14, cursorBlink: true, theme: THEME, scrollback: 2000, allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (globalShortcut(e)) return false;
    // Ctrl+Shift+C copia la selección (Shift+arrastrar para seleccionar)
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()); e.preventDefault(); return false;
    }
    return true;
  });
  const t = { name, term, fit, el, ws: null, retry: 0, closedByUs: false };
  term.onData(d => t.ws?.readyState === 1 && t.ws.send(enc.encode(d)));
  term.onBinary(d => t.ws?.readyState === 1 &&
    t.ws.send(Uint8Array.from(d, c => c.charCodeAt(0) & 0xff)));
  terms.set(name, t);
  connect(t);
  return t;
}

function connect(t) {
  const { cols, rows } = t.term;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?` +
    new URLSearchParams({ session: t.name, cols, rows }));
  ws.binaryType = 'arraybuffer';
  t.ws = ws;
  setConn(t, 'conectando…', '');
  ws.onopen = () => { t.retry = 0; setConn(t, 'conectado', 'ok'); sendResize(t); };
  ws.onmessage = e => t.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = () => {
    if (t.closedByUs) return;
    setConn(t, 'desconectado', 'bad');
    const delay = Math.min(10000, 500 * 2 ** t.retry++);
    setTimeout(async () => {
      await refresh();
      if (terms.get(t.name) === t && sessions.some(s => s.name === t.name)) connect(t);
    }, delay);
  };
}

function setConn(t, text, cls) {
  t.connText = text; t.connCls = cls;
  if (t.name === current) showConn(t);
  const i = panes.indexOf(t.name);
  if (paneEls[i]) paneEls[i].root.classList.toggle('offline', cls === 'bad');
}
function showConn(t) { $('#conn').textContent = t.connText || ''; $('#conn').className = 'conn ' + (t.connCls || ''); }

function sendResize(t) {
  if (t.ws?.readyState === 1) t.ws.send('\x00' + JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
}

function destroyTerm(name) {
  const t = terms.get(name);
  if (!t) return;
  t.closedByUs = true;
  t.ws?.close();
  t.term.dispose();
  t.el.remove();
  terms.delete(name);
}

// ---------- barra lateral contraíble ----------
// En el teléfono el panel es un menú superpuesto: arranca cerrado y no se recuerda
const phone = matchMedia('(max-width: 700px)');
function setSidebar(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (!phone.matches) localStorage.setItem('hermes.sidebarCollapsed', collapsed ? '1' : '');
  requestAnimationFrame(() => paneEls.forEach((_, i) => fitPane(i)));
}
const toggleSidebar = () => setSidebar(!document.body.classList.contains('sidebar-collapsed'));
$('#btn-collapse').onclick = toggleSidebar;
$('#btn-expand').onclick = toggleSidebar;
setSidebar(phone.matches || !!localStorage.getItem('hermes.sidebarCollapsed'));
$('#scrim').onclick = () => setSidebar(true);
// en el teléfono no hay lugar para varias terminales a la vez
const phoneLayout = () => { if (phone.matches && layout !== 'single') setLayout('single'); };
phone.addEventListener('change', () => { phoneLayout(); setSidebar(phone.matches || !!localStorage.getItem('hermes.sidebarCollapsed')); });

// ---------- notificaciones ----------
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: title });
  n.onclick = () => { window.focus(); setView('terms'); select(title); n.close(); };
}
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

// ---------- atajos ----------
const LAYOUT_KEYS = ['single', 'rows2', 'cols2', 'tri', 'grid4'];
function openKeys() { const d = $('#dlg-keys'); if (!d.open) d.showModal(); }
$('#btn-keys').onclick = openKeys;
$('#keys-close').onclick = () => $('#dlg-keys').close();

// Se llama desde la terminal (xterm) y otra vez cuando el mismo evento sube al document:
// la marca evita ejecutar dos veces un atajo que alterna (zoom, barra lateral, pantalla completa…).
function globalShortcut(e) {
  if (e.__hermes !== undefined) return e.__hermes;
  return (e.__hermes = handleShortcut(e));
}

function handleShortcut(e) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyH') { e.preventDefault(); openKeys(); return true; }
  // "?" abre la ayuda si no se está escribiendo (en una terminal "?" va a la terminal)
  if (e.key === '?' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.target.closest?.('.xterm')
      && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
    e.preventDefault(); openKeys(); return true;
  }
  if (view === 'saved' && !e.altKey && !e.ctrlKey && !e.metaKey && saved.onKey(e)) return true;
  if (!e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.code === 'KeyJ') { e.preventDefault(); launcher.open(e.shiftKey ? 'saved' : 'terms'); return true; }
  if (e.code === 'KeyG' && !e.shiftKey) { e.preventDefault(); setView(view === 'terms' ? 'saved' : 'terms'); return true; }
  if (view === 'saved' && e.code === 'KeyN' && !e.shiftKey) { e.preventDefault(); saved.openForm(); return true; }
  if (e.shiftKey) {
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.code];
    if (dir) { e.preventDefault(); moveFocus(dir); return true; }
    const m = /^Digit([1-5])$/.exec(e.code);
    if (m) { e.preventDefault(); setLayout(LAYOUT_KEYS[m[1] - 1]); return true; }
    if (e.code === 'KeyD') { e.preventDefault(); tools.openDiff(); return true; }
    if (e.code === 'KeyF') { e.preventDefault(); tools.toggleFullscreen(); return true; }
    if (e.code === 'KeyK') { e.preventDefault(); tools.toggleQuickbar(); return true; }
    return false;
  }
  if (e.code === 'KeyN') { e.preventDefault(); openNew(); return true; }
  if (e.code === 'KeyS') { e.preventDefault(); toggleSidebar(); return true; }
  if (e.code === 'KeyZ') { e.preventDefault(); toggleZoom(); return true; }
  const m = /^Digit([1-9])$/.exec(e.code);
  if (m && sessions[m[1] - 1]) { e.preventDefault(); setView('terms'); select(sessions[m[1] - 1].name); return true; }
  return false;
}

// ---------- vistas: terminales / guardadas ----------
let savedTimer;
function setView(v) {
  view = v;
  $('#terms-view').hidden = v !== 'terms';
  $('#saved-view').hidden = v !== 'saved';
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  clearInterval(savedTimer);
  if (v === 'saved') {
    if (!location.hash.startsWith('#saved')) history.replaceState(null, '', '#saved');
    saved.load();
    savedTimer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) saved.load(); }, 5000);
  } else {
    history.replaceState(null, '', current ? '#' + encodeURIComponent(current) : location.pathname);
    requestAnimationFrame(() => { paneEls.forEach((_, i) => fitPane(i)); placeSplitters(); terms.get(current)?.term.focus(); });
  }
}
document.querySelectorAll('#views button').forEach(b => b.onclick = () => { setView(b.dataset.view); if (phone.matches) setSidebar(true); });
$('#btn-expand-2').onclick = () => toggleSidebar();

saved.init({
  toast: (msg, err) => toast(msg, err),
  home: '',
  async onOpen(name) {
    setView('terms');
    await refresh();
    select(name);
  },
});

$('#btn-save-live').onclick = () => {
  const s = sessions.find(x => x.name === current);
  if (!s) return;
  if (s.saved) { setView('saved'); saved.show(s.saved.name); return; }
  saved.openForm(null, { session_uuid: s.uuid, cwd: s.cwd, name: s.name, title: cleanTitle(s.title).replace(/^Claude Code$/, ''), session_live: true });
};
document.addEventListener('keydown', globalShortcut);

document.querySelectorAll('#layouts button[data-layout]').forEach(b => {
  b.title = `${LAYOUTS[b.dataset.layout].label} (Alt+Shift+${LAYOUT_KEYS.indexOf(b.dataset.layout) + 1})`;
  b.onclick = () => setLayout(b.dataset.layout);
});
$('#btn-zoom').onclick = toggleZoom;

// ---------- acciones ----------
function openNew() {
  const f = $('#form-new');
  f.reset();
  f.name.value = '';
  $('#new-error').textContent = '';
  const dirs = [...new Set([...recentDirs, ...sessions.map(s => prettyPath(s.cwd))])].slice(0, 15);
  $('#recent-dirs').innerHTML = dirs.map(d => `<option value="${d.replace(/"/g, '&quot;')}">`).join('');
  f.cwd.value = dirs[0] || '~';
  $('#dlg-new').showModal();
  f.name.focus();
}
$('#btn-new').onclick = openNew;
$('#btn-new-2').onclick = openNew;
document.querySelectorAll('.presets button').forEach(b => b.onclick = () => { $('#form-new').command.value = b.dataset.cmd; });

$('#form-new').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value.trim(), cwd: f.cwd.value.trim(), command: f.command.value };
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) { $('#new-error').textContent = data.error; return; }
  if (body.cwd) {
    const i = recentDirs.indexOf(body.cwd);
    if (i >= 0) recentDirs.splice(i, 1);
    recentDirs.unshift(body.cwd);
    localStorage.setItem('hermes.recentDirs', JSON.stringify(recentDirs.slice(0, 15)));
  }
  $('#dlg-new').close();
  await refresh();
  // va al panel enfocado si está vacío, si no al primer panel vacío, si no reemplaza el enfocado
  const firstFree = panes.indexOf(null);
  assign(panes[focused] == null ? focused : firstFree >= 0 ? firstFree : focused, body.name);
});

$('#btn-kill').onclick = async () => {
  if (!current || !confirm(`¿Cerrar la sesión "${current}"? Se termina el proceso que corre en ella.`)) return;
  const name = current;
  await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
  panes = panes.map(n => (n === name ? null : n));
  destroyTerm(name);
  placeTerms();
  focusPane(focused);
  refresh();
};

$('#btn-rename').onclick = async () => {
  const old = current;
  const newName = prompt('Nuevo nombre', old)?.trim();
  if (!newName || newName === old) return;
  const r = await fetch('/api/sessions/' + encodeURIComponent(old), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newName }),
  });
  if (!r.ok) return alert((await r.json()).error);
  destroyTerm(old);
  panes = panes.map(n => (n === old ? newName : n));
  await refresh();
  placeTerms();
  focusPane(focused);
};

$('#btn-logout').onclick = async () => {
  leaving = true;
  for (const name of [...terms.keys()]) destroyTerm(name);
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login');
};

$('#btn-copy').onclick = () => {
  navigator.clipboard.writeText(`hcw a ${current}`);
  $('#btn-copy').textContent = '¡Copiado!';
  setTimeout(() => ($('#btn-copy').textContent = 'hcw a'), 1200);
};

// ---------- imágenes: botón, Ctrl+V y arrastrar ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let toastTimer;
function toast(msg, isError = false, ms = 3500) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.className = ''), ms);
}

async function uploadImages(files, session = current) {
  const imgs = [...files].filter(f => IMAGE_TYPES.includes(f.type));
  if (!session || !imgs.length) {
    if (files.length) toast('Solo imágenes PNG, JPG, GIF o WebP', true);
    return;
  }
  const skipped = files.length - imgs.length;
  toast(`Subiendo ${imgs.length} imagen${imgs.length > 1 ? 'es' : ''} a ${session}…`, false, 0);
  const results = await Promise.allSettled(imgs.map(async f => {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/upload`, {
      method: 'POST',
      headers: { 'content-type': f.type, 'x-filename': encodeURIComponent(f.name || 'pegada') },
      body: f,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${f.name}: ${data.error || (r.status === 413 ? 'demasiado grande (máx 20 MB)' : r.status)}`);
    return data.path;
  }));
  const paths = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (paths.length) {
    // como arrastrar archivos a la consola: rutas separadas por espacio, sin Enter
    await fetch(`/api/sessions/${encodeURIComponent(session)}/paste`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: paths.join(' ') + ' ' }),
    });
  }
  if (errors.length || skipped) toast([...errors, skipped ? `${skipped} archivo(s) no son imágenes` : ''].filter(Boolean).join(' · '), true, 6000);
  else toast(`${paths.length} imagen${paths.length > 1 ? 'es adjuntadas' : ' adjuntada'} en ${session} — escribe tu mensaje y Enter`);
  terms.get(session)?.term.focus();
}

$('#btn-upload').onclick = () => $('#file-input').click();
$('#file-input').onchange = e => { uploadImages(e.target.files); e.target.value = ''; };

// Ctrl+V con una imagen en el portapapeles (ej. captura con Win+Shift+S) → panel enfocado
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => IMAGE_TYPES.includes(f.type));
  if (!files.length || !current) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  uploadImages(files);
}, true);

// Arrastrar imágenes: van al panel sobre el que se sueltan
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const paneOf = e => paneEls.findIndex(p => p.root.contains(e.target));
let dragPane = null;
$('#grid').addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const i = paneOf(e);
  const p = paneEls[i];
  if (dragPane !== p) { dragPane?.root.classList.remove('dragover'); dragPane = panes[i] ? p : null; dragPane?.root.classList.add('dragover'); }
});
$('#grid').addEventListener('dragleave', e => {
  if (!$('#grid').contains(e.relatedTarget)) { dragPane?.root.classList.remove('dragover'); dragPane = null; }
});
$('#grid').addEventListener('drop', e => {
  e.preventDefault();
  dragPane?.root.classList.remove('dragover'); dragPane = null;
  const i = paneOf(e);
  if (i < 0 || !panes[i] || !e.dataTransfer?.files?.length) return;
  focusPane(i);
  uploadImages(e.dataTransfer.files, panes[i]);
});

// Evitar cerrar la pestaña por accidente (Ctrl+W) con sesiones abiertas
window.addEventListener('beforeunload', e => { if (!leaving && terms.size) e.preventDefault(); });

tools.init({
  current: () => current,
  currentSession: () => sessions.find(s => s.name === current),
  host: () => host,
  pretty: prettyPath,
  toast: (m, err, ms) => toast(m, err, ms),
  // envía bytes a la sesión como si se tipearan en su terminal
  send: (name, data) => { const t = terms.get(name); if (t?.ws?.readyState === 1) t.ws.send(enc.encode(data)); },
  focusTerm: () => terms.get(current)?.term.focus(),
  refit: () => requestAnimationFrame(() => { paneEls.forEach((_, i) => fitPane(i)); placeSplitters(); }),
});

launcher.init({
  sessions: () => sessions,
  current: () => current,
  describe, stateOf,
  pretty: prettyPath,
  toast: (m, err) => toast(m, err),
  focusTerm: () => terms.get(current)?.term.focus(),
  select: name => { setView('terms'); select(name); if (phone.matches) setSidebar(true); },
  async openSaved(name, live) {
    if (live) { setView('terms'); select(live); return; }
    try {
      const r = await fetch(`/api/saved/${encodeURIComponent(name)}/open`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo abrir');
      toast(d.already ? `Ya estaba abierta en «${d.name}»` : d.mode === 'resume' ? `Retomando «${name}»…` : `Iniciando «${name}»…`);
      setView('terms'); await refresh(); select(d.name);
    } catch (e) { toast(e.message, true); }
  },
});

// ---------- arranque ----------
buildGrid();
await refresh();
const fromHash = decodeURIComponent(location.hash.slice(1));
if (fromHash.startsWith('saved')) {
  focusPane(focused);
  setView('saved');
  const name = fromHash.split('=')[1];
  if (name) saved.show(name);
} else if (fromHash && sessions.some(s => s.name === fromHash)) select(fromHash);
else focusPane(focused);
saved.load();
window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('saved')) { setView('saved'); const n = h.split('=')[1]; if (n) saved.show(n); }
});
setInterval(refresh, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
