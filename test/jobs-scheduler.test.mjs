import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dueJobs, localParts, startOfDayMs, parseJsonAnswer, writeNextLesson, runReflection, validateReflection, purgeOld, trimLogs, jobState, startJobs, REFLECTION_SYSTEM, WRITER_RETRY_MS, PURGE_AGE_MS } from '../server/jobs/scheduler.mjs';
import { fakeDeps, fakeLessons, fakeMemorie, fakeConversations } from './llm-fakes.mjs';

const tz = 'Europe/Bucharest';
const at = (iso) => new Date(iso);
/** A fake agent whose runJob answers from a list, one per call (the last answer repeats). */
const fakeAgent = (answers) => {
  const calls = [];
  return {
    calls,
    runJob: async (job) => {
      calls.push(job);
      const a = answers[calls.length - 1] ?? answers.at(-1);
      return typeof a === 'string' ? { text: a, error: null } : a;
    },
  };
};

test('local time: Bucharest wall clock and the start of the day, in winter and in summer', () => {
  assert.deepEqual(localParts(at('2026-11-22T08:45:00Z'), tz), { date: '2026-11-22', hour: 10, minute: 45 });
  assert.deepEqual(localParts(at('2026-11-22T22:30:00Z'), tz), { date: '2026-11-23', hour: 0, minute: 30 });
  assert.equal(new Date(startOfDayMs(at('2026-11-22T08:45:00Z'), tz)).toISOString(), '2026-11-21T22:00:00.000Z'); // UTC+2
  assert.equal(new Date(startOfDayMs(at('2026-07-10T08:45:00Z'), tz)).toISOString(), '2026-07-09T21:00:00.000Z'); // UTC+3
  assert.equal(new Date(startOfDayMs(at('2026-11-22T22:30:00Z'), tz)).toISOString(), '2026-11-22T22:00:00.000Z');
});

test('due times: the writer every 5 minutes from 07:00 to 23:00, the reflection at 23:50, the purge at 03:30', () => {
  const ran = { curatenie: '2026-07-10', reflectie: '2026-07-09' };
  const due = (hhmm, last = ran) => dueJobs(at(`2026-07-10T${hhmm}:00+03:00`), tz, last);
  assert.deepEqual(due('07:00'), ['lectie']);
  assert.deepEqual(due('07:03'), []);
  assert.deepEqual(due('12:35'), ['lectie']);
  assert.deepEqual(due('22:55'), ['lectie']);
  assert.deepEqual(due('06:55'), []);
  assert.deepEqual(due('23:00'), []);
  assert.deepEqual(due('23:49'), []);
  assert.deepEqual(due('23:50'), ['reflectie']);
  assert.deepEqual(due('23:57'), ['reflectie']); // the exact minute was missed
  assert.deepEqual(due('23:50', { curatenie: '2026-07-10', reflectie: '2026-07-10' }), []); // already ran today
  assert.deepEqual(due('03:29', {}), []);
  assert.deepEqual(due('03:30', {}), ['curatenie']);
  assert.deepEqual(due('09:10', {}), ['lectie', 'curatenie']); // a start later in the day still purges once
  assert.deepEqual(due('00:10'), []);
});

test('parseJsonAnswer accepts bare JSON, a fenced block and JSON inside prose', () => {
  assert.deepEqual(parseJsonAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('Iată lecția:\n{"a":{"b":2}}\nSucces.'), { a: { b: 2 } });
  assert.equal(parseJsonAnswer('nu e json'), null);
  assert.equal(parseJsonAnswer('[1,2]'), null);
  assert.equal(parseJsonAnswer(''), null);
});

test('lesson writer: nothing missing means no model call', async () => {
  const agent = fakeAgent(['{}']);
  assert.equal(await writeNextLesson({ deps: fakeDeps(), agent }), null);
  assert.equal(agent.calls.length, 0);
});

