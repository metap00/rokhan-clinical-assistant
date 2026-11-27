// Videotecă: the shipped catalog, the Registru mapping, the "Văzut" ticks, the routes, the film of the day
// in the daily notification and the browser's search and filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, makeConfig } from './core-helpers.mjs';
import { ROOT } from '../server/config.mjs';
import { parseCatalog, filmOfDay, getVideoteca } from '../server/store/videoteca.mjs';
import { REGISTRU_VIDEOTECA } from '../server/store/registru-videoteca.mjs';
import { seedRows } from '../server/store/registru.mjs';
import { getPush, runDailyPush } from '../server/store/push.mjs';
import { NO_FILTERS, isFiltering, filterSections, videosOf, totalTime, shortBarem, registruLine } from '../web/lib/videoteca.js';

const shippedText = fs.readFileSync(path.join(ROOT, 'content', 'videoteca.json'), 'utf8');
const shipped = JSON.parse(shippedText);

const video = (n, over = {}) => ({ title: `Film ${n}`, url: `https://video.example.org/${n}`, source: 'Sursa', source_tier: 'journal', year: 2024, duration: '2:30', access: 'free', level: 'basic', covers_ro: 'Pașii.', caveat_ro: null, ...over });
const small = () => ({
  title: 'Videotecă', generated: '2026-11-27',
  start_here: [{ url: video(3).url, why_ro: 'întâi' }, { url: video(1).url, why_ro: 'apoi' }],
  sections: [
    { id: 'obstetrica', title_ro: 'Obstetrică', intro_ro: '', procedures: [
      { name_ro: 'Ventuza obstetricală', name_en: 'Vacuum', barem: '10-20', note_ro: null, videos: [video(1), video(2, { level: 'advanced', access: 'signin' })] },
      { name_ro: 'Cezariana pe uter cicatricial', name_en: 'Repeat caesarean', barem: '15-20', note_ro: 'Lipsă.', videos: [] },
    ] },
    { id: 'anatomie', title_ro: 'Anatomie', intro_ro: '', procedures: [{ name_ro: 'Ureterul', name_en: 'Ureter', barem: null, note_ro: null, videos: [video(3), video(4)] }] },
  ],
  libraries: [], gaps_ro: [], notes_ro: [],
});
// A config whose catalog is `catalog` (the override file in the data directory).
function withCatalog(catalog = small(), over = {}) {
  const config = makeConfig(over);
  const file = path.join(config.dataDir, 'library', 'videoteca.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  return { config, file };
}

// ---------- the shipped catalog and the mapping ----------

test('shipped catalog: it loads, no video is dropped, every "Start aici" address is one of its videos', () => {
  const c = parseCatalog(shippedText);
  const raw = shipped.sections.flatMap((s) => s.procedures.flatMap((p) => p.videos));
  assert.equal(c.videos.size, new Set(raw.map((v) => v.url)).size);
  assert.equal(c.start_here.length, shipped.start_here.length);
  assert.equal(c.libraries.length, shipped.libraries.length);
  const names = c.sections.flatMap((s) => s.procedures.map((p) => p.name_ro));
  assert.equal(new Set(names).size, names.length, 'procedure names are unique, the mapping relies on it');
});

test('Registru mapping: every key is a Registru row, every name is a procedure of the catalog', () => {
  const rows = new Set(seedRows().map((r) => r.id));
  const names = new Set(shipped.sections.flatMap((s) => s.procedures.map((p) => p.name_ro)));
  for (const [id, list] of Object.entries(REGISTRU_VIDEOTECA)) {
    assert.ok(rows.has(id), `no Registru row "${id}"`);
    assert.ok(list.length > 0, id);
    for (const n of list) assert.ok(names.has(n), `no catalog procedure "${n}" (row ${id})`);
  }
});

test('parseCatalog: only web addresses are kept, a wrong shape is refused', () => {
  const c = small();
  c.sections[0].procedures[0].videos.push(video(9, { url: 'javascript:alert(1)' }));
  c.libraries = [{ name: 'a', url: 'data:text/html,x' }, { name: 'b', url: 'https://example.org' }];
  c.start_here.push({ url: 'https://video.example.org/none', why_ro: 'x' });
  const parsed = parseCatalog(JSON.stringify(c));
  assert.deepEqual([...parsed.videos.keys()], [1, 2, 3, 4].map((n) => video(n).url));
  assert.deepEqual(parsed.libraries.map((l) => l.name), ['b']);
  assert.equal(parsed.start_here.length, 2);
  for (const bad of ['{}', '[]', 'null', '{"sections":[{"id":"a"}]}', '{"sections":[]}', 'not json']) assert.throws(() => parseCatalog(bad), bad);
});

test('parseCatalog: no en dash or em dash reaches the screen, addresses are left as they are', () => {
  const c = small();
  c.sections[0].procedures[0].videos[0] = video(1, { title: 'Single Port \u2013 Technique \u2014 Notes', covers_ro: 'Pașii 1\u20133.', url: 'https://video.example.org/a\u2013b' });
  const v = [...parseCatalog(JSON.stringify(c)).videos.values()][0];
  assert.deepEqual([v.title, v.covers_ro, v.url], ['Single Port - Technique - Notes', 'Pașii 1-3.', 'https://video.example.org/a\u2013b']);
});

test('Registru mapping: contraception also shows laparoscopic sterilisation, the sphincter repair stays with the tears', () => {
  assert.ok(REGISTRU_VIDEOTECA.contraceptie.includes('Sterilizarea tubară laparoscopică și salpingectomia oportunistă'));
  assert.ok(REGISTRU_VIDEOTECA['sutura-rupturi'].includes('Repararea leziunilor obstetricale ale sfincterului anal'));
});

// ---------- film of the day ----------

test('film of the day: "Start aici" in its order, then the catalog order, null when everything is seen', () => {
  const c = parseCatalog(JSON.stringify(small()));
  const seen = new Set();
  const order = [];
  for (let f = filmOfDay(c, seen); f; f = filmOfDay(c, seen)) {
    order.push(f.title);
    seen.add(f.url);
  }
  assert.deepEqual(order, ['Film 3', 'Film 1', 'Film 2', 'Film 4']);
  assert.equal(filmOfDay(c, new Set([video(1).url])).title, 'Film 3');
});

// ---------- ticks ----------

test('ticks: saved to the data directory, undone, refused for an unknown film or a bad body', () => {
  const { config } = withCatalog();
  const v = getVideoteca(config);
  assert.deepEqual(v.seen(), []);
  assert.deepEqual(v.setSeen(video(2).url, true), [video(2).url]);
  const stored = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'videoteca-vazute.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.vazute), [video(2).url]);
  assert.deepEqual(v.setSeen(video(2).url, false), []);
  assert.throws(() => v.setSeen('https://video.example.org/none', true), (e) => e.status === 404);
  for (const [url, on] of [[undefined, true], [video(1).url, 'da'], [7, false]]) assert.throws(() => v.setSeen(url, on), (e) => e.status === 400);
});

test('a new catalog file is picked up without a restart; ticks are kept by address, also for a film that left', () => {
  const { config, file } = withCatalog();
  const v = getVideoteca(config);
  v.setSeen(video(1).url, true);
  v.setSeen(video(2).url, true);
  const next = small();
  next.sections[0].procedures[0].videos = [video(1, { title: 'Film 1, titlu nou' }), video(5), video(6)];
  fs.writeFileSync(file, JSON.stringify(next));
  assert.equal(v.catalog().videos.size, 5);
  assert.deepEqual(v.seen(), [video(1).url]);
  assert.equal(v.filmOfDay().title, 'Film 3');
  fs.writeFileSync(file, JSON.stringify(small(), null, 2)); // film 2 is back
  assert.deepEqual(v.seen(), [video(1).url, video(2).url]);
});

test('catalog: the file in the data directory wins, a broken one falls back to the shipped catalog', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(getVideoteca(makeConfig()).catalog().videos.size, parseCatalog(shippedText).videos.size);
  assert.equal(getVideoteca(withCatalog().config).catalog().videos.size, 4);
  assert.equal(getVideoteca(withCatalog('{ half a file').config).catalog().videos.size, parseCatalog(shippedText).videos.size);
});

