import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLibrary } from '../server/library/index.mjs';
import { chunkLines, matchQueries } from '../server/library/search.mjs';
import { libraryConfig, tmpDir } from './content-helpers.mjs';

const lib = () => getLibrary(libraryConfig());
const GUIDE1 = 'ghiduri-sogr/01-nasterea-inainte-de-termen.md';

test('guides() lists the book table; the curriculum is a separate entry', () => {
  const g = lib().guides();
  assert.equal(g.length, 2);
  assert.deepEqual(g[0], { nr: '01', titlu: 'Nașterea înainte de termen', versiune: 'revizuit 2024', pagini: 4, fisier: GUIDE1, url: 'https://example.org/01.pdf' });
  const c = lib().curriculum();
  assert.equal(c.nr, 'curriculum');
  assert.equal(c.pagini, 58);
  assert.match(c.fisier, /curriculum-rezidentiat-og-2019/);
});

test('toc() gives sections with pages and line ranges; the number may be 1, "1" or "01"', () => {
  const t = lib().toc('01');
  assert.equal(t.titlu, 'Nașterea înainte de termen');
  assert.equal(t.total, 35);
  assert.deepEqual(t.sectiuni.map((s) => [s.nr, s.titlu, s.pagini, s.linii]), [
    ['1', 'Introducere', '2', [15, 20]],
    ['6.3', 'Administrarea corticoterapiei', '3', [21, 28]],
    ['6.4', 'Tocoliza', '4', [29, 35]],
  ]);
  assert.deepEqual(t.sectiuni[1].ghiduriNoi, [5, 9]);
  assert.equal(t.actualizari, 'ghiduri-sogr/actualizari/01-nasterea-inainte-de-termen.md');
  assert.deepEqual(lib().toc(1), t);
  assert.throws(() => lib().toc('77'), (e) => e.status === 404);
});

test('toc("curriculum") has one section per module file', () => {
  const t = lib().toc('curriculum');
  assert.equal(t.sectiuni.length, 1);
  assert.equal(t.sectiuni[0].fisier, 'curriculum-rezidentiat-og-2019/cap-01-obstetrica-ginecologie.md');
  assert.equal(t.sectiuni[0].pagini, '5');
});

test('readLines is 1-based and inclusive, and clamps to the file', () => {
  const r = lib().readLines(GUIDE1, 21, 23);
  assert.equal(r.from, 21);
  assert.equal(r.to, 23);
  assert.equal(r.total, 35);
  assert.equal(r.text.split('\n').length, 3);
  assert.equal(r.text.split('\n')[0], '6.3 Administrarea corticoterapiei');
  const end = lib().readLines(GUIDE1, 30, 999);
  assert.equal(end.to, 35);
  assert.equal(lib().readLines(GUIDE1, 0, 2).from, 1);
  assert.equal(lib().readLines(GUIDE1, 40, 50).text, '');
  assert.throws(() => lib().readLines(GUIDE1, 5, 2), (e) => e.status === 400);
  assert.throws(() => lib().readLines(GUIDE1, 'x', 2), (e) => e.status === 400);
});

test('readLines returns at most 400 lines per call', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'library', 'ghiduri-sogr'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'library', 'ghiduri-sogr', 'long.md'), Array.from({ length: 1000 }, (_, i) => `linia ${i + 1}`).join('\n') + '\n');
  const l = getLibrary({ dataDir });
  const r = l.readLines('ghiduri-sogr/long.md', 10, 900);
  assert.equal(r.to, 409);
  assert.equal(r.text.split('\n').length, 400);
  assert.equal(r.total, 1000);
  assert.equal(l.readLines('ghiduri-sogr/long.md', 10).to, 409); // no `to`: the same cap
});

test('readLines refuses paths that leave the library folder, and anything that is not Markdown', () => {
  const l = lib();
  const outside = ['../x.md', 'ghiduri-sogr/../../content-library.test.mjs', '../../../../etc/passwd', 'ghiduri-sogr/../../../package.json',
    path.resolve('package.json'), 'C:\\Windows\\win.ini', '/etc/passwd', '..\\x.md'];
  for (const bad of outside) assert.throws(() => l.readLines(bad, 1, 5), (e) => e.status === 403 || e.status === 404, bad);
  assert.throws(() => l.readLines('ghiduri-sogr/_book.txt', 1, 5), (e) => e.status === 403 || e.status === 404);
  assert.throws(() => l.readLines('', 1, 5), (e) => e.status === 400);
  assert.throws(() => l.readLines('ghiduri-sogr/nu-exista.md', 1, 5), (e) => e.status === 404);
});

const hit = (q, opts) => lib().search(q, opts);

test('search finds diacritic text typed without diacritics', () => {
  const h = hit('nastere inainte de termen');
  assert.ok(h.length > 0);
  assert.equal(h[0].nr, '01');
  assert.match(h[0].fragment, /<mark>/);
  assert.ok(hit('corticoterapia betametazona').some((x) => x.sectiune === '6.3 Administrarea corticoterapiei'));
});

test('search folds the old cedilla forms both ways', () => {
  // the fixture text has "şi ţesutul" (cedilla); the query uses comma forms and plain letters
  assert.ok(hit('și țesutul cicatriceal').some((x) => x.nr === '01'));
  assert.ok(hit('si tesutul').some((x) => x.nr === '01'));
  // the fixture has "nașterea" (comma); the query is typed with cedilla
  assert.ok(hit('naşterea').length > 0);
  assert.ok(hit('NAȘTEREA').length > 0);
  // curriculum text has "naşteri" (cedilla)
  assert.ok(hit('nasteri vaginale').some((x) => x.nr === 'curriculum'));
});

