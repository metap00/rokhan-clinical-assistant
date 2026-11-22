import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../server/llm/agent.mjs';
import { getAgent } from '../server/store/deps.mjs';
import { fakeDeps } from './llm-fakes.mjs';
import { boot, readSse } from './core-helpers.mjs';

const ID = '63ca41ac-464c-4404-82de-6ca2946b89e0';

test('forgetSession deletes one transcript through the SDK, only in the app\'s project directory', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-forget-'));
  const calls = [];
  const agent = createAgent({ config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), deleteFn: async (...a) => { calls.push(a); } });
  assert.equal(await agent.forgetSession(ID), true);
  assert.deepEqual(calls, [[ID, { dir: fs.realpathSync.native(path.join(dataDir, 'agent-cwd')) }]]);
});

test('forgetSession ignores anything that is not a session id, and never throws', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-forget-'));
  const calls = [];
  const agent = createAgent({ config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), deleteFn: async (...a) => { calls.push(a); } });
  for (const bad of [null, undefined, '', 42, 'fake-123', '../../x', `${ID}/../..`, `${ID}.jsonl`, 'C:\\Users\\x', '*']) assert.equal(await agent.forgetSession(bad), false, String(bad));
  assert.deepEqual(calls, []);

  const missing = createAgent({ config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), deleteFn: async () => { throw new Error(`Session ${ID} not found`); } });
  assert.equal(await missing.forgetSession(ID), false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'logs', 'agent.log')), 'a session that is already gone is not worth a log line');

  const broken = createAgent({ config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), deleteFn: async () => { throw new Error('EPERM'); } });
  assert.equal(await broken.forgetSession(ID), false);
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'agent.log'), 'utf8'), /forgetSession 63ca41ac-.*EPERM/);
});

test('deleting a conversation over HTTP asks the agent to forget its session', async () => {
  const s = await boot();
  try {
    await s.login();
    const agent = await getAgent(s.config);

    const empty = (await s.api('POST', '/api/conversations')).json;
    assert.equal((await s.api('DELETE', `/api/conversations/${empty.id}`)).status, 200);
    assert.deepEqual(agent.forgotten, [], 'a conversation that never reached the model has no session');

    const conv = (await s.api('POST', '/api/conversations')).json;
    const res = await fetch(`${s.url}/api/conversations/${conv.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie }, body: JSON.stringify({ text: 'salut' }) });
    await readSse(res);
    for (let i = 0; i < 100 && (await s.api('GET', `/api/conversations/${conv.id}`)).json.pending; i++) await new Promise((r) => setTimeout(r, 50));
    const del = await s.api('DELETE', `/api/conversations/${conv.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { ok: true });
    assert.equal(agent.forgotten.length, 1);
    assert.match(agent.forgotten[0], /^fake-[0-9a-f-]{36}$/);
    assert.equal((await s.api('GET', `/api/conversations/${conv.id}`)).status, 404);
  } finally {
    await s.close();
  }
});

// ---------- review finding 5: old SDK sessions are purged, only in the app's own project folder ----------

test('purgeSessions deletes the old sessions of the app\'s working directory through the SDK, and nothing else', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-forget-'));
  fs.mkdirSync(path.join(dataDir, 'agent-cwd'));
  const cwd = fs.realpathSync.native(path.join(dataDir, 'agent-cwd'));
  const DAY = 24 * 3600 * 1000;
  const now = Date.parse('2026-11-22T10:00:00Z');
  const id = (n) => ID.replace(/.$/, String(n));
  const sessions = [
    { sessionId: id(1), lastModified: now - 31 * DAY, cwd }, // old: goes
    { sessionId: id(2), lastModified: now - 29 * DAY, cwd }, // recent: stays
    { sessionId: id(3), lastModified: now - 99 * DAY, cwd: path.join(dataDir, 'alt-proiect') }, // another project: never
    { sessionId: '../../../x', lastModified: 0, cwd }, // not a session id: never
    { sessionId: id(5), lastModified: now - 40 * DAY }, // listed under our directory without a cwd field: goes
    { sessionId: id(6), lastModified: now - 50 * DAY, cwd }, // the delete fails: the purge goes on
    { sessionId: id(7), lastModified: now - 60 * DAY, cwd },
  ];
  const listed = [];
  const deleted = [];
  const agent = createAgent({
    config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), now: () => new Date(now),
    listFn: async (opts) => { listed.push(opts); return sessions; },
    deleteFn: async (...a) => { if (a[0] === id(6)) throw new Error('EPERM'); deleted.push(a); },
  });
  assert.equal(await agent.purgeSessions(30 * DAY), 3);
  assert.deepEqual(listed, [{ dir: cwd, includeWorktrees: false }]);
  assert.deepEqual(deleted, [[id(1), { dir: cwd }], [id(5), { dir: cwd }], [id(7), { dir: cwd }]]);

  const failing = createAgent({ config: { dataDir, tz: 'Europe/Bucharest' }, deps: fakeDeps(), listFn: async () => { throw new Error('ENOENT'); }, deleteFn: async () => { throw new Error('must not be called'); } });
  assert.equal(await failing.purgeSessions(30 * DAY), 0);
  for (const bad of [undefined, null, 0, -1, NaN, '30']) assert.equal(await agent.purgeSessions(bad), 0, `age ${bad}`);
  assert.equal(deleted.length, 3, 'an age that is not a positive number deletes nothing');
});

test('a conversation deleted while its turn is running: the session of that turn is forgotten when the turn ends', async () => {
  const s = await boot();
  try {
    await s.login();
    const agent = await getAgent(s.config);
    const conv = (await s.api('POST', '/api/conversations')).json;
    const res = await fetch(`${s.url}/api/conversations/${conv.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie }, body: JSON.stringify({ text: 'salut' }) });
    const done = readSse(res);
    assert.equal((await s.api('DELETE', `/api/conversations/${conv.id}`)).status, 200); // no session id is stored yet
    await done;
    for (let i = 0; i < 100 && !agent.forgotten.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(agent.forgotten.length, 1);
    assert.match(agent.forgotten[0], /^fake-[0-9a-f-]{36}$/);
  } finally {
    await s.close();
  }
});
