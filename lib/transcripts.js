// Lectura (solo lectura) de los transcripts de Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl
// Sirve para saber si una conversación existe en esta máquina, su directorio, título y actividad.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD = 1_500_000, TAIL = 400_000, TTL = 15_000;

let cache = { at: 0, map: new Map() };
const infoCache = new Map();

// uuid -> ruta del .jsonl (cacheado unos segundos)
export function index() {
  if (Date.now() - cache.at < TTL) return cache.map;
  const map = new Map();
  let dirs = [];
  try { dirs = readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }); } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(path.join(CLAUDE_PROJECTS, d.name)); } catch { continue; }
    for (const f of files) {
      const id = f.endsWith('.jsonl') ? f.slice(0, -6).toLowerCase() : '';
      if (UUID.test(id)) map.set(id, path.join(CLAUDE_PROJECTS, d.name, f));
    }
  }
  cache = { at: Date.now(), map };
  return map;
}

export const transcriptPath = uuid => (uuid ? index().get(uuid.toLowerCase()) || null : null);

function userText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return '';
  let c = rec.message?.content;
  if (Array.isArray(c)) c = c.filter(b => b?.type === 'text').map(b => b.text).join(' ');
  if (typeof c !== 'string') return '';
  c = c.trim();
  if (!c || c.startsWith('<') || c.startsWith('Caveat:')) return '';
  return c;
}

function readChunk(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString('utf8');
}

// Metadatos baratos: lee el inicio y el final del archivo
export function info(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = infoCache.get(file);
  if (hit?.key === key) return hit.data;

  const data = {
    uuid: path.basename(file, '.jsonl'), mtime: st.mtimeMs, size: st.size,
    cwd: '', first_prompt: '', ai_title: '', last_prompt: '', cost: null,
  };
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = readChunk(fd, 0, Math.min(HEAD, st.size));
    for (const line of head.split('\n')) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (!data.cwd && rec.cwd) data.cwd = rec.cwd;
      if (!data.first_prompt) data.first_prompt = userText(rec).slice(0, 400);
      if (data.cwd && data.first_prompt) break;
    }
    const start = Math.max(0, st.size - TAIL);
    let tail = readChunk(fd, start, st.size - start).split('\n');
    if (start > 0) tail = tail.slice(1);
    for (const line of tail) {
      if (!/"(ai-title|custom-title|last-prompt|cost-state)"/.test(line)) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === 'ai-title') data.ai_title = rec.aiTitle || data.ai_title;
      else if (rec.type === 'custom-title') data.ai_title = rec.customTitle || data.ai_title;
      else if (rec.type === 'last-prompt') data.last_prompt = (rec.lastPrompt || '').trim().slice(0, 400);
      else if (rec.type === 'cost-state') data.cost = rec.totalCostUSD ?? data.cost;
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  data.title = data.ai_title || data.first_prompt.slice(0, 90);
  infoCache.set(file, { key, data });
  return data;
}

// Conversaciones de esta máquina que todavía no están guardadas
export function discover(registered, q = '', limit = 200) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const [uuid, file] of index()) {
    if (registered.has(uuid)) continue;
    const d = info(file);
    if (!d) continue;
    const hay = `${d.title} ${d.cwd} ${d.first_prompt} ${d.uuid}`.toLowerCase();
    if (terms.every(t => hay.includes(t))) items.push(d);
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items: items.slice(0, limit), total: items.length };
}
