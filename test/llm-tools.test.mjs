import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools, memoriePageAllowed, todayIn } from '../server/llm/tools.mjs';
import { FetchError } from '../server/llm/fetch-url.mjs';
import { urlsIn, isKnownHost, createSeen, createProvenance, REFUSAL } from '../server/llm/provenance.mjs';
import { fakeDeps } from './llm-fakes.mjs';

const config = { tz: 'Europe/Bucharest' };
const setup = (fetchUrl = async () => ({ url: 'https://x.test/', kind: 'html', pages: null, chars: 500, text: 'a'.repeat(500), nextOffset: null })) => {
  const deps = fakeDeps();
  const tools = Object.fromEntries(createTools({ config, deps, fetchUrl }).map((t) => [t.name, t]));
  return { deps, tools };
};

test('the tool list is exactly the contract', () => {
  assert.deepEqual(Object.keys(setup().tools), ['ghid_cuprins', 'ghid_citeste', 'biblioteca_cauta', 'deschide_url', 'memorie_citeste', 'memorie_scrie', 'registru_stare', 'registru_adauga', 'registru_modifica', 'registru_sterge', 'lecturi_stare']);
});

test('ghid_cuprins lists the guidelines, then the sections with the newer-guidance column', async () => {
  const { tools } = setup();
  const index = await tools.ghid_cuprins.run({});
  assert.match(index, /17 \| Hipertensiunea asociată sarcinii \| 2019 \| 46 \| ghiduri-sogr\/17-hta\.md/);
  const toc = await tools.ghid_cuprins.run({ ghid: 'ghidul 17' });
  assert.match(toc, /^Ghid SOGR 17: Hipertensiunea asociată sarcinii \(2019\)\. Fișier: ghiduri-sogr\/17-hta\.md \(300 linii\)/);
  assert.match(toc, /6\.1 Conduită în preeclampsie \| p\. 16–18 \| 100–180 \| 12–30/);
  assert.match(toc, /6\.2 Eclampsia \| p\. 23–25 \| 181–260$/m);
  assert.match(toc, /ghiduri-sogr\/actualizari\/17-hta\.md/);
  assert.equal(await tools.ghid_cuprins.run({ ghid: 'curriculum' }), 'Curriculum OG (2019). Un fișier pe modul (modul | pagini | fișier | linii):\n01 Pregătirea de bază | p. 9–16 | curriculum/cap-01.md | 1–378');
  await assert.rejects(tools.ghid_cuprins.run({ ghid: 99 }), /Nu există ghidul/);
});

test('ghid_citeste caps a call at 120 lines and says where to continue', async () => {
  const { tools } = setup();
  const out = await tools.ghid_citeste.run({ fisier: 'library/ghiduri-sogr/17-hta.md', de_la: 100, pana_la: 290 });
  assert.match(out, /liniile 100–219 din 300/);
  assert.ok(out.includes('linia 219') && !out.includes('linia 220\n'));
  assert.match(out, /Continuă de la linia 220/);
  assert.match(await tools.ghid_citeste.run({ fisier: 'ghiduri-sogr/17-hta.md', de_la: 290 }), /Sfârșitul fișierului/);
  assert.equal(await tools.ghid_citeste.run({ fisier: 'ghiduri-sogr/17-hta.md', de_la: 999 }), 'ghiduri-sogr/17-hta.md are doar 300 linii.');
});

test('biblioteca_cauta returns plain passages with file, lines and page', async () => {
  const { tools } = setup();
  const out = await tools.biblioteca_cauta.run({ intrebare: 'sulfat de magneziu antidot', ghid: 17 });
  assert.match(out, /ghiduri-sogr\/17-hta\.md liniile 200–210 \| Ghid 17 .* \| 6\.2 Eclampsia \| p\. 25/);
  assert.match(out, /sulfat de magneziu & reflex patelar/); // marks and entities removed
  assert.match(await tools.biblioteca_cauta.run({ intrebare: 'nimic' }), /Niciun pasaj/);
});

test('memorie: read, list, and the write rules', async () => {
  const { tools, deps } = setup();
  assert.equal(await tools.memorie_citeste.run({ pagina: 'profil' }), 'Rezidenta, rezident anul I.');
  assert.match(await tools.memorie_citeste.run({ pagina: 'surse' }), /goală sau nu există/);
  assert.match(await tools.memorie_citeste.run({}), /Pagini: profil/);
  await tools.memorie_scrie.run({ pagina: 'subiect-preeclampsie', continut: '# Preeclampsie' });
  assert.equal(deps.memorie.store.get('subiect-preeclampsie'), '# Preeclampsie');
  await assert.rejects(tools.memorie_scrie.run({ pagina: 'registru', continut: 'x' }), /nu e permisă/);
  await assert.rejects(tools.memorie_scrie.run({ pagina: 'profil', continut: '   ' }), /gol/);
  await assert.rejects(tools.memorie_scrie.run({ pagina: 'profil', continut: 'ă'.repeat(10_241) }), /20 KB/);
  for (const ok of ['profil', 'plan-de-studiu', 'jurnal-de-studiu', 'surse', 'intrebari-deschise', 'corectii', 'subiect-rh-2']) assert.ok(memoriePageAllowed(ok), ok);
  for (const bad of ['subiect-', 'Profil', '../profil', 'subiect-ă', 'secret']) assert.ok(!memoriePageAllowed(bad), bad);
});

