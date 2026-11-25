// Herramientas de HermesWeb: barra de teclas para Claude, pantalla completa, cambios (git),
// uso y costo, ajustes (instalar app, avisos, respaldos) y otras máquinas.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ctx;

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const money = n => (n == null ? '—' : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const tokens = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const agoMs = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

// ---------- barra de teclas ----------
const KEYS = { esc: '\x1b', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', enter: '\r', ctrlc: '\x03' };
let quickOn = localStorage.getItem('hermes.quickbar') === '1';

export function toggleQuickbar(force) {
  quickOn = force ?? !quickOn;
  localStorage.setItem('hermes.quickbar', quickOn ? '1' : '');
  updateQuickbar();
}

// Se muestra si está activada, o sola cuando la sesión enfocada pide permiso
export function updateQuickbar() {
  const s = ctx.currentSession();
  const ask = s?.state === 'ask';
  const bar = $('#quickbar');
  const show = !!s && (quickOn || ask);
  if (bar.hidden === show) { bar.hidden = !show; ctx.refit(); }
  bar.classList.toggle('asking', ask);
  bar.classList.toggle('only-answers', ask && !quickOn);
  $('#qb-target').textContent = s ? (ask ? `${s.name} pide permiso →` : s.name) : '';
  $('#btn-quick').classList.toggle('on', quickOn);
}

function initQuickbar() {
  $('#quickbar').addEventListener('mousedown', e => e.preventDefault()); // no robar el foco a la terminal
  $('#quickbar').addEventListener('click', e => {
    const b = e.target.closest('button[data-send]');
    if (!b) return;
    const k = b.dataset.send;
    const name = ctx.current();
    if (!name) return;
    if (k.startsWith('/')) { ctx.send(name, k); setTimeout(() => ctx.send(name, '\r'), 60); }
    // salto de línea en Claude Code sin Shift+Enter: "\" + Enter (por separado, para que no parezca un pegado)
    else if (k === 'nl') { ctx.send(name, '\\'); setTimeout(() => ctx.send(name, '\r'), 60); }
    else ctx.send(name, KEYS[k] ?? k);
    ctx.focusTerm();
  });
  $('#qb-close').onclick = () => toggleQuickbar(false);
  $('#btn-quick').onclick = () => toggleQuickbar();
}

// ---------- pantalla completa + captura de teclado ----------
// En pantalla completa, navigator.keyboard.lock() hace que Ctrl+W, Ctrl+T, Ctrl+N, Alt+Tab… lleguen
// a la terminal en vez de al navegador (Chrome/Edge). Para salir: mantener Esc o el botón.
export async function toggleFullscreen() {
  if (document.fullscreenElement) { navigator.keyboard?.unlock?.(); return document.exitFullscreen(); }
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await navigator.keyboard?.lock?.();
    ctx.toast(navigator.keyboard?.lock ? 'Pantalla completa: los atajos van a la terminal. Mantén Esc para salir.' : 'Pantalla completa (Esc para salir)');
  } catch (e) { ctx.toast('No se pudo pasar a pantalla completa: ' + e.message, true); }
}
document.addEventListener('fullscreenchange', () => {
  $('#btn-full').classList.toggle('on', !!document.fullscreenElement);
  if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
});

// ---------- cambios (git) ----------
let diffFor = null;
export async function openDiff(name = ctx.current()) {
  if (!name) return;
  diffFor = name;
  $('#df-name').textContent = name;
  const body = $('#df-body');
  body.innerHTML = '<p class="muted">Cargando…</p>';
  if (!$('#dlg-diff').open) $('#dlg-diff').showModal();
  let d;
  try { d = await api(`/api/sessions/${encodeURIComponent(name)}/diff`); }
  catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (!d.repo) { body.innerHTML = `<p class="muted"><code>${esc(ctx.pretty(d.cwd))}</code> no es un repositorio git.</p>`; return; }
  const add = d.files.reduce((a, f) => a + (f.add || 0), 0), del = d.files.reduce((a, f) => a + (f.del || 0), 0);
  const parts = splitDiff(d.diff);
  body.innerHTML = `
    <div class="df-meta"><code>${esc(ctx.pretty(d.root))}</code> <span class="badge">⎇ ${esc(d.branch)}</span>
      ${d.files.length ? `<span>${d.files.length} archivo${d.files.length > 1 ? 's' : ''}</span> <span class="add">+${add}</span> <span class="del">−${del}</span>` : '<span class="muted">sin cambios pendientes</span>'}</div>
    ${d.files.length ? `<ul class="df-files">${d.files.map((f, i) => `
      <li><a href="#" data-i="${i}"><span class="st st-${esc(f.code.replace('?', 'u').charAt(0))}" title="${esc(STATUS[f.code.charAt(0)] || f.code)}">${f.code === '??' ? 'nuevo' : esc(f.code)}</span>
        <span class="f">${esc(f.file)}</span>
        <span class="n">${f.add != null ? `<span class="add">+${f.add}</span> <span class="del">−${f.del}</span>` : '<span class="muted">bin</span>'}</span></a></li>`).join('')}</ul>` : ''}
    ${parts.map(p => `<details class="df-file" open data-file="${esc(p.file)}"><summary>${esc(p.file)}</summary><pre>${p.html}</pre></details>`).join('')}
    ${d.truncated ? '<p class="muted small">El diff es muy grande: se muestra solo el comienzo.</p>' : ''}
    ${d.commits.length ? `<h3 class="df-h">Últimos commits</h3><ul class="df-commits">${d.commits.map(c => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">· ${esc(c.when)}</span></li>`).join('')}</ul>` : ''}`;
  body.querySelectorAll('.df-files a').forEach(a => a.onclick = e => {
    e.preventDefault();
    const f = d.files[a.dataset.i].file;
    const el = [...body.querySelectorAll('.df-file')].find(x => x.dataset.file === f);
    if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
}

const STATUS = { M: 'modificado', A: 'agregado', D: 'borrado', R: 'renombrado', C: 'copiado', U: 'en conflicto', '?': 'nuevo, sin seguimiento' };

function splitDiff(text) {
  const out = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(chunk);
    const file = m ? m[2] : '?';
    const html = chunk.split('\n').map(l => {
      const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') || /^(diff|index|new file|deleted file|similarity|rename|old mode|new mode)/.test(l) ? 'meta'
        : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return cls === 'meta' ? '' : `<span class="${cls}">${esc(l) || ' '}</span>`;
    }).filter(Boolean).join('');
    out.push({ file, html });
  }
  return out;
}

// ---------- uso y costo ----------
export async function openUsage() {
  const dlg = $('#dlg-usage');
  if (!dlg.open) dlg.showModal();
  $('#us-host').textContent = ctx.host() ? `· ${ctx.host()}` : '';
  const body = $('#us-body');
  if (!body.dataset.loaded) body.innerHTML = '<p class="muted">Leyendo los transcripts de Claude Code (la primera vez tarda unos segundos)…</p>';
  let u;
  try { u = await api('/api/usage?days=30'); }
  catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  body.dataset.loaded = '1';
  const card = (label, b) => `<div class="us-card"><span>${label}</span><b>${money(b.cost)}</b>
    <small>${tokens(b.output)} tokens de salida · ${tokens(b.input + b.cache_read + b.cache_write)} de entrada · ${b.messages} respuestas</small></div>`;
  const days = [...u.days].reverse();
  const max = Math.max(...days.map(d => d.cost), 0.01);
  body.innerHTML = `
    <div class="us-cards">${card('Hoy', u.today)}${card('Últimos 7 días', u.week)}${card('Últimos 30 días', u.month)}</div>
    <div class="us-chart" role="img" aria-label="Costo por día">${days.map(d => {
      const h = Math.round((d.cost / max) * 100), wd = new Date(d.date + 'T12:00').getDay();
      return `<div class="bar${wd === 0 || wd === 6 ? ' we' : ''}" title="${esc(d.date)}: ${money(d.cost)} · ${tokens(d.output)} tokens de salida"><i style="height:${h}%"></i><span>${Number(d.date.slice(8))}</span></div>`;
    }).join('')}</div>
    <h3 class="df-h">Sesiones con más costo (30 días)</h3>
    <table class="us-table"><thead><tr><th>Sesión</th><th>Hoy</th><th>30 días</th><th>Salida</th><th>Actividad</th></tr></thead><tbody>
    ${u.sessions.map(s => `<tr><td><div class="t">${s.saved ? `<span class="saved-mark">★</span> ${esc(s.saved)} · ` : ''}${esc(s.title || s.uuid.slice(0, 8))}</div><div class="muted small mono">${esc(ctx.pretty(s.cwd))}</div></td>
      <td>${s.today ? money(s.today) : '<span class="muted">—</span>'}</td><td><b>${money(s.cost)}</b></td><td>${tokens(s.output)}</td><td class="muted">hace ${agoMs(s.last)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin actividad.</td></tr>'}
    </tbody></table>
    <p class="muted small">El costo es el que calcula Claude Code (equivalente en precios de API; con suscripción no es lo que pagas).
    Claude Code lo guarda de a ratos, así que lo de las últimas horas puede aparecer con retraso. Los tokens son exactos.</p>`;
}

// ---------- ajustes ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
const standalone = () => matchMedia('(display-mode: standalone)').matches;

export async function openSettings() {
  const dlg = $('#dlg-settings');
  if (!dlg.open) dlg.showModal();
  const body = $('#st-body');
  let s;
  try { s = await api('/api/settings'); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  body.innerHTML = `
    <section><h3>App</h3>
      <p>${standalone() ? '✓ Estás usando HermesWeb instalada como app.' : installPrompt ? 'Instálala como app: ventana propia, sin barra del navegador.' :
        window.isSecureContext ? 'Para instalarla: menú del navegador → <b>Instalar HermesWeb</b> (o el ícono ⊕ en la barra de direcciones).' :
        'Para instalarla como app hace falta HTTPS (ver abajo).'}</p>
      <div class="row-actions">
        ${installPrompt && !standalone() ? '<button id="st-install" class="primary">Instalar app</button>' : ''}
        <button id="st-full">${document.fullscreenElement ? 'Salir de pantalla completa' : '⛶ Pantalla completa'}</button>
      </div>
      <p class="muted small">En pantalla completa los atajos del navegador (<kbd>Ctrl</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd>, <kbd>Ctrl</kbd>+<kbd>N</kbd>…) llegan a la terminal. Para salir, mantén <kbd>Esc</kbd>. Atajo: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>.</p>
    </section>
    <section><h3>Conexión</h3>
      <p>${s.secure ? '✓ HTTPS' : local ? 'HTTP local (bien en esta máquina).' : '⚠ Estás entrando por HTTP desde otra máquina: el navegador bloquea notificaciones, portapapeles e instalar la app.'}</p>
      ${!s.secure && !local ? '<p class="muted small">Solución: en esta máquina, <code>scripts/tailscale-serve.sh</code> y entra por <code>https://&lt;máquina&gt;.&lt;tailnet&gt;.ts.net</code>.</p>' : ''}
    </section>
    <section><h3>Avisos</h3>
      <p>Navegador: ${perm === 'granted' ? '✓ activados' : perm === 'denied' ? '✗ bloqueados (actívalos en los permisos del sitio)' : perm === 'unsupported' ? 'no disponibles aquí' : '<button id="st-perm">Activar avisos del navegador</button>'}</p>
      <p>Celular: ${s.notify.length ? `✓ ${s.notify.join(' + ')} <button id="st-test">Enviar prueba</button>` : 'sin configurar.'}</p>
      ${s.notify.length ? '' : `<p class="muted small">Agrega en <code>~/.config/hermesweb/deploy.env</code> <code>HERMES_NTFY_URL=https://ntfy.sh/&lt;tópico-secreto&gt;</code> (app ntfy en el celular, suscrita al mismo tópico) o <code>HERMES_TELEGRAM_TOKEN</code> + <code>HERMES_TELEGRAM_CHAT</code>, y vuelve a desplegar. Avisa cuando una sesión termina o pide permiso y no la estás mirando.</p>`}
    </section>
    <section><h3>Respaldos de sesiones guardadas</h3>
      <p>${s.backups.total ? `${s.backups.total} respaldo${s.backups.total > 1 ? 's' : ''} (uno por día, se guardan 14). Último: <code>${esc(s.backups.list[0].file)}</code> · hace ${agoMs(s.backups.list[0].mtime)}` : 'Todavía no hay respaldos.'}</p>
      <p class="muted small mono">${esc(ctx.pretty(s.backups.dir))}</p>
      <div class="row-actions"><button id="st-backup">Respaldar ahora</button></div>
    </section>
    ${s.peers.length ? `<section><h3>Otras máquinas</h3><p>${s.peers.map(p => `<a class="peer" href="${esc(p.url)}">${esc(p.name)} ↗</a>`).join(' ')}</p></section>` : ''}
    <p class="muted small">HermesWeb ${esc(s.version)} · ${esc(s.host)}${s.docker ? ' · Docker' : ''}</p>`;
  $('#st-install')?.addEventListener('click', async () => { await installPrompt.prompt(); installPrompt = null; openSettings(); });
  $('#st-full').onclick = async () => { dlg.close(); await toggleFullscreen(); };
  $('#st-perm')?.addEventListener('click', async () => { await Notification.requestPermission(); openSettings(); });
  $('#st-test')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await api('/api/notify/test', { method: 'POST' }); ctx.toast(`Aviso enviado${r.errors.length ? ' (con errores: ' + r.errors.join('; ') + ')' : ''}`); }
    catch (err) { ctx.toast(err.message, true, 8000); }
    e.target.disabled = false;
  });
  $('#st-backup').onclick = async () => {
    try { const r = await api('/api/backup', { method: 'POST' }); ctx.toast(`Respaldo creado: ${r.file}`); openSettings(); }
    catch (err) { ctx.toast(err.message, true); }
  };
}

// ---------- otras máquinas ----------
export async function loadPeers() {
  try {
    const s = await api('/api/settings');
    const nav = $('#peers');
    nav.hidden = !s.peers.length;
    nav.innerHTML = s.peers.map(p => `<a href="${esc(p.url)}" title="Abrir HermesWeb en ${esc(p.name)}">${esc(p.name)} ↗</a>`).join('');
  } catch {}
}

export function init(c) {
  ctx = c;
  initQuickbar();
  updateQuickbar();
  $('#btn-full').onclick = toggleFullscreen;
  $('#btn-diff').onclick = () => openDiff();
  $('#df-refresh').onclick = () => openDiff(diffFor);
  $('#df-close').onclick = () => $('#dlg-diff').close();
  $('#btn-usage').onclick = openUsage;
  $('#us-close').onclick = () => $('#dlg-usage').close();
  $('#btn-settings').onclick = openSettings;
  $('#st-close').onclick = () => $('#dlg-settings').close();
  loadPeers();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
