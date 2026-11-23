// API de sesiones guardadas: catálogo, reseña, historia, grupos, descubrir y "Abrir" en tmux.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  getDb, groupTree, ensureGroup, uniqueName, findSession, toIso, now,
  UUID_RE, NAME_RE, ENTRY_KINDS,
} from './db.js';
import { transcriptPath, info as transcriptInfo, discover } from './transcripts.js';

const HOME = homedir();
const expandHome = p => (p || '').trim().replace(/^~(?=$|\/)/, HOME).replace(/(.)\/+$/, '$1');
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const shq = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// Cómo se abre una sesión guardada
export function launchPlan(s) {
  const tfile = transcriptPath(s.session_uuid);
  const t = tfile ? transcriptInfo(tfile) : null;
  // --resume solo encuentra la conversación desde el directorio donde nació
  const cwd = (t?.cwd && isDir(t.cwd) ? t.cwd : '') || (isDir(s.cwd) ? s.cwd : '') || HOME;
  const args = [];
  let uuid = s.session_uuid;
  let mode;
  if (uuid && t) { args.push('--resume', uuid); mode = 'resume'; }
  else {
    if (!uuid) uuid = randomUUID();                      // lanzador: conversación nueva cada vez
    args.push('--session-id', uuid);
    mode = s.session_uuid ? 'start' : 'launcher';
  }
  args.push('-n', s.name);
  const extra = (s.claude_args || '').trim();
  const prompt = mode !== 'resume' && s.start_prompt ? ' ' + shq(s.start_prompt) : '';
  const command = `claude ${args.map(shq).join(' ')}${extra ? ' ' + extra : ''}${prompt}`;
  return { cwd, uuid, mode, command, cwdMissing: !!s.cwd && !isDir(s.cwd) && !t };
}

// Comando para copiar y pegar en cualquier terminal
const copyCommand = s => {
  const p = launchPlan(s);
  return `cd ${shq(p.cwd)} && ${p.command}`;
};

