import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../web/lib/sse.js';
import { splitBlocks, cleanGuideText } from '../web/lib/blocks.js';
import { dumFromDpn, dpnFromDum, dumFromEco, gaOn, gaLabel } from '../web/lib/ga.js';
import fs from 'node:fs';
import { containsCnp } from '../web/lib/cnp.js';
import { VECTORS as CNP_VECTORS } from './h1-cnp.test.mjs'; // the server's own list (importing it also runs its test here)
import { addDays, daysBetween, dayLabel, longDate, countWord, monthRange, isIsoDate } from '../web/lib/format.js';

test('sse: frames split across chunks, comments, JSON and plain data', () => {
  const feed = createSseParser();
  assert.deepEqual(feed(': hb\n\nevent: start\ndata: {"a":'), []);
  assert.deepEqual(feed('1}\n\nevent: delta\ndata: {"text":"Bună\\n"}\n\n'), [
    { event: 'start', data: { a: 1 } },
    { event: 'delta', data: { text: 'Bună\n' } },
  ]);
  assert.deepEqual(feed('data: plain\ndata: two\n\nevent: clear\ndata: {}\n'), [{ event: 'message', data: 'plain\ntwo' }]);
  assert.deepEqual(feed('\n'), [{ event: 'clear', data: {} }]);
});

