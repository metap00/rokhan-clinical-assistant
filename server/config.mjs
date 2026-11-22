import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tests build the object by hand instead.
export function loadConfig(env = process.env) {
  const tz = env.ROKHAN_TZ || 'Europe/Bucharest';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new Error(`ROKHAN_TZ "${tz}" is not a valid IANA time zone (for example Europe/Bucharest).`);
  }
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.ROKHAN_DATA_DIR || path.join(ROOT, 'data')),
    password: env.ROKHAN_PASSWORD || null,
    publicOrigin: env.ROKHAN_PUBLIC_ORIGIN ? env.ROKHAN_PUBLIC_ORIGIN.replace(/\/+$/, '') : null,
    model: env.ROKHAN_MODEL || 'claude-opus-5-5',
    effort: env.ROKHAN_EFFORT || 'high',
    fakeLlm: env.ROKHAN_FAKE_LLM === '1',
    pushContact: env.ROKHAN_PUSH_CONTACT || null,
    tz,
    root: ROOT,
  };
}
