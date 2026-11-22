// Review 12 fixes: negated gerunds ("nefiind") and a list header that ends the previous block ("Contraindicații").
import './content-sogr-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateLesson } from '../server/lessons/sogr/lesson.mjs';
import { lexiconWord } from '../server/lessons/sogr/figures.mjs';

const fixtureUnit = (id) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/content/sogr/units/${id}.json`, import.meta.url)), 'utf8'));
const cifraErrors = (unit, ref, eticheta, valoare) => {
  const l = { schema: 3, unit: unit.id, cifre: [{ eticheta, ref, valoare }] };
  return validateLesson(unit, l).errors.filter((e) => e.startsWith('cifre[0]'));
};

test('negated gerunds are restriction words; ordinary ne- words are not', () => {
  for (const w of ['nefiind', 'neavând', 'neexistând', 'neputând', 'nemaifiind']) assert.ok(lexiconWord(w), w);
  for (const w of ['nevoie', 'necesar', 'neonatal', 'nefracționată']) assert.equal(lexiconWord(w), null, w);
});

test('36-9 R182: "riscul nefiind mai mare după 5 ani" is refused as a cifră', () => {
  const errs = cifraErrors(fixtureUnit('36-9'), 'R182', 'Riscul de erupție albastră după oprirea fictivinei', 'mai mare după 5 ani');
  assert.ok(errs.some((e) => /negație sau restricție/.test(e)), errs.join('\n'));
});

test('38-7 P40: a figure in a list whose header ends the previous block (Contraindicații) is refused', () => {
  const errs = cifraErrors(fixtureUnit('38-7'), 'P40', 'Clearance-ul creatininei pentru tratamentul cu fictiplatină', '≥ 30 ml/min');
  assert.ok(errs.some((e) => /antet cu negație sau restricție din blocul anterior/.test(e)), errs.join('\n'));
});
