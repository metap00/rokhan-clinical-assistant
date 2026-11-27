import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Synchronous on purpose: one user, small files, and no interleaving between read and write.

export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Lowercase, no diacritics, single spaces. Used to match logbook names typed any way.
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

// UI text carries no en dash or em dash: a plain hyphen instead.
export const plainDashes = (s) => String(s ?? '').replace(/[\u2013\u2014]/g, '-');

// 'YYYY-MM-DD' of the given instant in the given IANA time zone.
export function dayIn(tz, ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