test('blocks: mermaid and svg fences, other fences stay Markdown, Surse line split off', () => {
  const text = 'Intro **bold**\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\n```js\nconst x = "```mermaid";\n```\n\n~~~svg\n<svg/>\n~~~\nGata.\nSurse: SOGR, p. 3.';
  const out = splitBlocks(text);
  assert.deepEqual(out.map((s) => s.type), ['md', 'mermaid', 'md', 'svg', 'md', 'sources']);
  assert.equal(out[1].code, 'flowchart TD\n  A-->B');
  assert.equal(out[1].open, false);
  assert.match(out[2].text, /```js/);
  assert.equal(out[3].code, '<svg/>');
  assert.equal(out[4].text, 'Gata.');
  assert.equal(out[5].text, 'Surse: SOGR, p. 3.');
});

test('blocks: an unclosed diagram while streaming, bold Surse, no Surse', () => {
  const s = splitBlocks('Text\n```mermaid\nflowchart');
  assert.deepEqual(s.at(-1), { type: 'mermaid', code: 'flowchart', open: true });
  assert.equal(splitBlocks('A\n\n**Surse:** ghid\n\n').at(-1).type, 'sources');
  assert.deepEqual(splitBlocks('Doar text.'), [{ type: 'md', text: 'Doar text.' }]);
  assert.deepEqual(splitBlocks('Surse: x'), [{ type: 'sources', text: 'Surse: x' }]);
  assert.deepEqual(splitBlocks(''), []);
});

test('cleanGuideText: indents and column spaces flattened, page markers left for rendering', () => {
  assert.equal(
    cleanGuideText('4       STRUCTURĂ\n              termen (NpT)  la o\n[p. 14]\nvezi [p. 6–7]'),
    '4 STRUCTURĂ\ntermen (NpT) la o\n[p. 14]\nvezi [p. 6–7]',
  );
});

test('gestational age: DPN = DUM + 280, scan dating, weeks and days', () => {
  assert.equal(dpnFromDum('2026-03-01'), '2026-12-06');
  assert.equal(dumFromDpn('2026-12-06'), '2026-03-01');
  assert.deepEqual(gaOn('2026-03-01', '2026-11-22'), { total: 266, weeks: 38, days: 0 });
  assert.deepEqual(gaOn('2026-03-01', '2026-03-10'), { total: 9, weeks: 1, days: 2 });
  assert.equal(dumFromEco('2026-06-10', 12, 3), addDays('2026-06-10', -87));
  assert.deepEqual(gaOn(dumFromEco('2026-06-10', 12, 3), '2026-06-10'), { total: 87, weeks: 12, days: 3 });
  assert.equal(gaOn('2026-03-10', '2026-03-01').total, -9);
  assert.equal(gaLabel({ weeks: 38, days: 0 }), '38 de săptămâni și 0 zile');
  assert.equal(gaLabel({ weeks: 12, days: 1 }), '12 săptămâni și 1 zi');
  assert.equal(gaLabel({ weeks: 1, days: 3 }), '1 săptămână și 3 zile');
});

test('format: days, labels, Romanian counts, month ranges, date check', () => {
  assert.equal(daysBetween('2026-10-30', '2026-11-02'), 3);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(dayLabel('2026-11-22', '2026-11-22'), 'azi');
  assert.equal(dayLabel('2026-11-21', '2026-11-22'), 'ieri');
  assert.equal(dayLabel('2026-10-20', '2026-11-22'), '20 octombrie');
  assert.equal(longDate('2025-01-03', '2026-11-22'), '3 ianuarie 2025');
  assert.equal(countWord(1, 'copil', 'copii'), '1 copil');
  assert.equal(countWord(14, 'copil', 'copii'), '14 copii');
  assert.equal(countWord(24, 'copil', 'copii'), '24 de copii');
  assert.equal(countWord(100, 'copil', 'copii'), '100 de copii');
  assert.equal(countWord(105, 'copil', 'copii'), '105 copii');
  assert.deepEqual(monthRange('2026-11-22'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(monthRange('2026-01-15', -1), { from: '2025-12-01', to: '2025-12-31' });
  assert.ok(isIsoDate('2026-02-28'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('22.11.2026'));
});

test('registru: pending entries count like the server, milestones', async () => {
  const { withPending, milestoneCrossed } = await import('../web/lib/registru.js');
  const base = {
    copii: { total: 24, vaginale: 14, cezariene: 10, primul: '2026-10-20' },
    rows: [{ id: 'nastere-vaginala', nume: 'Naștere vaginală', barem: '50', tinta: 50, efectuat: 14, ajutat: 0, observat: 0 },
      { id: 'cezariana', nume: 'Cezariană', barem: '20', tinta: 20, efectuat: 10, ajutat: 0, observat: 0 }],
    entries: [{ id: 'a', date: '2026-11-21', row: 'cezariana', rol: 'efectuat', n: 1, copii: 1 }],
    urmatorulPrag: 25,
  };
  const s = withPending(base, { id: 't1', body: { row: 'nastere-vaginala', rol: 'efectuat', n: 1, copii: 2, date: '2026-11-22' } }, '2026-11-22');
  assert.deepEqual(s.copii, { total: 26, vaginale: 16, cezariene: 10, primul: '2026-10-20' });
  assert.equal(s.rows[0].efectuat, 15);
  assert.equal(s.entries[0].id, 't1');
  assert.equal(s.urmatorulPrag, 50);
  const h = withPending(base, { id: 't2', body: { row: 'cezariana', rol: 'ajutat', n: 2 } }, '2026-11-22');
  assert.equal(h.copii.total, 24);
  assert.equal(h.rows[1].ajutat, 2);
  const n = withPending(base, { id: 't3', body: { row: 'Amniocenteză', rol: 'observat' } }, '2026-11-22');
  assert.equal(n.rows.at(-1).observat, 1);
  assert.equal(milestoneCrossed(24, 26), 25);
  assert.equal(milestoneCrossed(0, 1), 1);
  assert.equal(milestoneCrossed(9, 30), 25);
  assert.equal(milestoneCrossed(26, 27), null);
});

test('crop: drag clamps to the image and keeps a minimum size, output long side ≤ 1600', async () => {
  const { applyDrag, cropPlan, MIN, FULL } = await import('../web/lib/crop.js');
  assert.deepEqual(cropPlan(FULL, 800, 600), { sx: 0, sy: 0, sw: 800, sh: 600, w: 800, h: 600 }); // default keeps the whole picture
  assert.deepEqual(applyDrag(FULL, 'nw', 0.2, 0.2), { x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
  const r = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  assert.deepEqual(applyDrag(r, 'move', 0.5, -0.5), { x: 0.19999999999999996, y: 0, w: 0.8, h: 0.8 });
  const se = applyDrag(r, 'se', -2, -2);
  assert.ok(Math.abs(se.w - MIN) < 1e-9 && Math.abs(se.h - MIN) < 1e-9);
  assert.deepEqual(applyDrag(r, 'nw', -1, -1), { x: 0, y: 0, w: 0.9, h: 0.9 });
  assert.deepEqual(cropPlan({ x: 0, y: 0, w: 1, h: 1 }, 4000, 3000), { sx: 0, sy: 0, sw: 4000, sh: 3000, w: 1600, h: 1200 });
  assert.deepEqual(cropPlan({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, 800, 600), { sx: 400, sy: 300, sw: 200, sh: 300, w: 200, h: 300 });
});

test('cnp: the browser copy is the server file, and passes the server vectors', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read('../web/lib/cnp.js'), read('../server/store/cnp.mjs'));
  assert.ok(CNP_VECTORS.length >= 24);
  for (const [text, want] of CNP_VECTORS) assert.equal(containsCnp(text), want, JSON.stringify(text));
});
