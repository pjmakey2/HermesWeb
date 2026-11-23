// Vista "Sesiones guardadas": catálogo, ficha (reseña + historia), alta/edición y descubrir.
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = s => DOMPurify.sanitize(marked.parse(s || '', { breaks: true, gfm: true }));
const KINDS = ['avance', 'decisión', 'problema', 'pendiente', 'nota'];
const KIND_LABEL = { resume: '', new: 'sin iniciar', launcher: 'lanzador' };

let ctx;                    // { onOpen(name), toast(msg, err), home }
let data = { sessions: [], groups: [], counts: {} };
let status = 'active';
let sort = localStorage.getItem('hermes.savedSort') || 'group';
let query = '';
let selected = null;        // nombre de la sesión abierta en la ficha
let detail = null;
const collapsed = new Set(JSON.parse(localStorage.getItem('hermes.savedCollapsed') || '[]'));

// UUID v4 (crypto.randomUUID solo existe en contextos seguros: https o localhost)
export function uuid4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const short = p => (ctx.home && p?.startsWith(ctx.home) ? '~' + p.slice(ctx.home.length) : p || '');
function ago(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.round(s / 86400)} d`;
  return new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}
const fmtDate = iso => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const size = n => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

async function api(method, path, body) {
  const r = await fetch('/api/saved' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}
const copy = (text, what = 'Copiado') => navigator.clipboard.writeText(text).then(() => ctx.toast(what));

// ---------- lista ----------
export async function load() {
  try {
    data = await api('GET', `/?status=${status}&q=${encodeURIComponent(query)}`);
  } catch (e) { ctx.toast(e.message, true); return; }
  ctx.home = data.home;
  $('#n-saved').textContent = data.counts.active || '';
  document.querySelectorAll('#sv-status button').forEach(b => {
    b.classList.toggle('on', b.dataset.status === status);
    const c = b.querySelector('.count');
    if (c) c.textContent = data.counts[b.dataset.status] || 0;
  });
  renderList();
  if (selected && !editing()) loadDetail(selected, false);
}

// no refrescar la ficha si hay una reseña o entrada a medio escribir
const editing = () => !!document.getElementById('sd-summary-text') || (document.getElementById('sd-entry-form') && !document.getElementById('sd-entry-form').hidden);

function row(s) {
  const badges = [
    s.live ? `<span class="badge live" title="Abierta ahora en la terminal «${esc(s.live)}»">● abierta</span>` : '',
    KIND_LABEL[s.kind] ? `<span class="badge ${s.kind}" title="${s.kind === 'new' ? 'Todavía no hay conversación con este ID en esta máquina: «Abrir» la crea' : 'Abre una conversación nueva cada vez'}">${KIND_LABEL[s.kind]}</span>` : '',
    s.status === 'archived' ? '<span class="badge">archivada</span>' : '',
  ].join('');
  return `
    <div class="sv-row ${s.name === selected ? 'on' : ''}" data-name="${esc(s.name)}" tabindex="0">
      <button class="star ${s.pinned ? 'on' : ''}" data-act="pin" title="${s.pinned ? 'Quitar de fijadas' : 'Fijar arriba'}">★</button>
      <div class="sv-main">
        <div class="sv-name"><span class="mono">${esc(s.name)}</span>${badges}</div>
        <div class="sv-sub">${esc(s.title || s.transcript?.title || 'Sin título')}</div>
      </div>
      <div class="sv-cwd mono" title="${esc(s.cwd)}">${esc(short(s.cwd) || '—')}</div>
      <div class="sv-when" title="Última actividad">${ago(s.last_activity)}</div>
      <div class="sv-n" title="Entradas de historia">${s.n_entries ? `${s.n_entries} ✎` : ''}</div>
      <button class="open" data-act="open" title="${s.live ? 'Ir a la terminal' : 'Abrir en una terminal'}">${s.live ? '↗ Ir' : '▶ Abrir'}</button>
    </div>`;
}

function renderList() {
  const box = $('#sv-items');
  const list = [...data.sessions];
  if (!list.length) {
    box.innerHTML = `<div class="sv-empty">${query
      ? `<h3>Sin resultados para «${esc(query)}»</h3><p>Prueba con otro término o cambia de pestaña.</p>`
      : `<h3>No hay sesiones ${status === 'archived' ? 'archivadas' : 'guardadas'}</h3>
         <p>Crea una con <b>+ Nueva</b> o usa <b>Descubrir</b> para guardar conversaciones que ya existen en esta máquina.</p>`}</div>`;
    return;
  }
  const byAct = (a, b) => (b.last_activity || 0) - (a.last_activity || 0);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const sections = [];
  const pinned = list.filter(s => s.pinned).sort(byAct);
  if (pinned.length) sections.push({ key: 'pinned', title: '★ Fijadas', items: pinned });
  const rest = list.filter(s => !s.pinned);
  if (sort === 'group') {
    const by = new Map();
    for (const s of rest) { const k = s.group_id ?? 0; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
    for (const g of data.groups) if (by.has(g.id)) sections.push({ key: 'g' + g.id, title: g.path, icon: g.icon, items: by.get(g.id).sort(byAct) });
    if (by.has(0)) sections.push({ key: 'g0', title: 'Sin grupo', items: by.get(0).sort(byAct) });
  } else {
    sections.push({ key: 'all', title: sort === 'name' ? 'Por nombre' : 'Por actividad', items: rest.sort(sort === 'name' ? byName : byAct) });
  }
  box.innerHTML = sections.map(sec => `
    <section class="sv-sec ${collapsed.has(sec.key) ? 'collapsed' : ''}" data-key="${sec.key}">
      <h3 class="sv-sec-head"><span class="caret">▾</span>${sec.icon ? esc(sec.icon) + ' ' : ''}${esc(sec.title)} <span class="count">${sec.items.length}</span></h3>
      <div class="sv-rows">${sec.items.map(row).join('')}</div>
    </section>`).join('');
}

// ---------- ficha ----------
async function loadDetail(name, scroll = true) {
  try { detail = await api('GET', '/' + encodeURIComponent(name)); }
  catch (e) { selected = null; detail = null; $('#sv-detail').hidden = true; if (scroll) ctx.toast(e.message, true); return; }
  selected = detail.name;
  renderDetail();
  document.querySelectorAll('.sv-row').forEach(r => r.classList.toggle('on', r.dataset.name === selected));
}

export function show(name) {
  if (!name) return;
  selected = name;
  history.replaceState(null, '', '#saved=' + encodeURIComponent(name));
  loadDetail(name);
}

function closeDetail() {
  selected = null; detail = null;
  $('#sv-detail').hidden = true;
  history.replaceState(null, '', '#saved');
  document.querySelectorAll('.sv-row.on').forEach(r => r.classList.remove('on'));
}

function renderDetail() {
  const s = detail, t = s.transcript, p = s.plan;
  const el = $('#sv-detail');
  el.hidden = false;
  const modeText = {
    resume: 'retoma la conversación existente',
    start: 'crea la conversación con este ID (todavía no existe en esta máquina)',
    launcher: 'abre una conversación nueva',
  }[p.mode];
  el.innerHTML = `
    <header class="sd-head">
      <div class="min0">
        <h2 class="mono">${esc(s.name)}</h2>
        <p class="sd-title">${esc(s.title || t?.title || 'Sin título')}</p>
      </div>
      <button class="icon" data-act="close" title="Cerrar ficha (Esc)">×</button>
    </header>
    <div class="sd-actions">
      <button class="primary" data-act="open">${s.live ? `↗ Ir a «${esc(s.live)}»` : '▶ Abrir en terminal'}</button>
      <button data-act="copy-cmd" title="${esc(s.command)}">Copiar comando</button>
      <button data-act="pin" class="${s.pinned ? 'on' : ''}">${s.pinned ? '★ Fijada' : '☆ Fijar'}</button>
      <button data-act="edit">Editar</button>
      <button data-act="archive">${s.status === 'archived' ? 'Reactivar' : 'Archivar'}</button>
      <button data-act="delete" class="danger">Eliminar</button>
    </div>
    ${p.cwdMissing ? `<div class="alert">El directorio <code>${esc(s.cwd)}</code> no existe en esta máquina: se abrirá en tu home.</div>` : ''}

    <div class="sd-card">
      <dl class="meta">
        <dt>Al abrir</dt><dd>${esc(modeText)}<br><code class="cmd">${esc(p.command)}</code></dd>
        <dt>Directorio</dt><dd class="mono">${esc(short(p.cwd))}</dd>
        ${s.session_uuid ? `<dt>ID</dt><dd class="mono">${esc(s.session_uuid)} <button class="link" data-act="copy-uuid">copiar</button></dd>` : ''}
        <dt>Grupo</dt><dd>${esc(s.group || 'Sin grupo')}</dd>
        <dt>Creada</dt><dd>${fmtDate(s.created_at)}${s.last_opened_at ? ` · abierta ${ago(Date.parse(s.last_opened_at))}` : ''}</dd>
        ${t ? `
        <dt>Conversación</dt><dd>activa ${ago(t.mtime)} · ${size(t.size)}${t.cost ? ` · US$ ${t.cost.toFixed(2)}` : ''}</dd>
        ${t.title && t.title !== s.title ? `<dt>Título de Claude</dt><dd>${esc(t.title)}</dd>` : ''}
        ${t.last_prompt ? `<dt>Último prompt</dt><dd class="clamp">${esc(t.last_prompt)}</dd>` : ''}` : ''}
        ${s.start_prompt ? `<dt>Prompt inicial</dt><dd class="clamp">${esc(s.start_prompt)}</dd>` : ''}
      </dl>
    </div>

    <div class="sd-card" id="sd-summary">
      <header><h3>Reseña</h3><button class="link" data-act="edit-summary">${s.summary ? 'Editar' : 'Escribir'}</button></header>
      ${s.summary ? `<div class="prose">${md(s.summary)}</div>`
        : `<p class="muted small">Sin reseña. Desde la sesión: <code>/session-log</code> o <code>hcw summary</code>.</p>`}
    </div>

    <div class="sd-card">
      <header><h3>Historia <span class="count">${s.entries.length}</span></h3>
        <button class="link" data-act="new-entry">+ Entrada</button></header>
      <form id="sd-entry-form" class="entry-form" hidden></form>
      ${s.entries.length ? `<ol class="timeline">${s.entries.map(e => `
        <li data-eid="${e.id}">
          <div class="tl-meta"><span class="badge kind" data-kind="${esc(e.kind)}">${esc(e.kind)}</span>
            <time>${fmtDate(e.created_at)}</time><span class="grow"></span>
            <button class="link" data-act="edit-entry">editar</button></div>
          ${e.title ? `<h4>${esc(e.title)}</h4>` : ''}
          ${e.body ? `<div class="prose sm">${md(e.body)}</div>` : ''}
        </li>`).join('')}</ol>`
        : `<p class="muted small">Sin historia todavía. Desde la sesión: <code>hcw log -t "Título" &lt;&lt;'EOF' … EOF</code></p>`}
    </div>`;
}

function entryForm(e = null) {
  const f = $('#sd-entry-form');
  f.hidden = false;
  f.innerHTML = `
    <div class="row2">
      <select name="kind">${KINDS.map(k => `<option ${e?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input name="title" placeholder="Qué se hizo" value="${esc(e?.title || '')}">
    </div>
    <textarea name="body" rows="5" placeholder="Detalle (markdown)">${esc(e?.body || '')}</textarea>
    <div class="row-actions">
      ${e ? '<button type="button" class="danger" data-act="del-entry">Eliminar</button>' : ''}
      <span class="grow"></span>
      <button type="button" data-act="cancel-entry">Cancelar</button>
      <button class="primary">${e ? 'Guardar' : 'Agregar'}</button>
    </div>`;
  f.dataset.eid = e?.id || '';
  f.title.focus();
}

function summaryEditor() {
  const box = $('#sd-summary');
  box.innerHTML = `
    <header><h3>Reseña</h3></header>
    <textarea id="sd-summary-text" rows="12" placeholder="**Objetivo:** …&#10;&#10;**Estado actual:** …&#10;&#10;**Próximos pasos:** …">${esc(detail.summary)}</textarea>
    <div class="row-actions"><span class="grow"></span>
      <button type="button" data-act="cancel-summary">Cancelar</button>
      <button type="button" class="primary" data-act="save-summary">Guardar reseña</button></div>`;
  $('#sd-summary-text').focus();
}

// ---------- acciones ----------
async function act(action, name, target) {
  const s = data.sessions.find(x => x.name === name) || (detail?.name === name ? detail : null);
  try {
    switch (action) {
      case 'open': {
        if (s?.live) return ctx.onOpen(s.live);
        const r = await api('POST', `/${encodeURIComponent(name)}/open`);
        ctx.toast(r.already ? `Ya estaba abierta en «${r.name}»` : r.mode === 'resume' ? `Retomando «${name}»…` : `Iniciando «${name}»…`);
        ctx.onOpen(r.name);
        break;
      }
      case 'pin':
        await api('PATCH', '/' + encodeURIComponent(name), { pinned: !s.pinned });
        await load();
        break;
      case 'archive':
        await api('PATCH', '/' + encodeURIComponent(name), { status: s.status === 'archived' ? 'active' : 'archived' });
        ctx.toast(s.status === 'archived' ? 'Reactivada' : 'Archivada');
        await load();
        break;
      case 'delete':
        if (!confirm(`¿Eliminar «${name}» con su reseña e historia?\nLa conversación de Claude (transcript) no se toca.`)) return;
        await api('DELETE', '/' + encodeURIComponent(name));
        closeDetail();
        await load();
        break;
      case 'edit': return openForm(detail);
      case 'copy-cmd': return copy(detail.command, 'Comando copiado');
      case 'copy-uuid': return copy(detail.session_uuid, 'ID copiado');
      case 'close': return closeDetail();
      case 'edit-summary': return summaryEditor();
      case 'cancel-summary': return renderDetail();
      case 'save-summary':
        await api('PUT', `/${encodeURIComponent(name)}/summary`, { summary: $('#sd-summary-text').value });
        ctx.toast('Reseña guardada');
        await loadDetail(name);
        break;
      case 'new-entry': return entryForm();
      case 'edit-entry': return entryForm(detail.entries.find(e => e.id === Number(target.closest('li').dataset.eid)));
      case 'cancel-entry': $('#sd-entry-form').hidden = true; return;
      case 'del-entry': {
        if (!confirm('¿Eliminar esta entrada?')) return;
        await api('DELETE', `/${encodeURIComponent(name)}/entries/${$('#sd-entry-form').dataset.eid}`);
        await loadDetail(name);
        break;
      }
    }
  } catch (e) { ctx.toast(e.message, true); }
}

// ---------- formulario ----------
let formSession = null;   // null = alta
let knownUuid = '';       // uuid de una conversación que ya existe (descubierta / en vivo)
function groupOptions(sel) {
  return `<option value="">— Sin grupo —</option>` + data.groups.map(g =>
    `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${'  '.repeat(g.depth)}${g.depth ? '└ ' : ''}${esc(g.name)}</option>`).join('');
}

function knownDirs() {
  const dirs = new Set();
  for (const s of data.sessions) if (s.cwd) dirs.add(short(s.cwd));
  for (const d of JSON.parse(localStorage.getItem('hermes.recentDirs') || '[]')) dirs.add(d);
  return [...dirs].sort();
}

export function openForm(s = null, prefill = {}) {
  formSession = s;
  knownUuid = s?.kind === 'resume' ? s.session_uuid : prefill.session_uuid || '';
  const f = $('#form-saved');
  f.reset();
  $('#fs-error').textContent = '';
  $('#fs-title').textContent = s ? `Editar «${s.name}»` : 'Nueva sesión guardada';
  f.group_id.innerHTML = groupOptions(s?.group_id ?? prefill.group_id ?? null);
  $('#fs-dirs').innerHTML = knownDirs().map(d => `<option value="${esc(d)}">`).join('');
  const v = { ...(s || {}), ...prefill };
  f.name.value = v.name || '';
  f.title.value = v.title || '';
  f.cwd.value = v.cwd ? short(v.cwd) : '';
  f.start_prompt.value = v.start_prompt || '';
  f.claude_args.value = v.claude_args || '';
  const launcher = s ? !s.session_uuid : false;
  f.kind.value = launcher ? 'launcher' : 'conv';
  f.session_uuid.value = s ? s.session_uuid : (prefill.session_uuid || uuid4());
  f.session_uuid.readOnly = !!prefill.session_uuid && !s;
  $('#fs-uuid-hint').textContent = s
    ? 'Cambiarlo apunta la sesión a otra conversación.'
    : prefill.session_uuid ? 'ID de la conversación existente.' : 'Generado aquí: la primera apertura crea la conversación con este ID.';
  $('#fs-open-wrap').hidden = !!s;
  f.open.checked = !s && !prefill.session_live;
  syncForm();
  $('#dlg-saved').showModal();
  (s ? f.title : f.name).focus();
}

function syncForm() {
  const f = $('#form-saved');
  const launcher = f.kind.value === 'launcher';
  $('#fs-uuid-field').hidden = launcher;
  const uuid = launcher ? '<nuevo cada vez>' : f.session_uuid.value.trim() || '<uuid>';
  const exists = !!knownUuid && knownUuid === f.session_uuid.value.trim();
  const flag = !launcher && exists ? '--resume' : '--session-id';
  const prompt = f.start_prompt.value.trim() && !(exists && !launcher) ? ` "${f.start_prompt.value.trim().slice(0, 40)}${f.start_prompt.value.trim().length > 40 ? '…' : ''}"` : '';
  $('#fs-preview').textContent = `claude ${flag} ${uuid} -n ${f.name.value.trim() || '<nombre>'}${f.claude_args.value.trim() ? ' ' + f.claude_args.value.trim() : ''}${prompt}`;
  if (!f.name.value && f.cwd.value && !formSession) f.name.placeholder = f.cwd.value.split('/').filter(Boolean).pop() || 'mi_proyecto';
}

async function submitForm(e) {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim() || f.name.placeholder,
    title: f.title.value.trim(),
    cwd: f.cwd.value.trim(),
    group_id: f.group_id.value || null,
    new_group: f.new_group.value.trim(),
    session_uuid: f.kind.value === 'launcher' ? '' : f.session_uuid.value.trim(),
    start_prompt: f.start_prompt.value,
    claude_args: f.claude_args.value,
  };
  try {
    let r;
    if (formSession) r = await api('PATCH', '/' + encodeURIComponent(formSession.name), body);
    else r = await api('POST', '/', { ...body, open: f.open.checked });
    $('#dlg-saved').close();
    ctx.toast(formSession ? 'Cambios guardados' : `«${r.name}» guardada`);
    selected = r.name;
    await load();
    if (r.openError) ctx.toast(r.openError, true);
    if (r.tmux) ctx.onOpen(r.tmux.name);
    else show(r.name);
  } catch (err) { $('#fs-error').textContent = err.message; }
}

