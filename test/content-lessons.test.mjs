import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLessons } from '../server/lessons/index.mjs';
import { makeLessonsData, readJson, FIXTURES } from './content-helpers.mjs';

const NOW = new Date('2026-11-22T10:00:00Z'); // 2026-11-22 in Europe/Bucharest
const DAY = 24 * 3600 * 1000;
const setup = (opts = {}) => {
  const d = makeLessonsData(opts);
  const clock = { t: NOW };
  const svc = getLessons(d.config, { now: () => clock.t });
  return { ...d, svc, clock, state: () => readJson(path.join(d.dir, 'state.json')) };
};
const sampleLesson = (id) => readJson(path.join(FIXTURES, 'lessons', 'lessons', `${id}.json`));

test('status() of a fresh data dir: the first unit in curriculum order is next, nothing read, no recap', () => {
  const { svc } = setup();
  const s = svc.status();
  assert.equal(s.urmatoarea.id, '01-1');
  assert.deepEqual(s.urmatoarea.ghid, { nr: '01', titlu: 'Travaliul fictiv de test' });
  assert.equal(s.urmatoarea.scrisa, true);
  assert.equal(s.urmatoarea.titlu, sampleLesson('01-1').titlu);
  assert.ok(Number.isInteger(s.urmatoarea.minute) && s.urmatoarea.minute >= 4 && s.urmatoarea.minute <= 9, String(s.urmatoarea.minute));
  assert.deepEqual(s.progres.map((g) => [g.nr, g.total, g.citite]), [['01', 1, 0], ['07', 3, 0], ['08', 2, 0]]);
  assert.deepEqual(s.citite, []);
  assert.deepEqual(s.recap, { disponibil: false, lectii: [] });
});

test('status() of an unwritten next lesson shows the unit sections and scrisa:false', () => {
  const { svc } = setup({ state: { plan: ['08-2', '07-1'], cursor: 0, sent: [] } });
  const s = svc.status();
  assert.equal(s.urmatoarea.id, '08-2');
  assert.equal(s.urmatoarea.scrisa, false);
  assert.equal(typeof s.urmatoarea.titlu, 'string');
  assert.ok(s.urmatoarea.titlu.length > 0);
});

test('an old-format state.json (with extra fields and recap entries) is read as it is', () => {
  const { svc } = setup({
    state: {
      plan: ['01-1', '07-1', '07-2', '07-3', '08-1', '08-2'], cursor: 2,
      sent: [
        { unit: '01-1', data: '2026-11-15', tip: 'lectura', deschidere: 'text vechi' },
        { unit: '07-1', data: '2026-11-16', tip: 'lectura' },
        { tip: 'recap', data: '2026-11-22', unitati: ['01-1', '07-1'] },
      ],
      pauza_pana_la: null, inceput: '2026-11-15', extra_azi: null, repeta_azi: null, comenzi_servite: {}, sarite: [], extra: 0,
    },
  });
  const s = svc.status();
  assert.equal(s.urmatoarea.id, '07-2');
  assert.deepEqual(s.progres.map((g) => g.citite), [1, 1, 0]);
  assert.deepEqual(s.citite.map((c) => c.id), ['07-1', '01-1']); // newest first, recap entries ignored
  assert.equal(s.recap.disponibil, false); // two lessons in the last 7 days (and the 15th is older)
});

