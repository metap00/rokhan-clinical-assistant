// Spaced review of the quiz questions: the ladder, the seeding, the session cap, pause, flags, routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLessons } from '../server/lessons/index.mjs';
import { answerCard, LADDER } from '../server/lessons/review.mjs';
import { makeLessonsData, readJson, FIXTURES } from './content-helpers.mjs';
import { boot } from './core-helpers.mjs';

const TODAY = '2026-11-22';
const at = (date) => new Date(`${date}T10:00:00Z`); // midday in Bucharest
const lesson071 = () => readJson(path.join(FIXTURES, 'lessons', 'lessons', '07-1.json'));

/** Lessons written for every fixture unit; `read` = [[unit, date], ...] already read. */
function setup({ read = [], invalid = [] } = {}) {
  const d = makeLessonsData({
    state: { plan: ['01-1', '07-1', '07-2', '07-3', '08-1', '08-2'], cursor: 0, sent: read.map(([unit, data]) => ({ unit, data, tip: 'lectura' })) },
  });
  for (const id of ['07-3', '08-1', '08-2']) fs.writeFileSync(path.join(d.lessonsDir, `${id}.json`), JSON.stringify({ ...lesson071(), unit: id }));
  for (const id of invalid) {
    const l = readJson(path.join(d.lessonsDir, `${id}.json`));
    l.quiz[0].ref = 'NU-EXISTA';
    fs.writeFileSync(path.join(d.lessonsDir, `${id}.json`), JSON.stringify(l));
  }
  const clock = { t: at(TODAY) };
  const svc = getLessons(d.config, { now: () => clock.t });
  const store = () => readJson(path.join(d.dir, 'review.json'));
  return { ...d, svc, clock, store };
}

test('ladder: a right answer climbs 1, 3, 7, 16, 35 days, then 90 from the last box; a wrong one goes back to box 1, tomorrow', () => {
  const c = { box: 1, due: TODAY, seen: 0, lapses: 0, semnalat: false };
  const dues = [];
  for (let i = 0; i < 5; i++) { answerCard(c, true, TODAY); dues.push([c.box, c.due]); }
  assert.deepEqual(dues, [[2, '2026-11-25'], [3, '2026-11-29'], [4, '2026-12-08'], [5, '2026-12-27'], [5, '2027-02-20']]);
  assert.deepEqual(LADDER, [1, 3, 7, 16, 35]);
  answerCard(c, false, TODAY);
  assert.deepEqual(c, { box: 1, due: '2026-11-23', seen: 6, lapses: 1, semnalat: false });
});

test('seeding: lessons read before the review existed are spread six cards a day, oldest read first', () => {
  const { svc, store } = setup({ read: [['07-1', '2026-11-15'], ['01-1', '2026-11-12'], ['07-2', '2026-11-10']] });
  const r = svc.review();
  const cards = store().cards;
  assert.deepEqual(Object.keys(cards).map((id) => [id, cards[id].due]), [
    ['07-2#1', TODAY], ['07-2#2', TODAY], ['07-2#3', TODAY],
    ['01-1#1', TODAY], ['01-1#2', TODAY], ['01-1#3', TODAY],
    ['07-1#1', '2026-11-23'], ['07-1#2', '2026-11-23'], ['07-1#3', '2026-11-23'],
  ]);
  assert.ok(Object.values(cards).every((c) => c.box === 1 && c.seen === 0 && c.lapses === 0 && c.semnalat === false));
  assert.equal(r.scadente, 6);
  assert.equal(svc.status().repetitie.scadente, 6);
});

test('a lesson read from now on: "N-am știut" (or no mark) tomorrow, "Am știut" in 3 days', () => {
  const { svc, store } = setup({ read: [['01-1', '2026-11-12']] });
  svc.review(); // the store exists: what is read from now on follows the marks
  svc.markRead('07-1', { quiz: [true, false] });
  const c = store().cards;
  assert.deepEqual([c['07-1#1'].box, c['07-1#1'].due], [2, '2026-11-25']);
  assert.deepEqual([c['07-1#2'].box, c['07-1#2'].due], [1, '2026-11-23']);
  assert.deepEqual([c['07-1#3'].box, c['07-1#3'].due], [1, '2026-11-23']);
});