test('a damaged tick file is reported, never overwritten', () => {
  const { config } = withCatalog();
  const ticks = path.join(config.dataDir, 'videoteca-vazute.json');
  fs.writeFileSync(ticks, '{ broken');
  assert.throws(() => getVideoteca(config).setSeen(video(1).url, true));
  assert.equal(fs.readFileSync(ticks, 'utf8'), '{ broken');
});

// ---------- routes ----------

test('routes: login required, catalog with ticks and Registru counts, ticks survive a restart', async (t) => {
  const first = await boot();
  t.after(() => first.close());
  for (const [m, p] of [['GET', '/api/videoteca'], ['GET', '/api/videoteca/registru'], ['PUT', '/api/videoteca/vazut']]) {
    assert.equal((await first.api(m, p)).status, 401, p);
  }
  await first.login();
  await first.api('POST', '/api/registru/entries', { row: 'ventuza', n: 3 });
  await first.api('POST', '/api/registru/entries', { row: 'ventuza', rol: 'observat', n: 9 });
  const url = shipped.start_here[0].url;
  assert.deepEqual((await first.api('PUT', '/api/videoteca/vazut', { url, vazut: true })).json, { vazute: [url] });
  assert.equal((await first.api('PUT', '/api/videoteca/vazut', { url: 'https://example.org/x', vazut: true })).status, 404);

  const r = (await first.api('GET', '/api/videoteca')).json;
  assert.deepEqual(Object.keys(r).sort(), ['filmulZilei', 'gaps_ro', 'generated', 'libraries', 'notes_ro', 'sections', 'start_here', 'title', 'vazute']);
  assert.equal(r.filmulZilei, shipped.start_here[1].url, 'the next unwatched film, the first one is ticked');
  assert.deepEqual(r.vazute, [url]);
  const procs = r.sections.flatMap((s) => s.procedures);
  const ventuza = procs.find((p) => p.name_ro === 'Ventuza obstetricală');
  assert.deepEqual(ventuza.registru, [{ id: 'ventuza', nume: 'Ventuză obstetricală', barem: '10-20', efectuat: 3 }]);
  assert.deepEqual(procs.find((p) => p.name_ro === 'Operația cezariană, inclusiv cezariana în urgență').registru.map((x) => x.id), ['cezariana', 'cezariana-urgenta']);
  const mapped = new Set(Object.values(REGISTRU_VIDEOTECA).flat());
  assert.ok(procs.filter((p) => !mapped.has(p.name_ro)).every((p) => p.registru.length === 0), 'an unmapped procedure shows no count');

  const reg = (await first.api('GET', '/api/videoteca/registru')).json;
  assert.deepEqual(reg.vazute, [url]);
  assert.equal(reg.randuri.ventuza[0].name_ro, 'Ventuza obstetricală');
  assert.equal(reg.randuri.ventuza[0].capitol, 'obstetrica');
  assert.ok(reg.randuri.ventuza[0].videos.length > 0);
  assert.equal(reg.randuri.garzi, undefined);
  for (const list of Object.values(reg.randuri)) for (const p of list) assert.ok(p.videos.length > 0, 'a row never offers an empty list');

  await first.api('PUT', '/api/push/setari', { film: false });
  assert.equal((await first.api('GET', '/api/videoteca')).json.filmulZilei, null, 'switched off: no film at the top');

  // another server on the same data directory (the restart): the tick is there
  await first.close();
  const second = await boot({ dataDir: first.config.dataDir });
  t.after(() => second.close());
  await second.login();
  assert.deepEqual((await second.api('GET', '/api/videoteca')).json.vazute, [url]);
});

