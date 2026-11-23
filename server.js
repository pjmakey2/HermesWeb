import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { statSync, copyFileSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb, findSession } from './lib/db.js';
import { transcriptPath, info as transcriptInfo } from './lib/transcripts.js';
import { usageReport, refreshUsage } from './lib/usage.js';
import { channels as notifyChannels, markSeen, send as notifySend, startWatcher } from './lib/notify.js';
import { startBackups, backupNow, listBackups, BACKUP_DIR } from './lib/backup.js';
import { sessionDiff } from './lib/gitdiff.js';
import { savedRouter } from './lib/saved.js';
import {
  AUTH_FILE, CONFIG_DIR, loadAuth, checkPassword, makeSessionCookie, clearSessionCookie, validSession,
  loginBlocked, loginFailed, loginOk,
} from './auth.js';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7681);
// Socket tmux por ruta (no -L): así el contenedor Docker y el host comparten el mismo servidor.
const SOCKET = process.env.HERMES_TMUX_SOCKET || path.join(homedir(), '.local', 'state', 'hermesweb', 'tmux.sock');
mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
// En Docker el servidor tmux corre en el HOST: la config tiene que estar en una ruta que el host
// vea igual (~/.config/hermesweb/tmux.conf, montada en la misma ruta).
const IN_DOCKER = !!process.env.HERMES_IN_DOCKER;
let TMUX_CONF = path.join(__dirname, 'tmux.conf');
if (IN_DOCKER) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const shared = path.join(CONFIG_DIR, 'tmux.conf');
  copyFileSync(TMUX_CONF, shared);
  TMUX_CONF = shared;
}
const SHELL = process.env.SHELL || '/bin/bash';

// ---------- autenticación ----------
// auth.json se relee si cambia (npm run set-password funciona con el servidor corriendo)
let authCache = { mtime: 0, auth: null };
function getAuth() {
  let mtime = 0;
  try { mtime = statSync(AUTH_FILE).mtimeMs; } catch {}
  if (mtime !== authCache.mtime) authCache = { mtime, auth: mtime ? loadAuth() : null };
  return authCache.auth;
}
if (!getAuth()) {
  console.error('No hay contraseña configurada. Ejecuta primero:  npm run set-password');
  process.exit(1);
}

// Token para el CLI (hcw log/summary/register, skill /session-log): ~/.config/hermesweb/api-token
const API_TOKEN_FILE = path.join(CONFIG_DIR, 'api-token');
let API_TOKEN;
try { API_TOKEN = (await readFile(API_TOKEN_FILE, 'utf8')).trim(); } catch {}
if (!API_TOKEN) {
  API_TOKEN = randomBytes(32).toString('hex');
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(API_TOKEN_FILE, API_TOKEN + '\n', { mode: 0o600 });
}
function bearerOk(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isSecure = req => req.secure || req.headers['x-forwarded-proto'] === 'https';
const authed = req => validSession(getAuth(), req.headers.cookie) || bearerOk(req);
// Detrás de un proxy local (tailscale serve, caddy…) el Host puede venir reescrito: se acepta
// X-Forwarded-Host solo si la conexión viene de la propia máquina.
const fromLoopback = req => /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || '');
const sameOrigin = req => {
  const origin = req.headers.origin;
  if (!origin) return true;
  let o; try { o = new URL(origin).host; } catch { return false; }
  if (o === req.headers.host) return true;
  const fwd = fromLoopback(req) && req.headers['x-forwarded-host'];
  return !!fwd && fwd.split(',')[0].trim() === o;
};

// ---------- tmux ----------
const tmuxRaw = (...args) => exec('tmux', ['-S', SOCKET, '-f', TMUX_CONF, ...args], {
  env: { ...process.env, TERM: 'xterm-256color' },
});
// En Docker nunca hay que arrancar el servidor tmux dentro del contenedor (las sesiones
// morirían con él y claude correría sin tus herramientas): new-session exige que ya exista.
async function tmux(...args) {
  if (IN_DOCKER && args[0] === 'new-session') {
    try { await tmuxRaw('show-options', '-s', 'exit-empty'); }
    catch {
      throw new Error('El servidor tmux del host no está corriendo. En el host: ' +
        `tmux -S ${SOCKET} -f ${TMUX_CONF} start-server  (o scripts/deploy.sh, o el servicio hermes-tmux)`);
    }
  }
  return tmuxRaw(...args);
}

