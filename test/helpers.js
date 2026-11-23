// Levanta una instancia aislada de HermesWeb (scripts/dev-server.sh) para los tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UUID = '11111111-2222-4333-8444-555555555555';

// Transcript de Claude falso, con fechas de hoy: 2 respuestas (una repetida) y costo 0.5 → 1.25
function fakeTranscripts(dir) {
  const proj = path.join(dir, '-tmp-proyecto');
  mkdirSync(proj, { recursive: true });
  const t = new Date().toISOString();
  const usage = (id, out) => ({ type: 'assistant', timestamp: t, message: { id, model: 'claude-test',
    usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } });
  const lines = [
    { type: 'ai-title', aiTitle: 'Sesión de prueba' },
    { type: 'user', cwd: '/tmp', timestamp: t, message: { role: 'user', content: 'hola' } },
    usage('msg_1', 7), usage('msg_1', 7),            // mismo mensaje en dos registros: cuenta una vez
    { type: 'cost-state', totalCostUSD: 0.5 },
    usage('msg_2', 3),
    { type: 'cost-state', totalCostUSD: 1.25 },
  ];
  writeFileSync(path.join(proj, `${UUID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

export function startServer(port, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hermes-test-'));
  const env = {
    ...process.env, HERMES_DEV_DIR: path.join(dir, 'dev'), HERMES_HOST_LABEL: 'TEST',
    CLAUDE_PROJECTS_DIR: fakeTranscripts(path.join(dir, 'claude')), ...extraEnv,
  };
  const out = execFileSync(path.join(ROOT, 'scripts/dev-server.sh'), ['start', String(port)], { env, encoding: 'utf8' });
  const info = Object.fromEntries(out.trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
  const password = readFileSync(info.PASSWORD_FILE, 'utf8').trim();
  const tmux = (...args) => execFileSync('tmux', ['-S', info.TMUX_SOCKET, ...args], { encoding: 'utf8' });
  return {
    url: info.URL, password, tmux, dir,
    stop() {
      try { execFileSync(path.join(ROOT, 'scripts/dev-server.sh'), ['stop', String(port)], { env }); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function login(url, password) {
  const r = await fetch(url + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error('login: ' + r.status);
  return r.headers.get('set-cookie').split(';')[0];
}

export const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 200));
  }
};
