// Copia las sesiones de ManagWorkDashboard (grupos, reseñas e historia) a HermesWeb.
// La base de ManagWorkDashboard se abre en SOLO LECTURA: no se modifica.
//
//   npm run import-mwd [-- /ruta/a/dashboard.db] [--dry-run]
//
// Es idempotente: las sesiones que ya existen en HermesWeb (mismo nombre o mismo uuid) se saltan.
// Si una sesión no tiene directorio pero su conversación existe en esta máquina, se completa con
// el directorio del transcript (claude --resume solo la encuentra desde ahí).
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import { getDb, DB_FILE } from '../lib/db.js';
import { transcriptPath, info } from '../lib/transcripts.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const src = args.find(a => !a.startsWith('--'))
  || path.join(homedir(), 'projects', 'ManagWorkDashboard', 'data', 'dashboard.db');

const mwd = new DatabaseSync(src, { readOnly: true });
const db = getDb();
const iso = s => (!s ? null : s.replace(' ', 'T') + 'Z');

const stats = { groups: 0, sessions: 0, skipped: [], entries: 0, cwdFromTranscript: 0 };

db.exec('BEGIN');
try {
  // grupos usados por sesiones, con sus ancestros (para conservar el árbol)
  const groups = mwd.prepare('SELECT * FROM groups').all();
  const byId = new Map(groups.map(g => [g.id, g]));
  const needed = new Set();
  for (const { group_id } of mwd.prepare('SELECT DISTINCT group_id FROM sessions WHERE group_id IS NOT NULL').all()) {
    for (let g = byId.get(group_id); g && !needed.has(g.id); g = byId.get(g.parent_id)) needed.add(g.id);
  }
  const map = new Map();   // id en MWD -> id en HermesWeb
  const ensure = g => {
    if (map.has(g.id)) return map.get(g.id);
    const parent = g.parent_id && byId.has(g.parent_id) ? ensure(byId.get(g.parent_id)) : null;
    const found = db.prepare('SELECT id FROM groups WHERE name = ? AND parent_id IS ?').get(g.name, parent);
    let id = found?.id;
    if (!id) {
      id = Number(db.prepare('INSERT INTO groups (name, parent_id, icon, position) VALUES (?, ?, ?, ?)')
        .run(g.name, parent, g.icon || '', g.position || 0).lastInsertRowid);
      stats.groups++;
    }
    map.set(g.id, id);
    return id;
  };
  for (const id of needed) ensure(byId.get(id));

  const insS = db.prepare(`INSERT INTO sessions (group_id, name, title, session_uuid, cwd, start_prompt, summary, status, pinned, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insE = db.prepare('INSERT INTO entries (session_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)');

  for (const s of mwd.prepare('SELECT * FROM sessions ORDER BY id').all()) {
    const uuid = (s.session_uuid || '').trim().toLowerCase();
    const clash = db.prepare('SELECT name FROM sessions WHERE name = ? OR (? <> \'\' AND lower(session_uuid) = ?)').get(s.name, uuid, uuid);
    if (clash) { stats.skipped.push(`${s.name} (ya existe como «${clash.name}»)`); continue; }

    let cwd = (s.cwd || '').trim().replace(/(.)\/+$/, '$1');
    if (!cwd && uuid) {
      const t = transcriptPath(uuid);
      const tc = t && info(t)?.cwd;
      if (tc) { cwd = tc; stats.cwdFromTranscript++; }
    }
    const id = Number(insS.run(
      s.group_id ? map.get(s.group_id) ?? null : null, s.name, (s.title || '').trim(), uuid, cwd,
      s.start_prompt || '', s.summary || '', s.status === 'archived' ? 'archived' : 'active', s.pinned ? 1 : 0,
      iso(s.created_at) || new Date().toISOString(), iso(s.updated_at) || new Date().toISOString(),
    ).lastInsertRowid);
    stats.sessions++;
    for (const e of mwd.prepare('SELECT * FROM session_entries WHERE session_id = ? ORDER BY created_at, id').all(s.id)) {
      insE.run(id, e.kind || 'avance', e.title || '', e.body || '', iso(e.created_at));
      stats.entries++;
    }
  }
  db.exec(dry ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log(`${dry ? '[simulación] ' : ''}Origen: ${src}`);
console.log(`Destino: ${DB_FILE}`);
console.log(`Sesiones copiadas: ${stats.sessions} · entradas de historia: ${stats.entries} · grupos nuevos: ${stats.groups}`);
console.log(`Directorio completado desde el transcript: ${stats.cwdFromTranscript}`);
if (stats.skipped.length) console.log(`Saltadas (${stats.skipped.length}):\n  ` + stats.skipped.join('\n  '));
