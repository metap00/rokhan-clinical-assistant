// The reading checklist of the guideline library and "Continuă de unde ai rămas".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, makeConfig } from './core-helpers.mjs';
import { FIXTURES } from './content-helpers.mjs';
import { getCitit, sectionKeys } from '../server/store/citit.mjs';

// A throw-away data directory with the library fixtures: guides 01 (3 sections), 02 (2 sections), the curriculum.
function libraryData() {
  const config = makeConfig();
  fs.cpSync(path.join(FIXTURES, 'library'), path.join(config.dataDir, 'library'), { recursive: true });
  return config;
}
const stored = (config) => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'ghiduri-citite.json'), 'utf8'));

test('section keys: number and title without diacritics, the file for a module, repeats numbered', () => {
  assert.deepEqual(sectionKeys({ sectiuni: [{ nr: '1', titlu: 'Conduită' }, { nr: '', titlu: 'Anexe' }, { nr: '', titlu: 'Anexe' }, { nr: '01', titlu: 'x', fisier: 'curr/cap-01-og.md' }] }),
    ['1|conduita', '|anexe', '|anexe#2', 'cap-01-og.md']);
});

test('summary: nothing read at first; the overall count is of the SOGR guides, the curriculum has its own', () => {
  const s = getCitit(libraryData()).summary();
  assert.deepEqual([s.citite, s.total, s.ultima], [0, 2, null]);
  assert.deepEqual(s.ghiduri['01'], { citit: false, sectiuni: 3, bifate: 0 });
  assert.deepEqual(s.ghiduri.curriculum, { citit: false, sectiuni: 1, bifate: 0 });
});

test('ticking: the last section ticks the guide, unticking one unticks it, unticking the guide keeps the sections', () => {
  const config = libraryData();
  const c = getCitit(config);
  assert.deepEqual(c.tick('01', { sectiune: 0, citita: true }), { citit: false, sectiuni: [true, false, false] });
  c.tick('01', { sectiune: 1, citita: true });
  assert.deepEqual(c.tick('01', { sectiune: 2, citita: true }), { citit: true, sectiuni: [true, true, true] });
  assert.equal(c.summary().citite, 1);
  assert.deepEqual(c.tick('01', { sectiune: 1, citita: false }), { citit: false, sectiuni: [true, false, true] });
  assert.deepEqual(c.tick('01', { citit: true }), { citit: true, sectiuni: [true, false, true] });
  assert.deepEqual(c.tick('01', { citit: false }), { citit: false, sectiuni: [true, false, true] });
  c.tick('curriculum', { citit: true });
  assert.equal(c.summary().citite, 0, 'the curriculum is not one of the guides');
  c.tick('1', { citit: true }); // "1" is guide "01"
  assert.deepEqual(Object.keys(stored(config).ghiduri).sort(), ['01', 'curriculum']);
});

test('ticks and the position are refused for an unknown guide, a missing section or a bad body', () => {
  const c = getCitit(libraryData());
  assert.throws(() => c.tick('99', { citit: true }), (e) => e.status === 404);
  for (const body of [{}, { citit: 'da' }, { sectiune: 3, citita: true }, { sectiune: -1, citita: true }, { sectiune: '0', citita: true }, { sectiune: 0 }]) {
    assert.throws(() => c.tick('01', body), (e) => e.status === 400, JSON.stringify(body));
  }
  for (const body of [{ nr: '01', sectiune: 9 }, { nr: '01' }, { nr: '01', sectiune: 0, scroll: 'jos' }]) {
    assert.throws(() => c.setLast(body), (e) => e.status === 400, JSON.stringify(body));
  }
  assert.throws(() => c.setLast({ nr: '99', sectiune: 0 }), (e) => e.status === 404);
});

test('the last place: guide, section and scroll between 0 and 1', () => {
  const c = getCitit(libraryData());
  c.setLast({ nr: '01', sectiune: 1, scroll: 0.42 });
  assert.deepEqual(c.summary().ultima, { nr: '01', titlu: 'Nașterea înainte de termen', sectiune: 1, sectiuneTitlu: 'Administrarea corticoterapiei', sectiuneNr: '6.3', scroll: 0.42 });
  c.setLast({ nr: '02', sectiune: 0, scroll: 7 });
  assert.deepEqual([c.summary().ultima.nr, c.summary().ultima.scroll], ['02', 1]);
});

test('a re-imported library: ticks and the position follow the section, not its place in the list', () => {
  const config = libraryData();
  const c = getCitit(config);
  c.tick('01', { sectiune: 1, citita: true });
  c.setLast({ nr: '01', sectiune: 1, scroll: 0.5 });
  const toc = path.join(config.dataDir, 'library', 'ghiduri-sogr', 'cuprins', '01-nasterea-inainte-de-termen.md');
  // a new section appears before the one she read (toc files are read again on every call)
  fs.writeFileSync(toc, fs.readFileSync(toc, 'utf8').replace('| 6.3 |', '| 2 | Diagnostic | 2 | 15–16 |  |\n| 6.3 |'));
  assert.deepEqual(c.guide('01').sectiuni, [false, false, true, false]);
  assert.equal(c.summary().ultima.sectiune, 2);
  // the section disappears: the position falls back to the guide, the tick no longer counts
  fs.writeFileSync(toc, fs.readFileSync(toc, 'utf8').replace(/\| 6\.3 \|.*\n/, ''));
  assert.deepEqual([c.summary().ultima.sectiune, c.summary().ultima.nr, c.summary().ghiduri['01'].bifate], [null, '01', 0]);
});

test('no library yet: an empty summary, nothing breaks', () => {
  assert.deepEqual(getCitit(makeConfig()).summary(), { citite: 0, total: 0, ghiduri: {}, ultima: null });
});

test('routes: login required, ticks and position are stored and survive a restart, the guide files are untouched', async (t) => {
  const config = libraryData();
  const guide = path.join(config.dataDir, 'library', 'ghiduri-sogr', '01-nasterea-inainte-de-termen.md');
  const before = fs.readFileSync(guide, 'utf8');
  const first = await boot({ dataDir: config.dataDir });
  t.after(() => first.close());
  for (const [m, p] of [['GET', '/api/citit'], ['PUT', '/api/citit'], ['GET', '/api/citit/01'], ['PUT', '/api/citit/01']]) {
    assert.equal((await first.api(m, p)).status, 401, `${m} ${p}`);
  }
  await first.login();
  assert.deepEqual((await first.api('PUT', '/api/citit/02', { citit: true })).json, { citit: true, sectiuni: [false, false] });
  assert.deepEqual((await first.api('PUT', '/api/citit', { nr: '01', sectiune: 2, scroll: 0.25 })).json, { ok: true });
  assert.equal((await first.api('GET', '/api/citit/99')).status, 404);
  assert.equal((await first.api('PUT', '/api/citit', {})).status, 404);
  await first.close();

  const second = await boot({ dataDir: config.dataDir });
  t.after(() => second.close());
  await second.login();
  const s = (await second.api('GET', '/api/citit')).json;
  assert.deepEqual([s.citite, s.total, s.ultima.nr, s.ultima.sectiune, s.ultima.scroll], [1, 2, '01', 2, 0.25]);
  assert.deepEqual((await second.api('GET', '/api/citit/02')).json, { citit: true, sectiuni: [false, false] });
  assert.equal(fs.readFileSync(guide, 'utf8'), before);
});
