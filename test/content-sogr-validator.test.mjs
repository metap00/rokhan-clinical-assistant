import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixtureJson } from './content-sogr-helpers.mjs';
import { validateLesson } from '../server/lessons/sogr/lesson.mjs';

const unit = readFixtureJson('unit-07-1.json');
const sample = () => readFixtureJson('sample-lesson-07-1.json');
const errorsOf = (lesson) => validateLesson(unit, lesson).errors;

test('accepts the hand-written sample lesson for the invented unit 07-1', () => {
  const r = validateLesson(unit, sample());
  assert.deepEqual(r.errors, []);
  assert.ok(r.info.totalWords > 1000);
});

test('rejects a lesson that leaves out a Standard', () => {
  const l = sample();
  l.sectiuni[0].recomandari = l.sectiuni[0].recomandari.filter((id) => id !== 'R1'); // R1 is a Standard
  const e = errorsOf(l);
  assert.ok(e.some((m) => /acoperire incompletă/.test(m) && /R1 \(Standard\)/.test(m)), e.join('\n'));
});

test('rejects a duplicate ref', () => {
  const l = sample();
  l.sectiuni[1].recomandari.push('R1');
  assert.ok(errorsOf(l).some((m) => /R1 apare de două ori/.test(m)));
});

test('rejects unknown ids and wrong row kinds', () => {
  const l = sample();
  l.sectiuni[0].recomandari.push('R999');
  l.sectiuni[0].argumentare = ['R1']; // a Standard in the Argumentare slot
  const e = errorsOf(l);
  assert.ok(e.some((m) => /R999/.test(m)));
  assert.ok(e.some((m) => /R1 este Standard, nu Argumentare/.test(m)));
});

test('rejects a cifre ref that is not in the unit, and a valoare outside its block', () => {
  const l = sample();
  l.cifre[0].ref = 'R999';
  l.cifre[1].valoare = '99 ml/kg';
  const e = errorsOf(l);
  assert.ok(e.some((m) => /cifre\[0\]\.ref: id inexistent în unitate: R999/.test(m)));
  assert.ok(e.some((m) => /cifre\[1\]\.valoare "99 ml\/kg" nu e un fragment copiat literal din rândul R2/.test(m)));
});

test('valoare must be the guideline\'s own characters (only NFC and cedilla forms are tolerated); the old citat/pagina fields are refused', () => {
  const l = sample();
  l.cifre[1].valoare = '75   ML/KG';
  assert.ok(errorsOf(l).some((m) => /cifre\[1\]\.valoare .*scrie exact „75 ml\/kg”/.test(m)));
  const old = sample();
  old.cifre[1].citat = 'O gravidă prezintă un volum de sânge total de 75 ml/kg';
  old.cifre[1].pagina = 3;
  old.quiz[0].citat = 'Se recomandă';
  const e = errorsOf(old);
  assert.ok(e.some((m) => /cifre\[1\]\.citat nu mai există \(schema 3\)/.test(m)));
  assert.ok(e.some((m) => /cifre\[1\]\.pagina nu mai există \(schema 3\)/.test(m)));
  assert.ok(e.some((m) => /quiz\[0\]\.citat nu mai există \(schema 3\)/.test(m)));
});

test('rejects a 4-question quiz and counts of other lists', () => {
  const l = sample();
  l.quiz.push({ intrebare: 'Încă una?', ref: 'R2' });
  l.perle = ['doar una'];
  l.rezumat_telegram = ['unu', 'doi'];
  const e = errorsOf(l);
  assert.ok(e.some((m) => /quiz: 4 întrebări \(trebuie exact 3\)/.test(m)));
  assert.ok(e.some((m) => /perle/.test(m)));
  assert.ok(e.some((m) => /rezumat_telegram/.test(m)));
});

test('rejects telegram bullets over 25 words and Markdown/HTML in strings', () => {
  const l = sample();
  l.rezumat_telegram[0] = Array(26).fill('cuvânt').join(' ');
  l.context = 'Text cu **bold** și <b>tag</b>.';
  const e = errorsOf(l);
  assert.ok(e.some((m) => /rezumat_telegram\[0\]: 26 cuvinte/.test(m)));
  assert.ok(e.some((m) => /context: conține Markdown\/HTML/.test(m)));
});