// ---------- the daily notification ----------

const at = (hhmm) => new Date(`2026-11-23T${hhmm}:00+02:00`); // a Monday
const lessons = ({ citite = [], scadente = 0 } = {}) => ({
  status: () => ({ urmatoarea: { id: '14-1', ghid: { nr: '14', titlu: 'Preeclampsia' }, k: 1, n: 5, titlu: 'Diagnostic', scrisa: true, minute: 7 }, citite, recap: { disponibil: false, lectii: [] }, repetitie: { scadente } }),
  requestGenerate: () => ({}),
});
function pushSetup(catalog) {
  const { config, file } = withCatalog(catalog, { pushContact: 'mailto:test@example.com' });
  const sent = [];
  const logs = [];
  const push = getPush(config, { sender: async (s, payload) => { sent.push(JSON.parse(payload)); } });
  push.addSubscription({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });
  push.setSettings({ activ: true, ora: '18:00' });
  const run = (l = lessons(), hhmm = '18:00') => runDailyPush({ config, lessons: l, now: at(hhmm), log: (s, d) => logs.push(`${s} ${d}`) });
  return { config, file, push, sent, logs, run };
}

test('lesson day: the film is one more line, the tap still opens the lesson', async () => {
  const { push, sent, run } = pushSetup();
  assert.equal(push.info().film, true);
  await run();
  assert.deepEqual(sent, [{
    title: 'Lectura de azi',
    body: 'Preeclampsia: Diagnostic (cam 7 minute)\nFilmul zilei: Film 3 (2:30)',
    url: '/#/lecturi',
  }]);
});