test('get() returns the printed lesson with cards that carry the guideline text', () => {
  const { svc } = setup();
  const lesson = sampleLesson('07-1');
  const unit = readJson(path.join(FIXTURES, 'lessons', 'units', '07-1.json'));
  const l = svc.get('07-1');
  assert.equal(l.id, '07-1');
  assert.equal(l.titlu, lesson.titlu);
  assert.equal(l.k, 1);
  assert.deepEqual(l.ghid, { nr: '07', titlu: unit.ghid.titlu });
  assert.deepEqual(l.sursa.pagini, unit.pagini);
  assert.equal(l.sursa.url, unit.ghid.url);
  assert.equal(l.sectiuni.length, lesson.sectiuni.length);
  const refs = l.sectiuni.flatMap((s) => s.carduri.map((c) => c.ref));
  assert.deepEqual(refs, lesson.sectiuni.flatMap((s) => s.recomandari));
  const rows = new Map(unit.blocuri.filter((b) => b.id).map((b) => [b.id, b]));
  for (const s of l.sectiuni) for (const c of [...s.carduri, ...s.argumentare]) {
    const b = rows.get(c.ref);
    assert.equal(c.pagina, b.pagina_final ? `${b.pagina}-${b.pagina_final}` : String(b.pagina));
    assert.equal(c.grad, b.grad || null);
    // html is the guideline's own text: stripping the marks gives the text back, escaped
    assert.equal(c.html.replaceAll('<mark>', '').replaceAll('</mark>', ''), b.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  }
  const first = l.sectiuni[0].carduri[0];
  assert.ok(['standard', 'recomandare', 'optiune', 'argumentare', 'ghid'].includes(first.tip));
  assert.ok(l.sectiuni.some((s) => s.carduri.some((c) => c.html.includes('<mark>'))), 'numbers and units are marked');
  const explained = lesson.sectiuni.flatMap((s) => s.explicatii ?? []);
  for (const e of explained) assert.equal(l.sectiuni.flatMap((s) => s.carduri).find((c) => c.ref === e.ref).explicatie, e.text);
  assert.equal(l.cifre.length, lesson.cifre.length);
  assert.ok(l.cifre.every((c) => c.eticheta && c.valoare && /^p\. \d/.test(c.sursa)));
  assert.equal(l.quiz.length, 3);
  assert.deepEqual(l.quiz.map((q) => q.raspuns.ref), lesson.quiz.map((q) => q.ref));
  assert.ok(l.quiz.every((q) => q.intrebare && q.raspuns.html && 'comentariu' in q.raspuns));
  assert.deepEqual(l.perle, lesson.perle);
});

test('get() errors: nescrisa for an unwritten lesson, negasit for an unknown or malformed id', () => {
  const { svc } = setup();
  assert.throws(() => svc.get('08-2'), (e) => e.status === 404 && e.message === 'nescrisa');
  for (const id of ['99-9', '../x', '07-1/../../x', '', undefined, 'recap']) assert.throws(() => svc.get(id), (e) => e.status === 404 && e.message === 'negasit', String(id));
});

test('markRead() records the lesson, advances the cursor, logs the quiz and is idempotent', () => {
  const { svc, state, dir } = setup();
  const s = svc.markRead('01-1', { quiz: [true, false, true] });
  assert.equal(s.urmatoarea.id, '07-1');
  assert.deepEqual(s.progres.map((g) => g.citite), [1, 0, 0]);
  assert.deepEqual(s.citite, [{ id: '01-1', titlu: sampleLesson('01-1').titlu, data: '2026-11-22' }]);
  assert.deepEqual(state().sent, [{ unit: '01-1', data: '2026-11-22', tip: 'lectura' }]);
  assert.equal(state().cursor, 1);
  assert.deepEqual(readJson(path.join(dir, 'quiz-log.json')), [{ id: '01-1', date: '2026-11-22', quiz: [true, false, true] }]);
  svc.markRead('01-1', { quiz: [true, true, true] }); // read again: no second entry in sent, but the quiz is logged
  assert.equal(state().sent.length, 1);
  assert.equal(readJson(path.join(dir, 'quiz-log.json')).length, 2);
  assert.equal(svc.status().urmatoarea.id, '07-1');
});

test('markRead() date follows the configured time zone, and rejects bad input', () => {
  const { svc, clock, state } = setup();
  clock.t = new Date('2026-11-22T22:30:00Z'); // already the 23rd in Bucharest
  svc.markRead('01-1');
  assert.equal(state().sent[0].data, '2026-11-23');
  assert.throws(() => svc.markRead('99-9'), (e) => e.status === 404);
  assert.throws(() => svc.markRead('07-1', { quiz: 'da' }), (e) => e.status === 400);
  assert.throws(() => svc.markRead('07-1', { quiz: [1, 2] }), (e) => e.status === 400);
  assert.doesNotThrow(() => svc.markRead('07-1', { quiz: [] }));
});

test('reading ahead keeps the cursor on the first unread unit and later jumps over what was read', () => {
  const { svc } = setup({ state: { plan: ['07-1', '07-2', '07-3', '08-1'], cursor: 0, sent: [] } });
  assert.equal(svc.markRead('07-2').urmatoarea.id, '07-1'); // read 07-2 first
  assert.equal(svc.markRead('07-1').urmatoarea.id, '07-3'); // 07-2 is jumped over
});

test('setNextGuide() moves the unread units of a guideline to the cursor and keeps every other order', () => {
  const { svc, state } = setup();
  svc.markRead('01-1');
  const s = svc.setNextGuide('08');
  assert.equal(s.urmatoarea.id, '08-1');
  assert.deepEqual(state().plan, ['01-1', '08-1', '08-2', '07-1', '07-2', '07-3']);
  assert.equal(state().cursor, 1);
  svc.markRead('08-1');
  assert.equal(svc.status().urmatoarea.id, '08-2');
  assert.deepEqual(svc.setNextGuide(7).urmatoarea.id, '07-1'); // a number works too
  assert.deepEqual(state().plan, ['01-1', '08-1', '07-1', '07-2', '07-3', '08-2']);
  assert.throws(() => svc.setNextGuide('77'), (e) => e.status === 404);
});

test('skip() leaves the unit out without counting it as read', () => {
  const { svc, state } = setup();
  const s = svc.skip('01-1');
  assert.equal(s.urmatoarea.id, '07-1');
  assert.deepEqual(s.progres.map((g) => g.citite), [0, 0, 0]);
  assert.deepEqual(state().sarite, [{ unit: '01-1', data: '2026-11-22' }]);
  assert.equal(state().cursor, 1);
  svc.skip('01-1'); // again: no duplicate
  assert.equal(state().sarite.length, 1);
  svc.skip('08-1'); // a later unit: skipped when the cursor gets there
  assert.equal(svc.status().urmatoarea.id, '07-1');
  svc.markRead('07-1'); svc.markRead('07-2'); svc.markRead('07-3');
  assert.equal(svc.status().urmatoarea.id, '08-2');
  assert.throws(() => svc.skip('99-9'), (e) => e.status === 404);
});

test('a skipped unit that is read after all is no longer skipped', () => {
  const { svc, state } = setup();
  svc.skip('01-1');
  svc.markRead('01-1');
  assert.deepEqual(state().sarite, []);
  assert.deepEqual(svc.status().progres.map((g) => g.citite), [1, 0, 0]);
});

test('nextMissing() looks at the next units from the cursor; a request goes first; save() clears it', () => {
  const { svc, lessonsDir } = setup();
  // plan 01-1, 07-1, 07-2 are written, 07-3 is not
  assert.equal(svc.nextMissing(3), null);
  const m = svc.nextMissing(4);
  assert.equal(m.id, '07-3');
  assert.equal(m.unit.id, '07-3');
  assert.ok(Array.isArray(m.unit.blocuri));
  assert.deepEqual(svc.requestGenerate('08-2'), { status: 'in_lucru' });
  assert.equal(svc.nextMissing(1).id, '08-2'); // requested, even outside the lead
  assert.deepEqual(svc.requestGenerate('01-1'), { status: 'scrisa' }); // already written: not recorded
  svc.requestGenerate('08-1');
  assert.equal(svc.nextMissing(3).id, '08-2'); // first asked, first served
  const lesson = { ...sampleLesson('07-1'), unit: '08-2' };
  svc.save('08-2', lesson);
  assert.equal(svc.nextMissing(3).id, '08-1');
  assert.ok(fs.existsSync(path.join(lessonsDir, '08-2.json')));
  assert.throws(() => svc.requestGenerate('99-9'), (e) => e.status === 404);
});

test('nextMissing() ignores read and skipped units', () => {
  const { svc } = setup({ state: { plan: ['07-1', '07-3', '08-1', '08-2'], cursor: 0, sent: [{ unit: '07-1', data: '2026-11-20', tip: 'lectura' }], sarite: [{ unit: '07-3', data: '2026-11-20' }] } });
  assert.equal(svc.nextMissing(1).id, '08-1');
  assert.equal(svc.nextMissing(0), null);
});

test('nextMissing() leaves out the units in `exclude`, requested ones too', () => {
  const { svc } = setup({ state: { plan: ['07-1', '07-3', '08-1', '08-2'], cursor: 0, sent: [], sarite: [] } });
  assert.equal(svc.nextMissing(3).id, '07-3');
  assert.equal(svc.nextMissing(3, []).id, '07-3');
  assert.equal(svc.nextMissing(3, ['07-3']).id, '08-1'); // the writer gave up on 07-3: the one after it is next
  assert.equal(svc.nextMissing(3, ['07-3', '08-1']).id, '08-2');
  assert.equal(svc.nextMissing(3, ['07-3', '08-1', '08-2']), null);
  svc.requestGenerate('08-2');
  assert.equal(svc.nextMissing(3).id, '08-2');
  assert.equal(svc.nextMissing(3, ['08-2']).id, '07-3');
});

test('generatorPrompt() is the writer instructions without server-specific parts', () => {
  const { svc } = setup();
  const p = svc.generatorPrompt();
  assert.match(p, /schema 3/);
  assert.match(p, /Nu rescrii niciodată textul/);
  assert.match(p, /numai JSON-ul lecturii/);
  assert.doesNotMatch(p, /bin\/validate|node bin|\{UNIT_MD\}|\{LESSON_JSON\}|memory_get|Telegram|PDF/);
  assert.equal(svc.generatorPrompt(), p);
});

test('validate() accepts a good lesson, also as raw text with a code fence', () => {
  const { svc } = setup();
  const l = sampleLesson('07-1');
  const r = svc.validate('07-1', l);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.ok(r.minutes >= 4);
  assert.equal(svc.validate('07-1', '```json\n' + JSON.stringify(l) + '\n```').ok, true);
  assert.equal(svc.validate('07-1', JSON.stringify(l)).ok, true);
});

test('validate() rejects digits (and number words) in the model\'s own text', () => {
  const { svc } = setup();
  const withDigits = { ...sampleLesson('07-1'), context: 'După 3 ore de monitorizare se reevaluează pacienta.' };
  const r = svc.validate('07-1', withDigits);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('context:')), r.errors.join('\n'));
  const words = { ...sampleLesson('07-1'), perle: ['Verifici de două ori înainte să pleci din sală.', 'a doua pereche de ochi ajută'] };
  assert.ok(svc.validate('07-1', words).errors.some((e) => e.startsWith('perle[')));
  const embedded = sampleLesson('07-1');
  embedded.sectiuni[0].intro = 'Vezi cardul R12 mai jos.';
  assert.ok(svc.validate('07-1', embedded).errors.some((e) => /intro/.test(e)));
});