const SEP = '|~|'; // tmux escapa caracteres de control en -F, usar ASCII imprimible
const FIELDS = [
  'session_name', 'session_created', 'session_activity', 'session_attached',
  'pane_current_path', 'pane_current_command', 'pane_title', 'pane_dead', 'window_activity', '@hermes_uuid',
];

async function listSessions() {
  try {
    const { stdout } = await tmux('list-panes', '-a', '-F', FIELDS.map(f => `#{${f}}`).join(SEP));
    const seen = new Map();
    for (const line of stdout.split('\n').filter(Boolean)) {
      const v = line.split(SEP);
      const s = Object.fromEntries(FIELDS.map((f, i) => [f, v[i]]));
      if (seen.has(s.session_name)) continue; // primer pane de cada sesión
      seen.set(s.session_name, {
        name: s.session_name,
        created: Number(s.session_created) * 1000,
        activity: Math.max(Number(s.session_activity), Number(s.window_activity)) * 1000,
        attached: Number(s.session_attached),
        cwd: s.pane_current_path,
        command: s.pane_current_command,
        title: s.pane_title,
        dead: s.pane_dead === '1',
        uuid: s['@hermes_uuid'] || '',
      });
    }
    const list = [...seen.values()].sort((a, b) => a.created - b.created);
    await Promise.all(list.map(async s => { s.state = await detectState(s); }));
    return list;
  } catch (e) {
    if (/no server running|error connecting|No such file|no current target/i.test(e.stderr || e.message)) return [];
    throw e;
  }
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

// Lee el pie de la pantalla para saber qué hace Claude:
//   busy  → aparece "esc to interrupt"
//   ask   → está pidiendo permiso / una elección
//   idle  → esperando tu próximo mensaje
//   shell → no hay un programa corriendo (solo el shell)
async function detectState(s) {
  if (s.dead) return 'dead';
  if (SHELLS.has(s.command)) return 'shell';
  try {
    const { stdout } = await tmux('capture-pane', '-p', '-t', `=${s.name}:`);
    const tail = stdout.split('\n').filter(l => l.trim()).slice(-14).join('\n');
    if (/esc to interrupt/i.test(tail)) return 'busy';
    if (/Do you want to|Would you like to|❯\s*1\.\s/.test(tail)) return 'ask';
    return 'idle';
  } catch { return 'idle'; }
}

const validName =n => typeof n === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(n);
const expandHome = p => (p || '').replace(/^~(?=$|\/)/, homedir());

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // las peticiones que cambian algo deben venir de esta misma página
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req))
    return res.status(403).json({ error: 'Origen no permitido' });
  next();
});

// PWA: el navegador pide el manifiesto y el service worker sin credenciales
for (const f of ['manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'])
  app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));

