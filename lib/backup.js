// Respaldo diario de la base de sesiones guardadas (hermes.db): <DATA_DIR>/backups/hermes-AAAAMMDD.db
// Usa VACUUM INTO (copia consistente aunque la base esté en uso). Conserva los últimos KEEP.
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, DATA_DIR } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.HERMES_BACKUP_KEEP || 14);

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// Orden por nombre (no por fecha del archivo: Linux la guarda con poca resolución).
// hermes-AAAAMMDD.db es el automático, el primero del día; los manuales llevan hora y contador.
const order = f => {
  const [, d, t = '000000', n = '0'] = /^hermes-(\d{8})(?:-(\d{6})(?:-(\d+))?)?\.db$/.exec(f);
  return `${d}${t}${n.padStart(4, '0')}`;
};

export function listBackups() {
  try {
    return readdirSync(BACKUP_DIR).filter(f => /^hermes-\d{8}(-\d{6}(-\d+)?)?\.db$/.test(f))
      .map(f => { const st = statSync(path.join(BACKUP_DIR, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => order(b.file).localeCompare(order(a.file)));
  } catch { return []; }
}

export function backupNow({ force = false } = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  let name = `hermes-${stamp()}.db`;
  if (existsSync(path.join(BACKUP_DIR, name))) {
    if (!force) return null;                                   // el de hoy ya existe
    const t = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    name = `hermes-${stamp()}-${t}.db`;
    for (let i = 2; existsSync(path.join(BACKUP_DIR, name)); i++) name = `hermes-${stamp()}-${t}-${i}.db`;
  }
  const file = path.join(BACKUP_DIR, name);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups().slice(KEEP)) { try { unlinkSync(path.join(BACKUP_DIR, old.file)); } catch {} }
  return name;
}

export function startBackups() {
  const run = () => { try { const f = backupNow(); if (f) console.log(`[respaldo] ${f}`); } catch (e) { console.warn('[respaldo]', e.message); } };
  run();
  setInterval(run, 3 * 3600e3).unref();
}
