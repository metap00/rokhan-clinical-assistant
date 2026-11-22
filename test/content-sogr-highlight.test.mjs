import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightHtml, numUnitPairs } from '../server/lessons/sogr/highlight.mjs';

const marks = (s) => [...highlightHtml(s).matchAll(/<mark>(.*?)<\/mark>/g)].map((m) => m[1]);

test('"oxitocină 10 UI i.m." marks 10 UI only', () => {
  assert.deepEqual(marks('oxitocină 10 UI i.m.'), ['10 UI']);
  assert.equal(highlightHtml('oxitocină 10 UI i.m.'), 'oxitocină <mark>10 UI</mark> i.m.');
});

test('section numbers, page numbers and row ids are untouched', () => {
  assert.deepEqual(marks('vezi 6.3.1 și 6.1.1.1, p. 7, R12, Anexa 3'), []);
  assert.deepEqual(marks('(vezi 6.1.2.1.2.) asociat cu R12 la p. 13'), []);
});

test('ranges, thousands separators, percentages, comparators', () => {
  assert.deepEqual(marks('pierdere de 500-1.000 ml (10-15% din masa) la >500 ml'), ['500-1.000 ml', '10-15%', '&gt;500 ml']);
  assert.deepEqual(marks('TA 80–100 mmHg, la ≥ 2 ore'), ['80–100 mmHg', '≥ 2 ore']);
});

test('weeks of pregnancy and compound units', () => {
  assert.deepEqual(marks('la 34 s.a. sau 37 de săptămâni'), ['34 s.a.', '37 de săptămâni']);
  assert.deepEqual(marks('75 ml/kg și 5 mg/kg; 1g în 10 minute'), ['75 ml/kg', '5 mg/kg', '1g', '10 minute']);
});

test('words that merely start with a unit letter are not marked; HTML is escaped', () => {
  assert.deepEqual(marks('5 mai, 3 mare, 2 grupe'), []);
  assert.equal(highlightHtml('a < b & 5 g'), 'a &lt; b &amp; <mark>5 g</mark>');
});

test('numUnitPairs canonicalises thousands, ranges and unit variants', () => {
  assert.deepEqual(numUnitPairs('500-1.000 ml, 1 săptămână, 2 ore').map((p) => p.key), ['500-1000|ml', '1|sapt', '2|h']);
  assert.deepEqual(numUnitPairs('1000 mL').map((p) => p.key), ['1000|ml']);
});

// ---- SPEC-ROUND2 §3 ----
test('new units: time, rates, concentrations, daily doses', () => {
  assert.deepEqual(marks('≥ 2 secunde, 5 sec, 120 bătăi/min, 18 respirații/min, >120/min'), ['≥ 2 secunde', '5 sec', '120 bătăi/min', '18 respirații/min', '&gt;120/min']);
  assert.deepEqual(marks('2 l/min, 30 ml/min, 60 ml/h, 5 µg/kg/min, 5 mcg/kg/min, 4 mg/dl, 12 g/dl, 3 g/l, 5 mmol/l'),
    ['2 l/min', '30 ml/min', '60 ml/h', '5 µg/kg/min', '5 mcg/kg/min', '4 mg/dl', '12 g/dl', '3 g/l', '5 mmol/l']);
  assert.deepEqual(marks('10 UI/ml, 2 mUI/ml, 3 ng/ml, 7 pg/ml, 1 cm/oră, 1 cm/h, 500 kcal, 10 mg/zi, 2 g/zi, 40 UI/zi'),
    ['10 UI/ml', '2 mUI/ml', '3 ng/ml', '7 pg/ml', '1 cm/oră', '1 cm/h', '500 kcal', '10 mg/zi', '2 g/zi', '40 UI/zi']);
});

test('risk fractions and gestational ages', () => {
  assert.deepEqual(marks('risc 1/1.000, 1/50 și 1/10 000; dar 1/2 nu'), ['1/1.000', '1/50', '1/10 000']);
  assert.deepEqual(marks('între 11-13+6 săptămâni sau la 13+6, 14+0'), ['11-13+6 săptămâni', '13+6', '14+0']);
});

test('still no marks in p. N, ids, section numbers, years, citation numbers', () => {
  assert.deepEqual(marks('(2,13) 2018 p. 9 [R12] [P7] 6.3.1 Anexa 3, în 2019 (3,4) a apărut'), []);
  assert.deepEqual(marks('vezi p. 12-13 și 7.4.3, studiul din 2018, (11,346,360)'), []);
});

test('numUnitPairs: new kinds canonicalise (bătăi/min = /min, 1/1.000 = 1/1000, ranges)', () => {
  assert.deepEqual(numUnitPairs('120 bătăi/min și >120/min').map((p) => p.key), ['120|/min', '120|/min']);
  assert.deepEqual(numUnitPairs('1/1.000 și 1/10 000').map((p) => p.key), ['1/1000|frac', '1/10000|frac']);
  assert.deepEqual(numUnitPairs('11-13+6 săptămâni').map((p) => p.key), ['11-13+6|ga']);
  assert.deepEqual(numUnitPairs('5 mcg/kg/min').map((p) => p.key), ['5|µg/kg/min']);
});