export function savedRouter({ tmux, listSessions, shell }) {
  const r = express.Router();
  const db = getDb();

  const groupsById = () => new Map(groupTree(db).map(g => [g.id, g]));

  function enrich(s, groups, live) {
    const tfile = transcriptPath(s.session_uuid);
    const t = tfile ? transcriptInfo(tfile) : null;
    const lastEntry = toIso(s.last_entry_at);
    const acts = [t?.mtime, lastEntry && Date.parse(lastEntry), s.last_opened_at && Date.parse(s.last_opened_at)].filter(Boolean);
    const g = groups.get(s.group_id);
    return {
      id: s.id, name: s.name, title: s.title, session_uuid: s.session_uuid, cwd: s.cwd,
      start_prompt: s.start_prompt, claude_args: s.claude_args, status: s.status, pinned: !!s.pinned,
      group_id: s.group_id, group: g ? g.path : null, group_icon: g?.icon || '',
      summary: s.summary, n_entries: s.n_entries ?? 0, last_entry_at: lastEntry,
      created_at: toIso(s.created_at), updated_at: toIso(s.updated_at), last_opened_at: s.last_opened_at,
      last_activity: acts.length ? Math.max(...acts) : null,
      transcript: t ? { title: t.title, cwd: t.cwd, mtime: t.mtime, size: t.size, cost: t.cost,
                        first_prompt: t.first_prompt, last_prompt: t.last_prompt } : null,
      kind: !s.session_uuid ? 'launcher' : t ? 'resume' : 'new',
      live: live.get((s.session_uuid || '').toLowerCase()) || null,
      command: copyCommand(s),
    };
  }

  async function liveMap() {
    const m = new Map();
    try { for (const l of await listSessions()) if (l.uuid) m.set(l.uuid.toLowerCase(), l.name); } catch {}
    return m;
  }

  const SELECT = `SELECT s.*, (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id) AS n_entries,
                         (SELECT MAX(created_at) FROM entries e WHERE e.session_id = s.id) AS last_entry_at
                  FROM sessions s`;

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[saved]', e); res.status(500).json({ error: e.message }); }
  };
  const need = (req, res) => {
    const s = findSession(req.params.ref);
    if (!s) { res.status(404).json({ error: 'Sesión no encontrada' }); return null; }
    return s;
  };

  // ---------- lista ----------
  r.get('/', wrap(async (req, res) => {
    const status = ['active', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'active';
    const terms = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    let rows = db.prepare(SELECT + (status === 'all' ? '' : ' WHERE s.status = ?')).all(...(status === 'all' ? [] : [status]));
    if (terms.length) {
      const text = new Map(db.prepare(`SELECT session_id, group_concat(title || ' ' || body, ' ') AS t FROM entries GROUP BY session_id`).all().map(x => [x.session_id, x.t]));
      rows = rows.filter(s => {
        const hay = `${s.name} ${s.title} ${s.cwd} ${s.session_uuid} ${s.summary} ${text.get(s.id) || ''}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }
    const groups = groupsById(), live = await liveMap();
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM sessions GROUP BY status').all().map(x => [x.status, x.n]));
    res.json({ sessions: rows.map(s => enrich(s, groups, live)), groups: groupTree(db), counts, home: HOME });
  }));

  r.get('/discover', wrap(async (req, res) => {
    const registered = new Set(db.prepare(`SELECT lower(session_uuid) AS u FROM sessions WHERE session_uuid <> ''`).all().map(x => x.u));
    res.json(discover(registered, String(req.query.q || '')));
  }));

  r.get('/groups', (req, res) => res.json(groupTree(db)));

  r.post('/groups', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Nombre de grupo inválido' });
    const parent = req.body?.parent_id ? Number(req.body.parent_id) : null;
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM groups').get().p;
    const id = Number(db.prepare('INSERT INTO groups (name, parent_id, icon, position) VALUES (?, ?, ?, ?)')
      .run(name, parent, String(req.body?.icon || '').slice(0, 8), pos).lastInsertRowid);
    res.json({ id, groups: groupTree(db) });
  }));

  r.patch('/groups/:id', wrap(async (req, res) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(req.params.id));
    if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : g.name;
    const icon = req.body?.icon !== undefined ? String(req.body.icon).slice(0, 8) : g.icon;
    if (!name) return res.status(400).json({ error: 'Nombre de grupo inválido' });
    db.prepare('UPDATE groups SET name = ?, icon = ? WHERE id = ?').run(name, icon, g.id);
    res.json({ groups: groupTree(db) });
  }));

  r.delete('/groups/:id', wrap(async (req, res) => {
    db.prepare('DELETE FROM groups WHERE id = ?').run(Number(req.params.id));
    res.json({ groups: groupTree(db) });
  }));

  // ---------- alta / edición ----------
  function validate(body, id = null) {
    const d = {
      name: String(body.name ?? '').trim(),
      title: String(body.title ?? '').trim().slice(0, 200),
      session_uuid: String(body.session_uuid ?? '').trim().toLowerCase(),
      cwd: expandHome(String(body.cwd ?? '')),
      start_prompt: String(body.start_prompt ?? '').trim().slice(0, 4000),
      claude_args: String(body.claude_args ?? '').trim().slice(0, 300),
      status: body.status === 'archived' ? 'archived' : 'active',
      pinned: body.pinned ? 1 : 0,
    };
    if (!NAME_RE.test(d.name)) return { error: 'Nombre inválido: sin espacios, solo letras, números, punto, - y _ (máx 60).' };
    if (db.prepare('SELECT 1 FROM sessions WHERE name = ? AND id IS NOT ?').get(d.name, id))
      return { error: `Ya existe una sesión llamada «${d.name}».` };
    if (d.session_uuid && !UUID_RE.test(d.session_uuid)) return { error: 'El ID de sesión no tiene formato UUID.' };
    if (d.session_uuid) {
      const other = db.prepare('SELECT name FROM sessions WHERE lower(session_uuid) = ? AND id IS NOT ?').get(d.session_uuid, id);
      if (other) return { error: `Ese ID ya lo usa la sesión «${other.name}».` };
    }
    if (/[;&|`$<>]/.test(d.claude_args)) return { error: 'Los argumentos extra no pueden tener ; & | ` $ < >' };
    if (body.new_group) d.group_id = ensureGroup(body.new_group, db);
    else if (body.group !== undefined && body.group_id === undefined) d.group_id = ensureGroup(body.group, db);
    else d.group_id = body.group_id ? Number(body.group_id) || null : null;
    return { data: d };
  }

  r.post('/', wrap(async (req, res) => {
    const { error, data: d } = validate(req.body || {});
    if (error) return res.status(400).json({ error });
    const id = Number(db.prepare(`INSERT INTO sessions (group_id, name, title, session_uuid, cwd, start_prompt, claude_args, status, pinned)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.group_id, d.name, d.title, d.session_uuid, d.cwd, d.start_prompt, d.claude_args, d.status, d.pinned).lastInsertRowid);
    const out = { id, name: d.name };
    if (req.body.open) {
      try { out.tmux = await open(findSession(id)); }
      catch (e) { out.openError = `Guardada, pero no se pudo abrir: ${e.stderr || e.message}`; }
    }
    res.json(out);
  }));

  // Registro desde una sesión de Claude en curso (hcw register / skill): upsert por uuid
  r.post('/register', wrap(async (req, res) => {
    const b = req.body || {};
    const uuid = String(b.session_uuid || '').toLowerCase();
    if (!UUID_RE.test(uuid)) return res.status(400).json({ error: 'Falta session_uuid válido' });
    const cur = db.prepare('SELECT * FROM sessions WHERE lower(session_uuid) = ?').get(uuid);
    if (cur) {
      const patch = { ...cur, group_id: cur.group_id, pinned: cur.pinned };
      if (b.name) patch.name = b.name;
      if (b.title) patch.title = b.title;
      if (b.cwd && !cur.cwd) patch.cwd = b.cwd;
      if (b.group) { patch.group = b.group; delete patch.group_id; }
      const { error, data: d } = validate(patch, cur.id);
      if (error) return res.status(400).json({ error });
      db.prepare('UPDATE sessions SET name=?, title=?, cwd=?, group_id=?, updated_at=? WHERE id=?')
        .run(d.name, d.title, d.cwd, d.group_id, now(), cur.id);
      return res.json({ id: cur.id, name: d.name, created: false });
    }
    const name = b.name || uniqueName(String(b.cwd || '').split('/').filter(Boolean).pop() || 'sesion', db);
    const { error, data: d } = validate({ name, title: b.title, session_uuid: uuid, cwd: b.cwd, group: b.group });
    if (error) return res.status(400).json({ error });
    const id = Number(db.prepare('INSERT INTO sessions (group_id, name, title, session_uuid, cwd) VALUES (?, ?, ?, ?, ?)')
      .run(d.group_id, d.name, d.title, d.session_uuid, d.cwd).lastInsertRowid);
    res.json({ id, name: d.name, created: true });
  }));

  r.get('/:ref', wrap(async (req, res) => {
    const s0 = need(req, res); if (!s0) return;
    const s = db.prepare(SELECT + ' WHERE s.id = ?').get(s0.id);
    const out = enrich(s, groupsById(), await liveMap());
    out.entries = db.prepare('SELECT * FROM entries WHERE session_id = ? ORDER BY created_at DESC, id DESC').all(s.id)
      .map(e => ({ ...e, created_at: toIso(e.created_at) }));
    out.plan = launchPlan(s);
    res.json(out);
  }));

  r.patch('/:ref', wrap(async (req, res) => {
    const cur = need(req, res); if (!cur) return;
    const b = req.body || {};
    // cambios rápidos (fijar / archivar / grupo) sin pasar todo el formulario
    const merged = { ...cur, ...b };
    if (b.group_id === undefined && !b.new_group) merged.group_id = cur.group_id;
    if (b.pinned === undefined) merged.pinned = cur.pinned;
    const { error, data: d } = validate(merged, cur.id);
    if (error) return res.status(400).json({ error });
    db.prepare(`UPDATE sessions SET group_id=?, name=?, title=?, session_uuid=?, cwd=?, start_prompt=?, claude_args=?,
                status=?, pinned=?, updated_at=? WHERE id=?`)
      .run(d.group_id, d.name, d.title, d.session_uuid, d.cwd, d.start_prompt, d.claude_args, d.status, d.pinned, now(), cur.id);
    res.json({ ok: true, name: d.name });
  }));

  r.delete('/:ref', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    res.json({ ok: true });
  }));

  // ---------- abrir en tmux ----------
  async function open(s) {
    const live = await listSessions();
    if (s.session_uuid) {
      const running = live.find(l => (l.uuid || '').toLowerCase() === s.session_uuid.toLowerCase());
      if (running) return { name: running.name, already: true };
    }
    const plan = launchPlan(s);
    const base = s.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 36) || 'sesion';
    let name = base, i = 2;
    while (live.some(l => l.name === name)) name = `${base}-${i++}`;
    await tmux('new-session', '-d', '-s', name, '-c', plan.cwd, '-x', '200', '-y', '50', shell, '-l');
    await tmux('set-option', '-t', `=${name}:`, '@hermes_uuid', plan.uuid);
    await tmux('send-keys', '-t', `=${name}:`, '-l', plan.command);
    await tmux('send-keys', '-t', `=${name}:`, 'Enter');
    db.prepare('UPDATE sessions SET last_opened_at = ? WHERE id = ?').run(now(), s.id);
    return { name, mode: plan.mode, cwd: plan.cwd };
  }

  r.post('/:ref/open', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    res.json(await open(s));
  }));

  // ---------- reseña ----------
  r.put('/:ref/summary', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    const summary = String(req.body?.summary ?? '').trim().slice(0, 100_000);
    db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now(), s.id);
    res.json({ ok: true, id: s.id, name: s.name });
  }));

  // ---------- historia ----------
  const kindOf = k => { k = String(k || 'avance').trim().toLowerCase(); return ENTRY_KINDS.includes(k) ? k : (k.slice(0, 20) || 'avance'); };

  r.post('/:ref/entries', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    const title = String(req.body?.title ?? '').trim().slice(0, 300);
    const body = String(req.body?.body ?? '').trim().slice(0, 100_000);
    if (!title && !body) return res.status(400).json({ error: 'La entrada necesita título o detalle' });
    const id = Number(db.prepare('INSERT INTO entries (session_id, kind, title, body) VALUES (?, ?, ?, ?)')
      .run(s.id, kindOf(req.body?.kind), title, body).lastInsertRowid);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), s.id);
    res.json({ ok: true, id, session_id: s.id, name: s.name });
  }));

  r.patch('/:ref/entries/:eid', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    const e = db.prepare('SELECT * FROM entries WHERE id = ? AND session_id = ?').get(Number(req.params.eid), s.id);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    const b = req.body || {};
    db.prepare('UPDATE entries SET kind = ?, title = ?, body = ? WHERE id = ?').run(
      b.kind !== undefined ? kindOf(b.kind) : e.kind,
      b.title !== undefined ? String(b.title).trim().slice(0, 300) : e.title,
      b.body !== undefined ? String(b.body).trim().slice(0, 100_000) : e.body, e.id);
    res.json({ ok: true });
  }));

  r.delete('/:ref/entries/:eid', wrap(async (req, res) => {
    const s = need(req, res); if (!s) return;
    db.prepare('DELETE FROM entries WHERE id = ? AND session_id = ?').run(Number(req.params.eid), s.id);
    res.json({ ok: true });
  }));

  return r;
}