test('Filmul zilei skips what she has seen, and also follows the review notification', async () => {
  const { config, sent, run } = pushSetup();
  getVideoteca(config).setSeen(video(3).url, true);
  await run(lessons({ citite: [{ id: 'x', data: '2026-11-23' }], scadente: 2 }));
  assert.deepEqual([sent[0].title, sent[0].body, sent[0].url], ['De repetat azi', '2 întrebări din lecturile citite.\nFilmul zilei: Film 1 (2:30)', '/#/lecturi']);
});

test('Filmul zilei off, or every film seen: the notification is as before', async () => {
  const off = pushSetup();
  off.push.setSettings({ film: false });
  await off.run();
  assert.deepEqual([off.sent[0].body, off.sent[0].url], ['Preeclampsia: Diagnostic (cam 7 minute)', '/#/lecturi']);
  const done = pushSetup();
  for (const n of [1, 2, 3, 4]) getVideoteca(done.config).setSeen(video(n).url, true);
  await done.run();
  assert.deepEqual([done.sent[0].body, done.sent[0].url], ['Preeclampsia: Diagnostic (cam 7 minute)', '/#/lecturi']);
  assert.throws(() => off.push.setSettings({ film: 'da' }), (e) => e.status === 400);
});

const readToday = () => lessons({ citite: [{ id: 'x', data: '2026-11-23' }] });
const finished = () => ({ ...lessons(), status: () => ({ ...lessons().status(), urmatoarea: null }) });
const filmOnly = { title: 'Filmul zilei', body: 'Film 3 (2:30)', url: `/#/videoteca?v=${encodeURIComponent(video(3).url)}` };

test('no lesson to announce (read today, or the plan is finished): the film alone, the tap opens it, once a day', async () => {
  for (const day of [readToday, finished]) {
    const { sent, run, push } = pushSetup();
    assert.equal(await run(day(), '17:59'), null, 'not before her hour');
    assert.equal(await run(day()), 'trimis 1/1');
    assert.equal(await run(day(), '18:01'), null);
    assert.deepEqual(sent, [filmOnly]);
    assert.equal(push.state().ultimaTrimitere, '2026-11-23');
  }
});

test('no film alone when the switch is off or every film is seen', async () => {
  const off = pushSetup();
  off.push.setSettings({ film: false });
  const seenAll = pushSetup();
  for (const n of [1, 2, 3, 4]) getVideoteca(seenAll.config).setSeen(video(n).url, true);
  for (const x of [off, seenAll]) {
    assert.equal(await x.run(readToday()), 'citita deja');
    assert.equal(x.sent.length, 0);
    assert.equal(x.push.state().ultimaTrimitere, '2026-11-23');
  }
});

test('the daily notification switched off: no film either', async () => {
  const { push, sent, run } = pushSetup();
  push.setSettings({ activ: false });
  assert.equal(await run(readToday()), null);
  assert.equal(sent.length, 0);
});

test('a lesson still being written: the job waits for it, the film does not go ahead of it', async () => {
  const { sent, run, push } = pushSetup();
  const base = lessons().status();
  const writing = { status: () => ({ ...base, urmatoarea: { ...base.urmatoarea, scrisa: false } }), requestGenerate: () => ({}) };
  assert.equal(await run(writing), null);
  assert.equal(sent.length, 0);
  assert.equal(push.state().ultimaTrimitere, null);
});