test('registru_adauga defaults to efectuat today and reports the new totals and the milestone', async () => {
  const { tools, deps } = setup();
  const out = await tools.registru_adauga.run({ procedura: 'nastere vaginala' });
  assert.match(out, new RegExp(`Adăugat: e1 \\| ${todayIn(config.tz)} \\| Naștere vaginală \\| efectuat \\| 1`));
  assert.match(out, /Naștere vaginală: efectuat 1, ajutat 0, observat 0 \(barem 50\)/);
  assert.match(out, /Copii aduși pe lume: 1 \(1 din nașteri vaginale, 0 din cezariene\)/);
  assert.match(out, /Prag atins: 1 copil adus pe lume/);
  const twins = await tools.registru_adauga.run({ procedura: 'Cezariană', copii: 2, data: '2026-11-20' });
  assert.match(twins, /2026-11-20 \| Cezariană \| efectuat \| 1 \| copii 2/);
  assert.match(twins, /Copii aduși pe lume: 3/);
  assert.ok(!twins.includes('Prag atins'));
  assert.equal(deps.registru.summary().entries.length, 2);
});

test('registru_modifica moves babies out of the counter, registru_sterge removes the entry', async () => {
  const { tools } = setup();
  await tools.registru_adauga.run({ procedura: 'Cezariană' });
  const changed = await tools.registru_modifica.run({ id: 'e1', rol: 'ajutat' });
  assert.match(changed, /Cezariană: efectuat 0, ajutat 1/);
  assert.match(changed, /Copii aduși pe lume: 0/);
  await assert.rejects(tools.registru_modifica.run({ id: 'e1' }), /Nimic de schimbat/);
  assert.match(await tools.registru_sterge.run({ id: 'e1' }), /Șters: e1\.\nCezariană: efectuat 0, ajutat 0/);
  const empty = await tools.registru_stare.run({});
  assert.match(empty, /^2 rânduri .*\n- Naștere vaginală: 0, 0, 0, barem 50\n- Cezariană: 0, 0, 0, barem 20\nNicio intrare încă\.$/m);
  assert.ok(!empty.includes('Ultimele intrări'), 'no entries header over an empty list');
  await tools.registru_adauga.run({ procedura: 'Cezariană', data: '2026-11-20' });
  await tools.registru_modifica.run({ id: 'e2', nota: 'n'.repeat(200) });
  assert.match(await tools.registru_stare.run({}), /Ultimele intrări .*\n- e2 \| 2026-11-20 \| Cezariană \| efectuat \| 1 \| copii 1 \| n{80}…$/);
});

test('store error codes reach the model as sentences', async () => {
  const { tools } = setup();
  await assert.rejects(tools.registru_adauga.run({ procedura: 'Cezariană', data: '2031-01-01' }), /Data e în viitor/);
  await assert.rejects(tools.registru_sterge.run({ id: 'nu-exista' }), /Nu există/);
  await assert.rejects(tools.ghid_citeste.run({ fisier: '../registru.json', de_la: 1 }), /nu e un fișier din bibliotecă/);
  await assert.rejects(tools.ghid_citeste.run({ fisier: 'ghiduri-sogr/lipsa.md', de_la: 1 }), /Nu există/);
});

test('lecturi_stare gives the next lesson and the progress', async () => {
  const out = await setup().tools.lecturi_stare.run({});
  assert.match(out, /Următoarea lectură: 14-1, Ghid 14 Anestezia în obstetrică, partea 1 din 5: Analgezia la naștere \(scrisă, 7 min\)/);
  assert.match(out, /Citite: 7 din 18\.\nGhiduri începute \(nr: citite\/total\): 13: 4\/10\.\nUltimele citite: 13-4 Mastita \(2026-11-21\)$/);
});

