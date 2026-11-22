import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, readSse, makeConfig } from './core-helpers.mjs';
import { getConversations, INTERRUPTED } from '../server/store/conversations.mjs';
import { getMemorie } from '../server/store/memorie.mjs';

// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('conversations store', () => {
  test('create, save, list newest first, get, messagesSince, remove with uploads', () => {
    const config = makeConfig();
    const store = getConversations(config);
    const a = store.create();
    const b = store.create();
    a.messages.push({ id: 'm1', role: 'user', text: 'prima', ts: 1000 });
    a.updatedAt = Date.now() + 10;
    store.save(a);
    b.messages.push({ id: 'm2', role: 'user', text: 'x'.repeat(100), ts: 2000 });
    store.save(b);
    const list = store.list();
    assert.deepEqual(list.map((c) => c.id), [a.id, b.id]);
    assert.equal(list[1].preview.length, 80);
    assert.deepEqual(store.get(a.id).messages[0].text, 'prima');
    assert.equal(store.get('../secret'), null);
    assert.deepEqual(store.messagesSince(1500).map((m) => [m.id, m.conversationId]), [['m2', b.id]]);
    fs.mkdirSync(path.join(config.dataDir, 'uploads', a.id), { recursive: true });
    store.remove(a.id);
    assert.equal(store.get(a.id), null);
    assert.ok(!fs.existsSync(path.join(config.dataDir, 'uploads', a.id)));
    assert.throws(() => store.remove(a.id), (e) => e.status === 404);
  });

  test('startup closes turns that were still pending', async () => {
    const config = makeConfig();
    const store = getConversations(config);
    const c = store.create();
    c.pending = true;
    c.messages.push({ id: 'u', role: 'user', text: 'hei', ts: 1 });
    store.save(c);
    const s = await boot({ dataDir: config.dataDir });
    await s.close();
    const after = store.get(c.id);
    assert.equal(after.pending, false);
    assert.deepEqual(after.messages.at(-1).state, 'error');
    assert.deepEqual(after.messages.at(-1).error, { code: 'intern', message: INTERRUPTED, resetAt: null });
  });
});

describe('memorie store', () => {
  test('list, read, write, names checked', () => {
    const m = getMemorie(makeConfig());
    assert.deepEqual(m.list(), []);
    m.write('subiect-preeclampsie', '# P');
    const p = m.write('profil', '# Profil\n');
    assert.equal(p.titlu, 'Profil');
    assert.deepEqual(m.list().map((x) => [x.pagina, x.titlu]), [['profil', 'Profil'], ['subiect-preeclampsie', 'Subiect: preeclampsie']]);
    assert.equal(m.read('profil').markdown, '# Profil\n');
    assert.throws(() => m.read('../x'), (e) => e.status === 400);
    assert.throws(() => m.read('lipsa'), (e) => e.status === 404);
    assert.throws(() => m.write('profil', 5), (e) => e.status === 400);
  });
});