test('a session is the 10 most overdue cards; the rest wait; a card carries its question and the printed answer', () => {
  const read = [['01-1', '2026-11-01'], ['07-1', '2026-11-02'], ['07-2', '2026-11-03'], ['07-3', '2026-11-04'], ['08-1', '2026-11-05'], ['08-2', '2026-11-06']];
  const { svc, clock } = setup({ read });
  svc.review(); // seeded: 6 today, 6 tomorrow, 6 the day after
  clock.t = at('2026-11-25');
  const r = svc.review();
  assert.equal(r.scadente, 18);
  assert.equal(r.azi.length, 10);
  assert.deepEqual(r.azi.map((c) => c.id).slice(0, 7), ['01-1#1', '01-1#2', '01-1#3', '07-1#1', '07-1#2', '07-1#3', '07-2#1']);
  const card = r.azi[3];
  const printed = svc.get('07-1');
  assert.deepEqual(card, { id: '07-1#1', lectie: { id: '07-1', titlu: printed.titlu, ghid: printed.ghid }, intrebare: printed.quiz[0].intrebare, raspuns: printed.quiz[0].raspuns });
  assert.ok(card.raspuns.html && card.raspuns.ref && 'comentariu' in card.raspuns);
});

test('answers move cards; a lesson that no longer validates is skipped; unknown card 404, bad body 400', () => {
  const { svc, store } = setup({ read: [['01-1', '2026-11-01'], ['07-1', '2026-11-02']], invalid: ['01-1'] });
  let r = svc.review();
  assert.equal(r.scadente, 3); // 01-1's three cards are due too, but its lesson does not validate
  assert.ok(r.azi.every((c) => c.id.startsWith('07-1#')));
  assert.deepEqual(svc.reviewAnswer('07-1#1', true), { scadente: 2 });
  assert.deepEqual(svc.reviewAnswer('07-1#2', false), { scadente: 1 }); // wrong: tomorrow, so not due today any more
  assert.deepEqual([store().cards['07-1#1'].box, store().cards['07-1#1'].due], [2, '2026-11-25']);
  assert.deepEqual([store().cards['07-1#2'].lapses, store().cards['07-1#2'].due], [1, '2026-11-23']);
  assert.throws(() => svc.reviewAnswer('07-1#9', true), { status: 404 });
  assert.throws(() => svc.reviewAnswer('07-1#3', 'da'), { status: 400 });
});

test('pause moves every due date forward; zile must be 1 to 30', () => {
  const { svc, store } = setup({ read: [['01-1', '2026-11-01'], ['07-1', '2026-11-02'], ['07-2', '2026-11-03']] });
  svc.review();
  const before = store().cards;
  assert.deepEqual(svc.reviewPause(7), { scadente: 0 });
  const after = store().cards;
  for (const id of Object.keys(before)) assert.equal(after[id].due, new Date(Date.parse(before[id].due) + 7 * 864e5).toISOString().slice(0, 10), id);
  for (const bad of [0, 31, '3', 2.5, undefined]) assert.throws(() => svc.reviewPause(bad), { status: 400 }, String(bad));
});

test('a flagged card is never served again and leaves a line for the owner', () => {
  const { svc, store, dir } = setup({ read: [['01-1', '2026-11-01']] });
  assert.equal(svc.review().scadente, 3);
  assert.deepEqual(svc.reviewFlag('01-1#2'), { scadente: 2 });
  assert.equal(store().cards['01-1#2'].semnalat, true);
  assert.ok(!svc.review().azi.some((c) => c.id === '01-1#2'));
  const lines = fs.readFileSync(path.join(dir, 'review-flags.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.id), ['01-1#2']);
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  assert.throws(() => svc.reviewFlag('nu#1'), { status: 404 });
});

test('routes over HTTP: session, URL-encoded card id, pause before :id, flag, repetitie in GET /api/lecturi', async (t) => {
  const { config } = setup({ read: [['01-1', '2026-11-01'], ['07-1', '2026-11-02']] });
  const app = await boot({ dataDir: config.dataDir });
  t.after(() => app.close());
  await app.login();
  const s = await app.api('GET', '/api/lecturi/repetitie');
  assert.equal(s.status, 200);
  assert.equal(s.json.scadente, 6);
  assert.equal(s.json.azi.length, 6);
  assert.equal((await app.api('GET', '/api/lecturi')).json.repetitie.scadente, 6);
  assert.deepEqual((await app.api('POST', '/api/lecturi/repetitie/07-1%231', { stiut: true })).json, { scadente: 5 });
  assert.deepEqual((await app.api('POST', '/api/lecturi/repetitie/07-1%232/semnaleaza')).json, { scadente: 4 });
  assert.equal((await app.api('POST', '/api/lecturi/repetitie/07-1%239', { stiut: true })).status, 404);
  assert.equal((await app.api('POST', '/api/lecturi/repetitie/pauza', { zile: 0 })).status, 400);
  assert.deepEqual((await app.api('POST', '/api/lecturi/repetitie/pauza', { zile: 3 })).json, { scadente: 0 });
});
