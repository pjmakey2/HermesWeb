// Lanzador estilo rofi: buscar y saltar a una terminal abierta (Alt+J) o abrir una sesión guardada (Alt+Shift+J).
// Teclado: escribir filtra · ↑↓←→ (o Ctrl+N/P) mueven · Enter elige · Tab cambia de lista · Esc cierra.
let ctx;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MODES = { terms: 'Terminales', saved: 'Guardadas' };

let mode = 'terms', items = [], shown = [], sel = 0, savedCache = null, token = 0;

// Puntaje de coincidencia: prefijo > palabra > subcadena > letras en orden (tipo fuzzy). null = no coincide.
function score(q, text) {
  if (!q) return 0;
  const t = text.toLowerCase();
  let total = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = t.indexOf(w);
    if (i === 0) total += 100;
    else if (i > 0) total += /[\s/·_\-.]/.test(t[i - 1]) ? 70 : 40;
    else {
      let j = 0, gaps = 0;
      for (const c of w) { const k = t.indexOf(c, j); if (k < 0) return null; gaps += k - j; j = k + 1; }
      total += Math.max(1, 20 - gaps);
    }
  }
  return total;
}

function termItems() {
  return ctx.sessions().map((s, i) => ({
    key: s.name, title: s.name, sub: ctx.describe(s), state: ctx.stateOf(s),
    badge: s.name === ctx.current() ? 'actual' : i < 9 ? `Alt+${i + 1}` : '',
    hay: `${s.name} ${ctx.describe(s)} ${s.cwd}`,
    run: () => ctx.select(s.name),
  }));
}

async function loadSaved() {
  const r = await fetch('/api/saved?status=active');
  if (!r.ok) throw new Error('No se pudieron leer las sesiones guardadas');
  const list = (await r.json()).sessions;
  list.sort((a, b) => (b.pinned - a.pinned) || (b.last_activity || 0) - (a.last_activity || 0));
  return list.map(s => ({
    key: 'saved:' + s.name, title: s.name,
    sub: [s.title, s.group, ctx.pretty(s.cwd)].filter(Boolean).join(' · '),
    state: s.live ? 'idle' : 'off', badge: s.live ? 'abierta' : s.pinned ? '★' : '',
    hay: `${s.name} ${s.title || ''} ${s.group || ''} ${s.cwd || ''} ${s.summary || ''}`,
    run: () => ctx.openSaved(s.name, s.live),
  }));
}

async function setMode(m) {
  mode = m;
  $('#ln-mode').textContent = MODES[m];
  $('#ln-q').placeholder = m === 'terms' ? 'Buscar terminal…' : 'Buscar sesión guardada…';
  if (m === 'terms') items = termItems();
  else {
    items = savedCache || [];
    const my = ++token;
    if (!savedCache) $('#ln-list').innerHTML = '<p class="ln-empty">Cargando…</p>';
    try { savedCache = await loadSaved(); if (my === token && mode === 'saved') items = savedCache; }
    catch (e) { ctx.toast(e.message, true); }
  }
  filter();
}

function filter() {
  const q = $('#ln-q').value.trim();
  shown = items.map((it, i) => ({ it, s: score(q, it.hay), i }))
    .filter(x => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.it);
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  if (!q) sel = mode === 'terms' ? Math.max(0, shown.findIndex(x => x.badge === 'actual') + 1) % Math.max(1, shown.length) : 0;
  draw();
}

function draw() {
  const ul = $('#ln-list');
  if (!shown.length) {
    ul.innerHTML = `<p class="ln-empty">${items.length ? 'Nada coincide' : mode === 'terms' ? 'No hay terminales abiertas' : 'No hay sesiones guardadas'}</p>`;
    return;
  }
  ul.innerHTML = shown.map((it, i) => `
    <li class="${i === sel ? 'on' : ''}" data-i="${i}">
      <span class="ln-ico ${esc(it.state)}">${esc(it.title.slice(0, 1).toUpperCase())}</span>
      <span class="ln-txt"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span>
      ${it.badge ? `<span class="ln-badge">${esc(it.badge)}</span>` : ''}
    </li>`).join('');
  ul.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
}

const cols = () => (matchMedia('(max-width: 700px)').matches ? 1 : 2);
function move(d) { if (shown.length) { sel = (sel + d + shown.length) % shown.length; draw(); } }

function choose(i = sel) {
  const it = shown[i];
  if (!it) return;
  $('#dlg-launcher').close();
  it.run();
}

export function open(m = 'terms') {
  const dlg = $('#dlg-launcher');
  if (dlg.open && mode === m) { dlg.close(); return; }      // el mismo atajo lo cierra
  $('#ln-q').value = '';
  sel = 0;
  if (m === 'saved') savedCache = null;                      // siempre fresco al abrir
  if (!dlg.open) dlg.showModal();
  setMode(m);
  $('#ln-q').focus();
}

export function init(c) {
  ctx = c;
  const dlg = $('#dlg-launcher');
  $('#ln-q').addEventListener('input', () => { sel = 0; filter(); });
  $('#ln-mode').onclick = () => { setMode(mode === 'terms' ? 'saved' : 'terms'); $('#ln-q').focus(); };
  $('#ln-list').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
  $('#ln-list').addEventListener('mousemove', e => {
    const li = e.target.closest('li[data-i]');
    if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; draw(); }
  });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // clic fuera
  dlg.addEventListener('close', () => { token++; ctx.focusTerm(); });
  dlg.addEventListener('keydown', e => {
    const k = e.key, c = cols();
    if (k === 'Tab') { e.preventDefault(); setMode(mode === 'terms' ? 'saved' : 'terms'); return; }
    if (k === 'Enter') { e.preventDefault(); choose(); return; }
    if (k === 'ArrowDown' || (e.ctrlKey && (k === 'n' || k === 'j'))) { e.preventDefault(); move(c); return; }
    if (k === 'ArrowUp' || (e.ctrlKey && (k === 'p' || k === 'k'))) { e.preventDefault(); move(-c); return; }
    if (c > 1 && k === 'ArrowRight' && $('#ln-q').selectionStart === $('#ln-q').value.length) { e.preventDefault(); move(1); return; }
    if (c > 1 && k === 'ArrowLeft' && $('#ln-q').selectionStart === $('#ln-q').value.length && $('#ln-q').value === '') { e.preventDefault(); move(-1); return; }
    if (k === 'PageDown') { e.preventDefault(); move(c * 5); return; }
    if (k === 'PageUp') { e.preventDefault(); move(-c * 5); return; }
  });
}
