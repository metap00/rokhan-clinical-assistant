import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from '../store/files.mjs';

export const COOKIE = 'rokhan_session';
const MAX_AGE_MS = 180 * 24 * 3600 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5; // per client address
const MAX_FAILS_GLOBAL = 20; // all addresses together, so no header trick gives unlimited guesses

const instances = new WeakMap();

// One per config object: signing key in <dataDir>/secret.key, sessions in <dataDir>/sessions.json.
export function getAuth(config) {
  if (!instances.has(config)) instances.set(config, createAuth(config));
  return instances.get(config);
}

// The 32-byte cookie signing key. Refuses a damaged file instead of signing with a weak key.
export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text !== null) {
    if (!/^[0-9a-f]{64}$/i.test(text)) {
      throw new Error(`${file} is damaged (expected 64 hex characters, 32 bytes). Delete it to create a new key; everyone will have to log in again.`);
    }
    return Buffer.from(text, 'hex');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = crypto.randomBytes(32);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, secret.toString('hex') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return secret;
}

const passwordHash = (password, salt) => crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex');

function createAuth(config) {
  const secret = loadSecret(config.dataDir);
  const sessionsFile = path.join(config.dataDir, 'sessions.json');
  const secure = String(config.publicOrigin || '').startsWith('https');
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const sign = (value) => crypto.createHmac('sha256', secret).update(String(value)).digest('hex');

  // Sessions: { id: expiryMs }. Cleared when the password is not the one they were made under.
  const stored = readJson(sessionsFile, null);
  let pw = stored?.password;
  let sessions = {};
  if (pw?.salt && config.password && passwordHash(config.password, pw.salt) === pw.hash) {
    const now = Date.now();
    sessions = Object.fromEntries(Object.entries(stored.sessions ?? {}).filter(([, exp]) => exp > now));
  } else if (config.password) {
    const salt = crypto.randomBytes(16).toString('hex');
    pw = { salt, hash: passwordHash(config.password, salt) };
  }
  const saveSessions = () => writeJsonAtomic(sessionsFile, { password: pw, sessions });
  if (config.password) saveSessions();

  const failures = new Map(); // ip -> [failure timestamps]
  let globalFailures = [];

  function checkPassword(given) {
    if (!config.password || typeof given !== 'string') return false;
    return crypto.timingSafeEqual(sha(given), sha(config.password));
  }

  function makeCookie(now = Date.now()) {
    const id = crypto.randomBytes(16).toString('hex');
    const exp = now + MAX_AGE_MS;
    for (const [k, e] of Object.entries(sessions)) if (e <= now) delete sessions[k];
    sessions[id] = exp;
    saveSessions();
    return `${COOKIE}=${id}.${exp}.${sign(`${id}.${exp}`)}; Max-Age=${MAX_AGE_MS / 1000}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
  }

  function clearCookie() {
    return `${COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
  }

  // The session id of a cookie value when its signature, expiry and server-side record hold, else null.
  function verifyValue(value, now = Date.now()) {
    const m = /^([0-9a-f]{32})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(value || '');
    if (!m) return null;
    const good = Buffer.from(sign(`${m[1]}.${m[2]}`), 'hex');
    if (!crypto.timingSafeEqual(good, Buffer.from(m[3], 'hex'))) return null;
    if (Number(m[2]) <= now || !(sessions[m[1]] > now)) return null;
    return m[1];
  }

  function verify(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) {
        const id = verifyValue(part.slice(i + 1).trim());
        if (id) return id;
      }
    }
    return null;
  }

  function endSession(req) {
    const id = verify(req);
    if (id) {
      delete sessions[id];
      saveSessions();
    }
  }

  // Behind the proxy, the right-most X-Forwarded-For entry is the one the proxy itself added.
  function clientIp(req) {
    if (config.publicOrigin) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '?';
  }

  // Seconds until this ip may try again, or 0. Drops expired failures and empty buckets.
  function blockedFor(ip, now = Date.now()) {
    const recent = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length) failures.set(ip, recent);
    else failures.delete(ip);
    globalFailures = globalFailures.filter((t) => now - t < WINDOW_MS);
    let wait = 0;
    if (recent.length >= MAX_FAILS) wait = recent[0] + WINDOW_MS - now;
    if (globalFailures.length >= MAX_FAILS_GLOBAL) wait = Math.max(wait, globalFailures[0] + WINDOW_MS - now);
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  function recordFailure(ip, now = Date.now()) {
    failures.set(ip, [...(failures.get(ip) || []), now]);
    globalFailures.push(now);
  }

  function clearFailures(ip) {
    failures.delete(ip);
  }

  return {
    checkPassword, makeCookie, clearCookie, verify, verifyValue, endSession, sign, clientIp,
    blockedFor, recordFailure, clearFailures, bucketCount: () => failures.size,
  };
}
