// Chat additions: the CNP refusal, "the answer is ready" push, photos deleted one hour after the last message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig, readSse } from './core-helpers.mjs';
import { startServer } from '../server/index.mjs';
import { getPush } from '../server/store/push.mjs';
import { getConversations } from '../server/store/conversations.mjs';
import { forgetPhotos, startJobs, PHOTO_AGE_MS } from '../server/jobs/scheduler.mjs';

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A server whose push store sends through a fake. */
async function bootWithPush({ subs = 1, raspuns } = {}) {
  const config = makeConfig({ pushContact: 'mailto:test@example.com' });
  const sent = [];
  const push = getPush(config, { sender: async (s, payload) => { sent.push(JSON.parse(payload)); } });
  for (let i = 1; i <= subs; i++) push.addSubscription({ endpoint: `https://push.example.com/send/${i}`, keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });
  if (raspuns !== undefined) push.setSettings({ raspuns });
  const srv = await startServer(config);
  let cookie = '';
  const api = async (method, p, body) => fetch(srv.url + p, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const r = await api('POST', '/api/login', { password: config.password });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const json = async (...a) => (await api(...a)).json();
  const settled = async (id) => {
    for (let i = 0; i < 200; i++) {
      if (!(await json('GET', `/api/conversations/${id}`)).pending) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('turn did not finish');
  };
  return { config, srv, sent, api, json, settled };
}

test('a message holding a CNP is refused with 422 { error: "cnp" }: nothing stored, no turn', async (t) => {
  const s = await bootWithPush();
  t.after(() => s.srv.close());
  const conv = await s.json('POST', '/api/conversations');
  const r = await s.api('POST', `/api/conversations/${conv.id}/messages`, { text: 'Pacienta 2951201400124, TA 150/95', images: [{ dataUrl: PNG }] });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: 'cnp' });
  const after = await s.json('GET', `/api/conversations/${conv.id}`);
  assert.deepEqual([after.messages, after.pending], [[], false]);
  assert.ok(!fs.existsSync(path.join(s.config.dataDir, 'uploads', conv.id)));
  // a 13-digit number that fails the control digit goes through
  const ok = await s.api('POST', `/api/conversations/${conv.id}/messages`, { text: 'Nr. probă 2951201400125' });
  assert.equal(ok.status, 200);
  await readSse(ok);
});

test('the answer is ready: one push when nobody listens any more, none when the client stayed, none when switched off', async (t) => {
  const s = await bootWithPush();
  t.after(() => s.srv.close());
  // she leaves right after sending
  const a = await s.json('POST', '/api/conversations');
  await readSse(await s.api('POST', `/api/conversations/${a.id}/messages`, { text: 'întrebare' }), (e) => (e.event === 'start' ? 'stop' : undefined));
  await s.settled(a.id);
  for (let i = 0; i < 40 && !s.sent.length; i++) await new Promise((res) => setTimeout(res, 25));
  assert.deepEqual(s.sent, [{ title: 'Rokhan a răspuns', body: 'Răspunsul la întrebarea ta e gata.', url: '/#/intreaba' }]);
  // she stays until done
  const b = await s.json('POST', '/api/conversations');
  const events = await readSse(await s.api('POST', `/api/conversations/${b.id}/messages`, { text: 'altă întrebare' }));
  assert.equal(events.at(-1).event, 'done');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(s.sent.length, 1);
  // the setting is readable and writable through the push routes
  assert.equal((await s.json('GET', '/api/push')).raspuns, true);
  assert.equal((await s.json('PUT', '/api/push/setari', { raspuns: false })).raspuns, false);
  assert.equal((await s.api('PUT', '/api/push/setari', { raspuns: 'nu' })).status, 400);
  const c = await s.json('POST', '/api/conversations');
  await readSse(await s.api('POST', `/api/conversations/${c.id}/messages`, { text: 'a treia' }), (e) => (e.event === 'start' ? 'stop' : undefined));
  await s.settled(c.id);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(s.sent.length, 1);
});

test('no subscription: nothing is sent and the turn finishes normally', async (t) => {
  const s = await bootWithPush({ subs: 0 });
  t.after(() => s.srv.close());
  const a = await s.json('POST', '/api/conversations');
  await readSse(await s.api('POST', `/api/conversations/${a.id}/messages`, { text: 'întrebare' }), (e) => (e.event === 'start' ? 'stop' : undefined));
  await s.settled(a.id);
  assert.equal(s.sent.length, 0);
  assert.equal((await s.json('GET', `/api/conversations/${a.id}`)).messages.at(-1).state, 'ok');
});