test('section count, section bounds and explicatii refs are checked', () => {
  const l = sample();
  l.sectiuni = l.sectiuni.slice(0, 1);
  assert.ok(errorsOf(l).some((m) => /sectiuni: 1/.test(m)));
  const l2 = sample();
  l2.sectiuni[0].explicatii[0].ref = 'R20'; // exists, but in another section
  assert.ok(errorsOf(l2).some((m) => /R20 nu este în secțiunea aceasta/.test(m)));
});

test('ROUND6: an explanation over 40 words is an error; LLM text over 450 words only a warning', () => {
  const l = sample();
  l.sectiuni[0].explicatii[0].text = Array(41).fill('cuvânt').join(' ');
  assert.ok(errorsOf(l).some((m) => /explicație prea lungă \(41 cuvinte, max 40\) pentru R2/.test(m)));
  l.sectiuni[0].explicatii[0].text = Array(40).fill('cuvânt').join(' ');
  assert.ok(!errorsOf(l).some((m) => /explicație prea lungă/.test(m)));
  const r = validateLesson(unit, sample()); // the frozen fixture lesson writes 489 words
  assert.ok(r.warnings.some((w) => /textul scris de LLM are 489 cuvinte \(> 450/.test(w)), r.warnings.join('|'));
});

// ---- SPEC-ROUND2 §1.3–1.4: paragraph references and the prose coverage rule ----
const prose = readFixtureJson('unit-01-1.json');
const proseSample = () => readFixtureJson('sample-lesson-01-1.json');
const proseErrors = (l) => validateLesson(prose, l).errors;

test('prose unit is flagged, and the hand-written 01-1 lesson passes with its coverage reported', () => {
  assert.equal(prose.proza, true);
  assert.ok(prose.blocuri.some((b) => b.tip === 'paragraf' && /^P\d+$/.test(b.id) && b.cuvinte > 0));
  const r = validateLesson(prose, proseSample());
  assert.deepEqual(r.errors, []);
  assert.ok(r.info.proza.pct >= 60 && r.info.proza.pct < 100, `${r.info.proza.pct}`);
});

test('prose unit: coverage under 60 % fails, with the percentage in the message', () => {
  const l = proseSample();
  l.sectiuni = l.sectiuni.slice(0, 2);
  l.sectiuni[0].recomandari = ['P6'];
  l.sectiuni[1].recomandari = ['P10'];
  for (const s of l.sectiuni) { s.explicatii = s.explicatii.filter((e) => ['P6', 'P10'].includes(e.ref)); }
  const e = proseErrors(l);
  assert.ok(e.some((m) => /acoperire proză insuficientă: \d+\.\d %/.test(m)), e.join('\n'));
});

test('prose unit: a paragraph referenced twice fails; an unknown P id fails', () => {
  const l = proseSample();
  l.sectiuni[1].recomandari.push('P6');
  l.sectiuni[0].recomandari.push('P999');
  const e = proseErrors(l);
  assert.ok(e.some((m) => /P6 apare de două ori/.test(m)));
  assert.ok(e.some((m) => /id inexistent în unitate: P999/.test(m)));
});

test('prose unit: Standard/Recomandare coverage does not apply, quiz/explicatii refs may be P ids', () => {
  const l = proseSample();
  assert.ok(l.quiz.every((q) => /^P/.test(q.ref)));
  l.quiz[0].ref = 'R1'; // no rows in a prose unit
  assert.ok(proseErrors(l).some((m) => /quiz\[0\]\.ref: id inexistent/.test(m)));
});

test('row unit: P references are optional, but still at most once', () => {
  const l = sample();
  assert.ok(l.sectiuni[0].recomandari.includes('P3'));
  l.sectiuni[1].recomandari.push('P3');
  assert.ok(errorsOf(l).some((m) => /P3 apare de două ori/.test(m)));
  const l2 = sample();
  l2.sectiuni[0].recomandari = l2.sectiuni[0].recomandari.filter((id) => id !== 'P3');
  assert.deepEqual(errorsOf(l2), [], 'dropping the optional P3 is fine');
});

test('row unit: the 100 % rule still ignores the prose percentage', () => {
  const l = sample();
  l.sectiuni[0].recomandari = ['P3'];
  const e = errorsOf(l);
  assert.ok(e.some((m) => /acoperire incompletă/.test(m)));
  assert.ok(!e.some((m) => /proză/.test(m)));
});
