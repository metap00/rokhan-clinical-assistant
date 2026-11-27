// The daily nudge with a fixed clock and a fake sender.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig } from './core-helpers.mjs';
import { getPush, runDailyPush } from '../server/store/push.mjs';
import { startJobs } from '../server/jobs/scheduler.mjs';

const MON = '2026-11-23'; // a Monday
const SUN = '2026-11-22';
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+02:00`); // Bucharest, winter
const sub = (n = 1) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });

/** A lessons service reduced to what the job reads. `next.scrisa` can be flipped by the test. */
function fakeLessons({ citite = [], recap = false, next } = {}) {
  const l = {
    requested: [],
    next: next ?? { id: '14-1', ghid: { nr: '14', titlu: 'Preeclampsia' }, k: 1, n: 5, titlu: 'Diagnostic și severitate', scrisa: true, minute: 7 },
    status: () => ({ urmatoarea: l.next, progres: [], citite, recap: { disponibil: recap, lectii: [] } }),
    requestGenerate(id) { l.requested.push(id); return { status: 'in_lucru' }; },
  };
  return l;
}

/** fail(subscription) may return an error to throw for that subscription. */
function setup({ activ = true, ora = '07:00', subs = 1, fail = () => null } = {}) {
  const config = makeConfig({ pushContact: 'mailto:test@example.com' });
  const sent = [];
  const logs = [];
  const push = getPush(config, {
    sender: async (s, payload, options) => {
      const err = fail(s);
      if (err) throw err;
      sent.push({ s, ...JSON.parse(payload), options });
    },
  });
  for (let i = 1; i <= subs; i++) push.addSubscription(sub(i));
  push.setSettings({ activ, ora, film: false }); // the film line has its own tests (videoteca.test.mjs)
  const run = (lessons, now) => runDailyPush({ config, lessons, now, log: (status, detail) => logs.push(`${status} ${detail}`) });
  return { config, push, sent, logs, run };
}

test('before the time, nothing; from the time on, "Lectura de azi" with the guideline, title and minutes', async () => {
  const { sent, run, push } = setup({ ora: '07:30' });
  const l = fakeLessons();
  assert.equal(await run(l, at(MON, '07:29')), null);
  assert.equal(sent.length, 0);
  await run(l, at(MON, '07:30'));
  assert.equal(sent.length, 1);
  assert.deepEqual({ title: sent[0].title, body: sent[0].body, url: sent[0].url, ttl: sent[0].options.TTL }, {
    title: 'Lectura de azi', body: 'Preeclampsia: Diagnostic și severitate (cam 7 minute)', url: '/#/lecturi', ttl: 21600,
  });
  assert.equal(push.state().ultimaTrimitere, MON);
});

test('once a day: a second tick the same day sends nothing, the next day sends again', async () => {
  const { sent, run } = setup();
  const l = fakeLessons();
  await run(l, at(MON, '07:00'));
  await run(l, at(MON, '07:01'));
  await run(l, at(MON, '22:59'));
  assert.equal(sent.length, 1);
  await run(l, at('2026-11-24', '07:00'));
  assert.equal(sent.length, 2);
});

test('off, or no subscription: nothing is sent and nothing is marked', async () => {
  const off = setup({ activ: false });
  assert.equal(await off.run(fakeLessons(), at(MON, '08:00')), null);
  assert.equal(off.sent.length, 0);
  const none = setup({ subs: 0 });
  none.push.setSettings({ activ: true });
  assert.equal(await none.run(fakeLessons(), at(MON, '08:00')), null);
  assert.equal(none.push.state().ultimaTrimitere, null);
});

test('already read a lesson today: no notification, and today counts as sent', async () => {
  const { sent, run, push } = setup();
  const l = fakeLessons({ citite: [{ id: '14-1', titlu: 'x', data: MON }, { id: '13-5', titlu: 'y', data: '2026-11-20' }] });
  await run(l, at(MON, '08:00'));
  assert.equal(sent.length, 0);
  assert.equal(push.state().ultimaTrimitere, MON);
  // a lesson read yesterday does not stop today's nudge
  const other = setup();
  await other.run(fakeLessons({ citite: [{ id: '13-5', titlu: 'y', data: '2026-11-22' }] }), at(MON, '08:00'));
  assert.equal(other.sent.length, 1);
});

test('"today" is the local day: a lesson read at 00:30 local counts for the new local date', async () => {
  const { sent, run } = setup();
  await run(fakeLessons({ citite: [{ id: '14-1', titlu: 'x', data: MON }] }), new Date('2026-11-22T22:30:00Z') /* 00:30 on Monday in Bucharest, before 07:00 */);
  await run(fakeLessons({ citite: [{ id: '14-1', titlu: 'x', data: MON }] }), at(MON, '07:05'));
  assert.equal(sent.length, 0);
});

test('Sunday with a recap available: the weekly recap; without one, the lesson', async () => {
  const withRecap = setup();
  await withRecap.run(fakeLessons({ recap: true }), at(SUN, '07:00'));
  assert.deepEqual([withRecap.sent[0].title, withRecap.sent[0].body], ['Recapitularea săptămânii', 'Punctele-cheie din lecturile ultimei săptămâni.']);
  assert.equal(withRecap.sent[0].url, '/#/lecturi');
  const noRecap = setup();
  await noRecap.run(fakeLessons({ recap: false }), at(SUN, '07:00'));
  assert.equal(noRecap.sent[0].title, 'Lectura de azi');
  const monday = setup();
  await monday.run(fakeLessons({ recap: true }), at(MON, '07:00')); // the recap is for Sundays only
  assert.equal(monday.sent[0].title, 'Lectura de azi');
});

test('lesson not written: it is requested and nothing is sent; once written the next tick sends it', async () => {
  const { sent, run, push } = setup();
  const l = fakeLessons({ next: { id: '14-2', ghid: { nr: '14', titlu: 'Preeclampsia' }, k: 2, n: 5, titlu: 'Secțiunile 2', scrisa: false, minute: 6 } });
  assert.equal(await run(l, at(MON, '07:00')), null);
  assert.equal(await run(l, at(MON, '07:01')), null);
  assert.deepEqual(l.requested, ['14-2', '14-2']);
  assert.equal(sent.length, 0);
  assert.equal(push.state().ultimaTrimitere, null);
  l.next = { ...l.next, scrisa: true, titlu: 'Tratament' };
  await run(l, at(MON, '07:05'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Preeclampsia: Tratament (cam 6 minute)');
});

test('lesson still not written at 23:00: nothing is sent that day, and it is not asked for any more', async () => {
  const { sent, run } = setup();
  const l = fakeLessons({ next: { id: '14-2', ghid: { nr: '14', titlu: 'P' }, k: 2, n: 5, titlu: 't', scrisa: false, minute: 6 } });
  await run(l, at(MON, '22:59'));
  assert.equal(l.requested.length, 1);
  assert.equal(await run(l, at(MON, '23:00')), null);
  l.next.scrisa = true;
  assert.equal(await run(l, at(MON, '23:00')), null);
  assert.equal(await run(l, at(MON, '23:30')), null);
  assert.equal(sent.length, 0);
  assert.equal(l.requested.length, 1);
});

test('the plan is finished: nothing to send', async () => {
  const { sent, run } = setup();
  const l = fakeLessons();
  l.next = null;
  assert.equal(await run(l, at(MON, '08:00')), null);
  assert.equal(sent.length, 0);
});

test('a 410 removes that subscription, the others still get the message', async () => {
  const { sent, run, push } = setup({ subs: 3, fail: (s) => (s.endpoint.endsWith('/2') ? Object.assign(new Error('gone'), { statusCode: 410 }) : null) });
  await run(fakeLessons(), at(MON, '08:00'));
  assert.deepEqual(push.state().abonamente.map((a) => a.endpoint), [sub(1).endpoint, sub(3).endpoint]);
  assert.equal(sent.length, 2);
  assert.equal(push.state().ultimaTrimitere, MON);
});

test('another failure is logged, today is still marked, and nothing throws', async () => {
  const { run, push, logs } = setup({ fail: () => Object.assign(new Error('503 push service down'), { statusCode: 503 }) });
  const r = await run(fakeLessons(), at(MON, '08:00'));
  assert.equal(r, 'trimis 0/1');
  assert.equal(push.state().abonamente.length, 1); // a 503 is not a reason to forget the phone
  assert.equal(push.state().ultimaTrimitere, MON);
  assert.ok(logs.some((l) => l.includes('503 push service down')), logs.join('|'));
});

test('a service that throws (no lessons, a bad clock, a broken status) never breaks the tick', async () => {
  const { run, logs } = setup();
  assert.equal(await run(undefined, at(MON, '08:00')), null);
  assert.equal(await run({ status() { throw new Error('boom'); } }, at(MON, '08:00')), null);
  assert.ok(logs.some((l) => l.includes('boom')));
});

test('in the scheduler: a tick runs the job, logs to logs/jobs.log, and a throwing lessons service does not stop later ticks', async () => {
  const config = makeConfig({ pushContact: 'mailto:test@example.com' });
  const sent = [];
  const push = getPush(config, { sender: async (s, payload) => { sent.push(JSON.parse(payload)); } });
  push.addSubscription(sub(1));
  let broken = true;
  const lessons = fakeLessons();
  const deps = { lessons: { ...lessons, status: () => { if (broken) throw new Error('lessons down'); return lessons.status(); }, nextMissing: () => null } };
  const jobs = startJobs({ config, deps, agent: { runJob: async () => ({ text: '', error: null }) }, intervalMs: 3_600_000 });
  try {
    await jobs.tick(at(MON, '08:00')); // 08:00 is not a writer minute that matters: nextMissing is null
    assert.equal(sent.length, 0);
    broken = false;
    await jobs.tick(at(MON, '08:01'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Lectura de azi');
    const log = fs.readFileSync(path.join(config.dataDir, 'logs', 'jobs.log'), 'utf8');
    assert.match(log, /\tpush\tok\tLectura de azi: trimise=1 esuate=0/);
    assert.match(log, /\tpush\teroare\tlessons down/);
  } finally { jobs.stop(); }
});