test('lesson writer: asks again with the validator errors, then saves', async () => {
  const lessons = fakeLessons({ missing: { id: '14-2', unit: { id: '14-2', blocuri: [{ id: 'b1', text: 'Standard' }] } } });
  const agent = fakeAgent(['Nu pot.', '{"sectiuni":[]}', '```json\n{"titlu":"Rahianestezia"}\n```']);
  const r = await writeNextLesson({ deps: fakeDeps({ lessons }), agent });
  assert.deepEqual(r, { id: '14-2', ok: true, rounds: 3, errors: [] });
  assert.deepEqual(lessons.saved, { '14-2': { titlu: 'Rahianestezia' } });
  assert.equal(agent.calls.length, 3);
  for (const c of agent.calls) assert.deepEqual([c.system, c.model, c.effort], ['Scrie lecția ca JSON.', 'claude-opus-5-5', 'medium']);
  const unitJson = '{"id":"14-2","blocuri":[{"id":"b1","text":"Standard"}]}';
  assert.equal(agent.calls[0].prompt, unitJson);
  assert.ok(agent.calls[1].prompt.startsWith(unitJson));
  assert.match(agent.calls[1].prompt, /nu e un obiect JSON valid/);
  assert.ok(agent.calls[2].prompt.startsWith(unitJson));
  assert.ok(agent.calls[2].prompt.includes('{"sectiuni":[]}'), 'the rejected lesson is shown back');
  assert.match(agent.calls[2].prompt, /Erori de corectat:\n- lipsește titlu/);
});

test('lesson writer: after three failed rounds the unit rests for six hours', async () => {
  const lessons = fakeLessons({ missing: { id: '14-2', unit: {} } });
  const deps = fakeDeps({ lessons });
  const agent = fakeAgent(['{"sectiuni":[]}']);
  const state = jobState(null);
  let clock = 1_000_000;
  const r = await writeNextLesson({ deps, agent, state, now: () => clock });
  assert.deepEqual(r, { id: '14-2', ok: false, rounds: 3, errors: ['lipsește titlu'], gaveUp: false });
  assert.deepEqual(lessons.saved, {});
  clock += WRITER_RETRY_MS - 1;
  assert.equal(await writeNextLesson({ deps, agent, state, now: () => clock }), null);
  assert.equal(agent.calls.length, 3);
  clock += 2;
  await writeNextLesson({ deps, agent, state, now: () => clock });
  assert.equal(agent.calls.length, 6);
});

test('lesson writer: a model error (the usage limit) stops at once, pauses the whole writer for six hours and is not held against the unit', async () => {
  const deps = fakeDeps({ lessons: fakeLessons({ missing: [{ id: '14-2', unit: {} }, { id: '14-3', unit: {} }] }) });
  const agent = fakeAgent([{ text: '', error: { code: 'limita', message: 'Am atins limita de utilizare.' } }]);
  const state = jobState(null);
  let clock = 1_000_000;
  const r = await writeNextLesson({ deps, agent, state, now: () => clock });
  assert.deepEqual(r, { id: '14-2', ok: false, rounds: 1, errors: ['model: limita Am atins limita de utilizare.'] });
  clock += WRITER_RETRY_MS - 1;
  assert.equal(await writeNextLesson({ deps, agent, state, now: () => clock }), null, 'not the next unit either: the limit is not about one unit');
  assert.equal(agent.calls.length, 1);
  clock += 2;
  await writeNextLesson({ deps, agent, state, now: () => clock });
  assert.equal(agent.calls.length, 2);
  assert.deepEqual(state.get('lectie').units ?? {}, {}, 'no failed attempt was counted');
});

// ---------- review finding 15 ----------

const HOUR = 3600 * 1000;
/** Fails every unit except those in `good`. The unit JSON carries its id, so the answer can depend on it. */
const pickyAgent = (good) => {
  const calls = [];
  return { calls, runJob: async (job) => { calls.push(job); return { text: good.some((id) => job.prompt.includes(`"id":"${id}"`)) ? '{"titlu":"T"}' : '{"sectiuni":[]}', error: null }; } };
};
const units = (...ids) => ids.map((id) => ({ id, unit: { id } }));

