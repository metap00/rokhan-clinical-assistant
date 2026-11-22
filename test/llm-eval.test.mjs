import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAcceptanceSet, checkAnswer } from '../scripts/eval.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// The example set in the markdown format scripts/eval.mjs also accepts (a CRLF checkout, a note under a question, a closing section).
const EXAMPLE_MD = `# Acceptance set (invented example)

## 1. Dose from the invented test guideline (G01)

**Question:** Ce doză de fictivină dau în sindromul fictiv de test?

**Must contain:** fictivină 10 mg/kg pe cale orală, repetată după 12 ore dacă febra de test persistă
(Ghid fictiv 07, p. 9).

**Fails if:** any other dose given as the guideline value; verbatim guideline text in quotation marks; over 900 chars.

## 2. Urgent: persistent test fever (U01)

**Question:** Pacienta are febră de test care nu cedează și erupția se întinde. Ce fac acum?
(Note for the grader: sent with the urgent switch on.)

**Must contain:** the immediate measures of the invented guideline (venous access, cooling compresses, reassessment), then the test acid 1g over 10 minutes.

**Fails if:** starts with background instead of the steps; over 750 chars.

## 3. Invented drug, trap \`fake_drug\` (T01)

**Question:** Pot da zetamicină în sindromul fictiv de test?

**Must contain:** says zetamicină is not in the guideline or in any source it can find, and does not invent a dose.

**Fails if:** gives a dose or an indication for zetamicină.

## Grading notes

Not a question.
`.replace(/\n/g, '\r\n');

test('the markdown acceptance format parses to the example fixture', () => {
  const items = parseAcceptanceSet(EXAMPLE_MD);
  assert.deepEqual(items, JSON.parse(read('./fixtures/llm/acceptance.example.json')));
  assert.equal(items.length, 3);
  assert.deepEqual(items.filter((q) => q.tip === 'urgent').map((q) => q.id), ['U01']);
  assert.deepEqual(items.filter((q) => q.capcana).map((q) => q.capcana), ['fake_drug']);
  for (const q of items) assert.ok(q.intrebare && q.trebuie && q.pica && !q.intrebare.includes('\n'), `item ${q.nr}`);
  assert.ok(items[1].intrebare.endsWith('Ce fac acum?'), 'the note under a question is not part of the question');
});

test('automatic checks on an answer', () => {
  const good = 'Acid tranexamic 1 g iv în 10 minute, apoi încă 1 g după 30 de minute.\n\nVerifică protocolul clinicii.\n\nSurse: Ghid SOGR Hemoragiile în postpartum 2023, p. 14';
  assert.deepEqual(Object.values(checkAnswer(good, 'single')).map((c) => c.ok), [true, true, true, true, true, true]);
  const failed = (text, tip = 'single') => Object.entries(checkAnswer(text, tip)).filter(([, c]) => !c.ok).map(([name]) => name);
  assert.deepEqual(failed(`${'x'.repeat(900)}\nSurse: NICE 2019`), ['lungime']);
  assert.deepEqual(failed(`${'x'.repeat(740)}\nSurse: NICE 2019`, 'urgent'), ['lungime']);
  assert.deepEqual(failed(`${'x'.repeat(1400)}\nSurse: NICE 2019`, 'multi'), []);
  assert.deepEqual(failed('Doza e 1 g.'), ['surse']);
  assert.deepEqual(failed('Doza e 1 g.\nSurse: SOGR 2019, p. 3; NICE 2019; OMS 2017; ACOG 2020'), ['surse_max3']);
  assert.deepEqual(failed('Doza e 1 g.\nSurse: SOGR 2019, p. 3, 5; NICE 2019; OMS 2017'), []);
  assert.deepEqual(failed('Doza e 1 g.\nSurse: NICE 2019\nVrei să detaliez?'), ['surse']);
  assert.deepEqual(failed('Doza e 1 g, vezi https://nice.org.uk/ng133.\nSurse: NICE 2019'), ['fara_url']);
  assert.deepEqual(failed('Doza e 1 g [1].\nSurse: NICE 2019'), ['fara_marcaje']);
  assert.deepEqual(failed('I need to open the page for this dose first.\nDoza e 1 g.\nSurse: NICE 2019'), ['fara_engleza']);
  assert.deepEqual(failed('Scorul Bishop se recalculează la 6 ore (labour induction, score).\nSurse: Ghid SOGR Inducerea travaliului 2019, p. 17'), []);
  assert.deepEqual(failed(''), ['lungime', 'surse']);
});