test('validate() reports structural problems and bad input without throwing', () => {
  const { svc } = setup();
  const l = sampleLesson('07-1');
  assert.ok(svc.validate('07-1', { ...l, unit: '07-2' }).errors.some((e) => /unit/.test(e)));
  assert.ok(svc.validate('07-1', { ...l, schema: 2 }).errors.some((e) => /schema/.test(e)));
  assert.ok(svc.validate('07-1', { ...l, quiz: l.quiz.slice(0, 2) }).errors.some((e) => /quiz/.test(e)));
  assert.equal(svc.validate('07-1', 'nu e json {').ok, false);
  assert.equal(svc.validate('07-1', null).ok, false);
  assert.equal(svc.validate('99-9', l).ok, false);
});

test('save() validates first, writes lessons/<id>.json and the lesson then shows up as written', () => {
  const { svc, lessonsDir } = setup();
  const l = sampleLesson('07-1');
  const bad = { ...l, context: 'Doar 3 pași.' };
  fs.rmSync(path.join(lessonsDir, '07-1.json'));
  assert.equal(svc.status().urmatoarea.scrisa, true); // 01-1
  assert.throws(() => svc.save('07-1', bad), (e) => e.status === 422 && /context/.test(e.message) && e.errors.length > 0);
  assert.ok(!fs.existsSync(path.join(lessonsDir, '07-1.json')), 'nothing is written for an invalid lesson');
  assert.throws(() => svc.get('07-1'), (e) => e.message === 'nescrisa');
  const r = svc.save('07-1', JSON.stringify(l));
  assert.equal(r.id, '07-1');
  assert.deepEqual(readJson(path.join(lessonsDir, '07-1.json')), l);
  assert.equal(svc.get('07-1').titlu, l.titlu);
  assert.deepEqual(fs.readdirSync(lessonsDir).filter((f) => f.endsWith('.tmp')), []);
});