test('search is typo tolerant at the end of a long word (prefix and stem)', () => {
  assert.ok(hit('corticoterapi').some((x) => x.nr === '01')); // cut short: prefix
  assert.ok(hit('travaliul').some((x) => x.fragment.includes('<mark>Travaliul</mark>'))); // longer than the indexed word: stem
  assert.ok(hit('tocolitic').length > 0);
});

test('search ANDs the terms and falls back to OR when nothing has them all', () => {
  const and = hit('placenta distanta');
  assert.ok(and.length > 0 && and.every((x) => x.nr === '02'));
  // betametazona is only in guide 01, "praevia" only in guide 02: no chunk has both, so OR returns both guides
  const or = hit('betametazona praevia');
  assert.deepEqual([...new Set(or.map((x) => x.nr))].sort(), ['01', '02']);
});

test('search drops stop words of a typed question and ignores FTS operators and punctuation', () => {
  const g = ['"doza"', '("oxitocina"* OR "oxitoci"*)', '("travaliu"* OR "traval"*)'];
  assert.deepEqual(matchQueries('ce doza de oxitocina se da in travaliu?'), [g.join(' AND '), g.join(' OR ')]);
  assert.deepEqual(matchQueries('de la'), ['"de" AND "la"', '"de" OR "la"']); // only stop words: keep what was typed
  assert.deepEqual(matchQueries('ş ţ'), []); // one-letter noise is dropped
  assert.doesNotThrow(() => hit('"corticoterapia" AND OR NOT ( ) * NEAR/2 -x ^y :z'));
  assert.ok(hit('"corticoterapia" AND OR NOT ( )').length > 0);
  assert.deepEqual(hit(''), []);
  assert.deepEqual(hit('   ?!  '), []);
  assert.deepEqual(hit(undefined), []);
});

test('search fragments are HTML-escaped; only our <mark> is markup', () => {
  const h = hit('tocoliza valoarea');
  assert.ok(h.length > 0);
  const f = h.map((x) => x.fragment).join('\n');
  assert.match(f, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(f, /&lt;b&gt;risc&lt;\/b&gt;/);
  assert.match(f, /TA &lt; 90 &amp;/);
  const withoutMarks = f.replaceAll('<mark>', '').replaceAll('</mark>', '');
  assert.doesNotMatch(withoutMarks, /<|>/);
});

test('search hits carry file, guide, section, page and line range; ghid filters; contents lists are not indexed', () => {
  const h = hit('tocoliza', { ghid: '01' });
  const x = h[0];
  assert.equal(x.fisier, GUIDE1);
  assert.equal(x.nr, '01');
  assert.equal(x.titlu, 'Nașterea înainte de termen');
  assert.equal(x.sectiune, '6.4 Tocoliza');
  assert.equal(x.pagina, 4);
  assert.ok(x.linii[0] >= 29 && x.linii[1] <= 35, String(x.linii));
  // the text of a hit is really on those lines
  assert.match(lib().readLines(x.fisier, x.linii[0], x.linii[1]).text, /Tocoliza/);
  assert.deepEqual(hit('placenta', { ghid: '01' }), []);
  assert.deepEqual(hit('tocoliza', { ghid: 2 }), []);
  assert.deepEqual(hit('cuprins'), []); // the contents page of the guide and the cuprins/ folder are skipped
  const upd = hit('PTB-19 corticosteroizi').find((s) => s.fisier.includes('actualizari/'));
  assert.ok(upd, 'the actualizari file is indexed');
  assert.equal(upd.sectiune, '6.3 Administrarea corticoterapiei');
  assert.equal(hit('baremul cezariene')[0].sectiune, 'Modulul 1: Obstetrică-Ginecologie, Pregătirea de bază');
  assert.equal(hit('baremul cezariene')[0].pagina, 5);
});

test('search limit is honoured', () => {
  assert.equal(hit('termen', { limit: 1 }).length, 1);
  assert.ok(hit('sarcina naștere termen placenta', { limit: 2 }).length <= 2);
});

test('chunks: paragraph blocks of about 800-1500 characters, never across a heading or a section start', () => {
  const para = (w) => Array.from({ length: 22 }, () => w).join(' ') + '.'; // ~150 chars
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(para(`cuvant${i}`), '');
  lines.splice(20, 0, '## Titlu nou', '');
  const sectionB = 60;
  const chunks = chunkLines(lines, [{ from: 1, label: 'A' }, { from: sectionB, label: 'B' }]);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.text.length <= 1950, `${c.text.length}`);
  assert.ok(chunks.filter((c) => c.text.length >= 800).length >= chunks.length - 3);
  const h = lines.indexOf('## Titlu nou') + 1;
  for (const c of chunks) assert.ok(!(c.l1 < h && c.l2 >= h), `chunk ${c.l1}-${c.l2} crosses the heading at ${h}`);
  for (const c of chunks) assert.ok(!(c.l1 < sectionB && c.l2 >= sectionB), `chunk ${c.l1}-${c.l2} crosses the section start at ${sectionB}`);
  assert.deepEqual(new Set(chunks.map((c) => c.sectiune)), new Set(['A', 'B']));
  // a single paragraph over 1500 characters is cut at line boundaries
  const long = Array.from({ length: 30 }, (_, i) => `linie lunga ${i} ${'x'.repeat(100)}`);
  assert.ok(chunkLines(long).length >= 2);
  assert.ok(chunkLines(long).every((c) => c.text.length <= 1500));
});

test('the index builds from the fixture quickly and reports its size', () => {
  const info = lib().indexInfo();
  assert.ok(info.chunks >= 6);
  assert.ok(info.ms < 3000);
});
