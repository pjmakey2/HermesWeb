// Autenticación de HermesWeb: contraseña (scrypt) + cookie de sesión firmada (HMAC).
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const CONFIG_DIR = process.env.HERMES_CONFIG_DIR || path.join(homedir(), '.config', 'hermesweb');
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
// El nombre incluye el puerto: los navegadores no separan cookies por puerto, y dos instancias en
// el mismo host (p. ej. una de prueba) se pisarían la sesión.
export const COOKIE = `hermes_session_${process.env.PORT || 7681}`;
export const SESSION_DAYS = Number(process.env.HERMES_SESSION_DAYS || 30);

export function loadAuth() {
  if (!existsSync(AUTH_FILE)) return null;
  return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
}

export async function setPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const auth = {
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    // secreto nuevo → invalida todas las sesiones abiertas
    secret: randomBytes(32).toString('base64'),
    updated: new Date().toISOString(),
  };
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  return auth;
}

export async function checkPassword(auth, password) {
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  const hash = await scryptAsync(password, Buffer.from(auth.salt, 'base64'), 64, SCRYPT);
  return timingSafeEqual(hash, Buffer.from(auth.hash, 'base64'));
}

const b64u = b => Buffer.from(b).toString('base64url');
const sign = (auth, data) => createHmac('sha256', Buffer.from(auth.secret, 'base64')).update(data).digest('base64url');

export function makeSessionCookie(auth, secure) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = b64u(JSON.stringify({ exp, n: randomBytes(8).toString('hex') }));
  const value = `${payload}.${sign(auth, payload)}`;
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export const clearSessionCookie = secure =>
  `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export function validSession(auth, cookieHeader) {
  if (!auth) return false;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  const expected = Buffer.from(sign(auth, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}

// Límite de intentos por IP: 5 fallos → bloqueo creciente (30s, 60s, 120s… máx 15 min)
const attempts = new Map();
export function loginBlocked(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
export function loginFailed(ip) {
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails++;
  if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (a.fails - 5));
  attempts.set(ip, a);
}
export const loginOk = ip => attempts.delete(ip);