test('deschide_url formats the slice and turns a fetch failure into a clear error', async () => {
  const ok = setup(async () => ({ url: 'https://x.test/a.pdf', kind: 'pdf', pages: 30, chars: 90_000, text: '[p. 1]\n'.padEnd(400, 'x'), nextOffset: 12_000 }));
  assert.match(await ok.tools.deschide_url.run({ url: 'https://x.test/a.pdf' }), /^\[sursa: https:\/\/x\.test\/a\.pdf \| tip: pdf \| pagini: 30 \| caractere: 90000 \| continuă cu offset: 12000\]\n\[p\. 1\]/);
  const thin = setup(async () => ({ url: 'https://x.test/', kind: 'html', pages: null, chars: 12, text: 'Accept cookies', nextOffset: null }));
  assert.match(await thin.tools.deschide_url.run({ url: 'https://x.test/' }), /Nu e o sursă deschisă/);
  const bad = setup(async () => { throw new FetchError('blocat', 'Gazda duce la o adresă privată sau locală.'); });
  await assert.rejects(bad.tools.deschide_url.run({ url: 'http://10.0.0.1/' }), /Nu s-a putut deschide \(blocat\)/);
});

// ---------- review finding 1: where an address came from ----------

test('provenance: addresses are found in text, and known sources are matched by host', () => {
  assert.deepEqual(urlsIn('Vezi https://a.test/ghid.pdf. Și (https://b.test/x_(y)), [titlu](https://c.test/p?q=1&r=2)!\n{"url":"https://d.test/j"} HTTP://E.test#frag ftp://nu.test/x'), ['https://a.test/ghid.pdf', 'https://b.test/x_(y)', 'https://c.test/p?q=1&r=2', 'https://d.test/j', 'http://e.test/']);
  for (const h of ['sogr.ro', 'www.sogr.ro', 'nomenclator.anm.ro', 'www.nice.org.uk', 'eutils.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'www.ebi.ac.uk', 'europepmc.org', 'iris.who.int', 'www.rcog.org.uk', 'www.acog.org', 'www.figo.org', 'www.isuog.org', 'www.eshre.eu', 'esgo.org', 'www.smfm.org', 'www.ema.europa.eu', 'www.ms.ro', 'SOGR.ro.']) assert.equal(isKnownHost(h), true, h);
  for (const h of ['evil.example', 'sogr.ro.evil.example', 'notsogr.ro', 'nih.gov', 'ro', '', 'who.int.evil.example']) assert.equal(isKnownHost(h), false, h);
  const seen = createSeen();
  seen.add([{ type: 'text', text: 'Links: [{"title":"T","url":"https://found.test/page"}]' }, { nested: { deeper: 'https://deep.test/a' } }, 7, null]);
  assert.equal(seen.has('https://found.test/page'), true);
  assert.equal(seen.has('https://found.test/page#sectiune'), true); // a fragment never reaches the server
  assert.equal(seen.has('https://deep.test/a'), true);
  assert.equal(seen.has('https://found.test/page?d=profil'), false);
  assert.equal(seen.has('https://found.test/'), false);
  assert.equal(seen.has('not a url'), false);
  const prov = createProvenance();
  prov.of('c1').add('https://x.test/1');
  assert.equal(prov.of('c1').has('https://x.test/1'), true); // kept across turns
  assert.equal(prov.of('c2').has('https://x.test/1'), false);
  assert.equal(prov.of(undefined).has('https://x.test/1'), false);
});

test('deschide_url opens known sources and addresses seen in the conversation, nothing else', async () => {
  let allow;
  const { tools } = setup(async (args) => { allow = args.allow; return { url: args.url, kind: 'html', pages: null, chars: 500, text: 'a'.repeat(500), nextOffset: null }; });
  const ok = (u) => allow(new URL(u));
  const seen = createSeen();
  seen.add('uite ghidul: https://her.example/ghid.pdf.');

  await tools.deschide_url.run({ url: 'https://evil.example/c?d=continut-din-profil' }, { seen });
  assert.equal(ok('https://evil.example/c?d=continut-din-profil'), false);
  assert.equal(ok('https://www.nice.org.uk/guidance/ng133/chapter/Recommendations'), true);
  assert.equal(ok('https://her.example/ghid.pdf'), true);
  assert.equal(ok('https://her.example/ghid.pdf?d=continut-din-profil'), false);

  await tools.deschide_url.run({ url: ' https://her.example/ghid.pdf ' }, { seen }); // an address she gave: its redirects are followed
  assert.equal(ok('https://cdn.example/final.pdf'), true);
  await tools.deschide_url.run({ url: 'https://sogr.ro/x' }, { seen }); // an address built on a known source: redirects stay on known sources
  assert.equal(ok('https://www.sogr.ro/x'), true);
  assert.equal(ok('https://evil.example/c?d=continut-din-profil'), false);

  await tools.deschide_url.run({ url: 'https://her.example/ghid.pdf' }); // no conversation: known sources only
  assert.equal(ok('https://her.example/ghid.pdf'), false);
  assert.equal(ok('https://sogr.ro/'), true);

  const refusing = setup(async () => { throw new FetchError('provenienta', REFUSAL); });
  const err = await refusing.tools.deschide_url.run({ url: 'https://evil.example/' }, { seen }).catch((e) => e);
  assert.match(err.message, /^Adresă refuzată: .*WebSearch/);
  assert.ok(!err.message.includes('\n'), 'one line');
});
