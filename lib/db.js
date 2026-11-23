// Base de datos de HermesWeb (SQLite integrado de Node): sesiones guardadas, grupos e historia.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.HERMES_DATA_DIR || path.join(homedir(), '.local', 'share', 'hermesweb');
export const DB_FILE = path.join(DATA_DIR, 'hermes.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  icon       TEXT    NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0
);

-- session_uuid: el ID de la conversación de Claude. Se genera al crear la sesión, así el
-- primer "Abrir" usa claude --session-id <uuid> y los siguientes claude --resume <uuid>.
-- Vacío = lanzador: cada apertura es una conversación nueva (con el prompt inicial).
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY,
  group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL UNIQUE,
  title          TEXT    NOT NULL DEFAULT '',
  session_uuid   TEXT    NOT NULL DEFAULT '',
  cwd            TEXT    NOT NULL DEFAULT '',
  start_prompt   TEXT    NOT NULL DEFAULT '',
  claude_args    TEXT    NOT NULL DEFAULT '',
  summary        TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_opened_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_uuid ON sessions(session_uuid);
CREATE INDEX IF NOT EXISTS sessions_group ON sessions(group_id);

CREATE TABLE IF NOT EXISTS entries (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'avance',
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS entries_session ON entries(session_id, created_at);
`;

let db;
export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
export const ENTRY_KINDS = ['avance', 'decisión', 'problema', 'pendiente', 'nota'];
export const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Convierte fechas "YYYY-MM-DD HH:MM:SS" (UTC, formato de SQLite) a ISO
export const toIso = s => (!s ? null : /T/.test(s) ? s : s.replace(' ', 'T') + 'Z');

// Grupos en orden de árbol, con path "Padre / Hijo" y profundidad
export function groupTree(conn = getDb()) {
  const rows = conn.prepare(`SELECT g.*, (SELECT COUNT(*) FROM sessions s WHERE s.group_id = g.id) AS n
                             FROM groups g ORDER BY position, name COLLATE NOCASE`).all();
  const ids = new Set(rows.map(r => r.id));
  const byParent = new Map();
  for (const r of rows) {
    const p = ids.has(r.parent_id) ? r.parent_id : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(r);
  }
  const out = [];
  const walk = (parent, depth, prefix) => {
    for (const r of byParent.get(parent) || []) {
      const pathName = prefix + r.name;
      out.push({ id: r.id, name: r.name, icon: r.icon, parent_id: r.parent_id, depth, path: pathName, n: r.n });
      walk(r.id, depth + 1, pathName + ' / ');
    }
  };
  walk(null, 0, '');
  return out;
}

export function ensureGroup(name, conn = getDb()) {
  name = (name || '').trim();
  if (!name) return null;
  const row = conn.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE ORDER BY parent_id IS NOT NULL LIMIT 1').get(name);
  if (row) return row.id;
  const pos = conn.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM groups').get().p;
  return Number(conn.prepare('INSERT INTO groups (name, position) VALUES (?, ?)').run(name, pos).lastInsertRowid);
}

export function uniqueName(base, conn = getDb()) {
  base = (base || 'sesion').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'sesion';
  let name = base, i = 2;
  while (conn.prepare('SELECT 1 FROM sessions WHERE name = ?').get(name)) name = `${base}_${i++}`;
  return name;
}

// ref = id numérico, nombre o uuid
export function findSession(ref, conn = getDb()) {
  ref = String(ref ?? '').trim();
  if (!ref) return null;
  if (/^\d+$/.test(ref)) {
    const r = conn.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(ref));
    if (r) return r;
  }
  return conn.prepare('SELECT * FROM sessions WHERE name = ?').get(ref)
    || (UUID_RE.test(ref) ? conn.prepare('SELECT * FROM sessions WHERE lower(session_uuid) = lower(?) ORDER BY id LIMIT 1').get(ref) : null)
    || null;
}
