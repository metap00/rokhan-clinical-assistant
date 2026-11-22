import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './core-helpers.mjs';
import { startServer } from '../server/index.mjs';
import { getPush } from '../server/store/push.mjs';

const sub = (n = 1) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });
const sent = [];
let t;
// Boots a server whose push store already has a fake sender (the routes ask for the store when they register).
async function start(over, sender) {
  const config = makeConfig(over);
  if (sender) getPush(config, { sender });
  const srv = await startServer(config);
  let cookie = '';
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json };
  };
  const r = await api('POST', '/api/login', { password: config.password });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { config, ...srv, api };
}
before(async () => {
  t = await start({ pushContact: 'mailto:test@example.com' }, async (s, payload, options) => {
    sent.push({ s, payload, options });
    if (s.endpoint.endsWith('/410')) throw Object.assign(new Error('gone'), { statusCode: 410 });
  });
});
after(() => t.close());

test('every push route needs the session', async () => {
  const res = await fetch(`${t.url}/api/push`);
  assert.equal(res.status, 401);
  const post = await fetch(`${t.url}/api/push/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
});

test('GET /api/push: configured, the public key, off, 07:00, no subscriptions', async () => {
  const r = await t.api('GET', '/api/push');
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.json, cheie: typeof r.json.cheie }, { configurat: true, cheie: 'string', activ: false, ora: '07:00', raspuns: true, abonamente: 0 });
});

test('subscribe, settings, test, unsubscribe', async () => {
  let r = await t.api('POST', '/api/push/abonare', { subscription: sub(1) });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.activ, r.json.abonamente], [true, 1]);
  r = await t.api('POST', '/api/push/abonare', { subscription: sub(2) });
  assert.equal(r.json.abonamente, 2);
  assert.equal((await t.api('POST', '/api/push/abonare', { subscription: { endpoint: 'http://x' } })).status, 400);
  assert.equal((await t.api('POST', '/api/push/abonare', {})).status, 400);

  r = await t.api('PUT', '/api/push/setari', { activ: true, ora: '08:15' });
  assert.deepEqual([r.status, r.json.ora, r.json.activ], [200, '08:15', true]);
  assert.equal((await t.api('PUT', '/api/push/setari', { ora: '8:15' })).status, 400);
  assert.equal((await t.api('PUT', '/api/push/setari', { ora: '23:00' })).status, 400);
  assert.equal((await t.api('GET', '/api/push')).json.ora, '08:15');

  sent.length = 0;
  r = await t.api('POST', '/api/push/test');
  assert.deepEqual([r.status, r.json], [200, { trimise: 2, esuate: 0 }]);
  assert.equal(JSON.parse(sent[0].payload).body, 'Rokhan: notificările merg.');

  r = await t.api('DELETE', '/api/push/abonare', { endpoint: sub(1).endpoint });
  assert.equal(r.json.abonamente, 1);
  r = await t.api('DELETE', '/api/push/abonare', { endpoint: sub(2).endpoint });
  assert.deepEqual([r.json.abonamente, r.json.activ], [0, false]);
  assert.equal((await t.api('DELETE', '/api/push/abonare', {})).status, 400);
  assert.deepEqual((await t.api('POST', '/api/push/test')).json, { trimise: 0, esuate: 0 });
});

test('test send: a gone subscription (410) is counted as failed and dropped', async () => {
  await t.api('POST', '/api/push/abonare', { subscription: sub(7) });
  await t.api('POST', '/api/push/abonare', { subscription: { ...sub(1), endpoint: 'https://push.example.com/send/410' } });
  const r = await t.api('POST', '/api/push/test');
  assert.deepEqual(r.json, { trimise: 1, esuate: 1 });
  assert.equal((await t.api('GET', '/api/push')).json.abonamente, 1);
});

test('without a contact or an https origin push is not configured: the key is null, subscribing and testing answer 409', async () => {
  const u = await start({ pushContact: null });
  try {
    const info = (await u.api('GET', '/api/push')).json;
    assert.deepEqual([info.configurat, info.cheie], [false, null]);
    assert.equal((await u.api('POST', '/api/push/abonare', { subscription: sub() })).status, 409);
    assert.equal((await u.api('POST', '/api/push/test', {})).status, 409);
  } finally { await u.close(); }
});