test('photos go one hour after the last message: files gone (404), images marked, session forgotten; a fresh message keeps them', async (t) => {
  const s = await bootWithPush({ subs: 0 });
  t.after(() => s.srv.close());
  const conv = await s.json('POST', '/api/conversations');
  await readSse(await s.api('POST', `/api/conversations/${conv.id}/messages`, { text: 'ce arată?', images: [{ dataUrl: PNG }] }));
  const conversations = getConversations(s.config);
  const stored = conversations.get(conv.id);
  const img = stored.messages[0].images[0];
  const session = stored.sdkSessionId;
  assert.ok(session);
  assert.equal((await s.api('GET', img.url)).status, 200);
  const last = stored.messages.at(-1).ts;
  const forgotten = [];
  const agent = { forgetSession: async (id) => { forgotten.push(id); } };
  const run = (ms) => forgetPhotos({ dataDir: s.config.dataDir, conversations, agent, now: () => ms });

  // 59 minutes: a follow-up question about the picture still sees it
  assert.equal(await run(last + PHOTO_AGE_MS - 60_000), 0);
  assert.equal((await s.api('GET', img.url)).status, 200);
  // a fresh message at 59 minutes moves the hour
  const again = conversations.get(conv.id);
  again.messages.push({ id: 'x', role: 'user', text: 'și asta?', images: [], ts: last + PHOTO_AGE_MS - 60_000, urgent: false, state: 'ok', error: null });
  conversations.save(again);
  assert.equal(await run(last + PHOTO_AGE_MS + 1000), 0);
  assert.equal((await s.api('GET', img.url)).status, 200);

  // an hour after that message: gone
  assert.equal(await run(last + 2 * PHOTO_AGE_MS), 1);
  assert.equal((await s.api('GET', img.url)).status, 404);
  assert.ok(!fs.existsSync(path.join(s.config.dataDir, 'uploads', conv.id)));
  const after = conversations.get(conv.id);
  assert.deepEqual(after.messages[0].images, [{ id: img.id, sters: true }]);
  assert.equal(after.sdkSessionId, null);
  assert.deepEqual(forgotten, [session]);
  // the client sees the marks
  assert.deepEqual((await s.json('GET', `/api/conversations/${conv.id}`)).messages[0].images, [{ id: img.id, sters: true }]);
  // nothing left to do on the next tick
  assert.equal(await run(last + 3 * PHOTO_AGE_MS), 0);
  // the next turn starts a fresh session and works
  const events = await readSse(await s.api('POST', `/api/conversations/${conv.id}/messages`, { text: 'mai departe' }));
  assert.equal(events.at(-1).event, 'done');
});

test('the scheduler tick runs the photo job; a pending conversation is left alone', async () => {
  const config = makeConfig();
  const conversations = getConversations(config);
  const make = (pending) => {
    const c = conversations.create();
    c.messages.push({ id: 'm', role: 'user', text: 'x', images: [{ id: 'a'.repeat(24), url: `/api/uploads/${c.id}/${'a'.repeat(24)}` }], ts: 1000, urgent: false, state: 'ok', error: null });
    c.updatedAt = 1000;
    c.pending = pending;
    c.sdkSessionId = `s-${c.id}`;
    conversations.save(c);
    fs.mkdirSync(path.join(config.dataDir, 'uploads', c.id), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, 'uploads', c.id, `${'a'.repeat(24)}.png`), 'x');
    return c.id;
  };
  const idle = make(false);
  const busy = make(true);
  const forgotten = [];
  const jobs = startJobs({ config, deps: { conversations }, agent: { forgetSession: async (id) => forgotten.push(id) }, intervalMs: 1e9 });
  jobs.stop();
  await jobs.tick(new Date(1000 + PHOTO_AGE_MS + 1));
  assert.deepEqual(forgotten, [`s-${idle}`]);
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'uploads', idle)));
  assert.ok(fs.existsSync(path.join(config.dataDir, 'uploads', busy)));
  assert.equal(conversations.get(busy).messages[0].images[0].url.startsWith('/api/uploads/'), true);
  assert.match(fs.readFileSync(path.join(config.dataDir, 'logs', 'jobs.log'), 'utf8'), /fotografii\tok\tconversații=1/);
});