test('recap: available from three lessons read in the last seven days; recap() lists key points, figures and quiz', () => {
  const { svc, clock } = setup();
  svc.markRead('01-1'); svc.markRead('07-1');
  assert.equal(svc.status().recap.disponibil, false);
  clock.t = new Date(NOW.getTime() + 2 * DAY);
  svc.markRead('07-2');
  const s = svc.status();
  assert.equal(s.recap.disponibil, true);
  assert.deepEqual(s.recap.lectii.map((x) => x.id), ['07-2', '07-1', '01-1']);
  const r = svc.recap();
  assert.equal(r.disponibil, true);
  assert.deepEqual(r.lectii.map((x) => x.id), ['07-2', '07-1', '01-1']);
  assert.ok(r.lectii.every((x) => x.sectiuni.length >= 2 && x.sectiuni.every((sec) => sec.puncte_cheie.length >= 1)));
  assert.equal(r.quiz.length, 9);
  assert.ok(r.cifre.length >= 3 && r.cifre.every((c) => c.id && c.valoare));
  // a week later the first lessons fall out
  clock.t = new Date(NOW.getTime() + 8 * DAY);
  assert.deepEqual(svc.status().recap.lectii.map((x) => x.id), ['07-2']);
  assert.equal(svc.status().recap.disponibil, false);
});