test('lesson writer: the failure count survives a restart; after three failed attempts the unit is given up and the next missing one is written', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-')), 'jobs-state.json');
  const lessons = fakeLessons({ missing: units('14-2', '14-3', '14-4') });
  const deps = fakeDeps({ lessons });
  const agent = pickyAgent(['14-3', '14-4']);
  let clock = Date.parse('2026-11-22T08:00:00Z');
  const run = () => writeNextLesson({ deps, agent, state: jobState(file), now: () => clock }); // a new state object each time: a restart

  assert.deepEqual(await run(), { id: '14-2', ok: false, rounds: 3, errors: ['lipsește titlu'], gaveUp: false });
  clock += 5 * 60_000;
  assert.deepEqual(await run(), { id: '14-3', ok: true, rounds: 1, errors: [] }, 'while 14-2 rests the writer moves on');
  clock += 6 * HOUR;
  assert.equal((await run()).gaveUp, false); // second failed attempt on 14-2
  clock += 6 * HOUR;
  assert.deepEqual(await run(), { id: '14-2', ok: false, rounds: 3, errors: ['lipsește titlu'], gaveUp: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lectie.units['14-2'].fails, 3);
  clock += 6 * HOUR;
  assert.deepEqual(await run(), { id: '14-4', ok: true, rounds: 1, errors: [] }, 'a unit that was given up no longer blocks the ones after it');
  for (let i = 0; i < 5; i++) { clock += 6 * HOUR; assert.equal(await run(), null); }
  assert.equal(agent.calls.length, 3 * 3 + 2, 'nine calls for the unit that never validates, then none');
  assert.deepEqual(lessons.excluded.at(-1), ['14-2']);
  assert.deepEqual(Object.keys(lessons.saved), ['14-3', '14-4']);

  // A lessons service that does not know `exclude` keeps offering the unit: the writer still does not call the model again.
  const stubborn = fakeDeps({ lessons: { ...lessons, nextMissing: () => ({ id: '14-2', unit: { id: '14-2' } }) } });
  assert.equal(await writeNextLesson({ deps: stubborn, agent, state: jobState(file), now: () => clock }), null);
  assert.equal(agent.calls.length, 11);
});

test('lesson writer: three different units failing within a day stop the writer, so a broken validator cannot burn calls', async () => {
  const lessons = fakeLessons({ missing: units('14-1', '14-2', '14-3', '14-4') });
  const deps = fakeDeps({ lessons });
  const agent = pickyAgent(['14-4']);
  const state = jobState(null);
  let clock = Date.parse('2026-11-22T08:00:00Z');
  const run = () => writeNextLesson({ deps, agent, state, now: () => clock });
  for (const id of ['14-1', '14-2', '14-3']) { assert.equal((await run()).id, id); clock += 5 * 60_000; }
  assert.equal(await run(), null, '14-4 would validate, but three failures in a row mean something else is wrong');
  assert.equal(agent.calls.length, 9);
  clock += 24 * HOUR;
  assert.equal((await run()).id, '14-1');
});

test('startJobs: a unit that is given up is logged for the owner, and the purge also asks the agent to drop old sessions', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-'));
  fs.writeFileSync(path.join(dataDir, 'jobs-state.json'), JSON.stringify({ lectie: { units: { '14-2': { fails: 2, at: 0 } } } }));
  const purged = [];
  const agent = { ...fakeAgent(['{"sectiuni":[]}']), purgeSessions: async (age) => { purged.push(age); return 2; } };
  const jobs = startJobs({ config: { dataDir, tz }, deps: fakeDeps({ lessons: fakeLessons({ missing: units('14-2') }) }), agent, intervalMs: 3_600_000 });
  try { await jobs.tick(at('2026-11-22T10:05:00+02:00')); } finally { jobs.stop(); }
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'jobs.log'), 'utf8').trim().split('\n').map((l) => l.split('\t').slice(1));
  assert.match(log.find((l) => l[0] === 'lectie' && l[1] === 'renuntat')[2], /^14-2 după 3 încercări/);
  assert.deepEqual(purged, [PURGE_AGE_MS]);
  assert.match(log.find((l) => l[0] === 'curatenie')[2], /sesiuni=2/);
});

// ---------- review finding 19 ----------

test('startJobs: a throw inside tick (an unknown time zone) is logged and does not reject', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-'));
  const jobs = startJobs({ config: { dataDir, tz: 'Europe/Bucuresti' }, deps: fakeDeps(), agent: fakeAgent(['{}']), intervalMs: 3_600_000 });
  try {
    assert.equal(await jobs.tick(at('2026-11-22T10:05:00+02:00')), undefined);
  } finally {
    jobs.stop();
  }
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'jobs.log'), 'utf8'), /\ttick\teroare\t.*Bucuresti/);
});

