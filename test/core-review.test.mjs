// Fixes from the security review. Numbers are the review's finding numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { boot, makeConfig, tmpDir } from './core-helpers.mjs';
import { startServer } from '../server/index.mjs';
import { loadConfig } from '../server/config.mjs';
import { getRegistru } from '../server/store/registru.mjs';
import { getMemorie } from '../server/store/memorie.mjs';
import { getConversations } from '../server/store/conversations.mjs';
import { SECURITY_HEADERS } from '../server/http/router.mjs';
import { run } from '../scripts/import-from-openclaw.mjs';

const PAGE = fs.readFileSync(fileURLToPath(new URL('./fixtures/core/registru-de-proceduri.md', import.meta.url)), 'utf8');

function raw(url, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('2: login throttle', () => {
  const origin = 'https://rokhan.example:8444';
  const bad = (s, xff) => s.api('POST', '/api/login', { password: 'x' }, { origin, 'x-forwarded-for': xff });

  test('counts the right-most X-Forwarded-For entry, not the client-written first one', async () => {
    const s = await boot({ publicOrigin: origin });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await bad(s, `6.6.6.${i}, 1.2.3.4`)).status, 401);
      assert.equal((await bad(s, '7.7.7.7, 1.2.3.4')).status, 429); // same proxy-added address
      assert.equal((await bad(s, '1.2.3.4, 5.6.7.8')).status, 401); // her address only in the spoofable part
    } finally {
      await s.close();
    }
  });

  test('a global cap of 20 failures per 15 minutes across all addresses', async () => {
    const s = await boot({ publicOrigin: origin });
    try {
      for (let i = 0; i < 20; i++) assert.equal((await bad(s, `10.0.${i}.1`)).status, 401, `try ${i}`);
      const r = await s.api('POST', '/api/login', { password: s.config.password }, { origin, 'x-forwarded-for': '10.9.9.9' });
      assert.equal(r.status, 429);
    } finally {
      await s.close();
    }
  });

  test('empty buckets are deleted', async () => {
    const { getAuth } = await import('../server/http/auth.mjs');
    const auth = getAuth(makeConfig());
    const t0 = Date.now();
    auth.recordFailure('9.9.9.9', t0);
    assert.equal(auth.blockedFor('9.9.9.9', t0 + 16 * 60e3), 0);
    assert.equal(auth.bucketCount(), 0);
  });
});

describe('6: sessions that can end', () => {
  test('logout ends the session; the old cookie is refused', async () => {
    const s = await boot();
    try {
      await s.login();
      const cookie = s.cookie;
      assert.equal((await s.api('GET', '/api/registru')).status, 200);
      await s.api('POST', '/api/logout');
      s.cookie = cookie;
      assert.equal((await s.api('GET', '/api/registru')).status, 401);
    } finally {
      await s.close();
    }
  });

  test('sessions survive a restart, a password change clears them, the password is not stored', async () => {
    const s = await boot();
    await s.login();
    const cookie = s.cookie;
    await s.close();
    const file = path.join(s.config.dataDir, 'sessions.json');
    assert.ok(fs.existsSync(file));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(s.config.password));

    const again = await startServer({ ...s.config });
    let r = await fetch(again.url + '/api/registru', { headers: { cookie } });
    assert.equal(r.status, 200);
    await again.close();

    const changed = await startServer({ ...s.config, password: 'alta-parola' });
    r = await fetch(changed.url + '/api/registru', { headers: { cookie } });
    assert.equal(r.status, 401);
    await changed.close();
  });

  test('expired ids are dropped on load', async () => {
    const config = makeConfig();
    const s = await startServer(config);
    await s.close();
    const file = path.join(config.dataDir, 'sessions.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.sessions = { old: Date.now() - 1000, live: Date.now() + 60e3 };
    fs.writeFileSync(file, JSON.stringify(data));
    const t = await startServer({ ...config });
    await t.close();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions), ['live']);
  });
});

