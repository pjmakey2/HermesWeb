// Avisos al celular cuando una sesión termina de trabajar o pide permiso y nadie la está mirando.
// Canales (variables de entorno, p. ej. en ~/.config/hermesweb/deploy.env):
//   HERMES_NTFY_URL=https://ntfy.sh/<tópico-secreto>   (+ HERMES_NTFY_TOKEN opcional)
//   HERMES_TELEGRAM_TOKEN=<token del bot>  HERMES_TELEGRAM_CHAT=<chat id>
// "Nadie la está mirando" = ninguna pestaña de HermesWeb visible la mostró en el último minuto.
const NTFY_URL = process.env.HERMES_NTFY_URL || '';
const NTFY_TOKEN = process.env.HERMES_NTFY_TOKEN || '';
const TG_TOKEN = process.env.HERMES_TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.HERMES_TELEGRAM_CHAT || '';
const UNSEEN_MS = 60_000;      // sin mirarla hace más de 1 min
const MIN_BUSY_MS = Number(process.env.HERMES_NOTIFY_MIN_BUSY_MS || 20_000); // solo avisar si trabajó al menos 20 s (evita ruido)

export const channels = () => [NTFY_URL && 'ntfy', TG_TOKEN && TG_CHAT && 'telegram'].filter(Boolean);

const seen = new Map();        // sesión -> último momento en que una pestaña visible la mostró
export function markSeen(names) { const t = Date.now(); for (const n of names) seen.set(n, t); }

export async function send(title, body, { url, priority } = {}) {
  const jobs = [];
  if (NTFY_URL) {
    jobs.push(fetch(NTFY_URL, {
      method: 'POST',
      headers: {
        // las cabeceras HTTP no aceptan UTF-8 sin codificar → RFC 2047
        Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
        Tags: priority === 'high' ? 'warning' : 'white_check_mark',
        Priority: priority === 'high' ? '4' : '3',
        ...(url ? { Click: url } : {}),
        ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }).then(r => { if (!r.ok) throw new Error(`ntfy: HTTP ${r.status}`); }));
  }
  if (TG_TOKEN && TG_CHAT) {
    jobs.push(fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n${body}${url ? `\n${url}` : ''}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    }).then(r => { if (!r.ok) throw new Error(`telegram: HTTP ${r.status}`); }));
  }
  if (!jobs.length) throw new Error('No hay canales configurados (HERMES_NTFY_URL o HERMES_TELEGRAM_TOKEN + HERMES_TELEGRAM_CHAT)');
  const res = await Promise.allSettled(jobs);
  const errors = res.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (errors.length === jobs.length) throw new Error(errors.join('; '));
  return { sent: jobs.length - errors.length, errors };
}

// Vigila los estados de las sesiones (los mismos que ve la web) y avisa en las transiciones.
export function startWatcher({ listSessions, host, baseUrl, interval = 3000 }) {
  if (!channels().length) return;
  const prev = new Map();      // sesión -> { state, since }
  const tick = async () => {
    let list;
    try { list = await listSessions(); } catch { return; }
    const now = Date.now();
    for (const s of list) {
      const p = prev.get(s.name);
      const st = s.state;
      if (!p) { prev.set(s.name, { state: st, since: now }); continue; }
      if (p.state === st) continue;
      const unseen = now - (seen.get(s.name) || 0) > UNSEEN_MS;
      const url = baseUrl ? `${baseUrl}/#${encodeURIComponent(s.name)}` : undefined;
      const label = s.saved?.title || s.saved?.name || (s.title || '').replace(/^[⠀-⣿✳*·\s]+/, '').trim();
      if (unseen && st === 'ask')
        send(`${s.name} pide permiso`, `${host}: Claude espera tu aprobación${label ? ` — ${label}` : ''}`, { url, priority: 'high' }).catch(e => console.warn('[aviso]', e.message));
      else if (unseen && p.state === 'busy' && st === 'idle' && now - p.since >= MIN_BUSY_MS)
        send(`${s.name} terminó`, `${host}: listo tras ${Math.round((now - p.since) / 60000) || '<1'} min${label ? ` — ${label}` : ''}`, { url }).catch(e => console.warn('[aviso]', e.message));
      prev.set(s.name, { state: st, since: now });
    }
    for (const n of prev.keys()) if (!list.some(s => s.name === n)) prev.delete(n);
  };
  setInterval(tick, interval).unref();
}
