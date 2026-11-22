import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig } from './core-helpers.mjs';
import { getPush, clock, validHora, TTL_SECONDS, MAX_SUBSCRIPTIONS } from '../server/store/push.mjs';

const sub = (n = 1) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });
const fresh = (over = {}, sender) => { const config = makeConfig({ pushContact: 'mailto:test@example.com', ...over }); return { config, push: getPush(config, { sender }) }; };

test('defaults: off, 07:00, no subscriptions, and the public key is made once and kept in vapid.json', () => {
  const { config, push } = fresh();
  const a = push.info();
  assert.deepEqual({ ...a, cheie: typeof a.cheie }, { configurat: true, cheie: 'string', activ: false, ora: '07:00', raspuns: true, abonamente: 0 });
  const file = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'vapid.json'), 'utf8'));
  assert.equal(file.publicKey, a.cheie);
  assert.ok(file.privateKey);
  assert.equal(push.info().cheie, a.cheie); // the same key the second time
});

test('not configured without an https public origin or a contact: no key is made', () => {
  const { config, push } = fresh({ pushContact: null });
  assert.deepEqual(push.info(), { configurat: false, cheie: null, activ: false, ora: '07:00', raspuns: true, abonamente: 0 });
  assert.equal(fs.existsSync(path.join(config.dataDir, 'vapid.json')), false);
  assert.equal(fresh({ pushContact: null, publicOrigin: 'http://localhost:8787' }).push.configured(), false); // web-push rejects a non-https subject
  assert.equal(fresh({ pushContact: null, publicOrigin: 'https://rokhan.example.ts.net' }).push.configured(), true);
  assert.equal(fresh({ pushContact: 'rokhan' }).push.configured(), false);
});

test('a subscription is stored once per endpoint and switches the nudge on; the last removal switches it off', () => {
  const { config, push } = fresh();
  push.addSubscription(sub(1));
  push.addSubscription(sub(1));
  push.addSubscription(sub(2));
  const s = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'push.json'), 'utf8'));
  assert.equal(s.abonamente.length, 2);
  assert.equal(s.setari.activ, true);
  assert.ok(s.abonamente[0].createdAt);
  push.removeSubscription(sub(1).endpoint);
  assert.equal(push.info().activ, true);
  push.removeSubscription(sub(2).endpoint);
  assert.deepEqual([push.info().activ, push.info().abonamente], [false, 0]);
});

test('bad subscriptions are refused: not https, an address of the machine itself, missing or odd keys', () => {
  const { push } = fresh();
  const bad = [
    null, {}, { endpoint: 'http://push.example.com/x', keys: sub().keys },
    { endpoint: 'https://127.0.0.1/x', keys: sub().keys }, { endpoint: 'https://localhost/x', keys: sub().keys },
    { endpoint: 'https://[::1]/x', keys: sub().keys }, { endpoint: 'https://user:pw@push.example.com/x', keys: sub().keys },
    { endpoint: sub().endpoint, keys: { p256dh: 'x y', auth: 'a' } }, { endpoint: sub().endpoint, keys: { p256dh: 'abc' } }, { endpoint: sub().endpoint },
  ];
  for (const b of bad) assert.throws(() => push.addSubscription(b), (e) => e.status === 400, JSON.stringify(b));
  assert.equal(push.info().abonamente, 0);
});

test('at most MAX_SUBSCRIPTIONS devices: the oldest makes room', () => {
  const { push } = fresh();
  for (let i = 1; i <= MAX_SUBSCRIPTIONS + 2; i++) push.addSubscription(sub(i));
  const s = push.state().abonamente;
  assert.equal(s.length, MAX_SUBSCRIPTIONS);
  assert.equal(s[0].endpoint, sub(3).endpoint);
});

test('settings: HH:MM before 23:00, a boolean; a partial update keeps the other field', () => {
  const { push } = fresh();
  assert.deepEqual([validHora('07:00'), validHora('22:59'), validHora('23:00'), validHora('7:00'), validHora('24:00'), validHora(700)], [true, true, false, false, false, false]);
  push.setSettings({ ora: '08:30' });
  push.setSettings({ activ: true });
  assert.deepEqual([push.info().activ, push.info().ora], [true, '08:30']);
  assert.throws(() => push.setSettings({ ora: '23:30' }), (e) => e.status === 400);
  assert.throws(() => push.setSettings({ activ: 'yes' }), (e) => e.status === 400);
  assert.equal(push.info().ora, '08:30');
});

test('sendAll: payload and TTL reach the sender; 404 and 410 remove the subscription, other errors are counted and reported', async () => {
  const calls = [];
  const errors = [];
  const outcome = { 1: 'ok', 2: 410, 3: 404, 4: 500, 5: 'network' };
  const sender = async (s, payload, options) => {
    calls.push({ s, payload, options });
    const n = Number(s.endpoint.split('/').pop());
    if (outcome[n] === 'ok') return { statusCode: 201 };
    throw outcome[n] === 'network' ? new Error('ECONNRESET') : Object.assign(new Error('push error'), { statusCode: outcome[n] });
  };
  const { push } = fresh({}, sender);
  for (let i = 1; i <= 5; i++) push.addSubscription(sub(i));
  const r = await push.sendAll({ title: 'T', body: 'B', url: '/#/lecturi' }, (e) => errors.push(e.message));
  assert.deepEqual(r, { trimise: 1, esuate: 4 });
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(calls[0].payload), { title: 'T', body: 'B', url: '/#/lecturi' });
  assert.equal(calls[0].options.TTL, TTL_SECONDS);
  assert.equal(TTL_SECONDS, 6 * 3600);
  assert.deepEqual(calls[0].s, sub(1)); // endpoint and keys only
  assert.deepEqual(errors.sort(), ['ECONNRESET', 'push error']); // the 404 and the 410 are not errors
  assert.deepEqual(push.state().abonamente.map((a) => a.endpoint), [sub(1).endpoint, sub(4).endpoint, sub(5).endpoint]);
});

test('clock: local date, time and weekday in the zone, across midnight', () => {
  assert.deepEqual(clock(new Date('2026-11-22T05:05:00Z'), 'Europe/Bucharest'), { date: '2026-11-22', hhmm: '07:05', sunday: true });
  assert.deepEqual(clock(new Date('2026-11-22T22:30:00Z'), 'Europe/Bucharest'), { date: '2026-11-23', hhmm: '00:30', sunday: false });
  assert.deepEqual(clock(new Date('2026-07-10T04:00:00Z'), 'Europe/Bucharest'), { date: '2026-07-10', hhmm: '07:00', sunday: false });
});
