// "¿Qué cambió Claude?": estado de git y diff del directorio de una sesión (solo lectura).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX = 600_000; // bytes de diff que se devuelven como mucho

const git = (cwd, ...args) => exec('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
  { maxBuffer: 20 * 1024 * 1024, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });

export async function sessionDiff(cwd) {
  let root;
  try { root = (await git(cwd, 'rev-parse', '--show-toplevel')).stdout.trim(); }
  catch { return { repo: false, cwd }; }
  const [branch, status, stat, diff, log] = await Promise.all([
    git(root, 'rev-parse', '--abbrev-ref', 'HEAD').then(r => r.stdout.trim()).catch(() => ''),
    git(root, 'status', '--porcelain=v1', '-uall').then(r => r.stdout).catch(() => ''),
    git(root, 'diff', 'HEAD', '--numstat').then(r => r.stdout).catch(() => ''),
    git(root, 'diff', 'HEAD', '--no-ext-diff', '-M').then(r => r.stdout).catch(() =>
      git(root, 'diff', '--no-ext-diff').then(r => r.stdout).catch(() => '')),   // repo sin commits
    git(root, 'log', '-5', '--format=%h\x1f%s\x1f%cr').then(r => r.stdout).catch(() => ''),
  ]);
  const nums = new Map(stat.split('\n').filter(Boolean).map(l => {
    const [a, d, ...f] = l.split('\t');
    return [f.join('\t').replace(/^.*\{.* => (.*)\}.*$/, '$1'), { add: a === '-' ? null : +a, del: d === '-' ? null : +d }];
  }));
  const files = status.split('\n').filter(Boolean).map(l => {
    const code = l.slice(0, 2), file = l.slice(3).replace(/^.* -> /, '');
    return { code: code.trim() || code, file, ...(nums.get(file) || {}) };
  });
  // archivos nuevos (sin seguimiento): git diff HEAD no los incluye → diff contra /dev/null
  let full = diff;
  for (const f of files.filter(f => f.code === '??').slice(0, 30)) {
    if (full.length > MAX) break;
    const r = await git(root, 'diff', '--no-index', '--no-ext-diff', '--', '/dev/null', f.file)
      .catch(e => ({ stdout: e.stdout || '' }));               // --no-index sale con 1 si hay diferencias
    full += r.stdout;
    const added = (r.stdout.match(/^\+(?!\+\+)/gm) || []).length;
    if (f.add == null && !/^Binary/m.test(r.stdout)) f.add = added, f.del = 0;
  }
  return {
    repo: true, root, cwd, branch, files,
    diff: full.length > MAX ? full.slice(0, MAX) : full,
    truncated: full.length > MAX,
    commits: log.split('\n').filter(Boolean).map(l => { const [hash, subject, when] = l.split('\x1f'); return { hash, subject, when }; }),
  };
}