test('status() lists at most the last 14 read lessons, newest first, each unit once', () => {
  const sent = Array.from({ length: 16 }, (_, i) => ({ unit: i % 2 ? '07-1' : '01-1', data: `2026-11-${String(i + 1).padStart(2, '0')}`, tip: 'lectura' }));
  sent.push({ unit: '07-2', data: '2026-11-17', tip: 'lectura' });
  const { svc } = setup({ state: { plan: ['01-1', '07-1', '07-2', '07-3'], cursor: 3, sent } });
  const s = svc.status();
  assert.deepEqual(s.citite.map((c) => c.id), ['07-2', '07-1', '01-1']); // three distinct units
  assert.equal(s.citite[0].data, '2026-11-17');
  assert.equal(s.citite[1].data, '2026-11-16');
});

test('sectionSummary keeps acronyms the unit writes in capitals, lowercases the rest of a shouted heading', async () => {
  const { sectionSummary } = await import('../server/lessons/sogr/text.mjs');
  const h = (level, num, text) => ({ tip: 'heading', level, num, text });
  const blocks = [
    h(1, '6', 'INSTRUMENTE DE DIAGNOSTIC ȘI SUPRAVEGHERE A CAZURILOR CU RCIU'), h(2, '6.1', 'Datarea sarcinii'), h(2, '6.2', 'Doppler'),
    h(1, '7', 'CONDUITA ÎN RCIU PRECOCE'), h(2, '7.1', 'Principii'),
    { tip: 'row', text: 'Nu se folosește pentru evaluarea RCIU.' },
    { tip: 'row', text: '(RECOMANDARE DE BUNĂ PRACTICĂ) Alt text.' },
  ];
  assert.equal(sectionSummary(blocks), '6 Instrumente de diagnostic și supraveghere a cazurilor cu RCIU (6.1-6.2) → 7 Conduita în RCIU precoce (7.1)');
});