// ---------- review finding 16 ----------

test('reflection: a long page may be rewritten to the 4,000 characters the prompt asks for', () => {
  const current = { profil: 'x'.repeat(9000), 'jurnal-de-studiu': 'y'.repeat(3000) };
  assert.deepEqual(validateReflection({ profil: 'p'.repeat(3900) }, current), { writes: { profil: 'p'.repeat(3900) }, rejected: [] });
  assert.deepEqual(validateReflection({ profil: 'p'.repeat(2000) }, current).rejected, []);
  assert.deepEqual(validateReflection({ profil: 'p'.repeat(1999) }, current).rejected, ['profil: mai scurt de jumătate din pagina veche']);
  assert.deepEqual(validateReflection({ 'jurnal-de-studiu': 'j'.repeat(1499) }, current).rejected, ['jurnal-de-studiu: mai scurt de jumătate din pagina veche']);
});

test('reflection: reads the messages since the last run, kept on disk, so nothing sent after 23:50 is lost', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-')), 'jobs-state.json');
  const lastRun = Date.parse('2026-11-21T21:50:00Z'); // yesterday 23:50 in Bucharest
  jobState(file).set('reflectie', { at: lastRun });
  const messages = [
    { role: 'user', text: 'inainte de reflectia de ieri', ts: lastRun - 60_000 },
    { role: 'user', text: 'din garda, dupa reflectie', ts: Date.parse('2026-11-21T21:56:00Z') }, // 23:56, before midnight
    { role: 'user', text: 'de azi', ts: Date.parse('2026-11-22T09:00:00Z') },
  ];
  const memorie = fakeMemorie({ profil: 'Profil.', 'jurnal-de-studiu': 'Jurnal.' });
  const deps = fakeDeps({ memorie, conversations: fakeConversations(messages) });
  const now = () => at('2026-11-22T21:50:00Z');

  const limited = fakeAgent([{ text: '', error: { code: 'limita', message: 'L' } }]);
  await runReflection({ config: { tz }, deps, agent: limited, state: jobState(file), now });
  assert.equal(jobState(file).get('reflectie').at, lastRun, 'a failed run does not move the mark: tomorrow reads these messages again');

  const agent = fakeAgent(['{}']);
  assert.deepEqual(await runReflection({ config: { tz }, deps, agent, state: jobState(file), now }), { ran: true, written: [], rejected: [] });
  const { prompt } = agent.calls[0];
  assert.ok(prompt.includes('2026-11-21 23:56 Rezidenta: din garda, dupa reflectie'), 'a message of another day carries its date');
  assert.ok(prompt.includes('\n\n11:00 Rezidenta: de azi'));
  assert.ok(!prompt.includes('inainte de reflectia de ieri'));
  assert.equal(jobState(file).get('reflectie').at, now().getTime());

  const quiet = fakeAgent(['{}']);
  assert.equal((await runReflection({ config: { tz }, deps, agent: quiet, state: jobState(file), now: () => at('2026-11-22T21:55:00Z') })).ran, false, 'a second run finds nothing new');
  assert.equal(quiet.calls.length, 0);
});

// ---------- review finding 9 ----------