describe('chat over HTTP with the fake agent', () => {
  let s;
  before(async () => {
    s = await boot();
    await s.login();
  });
  after(() => s.close());

  const post = (id, body) =>
    fetch(`${s.url}/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie },
      body: JSON.stringify(body),
    });

  async function waitIdle(id) {
    for (let i = 0; i < 100; i++) {
      const c = (await s.api('GET', `/api/conversations/${id}`)).json;
      if (!c.pending) return c;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('still pending');
  }

  test('a message streams start, status, deltas, done and is stored', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    assert.deepEqual(conv.messages, []);
    assert.ok(!('sdkSessionId' in conv));
    const res = await post(conv.id, { text: 'Ce doză de sulfat de magneziu? desen' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res);
    assert.equal(events[0].event, 'start');
    assert.equal(events[0].data.userMessage.text, 'Ce doză de sulfat de magneziu? desen');
    assert.deepEqual(events[1], { event: 'status', data: { label: 'Mă gândesc…' } });
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(text, /\| Parametru/);
    assert.match(text, /```mermaid/);
    assert.match(text, /\nSurse: /);
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.message.id, events[0].data.assistantMessageId);
    assert.equal(done.data.message.text, text);
    assert.equal(done.data.message.state, 'ok');

    const stored = (await s.api('GET', `/api/conversations/${conv.id}`)).json;
    assert.equal(stored.pending, false);
    assert.equal(stored.title, 'Ce doză de sulfat de magneziu? desen');
    assert.deepEqual(stored.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(stored.messages[1].text, text);
    const onDisk = getConversations(s.config).get(conv.id);
    assert.match(onDisk.sdkSessionId, /^fake-/);
    const list = (await s.api('GET', '/api/conversations')).json;
    assert.equal(list[0].id, conv.id);
    assert.equal(list[0].preview, text.slice(0, 80));
  });

  test('narration is cleared before the answer', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    const events = await readSse(await post(conv.id, { text: 'narare' }));
    const names = events.map((e) => e.event);
    const clear = names.indexOf('clear');
    assert.ok(clear > names.indexOf('delta'));
    assert.deepEqual(events[clear + 1], { event: 'status', data: { label: 'Caut în ghiduri…' } });
    assert.doesNotMatch(events.at(-1).data.message.text, /Mă uit/);
  });

  test('a usage-limit error is streamed and stored', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    const events = await readSse(await post(conv.id, { text: 'eroare' }));
    const err = events.find((e) => e.event === 'error');
    assert.equal(err.data.code, 'limita');
    assert.ok(Date.parse(err.data.resetAt) > Date.now() + 3500e3);
    assert.equal(events.at(-1).data.message.state, 'error');
    const stored = await waitIdle(conv.id);
    assert.equal(stored.messages[1].error.code, 'limita');
  });

  test('409 while a turn runs; stop keeps the text so far', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    const res = await post(conv.id, { text: 'salut' });
    let second;
    const events = await readSse(res, async (e) => {
      if (e.event === 'delta' && !second) {
        second = await post(conv.id, { text: 'încă una' });
        assert.equal(second.status, 409);
        assert.deepEqual(await second.json(), { error: 'in_lucru' });
        const st = await s.api('POST', `/api/conversations/${conv.id}/stop`);
        assert.deepEqual(st.json, { ok: true, running: true });
      }
    });
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.message.state, 'oprit');
    assert.ok(done.data.message.text.length > 0);
    assert.ok(events.some((e) => e.event === 'error' && e.data.code === 'oprit'));
    const stored = await waitIdle(conv.id);
    assert.equal(stored.messages[1].state, 'oprit');
    // free again
    const again = await readSse(await post(conv.id, { text: 'din nou' }));
    assert.equal(again.at(-1).data.message.state, 'ok');
  });

  test('the turn continues when the client goes away', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    const ctrl = new AbortController();
    const res = await fetch(`${s.url}/api/conversations/${conv.id}/messages`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', cookie: s.cookie },
      body: JSON.stringify({ text: 'pleacă' }),
    });
    await readSse(res, (e) => (e.event === 'start' ? 'stop' : undefined));
    ctrl.abort();
    const pending = (await s.api('GET', `/api/conversations/${conv.id}`)).json;
    assert.equal(pending.pending, true);
    const stored = await waitIdle(conv.id);
    assert.equal(stored.messages[1].state, 'ok');
    assert.match(stored.messages[1].text, /Surse:/);
  });

  test('images: saved, served, validated', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    const events = await readSse(await post(conv.id, { text: '', images: [{ dataUrl: `data:image/png;base64,${PNG}` }], urgent: true }));
    const user = events[0].data.userMessage;
    assert.equal(user.urgent, true);
    assert.equal(user.images.length, 1);
    const img = await fetch(s.url + user.images[0].url, { headers: { cookie: s.cookie } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(s.url + user.images[0].url)).status, 401);
    assert.equal((await s.api('GET', `/api/conversations/${conv.id}`)).json.title, 'Imagine');

    const notPng = Buffer.from('<svg></svg>').toString('base64');
    let r = await post(conv.id, { text: 'x', images: [{ dataUrl: `data:image/png;base64,${notPng}` }] });
    assert.equal(r.status, 400);
    r = await post(conv.id, { text: 'x', images: Array(5).fill({ dataUrl: `data:image/png;base64,${PNG}` }) });
    assert.deepEqual([r.status, (await r.json()).error], [400, 'prea_multe_imagini']);
    r = await post(conv.id, { text: '   ' });
    assert.equal(r.status, 400);
    // over 1 MB is accepted on this route (25 MB limit); a 4 MB+ image is refused
    const big = Buffer.alloc(4 * 1024 * 1024 + 10);
    Buffer.from(PNG, 'base64').copy(big);
    r = await post(conv.id, { text: 'x', images: [{ dataUrl: `data:image/png;base64,${big.toString('base64')}` }] });
    assert.deepEqual([r.status, (await r.json()).error], [400, 'imagine_prea_mare']);
    assert.equal((await s.api('GET', `/api/uploads/${conv.id}/${'0'.repeat(24)}`)).status, 404);
  });

  test('delete removes the conversation and its uploads; 404 afterwards', async () => {
    const conv = (await s.api('POST', '/api/conversations')).json;
    await readSse(await post(conv.id, { images: [{ dataUrl: `data:image/png;base64,${PNG}` }] }));
    assert.ok(fs.existsSync(path.join(s.config.dataDir, 'uploads', conv.id)));
    assert.deepEqual((await s.api('DELETE', `/api/conversations/${conv.id}`)).json, { ok: true });
    assert.ok(!fs.existsSync(path.join(s.config.dataDir, 'uploads', conv.id)));
    assert.equal((await s.api('GET', `/api/conversations/${conv.id}`)).status, 404);
    assert.equal((await post(conv.id, { text: 'x' })).status, 404);
  });

  test('registru and memorie routes', async () => {
    let r = await s.api('POST', '/api/registru/entries', { row: 'cezariana', date: '2026-11-01' });
    assert.equal(r.json.entry.copii, 1);
    assert.equal(r.json.registru.copii.total, 1);
    r = await s.api('PATCH', `/api/registru/entries/${r.json.entry.id}`, { copii: 2 });
    assert.equal(r.json.registru.copii.total, 2);
    r = await s.api('GET', '/api/registru/export?from=2026-11-01&to=2026-11-01');
    assert.deepEqual(r.json, { text: '2026-11-01 – Cezariană ×1 – efectuat' });
    r = await s.api('POST', '/api/registru/rows', { nume: 'Amniocenteză', barem: '5' });
    assert.equal(r.json.row.id, 'amniocenteza');
    r = await s.api('POST', '/api/registru/entries', { row: 'cerclaj', date: '2099-01-01' });
    assert.deepEqual([r.status, r.json.error], [400, 'data_in_viitor']);
    const id = (await s.api('GET', '/api/registru')).json.entries[0].id;
    r = await s.api('DELETE', `/api/registru/entries/${id}`);
    assert.equal(r.json.registru.entries.length, 0);

    r = await s.api('PUT', '/api/memorie/profil', { markdown: '# Profil' });
    assert.equal(r.json.markdown, '# Profil');
    r = await s.api('GET', '/api/memorie');
    assert.deepEqual(r.json.map((p) => p.pagina), ['profil']);
    r = await s.api('GET', '/api/memorie/profil');
    assert.deepEqual([r.json.pagina, r.json.titlu, r.json.markdown], ['profil', 'Profil', '# Profil']);
    assert.equal((await s.api('GET', '/api/memorie/Profil')).status, 400);
  });
});