describe('7: signing key', () => {
  for (const content of ['', 'not hex at all', 'abc', 'ab'.repeat(31)]) {
    test(`refuses to start with secret.key = ${JSON.stringify(content.slice(0, 20))}`, async () => {
      const config = makeConfig();
      fs.writeFileSync(path.join(config.dataDir, 'secret.key'), content);
      await assert.rejects(startServer(config), /secret\.key/);
    });
  }

  test('a new key is 32 bytes, written through a temporary file', async () => {
    const config = makeConfig();
    const s = await startServer(config);
    await s.close();
    assert.match(fs.readFileSync(path.join(config.dataDir, 'secret.key'), 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(config.dataDir).filter((f) => f.includes('.tmp')), []);
  });
});

describe('8: cross-site requests', () => {
  test('a body without Content-Type: application/json is 415', async () => {
    const s = await boot();
    try {
      await s.login();
      let r = await s.api('POST', '/api/registru/rows', '{"nume":"Form"}', { 'content-type': 'text/plain', origin: 'https://evil.example' });
      assert.deepEqual([r.status, r.json], [415, { error: 'tip_continut' }]);
      r = await s.api('POST', '/api/registru/rows', '{"nume":"Form"}', { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal(r.status, 415);
      assert.ok(!(await s.api('GET', '/api/registru')).json.rows.some((x) => x.nume === 'Form'));
      r = await s.api('POST', '/api/registru/rows', { nume: 'Json' }, { 'content-type': 'application/json; charset=utf-8' });
      assert.equal(r.status, 200);
      assert.equal((await s.api('POST', '/api/logout')).status, 200); // no body: no content type needed
    } finally {
      await s.close();
    }
  });

  test('warning at start when public origin is unset and HOST is not loopback', async () => {
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
      const s = await startServer(makeConfig({ host: '0.0.0.0' }));
      await s.close();
      const t = await startServer(makeConfig());
      await t.close();
    } finally {
      console.warn = orig;
    }
    assert.equal(lines.filter((l) => /ROKHAN_PUBLIC_ORIGIN/.test(l)).length, 1);
  });
});

test('9: files are created without group/other permissions', { skip: process.platform === 'win32' && 'no POSIX modes on Windows' }, async () => {
  const s = await boot();
  await s.close();
  const mode = fs.statSync(path.join(s.config.dataDir, 'conversations')).mode & 0o077;
  assert.equal(mode, 0);
});

test('9: server/index.mjs sets umask 077', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../server/index.mjs', import.meta.url)), 'utf8');
  assert.match(src, /^process\.umask\(0o077\);$/m);
});

test('12: CSP has form-action self', () => {
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /form-action 'self'/);
});