app.get('/login', (req, res) => {
  if (authed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  const wait = loginBlocked(ip);
  if (wait) return res.status(429).json({ error: `Demasiados intentos. Espera ${wait}s.` });
  const ok = await checkPassword(getAuth(), req.body?.password);
  if (!ok) {
    loginFailed(ip);
    console.warn(`[auth] intento fallido desde ${ip}`);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  loginOk(ip);
  res.setHeader('Set-Cookie', makeSessionCookie(getAuth(), isSecure(req)));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie(isSecure(req)));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked/lib')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

const HOST_LABEL = process.env.HERMES_HOST_LABEL || hostname();
const VERSION = process.env.HERMES_VERSION || 'dev';

app.get('/api/sessions', async (req, res) => {
  try {
    // ?seen=a,b → sesiones que una pestaña visible está mostrando (para no avisar al celular)
    if (typeof req.query.seen === 'string' && req.query.seen) markSeen(req.query.seen.split(',').filter(validName));
    const sessions = await listSessions();
    for (const s of sessions) {
      const saved = s.uuid ? findSession(s.uuid) : null;
      s.saved = saved ? { id: saved.id, name: saved.name, title: saved.title } : null;
      const file = s.uuid && transcriptPath(s.uuid);
      s.cost = file ? transcriptInfo(file)?.cost ?? null : null;
    }
    res.json({ sessions, home: homedir(), host: HOST_LABEL, version: VERSION });
  }
  catch (e) { res.status(500).json({ error: e.stderr || e.message }); }
});

app.use('/api/saved', savedRouter({ tmux, listSessions, shell: SHELL }));

// ---------- cambios (git) del directorio de una sesión ----------
app.get('/api/sessions/:name/diff', async (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ error: 'Nombre inválido' });
  const s = (await listSessions()).find(x => x.name === name);
  if (!s) return res.status(404).json({ error: 'No existe la sesión' });
  try { res.json(await sessionDiff(s.cwd)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- uso y costo ----------
app.get('/api/usage', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(31, Number(req.query.days) || 30));
    res.json(await usageReport({
      days,
      sessionInfo: (uuid, file) => {
        const i = transcriptInfo(file) || {};
        const sv = findSession(uuid);
        return { title: sv?.title || i.title || '', cwd: i.cwd || '', saved: sv ? sv.name : null };
      },
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ajustes / estado ----------
// HERMES_PEERS="hp=https://hp.tu-tailnet.ts.net,laptop=http://100.x.y.z:7681" → selector de máquinas
const PEERS = (process.env.HERMES_PEERS || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
  const i = x.indexOf('=');
  return i > 0 ? { name: x.slice(0, i).trim(), url: x.slice(i + 1).trim().replace(/\/$/, '') } : null;
}).filter(p => p && /^https?:\/\//.test(p.url));

app.get('/api/settings', (req, res) => {
  res.json({
    version: VERSION, host: HOST_LABEL, docker: IN_DOCKER, secure: isSecure(req),
    notify: notifyChannels(), peers: PEERS,
    backups: { dir: BACKUP_DIR, list: listBackups().slice(0, 5), total: listBackups().length },
  });
});
app.post('/api/notify/test', async (req, res) => {
  try { res.json(await notifySend('HermesWeb', `Aviso de prueba desde ${HOST_LABEL}`)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/backup', (req, res) => {
  try { res.json({ file: backupNow({ force: true }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions', async (req, res) => {
  const { name, cwd, command } = req.body || {};
  if (!validName(name)) return res.status(400).json({ error: 'Nombre inválido (letras, números, - y _; máx 40)' });
  const dir = expandHome(cwd) || homedir();
  try {
    if (!statSync(dir).isDirectory()) throw new Error();
  } catch { return res.status(400).json({ error: `El directorio no existe: ${dir}` }); }
  if ((await listSessions()).some(s => s.name === name))
    return res.status(409).json({ error: `Ya existe la sesión "${name}"` });

  try {
    // Shell interactivo de login → el comando se "tipea" en él, igual que en tu terminal.
    // Al salir de claude vuelves al shell en ese directorio.
    await tmux('new-session', '-d', '-s', name, '-c', dir, '-x', '200', '-y', '50', SHELL, '-l');
    let cmd = (command ?? 'claude').trim();
    // Conversación nueva de claude: se le asigna el ID desde ya, así se puede guardar después
    const m = /^claude(\s|$)/.test(cmd) && /(?:--resume|-r)\s+([0-9a-f-]{36})/i.exec(cmd);
    let uuid = m ? m[1] : '';
    if (/^claude(\s|$)/.test(cmd) && !/(^|\s)(-c|--continue|-r|--resume|--session-id|-p|--print)(\s|=|$)/.test(cmd)) {
      uuid = randomUUID();
      cmd = cmd.replace(/^claude/, `claude --session-id ${uuid}`);
    }
    if (uuid) await tmux('set-option', '-t', `=${name}:`, '@hermes_uuid', uuid.toLowerCase());
    if (cmd) {
      await tmux('send-keys', '-t', `=${name}:`, '-l', cmd);
      await tmux('send-keys', '-t', `=${name}:`, 'Enter');
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

app.patch('/api/sessions/:name', async (req, res) => {
  const { name } = req.params, { newName } = req.body || {};
  if (!validName(name) || !validName(newName)) return res.status(400).json({ error: 'Nombre inválido' });
  try { await tmux('rename-session', '-t', `=${name}`, newName); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.message }); }
});

app.delete('/api/sessions/:name', async (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ error: 'Nombre inválido' });
  try { await tmux('kill-session', '-t', `=${name}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.message }); }
});

// ---------- subir imágenes ----------
// Se guardan en ~/.cache/hermesweb/uploads/<sesión>/ y sus rutas se "pegan" en la terminal,
// igual que arrastrar archivos a una consola: Claude las adjunta como [Image #N].
const UPLOAD_DIR = process.env.HERMES_UPLOAD_DIR || path.join(homedir(), '.cache', 'hermesweb', 'uploads');
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_UPLOAD_MB = 20;

app.post('/api/sessions/:name/upload',
  express.raw({ type: Object.keys(IMAGE_EXT), limit: `${MAX_UPLOAD_MB}mb` }),
  async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ error: 'Nombre inválido' });
    const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length)
      return res.status(415).json({ error: 'Solo imágenes PNG, JPG, GIF o WebP' });
    try {
      const original = decodeURIComponent(req.headers['x-filename'] || 'imagen');
      const base = path.parse(original).name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'imagen';
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      const dir = path.join(UPLOAD_DIR, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${stamp}-${randomBytes(3).toString('hex')}-${base}.${ext}`);
      await writeFile(file, req.body, { mode: 0o600 });
      res.json({ path: file });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

// Pega texto en la sesión como "bracketed paste" (como Ctrl+V en una terminal)
app.post('/api/sessions/:name/paste', async (req, res) => {
  const { name } = req.params, { text } = req.body || {};
  if (!validName(name) || typeof text !== 'string' || !text || text.length > 20000)
    return res.status(400).json({ error: 'Petición inválida' });
  const buf = `hermes-paste-${randomBytes(4).toString('hex')}`;
  try {
    await tmux('set-buffer', '-b', buf, '--', text);
    await tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', `=${name}:`);
    res.json({ ok: true });
  } catch (e) {
    try { await tmux('delete-buffer', '-b', buf); } catch {}
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// ---------- WebSocket: un cliente tmux (pty real) por pestaña ----------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !sameOrigin(req) || !authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, url));
});

wss.on('connection', (ws, url) => {
  const name = url.searchParams.get('session');
  const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 120));
  const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 40));
  if (!validName(name)) return ws.close(4000, 'bad session');

  const term = pty.spawn('tmux', ['-S', SOCKET, '-f', TMUX_CONF, 'attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols, rows,
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  term.onData(d => { if (ws.readyState === ws.OPEN) ws.send(d); });
  term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(4001, 'detached'); });

  ws.on('message', (msg, isBinary) => {
    // Frames binarios = teclado (bytes crudos). Frames de texto = control ("\x00" + JSON).
    if (isBinary) return term.write(Buffer.from(msg).toString('utf8'));
    const s = msg.toString();
    if (s.charCodeAt(0) !== 0) return;
    try {
      const m = JSON.parse(s.slice(1));
      if (m.type === 'resize') term.resize(
        Math.max(20, Math.min(500, m.cols | 0)), Math.max(5, Math.min(200, m.rows | 0)));
    } catch {}
  });
  ws.on('close', () => { try { term.kill(); } catch {} }); // solo cierra el cliente; la sesión sigue viva
});

// ---------- arranque ----------
async function initTmux() {
  // si el servidor tmux dedicado ya corre, recarga la config
  try { await tmux('source-file', TMUX_CONF); } catch {}
}

await initTmux();
getDb();
startBackups();
startWatcher({ listSessions, host: HOST_LABEL, baseUrl: (process.env.HERMES_PUBLIC_URL || '').replace(/\/$/, '') });
refreshUsage().catch(() => {});   // primera lectura de los transcripts en segundo plano
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`HermesWeb escuchando en http://${shown}:${PORT}`);
  console.log(`Desde una terminal: hcw a <sesion>   (tmux -S ${SOCKET} attach -t <sesion>)`);
});