// ---------- descubrir ----------
let dcTimer;
async function discover() {
  const box = $('#dc-items');
  box.innerHTML = '<p class="muted small">Buscando…</p>';
  try {
    const { items, total } = await api('GET', '/discover?q=' + encodeURIComponent($('#dc-q').value));
    box.innerHTML = items.length ? `<p class="muted small">${total} conversación(es) sin guardar${total > items.length ? `, se muestran ${items.length}` : ''}.</p>` + items.map(d => `
      <div class="dc-row" data-uuid="${esc(d.uuid)}">
        <div class="min0">
          <div class="dc-title">${esc(d.title || '(sin título)')}</div>
          <div class="dc-sub mono">${esc(short(d.cwd) || '—')} · ${ago(d.mtime)} · ${size(d.size)}${d.cost ? ` · US$ ${d.cost.toFixed(2)}` : ''}</div>
          ${d.first_prompt && d.first_prompt !== d.title ? `<div class="dc-prompt">${esc(d.first_prompt.slice(0, 200))}</div>` : ''}
        </div>
        <button data-act="save-discovered">Guardar</button>
      </div>`).join('')
      : '<p class="muted small">No hay conversaciones sin guardar.</p>';
    box._items = items;
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ---------- init ----------
export function init(options) {
  ctx = options;
  $('#sv-sort').value = sort;
  $('#sv-sort').onchange = e => { sort = e.target.value; localStorage.setItem('hermes.savedSort', sort); renderList(); };
  document.querySelectorAll('#sv-status button').forEach(b => b.onclick = () => { status = b.dataset.status; load(); });
  let qTimer;
  $('#sv-q').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => { query = e.target.value.trim(); load(); }, 200); };
  $('#btn-saved-new').onclick = () => openForm();
  $('#btn-discover').onclick = () => { $('#dlg-discover').showModal(); $('#dc-q').focus(); discover(); };
  $('#dc-close').onclick = () => $('#dlg-discover').close();
  $('#dc-q').oninput = () => { clearTimeout(dcTimer); dcTimer = setTimeout(discover, 250); };
  $('#dc-items').onclick = e => {
    const b = e.target.closest('[data-act="save-discovered"]');
    if (!b) return;
    const d = $('#dc-items')._items.find(x => x.uuid === b.closest('.dc-row').dataset.uuid);
    $('#dlg-discover').close();
    const base = (d.cwd || '').split('/').filter(Boolean).pop() || 'sesion';
    let name = base.replace(/[^A-Za-z0-9._-]+/g, '_'), i = 2;
    while (data.sessions.some(s => s.name === name)) name = `${base}_${i++}`;
    openForm(null, { session_uuid: d.uuid, cwd: d.cwd, title: d.title.slice(0, 120), name, session_live: true });
  };

  $('#sv-items').addEventListener('click', e => {
    const head = e.target.closest('.sv-sec-head');
    if (head) {
      const sec = head.parentElement, key = sec.dataset.key;
      sec.classList.toggle('collapsed');
      collapsed[sec.classList.contains('collapsed') ? 'add' : 'delete'](key);
      localStorage.setItem('hermes.savedCollapsed', JSON.stringify([...collapsed]));
      return;
    }
    const rowEl = e.target.closest('.sv-row');
    if (!rowEl) return;
    const btn = e.target.closest('[data-act]');
    if (btn) { e.stopPropagation(); act(btn.dataset.act, rowEl.dataset.name, btn); return; }
    show(rowEl.dataset.name);
  });
  $('#sv-items').addEventListener('dblclick', e => {
    const rowEl = e.target.closest('.sv-row');
    if (rowEl && !e.target.closest('[data-act]')) act('open', rowEl.dataset.name);
  });
  $('#sv-items').addEventListener('keydown', e => {
    const rowEl = e.target.closest('.sv-row');
    if (!rowEl) return;
    if (e.key === 'Enter') { e.preventDefault(); e.ctrlKey || e.metaKey ? act('open', rowEl.dataset.name) : show(rowEl.dataset.name); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...document.querySelectorAll('.sv-sec:not(.collapsed) .sv-row')];
      rows[rows.indexOf(rowEl) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  });
  $('#sv-detail').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (btn && detail) act(btn.dataset.act, detail.name, btn);
  });
  $('#sv-detail').addEventListener('submit', async e => {
    if (e.target.id !== 'sd-entry-form') return;
    e.preventDefault();
    const f = e.target, eid = f.dataset.eid;
    const body = { kind: f.kind.value, title: f.title.value, body: f.body.value };
    try {
      if (eid) await api('PATCH', `/${encodeURIComponent(detail.name)}/entries/${eid}`, body);
      else await api('POST', `/${encodeURIComponent(detail.name)}/entries`, body);
      await loadDetail(detail.name);
      load();
    } catch (err) { ctx.toast(err.message, true); }
  });

  const f = $('#form-saved');
  f.addEventListener('submit', submitForm);
  f.addEventListener('input', syncForm);
  f.addEventListener('change', syncForm);
  $('#fs-regen').onclick = () => { f.session_uuid.readOnly = false; f.session_uuid.value = uuid4(); syncForm(); };
  $('#fs-copy-uuid').onclick = () => copy(f.session_uuid.value, 'ID copiado');
}

// atajos propios de la vista (los llama app.js cuando la vista está activa)
export function onKey(e) {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault(); $('#sv-q').focus(); return true;
  }
  if (e.key === 'Escape' && selected && !document.querySelector('dialog[open]')) { closeDetail(); return true; }
  return false;
}