test('purge: cache files go after 2 days, log lines and idle log files after 90 days', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-'));
  const DAY = 24 * HOUR;
  const now = Date.parse('2026-11-22T03:30:00Z');
  const put = (rel, ageDays, text = 'x') => {
    const p = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    const t = new Date(now - ageDays * DAY);
    fs.utimesSync(p, t, t);
  };
  const stamp = (ageDays) => new Date(now - ageDays * DAY).toISOString();
  put('cache/url-3-zile.json', 3);
  put('cache/url-1-zi.json', 1);
  put('uploads/c/poza.jpg', 29);
  put('logs/vechi.log', 91, `${stamp(91)}\tx\n`);
  put('logs/fetch.log', 0, `${stamp(120)}\t"https://a.test/vechi"\t200\t1\n${stamp(91)}\t"https://a.test/vechi2"\t200\t1\n${stamp(89)}\t"https://a.test/nou"\t200\t1\n${stamp(1)}\t"https://a.test/ieri"\t200\t1\n`);
  put('logs/agent.log', 0, `${stamp(100)} runTurn crashed: Error: x\n    at stack (file.mjs:1:1)\n${stamp(2)} init: model=m\n    continuation line\n`);
  put('logs/jobs.log', 0, `${stamp(5)}\tlectie\tok\t14-2\n`);

  assert.equal(purgeOld({ dataDir, now: () => now }), 2);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'cache')), ['url-1-zi.json']);
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', 'c', 'poza.jpg')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'logs', 'vechi.log')));
  assert.equal(trimLogs({ dataDir, now: () => now }), 4);
  assert.equal(fs.readFileSync(path.join(dataDir, 'logs', 'fetch.log'), 'utf8'), `${stamp(89)}\t"https://a.test/nou"\t200\t1\n${stamp(1)}\t"https://a.test/ieri"\t200\t1\n`);
  assert.equal(fs.readFileSync(path.join(dataDir, 'logs', 'agent.log'), 'utf8'), `${stamp(2)} init: model=m\n    continuation line\n`);
  assert.equal(fs.readFileSync(path.join(dataDir, 'logs', 'jobs.log'), 'utf8'), `${stamp(5)}\tlectie\tok\t14-2\n`);
  assert.equal(trimLogs({ dataDir, now: () => now }), 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'logs')).sort(), ['agent.log', 'fetch.log', 'jobs.log']);
});


test('reflection: validation of the answer', () => {
  const current = { profil: 'x'.repeat(1000), 'jurnal-de-studiu': '' };
  const good = { profil: 'y'.repeat(900), 'jurnal-de-studiu': 'azi: preeclampsie' };
  assert.deepEqual(validateReflection(good, current), { writes: good, rejected: [] });
  assert.deepEqual(validateReflection({ profil: 'y'.repeat(499) }, current).rejected, ['profil: mai scurt de jumătate din pagina veche']);
  assert.deepEqual(validateReflection({ profil: '  ', corectii: 'x', 'jurnal-de-studiu': 7 }, current).rejected, ['profil: gol', 'corectii: pagină nepermisă', 'jurnal-de-studiu: gol']);
  assert.deepEqual(validateReflection({ profil: 'ă'.repeat(10_241) }, current).rejected, ['profil: peste 20 KB']);
  assert.deepEqual(validateReflection({ profil: current.profil }, current), { writes: {}, rejected: [] }); // unchanged
  assert.deepEqual(validateReflection({}, current), { writes: {}, rejected: [] });
});

test('reflection: one job with the messages of today and both pages, then only valid pages are written', async () => {
  const now = () => at('2026-11-22T21:50:00Z'); // 23:50 in Bucharest
  const messages = [
    { role: 'user', text: 'de ieri', ts: Date.parse('2026-11-21T20:00:00Z') },
    { role: 'user', text: 'cand dau sulfat de magneziu?', ts: Date.parse('2026-11-22T09:00:00Z') },
    { role: 'assistant', text: 'R'.repeat(900), ts: Date.parse('2026-11-22T09:00:30Z') },
  ];
  const memorie = fakeMemorie({ profil: 'Profil vechi, destul de lung ca să nu fie tăiat la jumătate.', 'jurnal-de-studiu': 'Jurnal vechi.' });
  const answer = { profil: 'Profil nou, cu un rând în plus despre preferințe.\nUltima reflecție: 2026-11-22', 'jurnal-de-studiu': 'J', registru: 'x' };
  const agent = fakeAgent([JSON.stringify(answer)]);
  const r = await runReflection({ config: { tz }, deps: fakeDeps({ memorie, conversations: fakeConversations(messages) }), agent, now });
  assert.deepEqual(r, { ran: true, written: ['profil'], rejected: ['jurnal-de-studiu: mai scurt de jumătate din pagina veche', 'registru: pagină nepermisă'] });
  assert.equal(memorie.store.get('profil'), answer.profil);
  assert.equal(memorie.store.get('jurnal-de-studiu'), 'Jurnal vechi.');
  const [job] = agent.calls;
  assert.equal(job.system, REFLECTION_SYSTEM);
  assert.deepEqual([job.model, job.effort], ['claude-sonnet-5-5', 'medium']);
  assert.ok(job.prompt.startsWith('Data de azi: 2026-11-22\n\n<profil>\nProfil vechi'));
  assert.ok(job.prompt.includes('<jurnal-de-studiu>\nJurnal vechi.\n</jurnal-de-studiu>'));
  assert.ok(job.prompt.includes('11:00 Rezidenta: cand dau sulfat de magneziu?'));
  assert.ok(job.prompt.endsWith(`11:00 Rokhan: ${'R'.repeat(700)}\n</mesajele_de_azi>`), 'long answers are cut to 700 characters');
  assert.ok(!job.prompt.includes('de ieri'));
  assert.match(REFLECTION_SYSTEM, /Nimic despre paciente/);
});