test('a day with no lesson and ticks that cannot be read: nothing is sent, logged once', async () => {
  const { config, sent, logs, run } = pushSetup();
  fs.writeFileSync(path.join(config.dataDir, 'videoteca-vazute.json'), '{ broken');
  await run(finished());
  await run(finished(), '18:01');
  assert.equal(sent.length, 0);
  assert.equal(logs.filter((l) => l.includes('filmul zilei')).length, 1);
});

test('a catalog that cannot be read never stops the lesson notification', async () => {
  const { config, sent, logs, run } = pushSetup();
  fs.writeFileSync(path.join(config.dataDir, 'videoteca-vazute.json'), '{ broken');
  await run();
  assert.deepEqual([sent[0].body, sent[0].url], ['Preeclampsia: Diagnostic (cam 7 minute)', '/#/lecturi']);
  assert.ok(logs.some((l) => l.includes('filmul zilei')), logs.join('|'));
});

test('an old push.json without the setting counts as on', () => {
  const config = makeConfig({ pushContact: 'mailto:test@example.com' });
  fs.writeFileSync(path.join(config.dataDir, 'push.json'), JSON.stringify({ setari: { activ: true, ora: '18:00', raspuns: true }, abonamente: [] }));
  assert.equal(getPush(config).info().film, true);
});

// ---------- the browser side ----------

test('search ignores diacritics; level, "fără cont" and "ascunde văzute" cut the list', () => {
  const { sections } = small();
  const titles = (f, seen = new Set()) => filterSections(sections, { ...NO_FILTERS, ...f }, seen).flatMap((s) => s.procedures.map((p) => [p.name_ro, p.videos.map((v) => v.title)]));
  assert.equal(isFiltering(NO_FILTERS), false);
  assert.equal(isFiltering({ ...NO_FILTERS, hide: true }), true);
  assert.equal(titles({}).length, 3); // the gap is listed too
  assert.deepEqual(titles({ q: 'VENTUZA obstetricala' }), [['Ventuza obstetricală', ['Film 1', 'Film 2']]]);
  assert.deepEqual(titles({ q: 'pasii ureter' }), [['Ureterul', ['Film 3', 'Film 4']]]);
  assert.deepEqual(titles({ q: 'cicatricial' }), [['Cezariana pe uter cicatricial', []]]);
  assert.deepEqual(titles({ level: 'advanced' }), [['Ventuza obstetricală', ['Film 2']]]);
  assert.deepEqual(titles({ free: true })[0], ['Ventuza obstetricală', ['Film 1']]);
  assert.deepEqual(titles({ hide: true }, new Set([1, 2, 3].map((n) => video(n).url))), [['Ureterul', ['Film 4']]]);
  assert.deepEqual(titles({ q: 'nimic de gasit' }), []);
});

test('labels: total time, short barem, the Registru line', () => {
  assert.equal(totalTime([video(1), video(2)]), '5 min');
  assert.equal(totalTime([{ duration: '1:02:00' }, { duration: '59:40' }, { duration: null }]), '2 h 2 min');
  assert.equal(totalTime([{ duration: '59:59' }]), '1 h 0 min');
  assert.equal(videosOf([{ videos: [video(1)] }, { videos: [video(1), video(2)] }]).length, 2);
  assert.deepEqual([shortBarem('5'), shortBarem('15-20'), shortBarem('listat'), shortBarem(null)], [true, true, false, false]);
  assert.equal(registruLine({ nume: 'Cezariană', barem: '20', efectuat: 3 }), 'Registru: 3 din 20');
  assert.equal(registruLine({ nume: 'Ventuză obstetricală', barem: '10-20', efectuat: 3 }), 'Registru: 3 din 10-20');
  assert.equal(registruLine({ nume: 'Cezariană în urgență', barem: 'min. 10-15', efectuat: 0 }, true), 'Registru, Cezariană în urgență: 0 din min. 10-15');
  assert.equal(registruLine({ nume: 'x', barem: '', efectuat: 2 }), 'Registru: 2');
});
