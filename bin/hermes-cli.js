#!/usr/bin/env node
// Cliente de sesiones guardadas de HermesWeb (lo invoca `hcw`). Sin dependencias.
//
// Desde una sesión de Claude Code (usa $CLAUDE_CODE_SESSION_ID y el directorio actual):
//   hcw register [--name N] [--title T] [--group G]     registra/actualiza la sesión actual
//   hcw summary  [-f archivo | texto | stdin]           guarda la reseña (reemplaza la anterior)
//   hcw log -t "Título" [-k tipo] [-f archivo | stdin]  agrega una entrada a la historia
//
// Desde la terminal:
//   hcw saved [filtro] [-a]     lista sesiones guardadas (-a incluye archivadas)
//   hcw show <ref>              reseña + historia
//   hcw o <ref>                 abre la sesión guardada (en tmux) y te engancha
//
// <ref> = nombre, uuid o id numérico. Opción -s <ref> para apuntar a otra sesión.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const BASE = (process.env.HERMES_URL || `http://127.0.0.1:${process.env.PORT || 7681}`).replace(/\/$/, '');
const CONFIG_DIR = process.env.HERMES_CONFIG_DIR || path.join(homedir(), '.config', 'hermesweb');

function token() {
  try { return readFileSync(path.join(CONFIG_DIR, 'api-token'), 'utf8').trim(); }
  catch { die(`no encuentro ${path.join(CONFIG_DIR, 'api-token')} (se crea al arrancar el servidor HermesWeb)`); }
}
function die(msg) { console.error(`hcw: ${msg}`); process.exit(1); }

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(method, p, body) {
  let res;
  try {
    res = await fetch(BASE + '/api/saved' + p, {
      method,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`no se pudo conectar con ${BASE}. ¿Está corriendo HermesWeb? (cd ~/projects/HermesWeb && npm start)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

// parser mínimo: flags con valor y posicionales
function parse(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = spec[a];
    if (key === true) out[a.replace(/^-+/, '')] = true;
    else if (key) { out[key] = argv[++i]; if (out[key] === undefined) die(`falta el valor de ${a}`); }
    else out._.push(a);
  }
  return out;
}

async function readText(o) {
  if (o.file) return readFileSync(o.file, 'utf8');
  if (o._.length) return o._.join(' ');
  if (process.stdin.isTTY) return '';
  // stdin puede ser un pipe que nunca se cierra (p. ej. la herramienta Bash de Claude):
  // si en 400 ms no llega nada, se toma como vacío.
  return new Promise(resolve => {
    let s = '', got = false;
    const done = () => { process.stdin.destroy(); resolve(s); };
    const idle = setTimeout(() => { if (!got) done(); }, 400);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { got = true; clearTimeout(idle); s += c; });
    process.stdin.on('end', () => { clearTimeout(idle); done(); });
    process.stdin.on('error', () => { clearTimeout(idle); done(); });
  });
}

const enc = encodeURIComponent;
const url = s => `${BASE}/#saved=${enc(s.name)}`;

function currentRef(o) {
  const ref = o.session || process.env.CLAUDE_CODE_SESSION_ID;
  if (!ref) die('no hay sesión actual ($CLAUDE_CODE_SESSION_ID vacío). Indica una con -s <ref>.');
  return ref;
}

async function ensureRegistered(ref) {
  try { return await api('GET', `/${enc(ref)}`); }
  catch (e) {
    if (e.status !== 404 || ref !== process.env.CLAUDE_CODE_SESSION_ID) throw e;
  }
  const r = await api('POST', '/register', { session_uuid: ref, cwd: process.cwd() });
  console.log(`Sesión registrada como «${r.name}» (renómbrala con: hcw register --name <alias>)`);
  return r;
}

const commands = {
  async register(argv) {
    const o = parse(argv, { '--name': 'name', '--title': 'title', '--group': 'group', '-s': 'session', '--session': 'session', '--cwd': 'cwd' });
    const uuid = o.session || process.env.CLAUDE_CODE_SESSION_ID;
    if (!uuid) die('fuera de una sesión de Claude indica el uuid con -s <uuid>');
    const r = await api('POST', '/register', { session_uuid: uuid, cwd: o.cwd || process.cwd(), name: o.name, title: o.title, group: o.group });
    console.log(`${r.created ? 'Registrada' : 'Actualizada'}: ${r.name}  →  ${url(r)}`);
  },
  async summary(argv) {
    const o = parse(argv, { '-s': 'session', '--session': 'session', '-f': 'file', '--file': 'file' });
    const text = (await readText(o)).trim();
    if (!text) die('reseña vacía (pásala como texto, con -f archivo o por stdin)');
    const ref = currentRef(o);
    await ensureRegistered(ref);
    const r = await api('PUT', `/${enc(ref)}/summary`, { summary: text });
    console.log(`Reseña guardada en «${r.name}»  →  ${url(r)}`);
  },
  async log(argv) {
    const o = parse(argv, { '-t': 'title', '--title': 'title', '-k': 'kind', '--kind': 'kind', '-s': 'session', '--session': 'session', '-f': 'file', '--file': 'file' });
    const body = (await readText(o)).trim();
    if (!o.title && !body) die('la entrada necesita -t título y/o un cuerpo (stdin o -f archivo)');
    const ref = currentRef(o);
    await ensureRegistered(ref);
    const r = await api('POST', `/${enc(ref)}/entries`, { title: o.title || '', body, kind: o.kind || 'avance' });
    console.log(`Entrada agregada a «${r.name}»  →  ${url(r)}`);
  },
  async saved(argv) {
    const o = parse(argv, { '-a': true, '--all': true });
    const q = new URLSearchParams({ q: o._.join(' '), status: o.a || o.all ? 'all' : 'active' });
    const { sessions } = await api('GET', `/?${q}`);
    if (!sessions.length) return console.log('Sin sesiones.');
    const w = Math.max(...sessions.map(s => s.name.length));
    const gw = Math.min(24, Math.max(...sessions.map(s => (s.group || '-').length)));
    for (const s of sessions) {
      const flag = s.live ? '●' : s.kind === 'new' ? '○' : ' ';
      console.log(`${flag} ${s.name.padEnd(w)}  ${(s.group || '-').slice(0, gw).padEnd(gw)}  ${s.title || s.cwd.replace(homedir(), '~')}`);
    }
    console.log('\n● abierta ahora   ○ todavía sin conversación en esta máquina');
  },
  async show(argv) {
    const ref = argv[0] || process.env.CLAUDE_CODE_SESSION_ID;
    if (!ref) die('uso: hcw show <ref>');
    const s = await api('GET', `/${enc(ref)}`);
    console.log(`# ${s.name}${s.title ? ' — ' + s.title : ''}\n\n${s.command}\n`);
    console.log(s.summary || '(sin reseña)');
    for (const e of s.entries) console.log(`\n## [${e.created_at}] (${e.kind}) ${e.title}\n${e.body}`);
  },
  // imprime el nombre de la sesión tmux (hcw se engancha)
  async open(argv) {
    if (!argv[0]) die('uso: hcw o <ref>');
    const r = await api('POST', `/${enc(argv[0])}/open`);
    process.stdout.write(r.name + '\n');
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) die(`comando desconocido: ${cmd}`);
try { await commands[cmd](rest); process.exit(0); }
catch (e) { die(e instanceof ApiError ? `${e.message} (HTTP ${e.status})` : e.message); }