test('reflection: no conversation today means no model call; a bad answer writes nothing', async () => {
  const now = () => at('2026-11-22T21:50:00Z');
  const quiet = fakeAgent(['{}']);
  assert.deepEqual(await runReflection({ config: { tz }, deps: fakeDeps(), agent: quiet, now }), { ran: false, written: [], rejected: [] });
  assert.equal(quiet.calls.length, 0);
  const memorie = fakeMemorie({ profil: 'P' });
  const deps = fakeDeps({ memorie, conversations: fakeConversations([{ role: 'user', text: 'salut', ts: now().getTime() - 1000 }]) });
  assert.equal((await runReflection({ config: { tz }, deps, agent: fakeAgent(['nu e json']), now })).error, 'răspunsul nu e JSON');
  const limited = fakeAgent([{ text: '', error: { code: 'limita', message: 'L' } }]);
  assert.match((await runReflection({ config: { tz }, deps, agent: limited, now })).error, /limita/);
  assert.deepEqual(await runReflection({ config: { tz }, deps, agent: fakeAgent(['{}']), now }), { ran: true, written: [], rejected: [] });
  assert.equal(memorie.store.get('profil'), 'P');
});

test('purge: uploads and cache files older than 30 days go, newer ones and other folders stay', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-'));
  const put = (rel, ageDays) => {
    const p = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
    fs.utimesSync(p, t, t);
  };
  put('uploads/conv-vechi/a.jpg', 40);
  put('uploads/conv-mixt/b.jpg', 31);
  put('uploads/conv-mixt/c.jpg', 2);
  put('cache/url-old.json', 45);
  put('cache/url-new.json', 1);
  put('memory/profil.md', 400);
  put('conversations/c1.json', 400);
  assert.equal(purgeOld({ dataDir }), 3);
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'conv-vechi')), 'an emptied upload folder is removed');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads', 'conv-mixt')), ['c.jpg']);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'cache')), ['url-new.json']);
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'profil.md')));
  assert.ok(fs.existsSync(path.join(dataDir, 'conversations', 'c1.json')));
  assert.equal(purgeOld({ dataDir: path.join(dataDir, 'nu-exista') }), 0);
});

test('startJobs: a tick runs what is due once, logs each run, and survives a failing job', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-jobs-'));
  const lessons = fakeLessons({ missing: { id: '14-2', unit: {} } });
  const conversations = { messagesSince: () => { throw new Error('disc plin'); } };
  const agent = fakeAgent(['{"titlu":"T"}']);
  const jobs = startJobs({ config: { dataDir, tz }, deps: fakeDeps({ lessons, conversations }), agent, intervalMs: 3_600_000 });
  try {
    await jobs.tick(at('2026-11-22T10:05:00+02:00')); // the writer, and the first purge of the day
    await jobs.tick(at('2026-11-22T10:06:00+02:00')); // nothing due
    await jobs.tick(at('2026-11-22T23:50:00+02:00')); // the reflection, which fails
    await jobs.tick(at('2026-11-22T23:51:00+02:00')); // not again today
  } finally {
    jobs.stop();
  }
  assert.deepEqual(lessons.saved, { '14-2': { titlu: 'T' } });
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'jobs.log'), 'utf8').trim().split('\n').map((l) => l.split('\t').slice(1));
  assert.deepEqual(log.map((l) => l.slice(0, 2)).sort(), [['curatenie', 'ok'], ['lectie', 'ok'], ['reflectie', 'eroare']]);
  assert.match(log.find((l) => l[0] === 'reflectie')[2], /disc plin/);
  assert.match(log.find((l) => l[0] === 'lectie')[2], /14-2 runde=1/);
});