describe('13: static files', () => {
  test('dot segments are 404; links out of web/ are not followed', async () => {
    const root = tmpDir('rokhan-root-');
    const outside = tmpDir('rokhan-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    fs.mkdirSync(path.join(root, 'web', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'index.html'), 'app');
    fs.writeFileSync(path.join(root, 'web', '.env'), 'ROKHAN_PASSWORD=x');
    fs.writeFileSync(path.join(root, 'web', '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1"}');
    fs.symlinkSync(outside, path.join(root, 'web', 'link'), 'junction'); // works without admin on Windows
    const s = await boot({ root });
    try {
      for (const p of ['/.env', '/.git/config', '/.git', '/x/.hidden/a.js', '/link/secret.txt']) {
        const r = await raw(s.url, p);
        assert.equal(r.status, 404, p);
        assert.doesNotMatch(r.body, /SECRET|ROKHAN|core/, p);
      }
      assert.equal((await raw(s.url, '/')).body, 'app');
    } finally {
      await s.close();
    }
  });
});

test('17: a row named "constructor" does not count as babies', () => {
  const r = getRegistru(makeConfig());
  r.addEntry({ row: 'constructor', n: 7 });
  r.addEntry({ row: 'toString', n: 2 });
  r.addEntry({ row: '__proto__', n: 1 });
  const { copii } = r.summary();
  assert.deepEqual(copii, { total: 0, vaginale: 0, cezariene: 0, primul: null });
  assert.ok(r.summary().entries.every((e) => e.copii === 0));
});

test('19: an invalid ROKHAN_TZ fails in loadConfig with a clear message', () => {
  assert.throws(() => loadConfig({ ROKHAN_TZ: 'Europe/Bucuresti' }), /ROKHAN_TZ.*Europe\/Bucuresti/);
  assert.equal(loadConfig({ ROKHAN_TZ: 'Europe/Bucharest' }).tz, 'Europe/Bucharest');
});

describe('4: history of memory pages and logbook changes', () => {
  test('memorie.write keeps the old page in memory/.history, newest 20, not listed', () => {
    const config = makeConfig();
    const m = getMemorie(config);
    m.write('profil', 'v0');
    m.write('subiect-a-b', 'other');
    for (let i = 1; i <= 25; i++) m.write('profil', `v${i}`);
    const dir = path.join(config.dataDir, 'memory', '.history');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('profil-')).sort();
    assert.equal(files.length, 20);
    assert.equal(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8'), 'v24');
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'v5');
    assert.equal(m.read('profil').markdown, 'v25');
    assert.deepEqual(m.list().map((p) => p.pagina), ['profil', 'subiect-a-b']);
  });

  test('logbook changes and deletions are appended to registru-history.jsonl', () => {
    const config = makeConfig();
    const r = getRegistru(config);
    const e = r.addEntry({ row: 'cezariana', date: '2026-11-01' });
    r.updateEntry(e.id, { n: 2 });
    r.deleteEntry(e.id);
    const lines = fs.readFileSync(path.join(config.dataDir, 'registru-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((l) => [l.action, l.entry.id, l.entry.n]), [['update', e.id, 1], ['delete', e.id, 2]]);
    assert.ok(lines.every((l) => typeof l.ts === 'string' && !isNaN(Date.parse(l.ts))));
  });
});

describe('18: importer keeps live data', () => {
  function openclaw() {
    const oc = tmpDir('rokhan-openclaw-');
    const wiki = path.join(oc, 'wiki', 'rokhan', 'syntheses');
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, 'registru-de-proceduri.md'), PAGE);
    fs.writeFileSync(path.join(wiki, 'profil.md'), '<!-- openclaw:wiki:generated:start -->\nbot\n<!-- openclaw:wiki:generated:end -->');
    fs.mkdirSync(path.join(oc, 'workspace-rokhan', 'library'), { recursive: true });
    fs.writeFileSync(path.join(oc, 'workspace-rokhan', 'library', 'g.md'), 'bot');
    const lessons = path.join(oc, 'workspace', 'projects', 'sogr-lecturi', 'data');
    fs.mkdirSync(path.join(lessons, 'lessons'), { recursive: true });
    fs.writeFileSync(path.join(lessons, 'lessons', '01-1.json'), '{"bot":1}');
    fs.writeFileSync(path.join(lessons, 'state.json'), '{"bot":1}');
    const dbDir = path.join(oc, 'agents', 'rokhan', 'agent');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, 'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE session_transcript_fts_content (id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)');
    const ins = db.prepare('INSERT INTO session_transcript_fts_content (c0, c1, c2, c3, c4) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 6; i++) ins.run(`m${i}`, 's1', `id${i}`, i % 2 ? 'assistant' : 'user', String(Date.UTC(2026, 9, 20, 9, i)));
    db.close();
    return oc;
  }

  test('--force needs --only', () => {
    const log = [];
    const r = run({ openclaw: openclaw(), data: tmpDir('rokhan-data-'), force: true, log: (l) => log.push(l) });
    assert.equal(r.ok, false);
    assert.match(log.join('\n'), /--only/);
  });

  test('a plain re-run keeps lesson files written in the app and deleted conversations stay deleted', async () => {
    const oc = openclaw();
    const data = tmpDir('rokhan-data-');
    assert.equal(run({ openclaw: oc, data, log: () => {} }).ok, true);
    const lesson = path.join(data, 'lessons', 'lessons', '01-1.json');
    fs.writeFileSync(lesson, '{"app":1}');
    const config = makeConfig({ dataDir: data });
    const convs = getConversations(config);
    assert.ok(convs.get('tg-20261020-1200'));
    convs.remove('tg-20261020-1200');
    assert.equal(run({ openclaw: oc, data, log: () => {} }).ok, true);
    assert.equal(fs.readFileSync(lesson, 'utf8'), '{"app":1}');
    assert.equal(convs.get('tg-20261020-1200'), null);
  });

  test('--force copies the old file to <file>.bak-<timestamp> before replacing it', () => {
    const oc = openclaw();
    const data = tmpDir('rokhan-data-');
    run({ openclaw: oc, data, log: () => {} });
    fs.writeFileSync(path.join(data, 'memory', 'profil.md'), 'live');
    fs.writeFileSync(path.join(data, 'lessons', 'state.json'), '{"live":1}');
    const before = fs.readFileSync(path.join(data, 'registru.json'), 'utf8');
    assert.equal(run({ openclaw: oc, data, only: 'registru,memorie,lessons', force: true, log: () => {} }).ok, true);
    const bak = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(base + '.bak-'));
    const mem = bak(path.join(data, 'memory'), 'profil.md');
    assert.equal(mem.length, 1);
    assert.equal(fs.readFileSync(path.join(data, 'memory', mem[0]), 'utf8'), 'live');
    assert.equal(fs.readFileSync(path.join(data, 'memory', 'profil.md'), 'utf8'), 'bot\n');
    const st = bak(path.join(data, 'lessons'), 'state.json');
    assert.equal(fs.readFileSync(path.join(data, 'lessons', st[0]), 'utf8'), '{"live":1}');
    assert.equal(fs.readFileSync(path.join(data, bak(data, 'registru.json')[0]), 'utf8'), before);
  });
});
