import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, waitFor, UUID } from './helpers.js';

const PORT = 7790;
let srv, cookie, api;

before(async () => {
  srv = startServer(PORT);
  cookie = await login(srv.url, srv.password);
  api = (p, opts = {}) => fetch(srv.url + p, { ...opts, headers: { cookie, origin: srv.url, 'content-type': 'application/json', ...opts.headers } });
});
after(() => srv?.stop());

test('la cookie de sesión lleva el puerto en el nombre', () => {
  assert.match(cookie, new RegExp(`^hermes_session_${PORT}=`));
});

test('sin sesión no hay acceso', async () => {
  const r = await fetch(srv.url + '/api/sessions');
  assert.equal(r.status, 401);
});

test('contraseña incorrecta', async () => {
  const r = await fetch(srv.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.url }, body: '{"password":"no"}' });
  assert.equal(r.status, 401);
});

test('rechaza otro origen, acepta X-Forwarded-Host desde localhost (proxy)', async () => {
  assert.equal((await api('/api/backup', { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  const r = await api('/api/backup', { method: 'POST', headers: { origin: 'https://m.ts.net', 'x-forwarded-host': 'm.ts.net' } });
  assert.equal(r.status, 200);
});

test('crear sesión, ver su estado y cerrarla', async () => {
  let r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'shell1', cwd: '/tmp', command: '' }) });
  assert.equal(r.status, 200, await r.text());
  // el shell tarda un momento en arrancar; hasta entonces tmux puede informar otra carpeta
  const s = await waitFor(async () => (await (await api('/api/sessions')).json()).sessions.find(x => x.name === 'shell1' && x.cwd === '/tmp'));
  assert.equal(s.cwd, '/tmp');
  assert.equal(s.state, 'shell');
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'shell1', cwd: '/tmp', command: '' }) });
  assert.equal(r.status, 409);
  assert.equal((await api('/api/sessions/shell1', { method: 'DELETE' })).status, 200);
});

test('detecta cuando Claude pide permiso', async () => {
  srv.tmux('new-session', '-d', '-s', 'pide', '-x', '100', '-y', '30', `bash --norc -c 'printf "Do you want to proceed?\\n❯ 1. Yes\\n"; exec cat'`);
  const s = await waitFor(async () => (await (await api('/api/sessions')).json()).sessions.find(x => x.name === 'pide' && x.state === 'ask'));
  assert.ok(s);
});

test('cambios: repo git y carpeta sin git', async () => {
  srv.tmux('new-session', '-d', '-s', 'repo', '-c', process.cwd(), 'bash --norc');
  srv.tmux('new-session', '-d', '-s', 'norepo', '-c', srv.dir, 'bash --norc');
  const d = await waitFor(async () => { const r = await api('/api/sessions/repo/diff'); return r.ok && r.json(); });
  assert.equal(d.repo, true);
  assert.ok(d.branch);
  assert.ok(Array.isArray(d.files));
  const n = await (await api('/api/sessions/norepo/diff')).json();
  assert.equal(n.repo, false);
  assert.equal((await api('/api/sessions/noexiste/diff')).status, 404);
});

test('uso: tokens sin duplicar y costo por incrementos', async () => {
  const u = await (await api('/api/usage?days=7')).json();
  assert.equal(u.today.output, 10);          // 7 + 3 (msg_1 repetido cuenta una vez)
  assert.equal(u.today.messages, 2);
  assert.equal(u.today.cache_read, 200);
  assert.ok(Math.abs(u.today.cost - 1.25) < 1e-9);
  assert.equal(u.days.length, 7);
  const s = u.sessions.find(x => x.uuid === UUID);
  assert.equal(s.title, 'Sesión de prueba');
  assert.equal(s.cwd, '/tmp');
});

test('ajustes y respaldos', async () => {
  const s = await (await api('/api/settings')).json();
  assert.equal(s.host, 'TEST');
  assert.deepEqual(s.notify, []);
  const r1 = await (await api('/api/backup', { method: 'POST' })).json();
  const r2 = await (await api('/api/backup', { method: 'POST' })).json();
  assert.notEqual(r1.file, r2.file);
  const s2 = await (await api('/api/settings')).json();
  assert.ok(s2.backups.total >= 3);           // el diario del arranque + 2 manuales (+ el del test de origen)
  assert.equal(s2.backups.list[0].file, r2.file);
  assert.equal((await api('/api/notify/test', { method: 'POST' })).status, 400);  // sin canales
});

test('PWA: manifiesto e íconos sin sesión', async () => {
  for (const f of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png']) {
    const r = await fetch(srv.url + f);
    assert.equal(r.status, 200, f);
  }
});
