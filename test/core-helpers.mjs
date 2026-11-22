import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { ROOT } from '../server/config.mjs';

export const tmpDir = (p = 'rokhan-core-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

export function makeConfig(over = {}) {
  return {
    port: 0, host: '127.0.0.1', dataDir: tmpDir(), password: 'parola-test', publicOrigin: null,
    model: 'claude-opus-5-5', effort: 'high', fakeLlm: true, tz: 'Europe/Bucharest', root: ROOT, ...over,
  };
}

// Starts a server; returns helpers bound to it. Call close() in an after hook.
export async function boot(over = {}) {
  const config = makeConfig(over);
  const srv = await startServer(config);
  let cookie = '';
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(srv.url + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, json, text };
  };
  const login = async () => {
    const r = await api('POST', '/api/login', { password: config.password }, config.publicOrigin ? { origin: config.publicOrigin } : {});
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return r;
  };
  return { config, ...srv, api, login, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

// Reads SSE frames until `done` (or the stream ends). onEvent may return 'stop' to abort early.
export async function readSse(res, onEvent = () => {}) {
  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!ev) continue;
      const e = { event: ev, data: JSON.parse(data) };
      events.push(e);
      if ((await onEvent(e)) === 'stop') {
        await reader.cancel();
        return events;
      }
      if (ev === 'done') {
        await reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  return events;
}
