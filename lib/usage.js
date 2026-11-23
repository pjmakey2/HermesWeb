// Uso y costo de Claude Code a partir de los transcripts (~/.claude/projects/*/*.jsonl).
//
// - Tokens: de cada respuesta del asistente (message.usage), sin duplicar los registros que
//   comparten el mismo message.id (Claude Code escribe un registro por bloque de contenido).
// - Costo: el que calcula el propio Claude Code (registros "cost-state", acumulados por sesión).
//   Se reparte por día según el incremento entre un registro y el anterior. Claude Code escribe
//   esos registros de a ratos, así que el costo del día puede ir un poco atrasado; con
//   suscripción es el "equivalente en API", no lo que se paga.
//
// La lectura es incremental: de cada archivo se recuerda hasta dónde se leyó.
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { index } from './transcripts.js';

const WINDOW_DAYS = 31;
const files = new Map();   // ruta -> { offset, size, mtime, lastTs, cost, recent: [], days: Map(date -> bucket), uuid }
let scanning = null;

const dayKey = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const emptyBucket = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, messages: 0 });

async function readFrom(file, st, f) {
  const rl = createInterface({ input: createReadStream(file, { start: f.offset, end: st.size - 1 }), crlfDelay: Infinity });
  let consumed = f.offset, lastLen = 0;
  for await (const line of rl) {
    lastLen = Buffer.byteLength(line);
    consumed += lastLen + 1;
    const isUsage = line.includes('"usage"'), isCost = line.includes('"cost-state"');
    const ts = /"timestamp":"([^"]+)"/.exec(line);
    if (ts) { const t = Date.parse(ts[1]); if (t) f.lastTs = t; }
    if (!isUsage && !isCost) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'cost-state' && typeof rec.totalCostUSD === 'number') {
      // acumulado de la sesión; si baja, empezó un proceso nuevo desde 0
      const delta = rec.totalCostUSD >= f.cost ? rec.totalCostUSD - f.cost : rec.totalCostUSD;
      f.cost = rec.totalCostUSD;
      if (delta > 0 && f.lastTs) bucket(f, f.lastTs).cost += delta;
    } else if (rec.type === 'assistant' && rec.message?.usage && !rec.isSidechain) {
      const id = rec.message.id || rec.requestId;
      if (id && f.recent.includes(id)) continue;
      if (id) { f.recent.push(id); if (f.recent.length > 64) f.recent.shift(); }
      const u = rec.message.usage, t = Date.parse(rec.timestamp) || f.lastTs;
      if (!t) continue;
      const b = bucket(f, t);
      b.input += u.input_tokens || 0;
      b.output += u.output_tokens || 0;
      b.cache_read += u.cache_read_input_tokens || 0;
      b.cache_write += u.cache_creation_input_tokens || 0;
      b.messages++;
    }
  }
  // la última línea sin "\n" está a medio escribir: se vuelve a leer la próxima vez
  f.offset = consumed > st.size ? consumed - lastLen - 1 : consumed;
  f.size = st.size;
  f.mtime = st.mtimeMs;
}

function bucket(f, t) {
  const k = dayKey(t);
  let b = f.days.get(k);
  if (!b) f.days.set(k, (b = emptyBucket()));
  return b;
}

async function scan() {
  const since = Date.now() - WINDOW_DAYS * 864e5;
  for (const [uuid, file] of index()) {
    let st; try { st = statSync(file); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let f = files.get(file);
    if (f && st.size < f.offset) f = null;                 // archivo reescrito: empezar de nuevo
    if (!f) files.set(file, (f = { offset: 0, size: 0, mtime: 0, lastTs: 0, cost: 0, recent: [], days: new Map(), uuid }));
    if (st.size === f.size && st.mtimeMs === f.mtime) continue;
    try { await readFrom(file, st, f); } catch {}
  }
}

// Escanea como mucho una vez a la vez; las peticiones concurrentes esperan el mismo escaneo
export async function refreshUsage() {
  if (!scanning) scanning = scan().finally(() => { scanning = null; });
  return scanning;
}

const COUNTERS = Object.keys(emptyBucket());
const add = (a, b) => { for (const k of COUNTERS) a[k] += b[k] || 0; return a; };

export async function usageReport({ days = 30, sessionInfo = () => null } = {}) {
  await refreshUsage();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(today.getTime() - i * 864e5));
  const byDay = new Map(keys.map(k => [k, emptyBucket()]));
  const bySession = new Map();
  for (const [file, f] of files) {
    let s = null;
    for (const [k, b] of f.days) {
      if (!byDay.has(k)) continue;
      add(byDay.get(k), b);
      if (!s) {
        s = bySession.get(f.uuid);
        if (!s) bySession.set(f.uuid, (s = { uuid: f.uuid, file, project: path.basename(path.dirname(file)), ...emptyBucket(), today: 0, last: f.mtime }));
      }
      add(s, b);
      if (k === keys[0]) s.today += b.cost;
    }
  }
  const sum = ks => ks.reduce((acc, k) => add(acc, byDay.get(k)), emptyBucket());
  const sessions = [...bySession.values()].sort((a, b) => b.cost - a.cost || b.last - a.last).slice(0, 40)
    .map(s => ({ ...s, ...sessionInfo(s.uuid, s.file) }));
  return {
    today: sum(keys.slice(0, 1)),
    week: sum(keys.slice(0, 7)),
    month: sum(keys),
    days: keys.map(k => ({ date: k, ...byDay.get(k) })),
    sessions,
  };
}
