import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './core-helpers.mjs';
import { importRegistru, parseEntryLine, splitTop, cleanText, buildConversations, run } from '../scripts/import-from-openclaw.mjs';

const PAGE = fs.readFileSync(fileURLToPath(new URL('./fixtures/core/registru-de-proceduri.md', import.meta.url)), 'utf8');

test('splitTop ignores separators inside parentheses', () => {
  assert.deepEqual(splitTop('a (x; y) ; b', ';'), ['a (x; y)', 'b']);
  assert.deepEqual(splitTop('d (p — q) — r — 👶 +1', ' — '), ['d (p — q)', 'r', '👶 +1']);
});

test('entry line with two procedures, notes and the baby count', () => {
  const e = parseEntryLine('- 2026-11-08 (free text; with semicolons) — Naștere vaginală ×3 (efectuat); Cezariană ×1 (efectuat, mâna 1; „quoted”) — optional notes — 👶 +4');
  assert.equal(e.date, '2026-11-08');
  assert.equal(e.babies, 4);
  assert.deepEqual(e.notes, ['free text; with semicolons', 'optional notes']);
  assert.deepEqual(e.procedures, [
    { name: 'Naștere vaginală', n: 3, rol: 'efectuat', nota: '' },
    { name: 'Cezariană', n: 1, rol: 'efectuat', nota: 'mâna 1; „quoted”' },
  ]);
  assert.throws(() => parseEntryLine('- 2026-11-08 — Cezariană ×1 (mâna 1)'), /role/);
});

test('registru page: parsed, twins added, checked against the page totals', () => {
  const { data, summary, errors } = importRegistru(PAGE);
  assert.deepEqual(errors, []);
  assert.deepEqual(summary.copii, { total: 8, vaginale: 5, cezariene: 3, primul: '2026-09-01' });
  assert.equal(data.entries.length, 8);
  const twins = data.entries.find((e) => e.date === '2026-11-01');
  assert.deepEqual([twins.n, twins.copii], [2, 3]);
  assert.match(twins.nota, /înregistrat 2026-11-02/);
  const ajutat = data.entries.filter((e) => e.rol === 'ajutat');
  assert.ok(ajutat.every((e) => e.copii === 0));
  assert.equal(summary.rows.find((r) => r.id === 'garzi').efectuat, 2);
  // newest first in the summary, same order as the page for the same day
  assert.deepEqual(summary.entries.filter((e) => e.date === '2026-10-15').map((e) => e.row), ['nastere-vaginala', 'cezariana']);
});

test('registru page: mismatches are reported with both sides', () => {
  const bad = PAGE.replace('Copii aduși pe lume: 8', 'Copii aduși pe lume: 9').replace('Cezariană: efectuat 3 · ajutat 2', 'Cezariană: efectuat 3 · ajutat 1');
  const { errors } = importRegistru(bad);
  assert.ok(errors.some((e) => e === 'babies total: page 9, computed 8'), errors.join('\n'));
  assert.ok(errors.some((e) => e === 'Cezariană ajutat: page 1, computed 2'), errors.join('\n'));
});

test('text cleaning', () => {
  assert.equal(cleanText('user', 'vezi <file name="curs.pdf" mime="application/pdf">\n<<<EXTERNAL_UNTRUSTED_CONTENT id="1">>>\nxx\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1">>>\n</file> te rog'), 'vezi [fișier: curs.pdf] te rog');
  assert.equal(cleanText('assistant', 'Răspuns\nMEDIA:/tmp/x.png\nSurse: SOGR'), 'Răspuns\nSurse: SOGR');
});

function msgs(session, startMs, n, { gapAt = -1, inter = 0 } = {}) {
  const out = [];
  let t = startMs;
  for (let i = 0; i < n; i++) {
    if (i === gapAt) t += 5 * 3600e3;
    const role = i % 2 ? 'assistant' : 'user';
    out.push({ session, role, ts: t, messageId: `${session}-${i}`, text: role === 'user' && i / 2 < inter ? '[Inter-session message] x' : `${role} ${i}` });
    t += 60e3;
  }
  return out;
}

test('conversations: filters, 4-hour split, Bucharest ids', () => {
  const t0 = Date.UTC(2026, 10, 3, 18, 5); // 20:05 in Bucharest
  const rows = [
    ...msgs('keep', t0, 10, { gapAt: 6 }),
    ...msgs('short', t0, 4),
    ...msgs('inter', t0, 10, { inter: 1 }), // 1 of 5 user messages = 20%: dropped
  ];
  const { conversations, skippedSessions } = buildConversations(rows);
  assert.equal(skippedSessions, 2);
  assert.deepEqual(conversations.map((c) => [c.id, c.messages.length]), [['tg-20261103-2005', 6], ['tg-20261104-0111', 4]]);
  assert.equal(conversations[0].imported, true);
  assert.equal(conversations[0].title, 'user 0');
  assert.equal(conversations[0].sdkSessionId, undefined);
});

test('run(): end to end into a temp data dir, re-run does not duplicate or overwrite', () => {
  const oc = tmpDir('rokhan-openclaw-');
  const data = tmpDir('rokhan-data-');
  const wiki = path.join(oc, 'wiki', 'rokhan', 'syntheses');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'registru-de-proceduri.md'), PAGE);
  const wrap = (s) => `# X\n<!-- openclaw:wiki:generated:start -->\n${s}\n<!-- openclaw:wiki:generated:end -->\n## Related\nnu`;
  fs.writeFileSync(path.join(wiki, 'profil.md'), wrap('## Cine este\n- Rezidentă de test.'));
  fs.writeFileSync(path.join(wiki, 'întrebări-deschise.md'), wrap('- nimic'));
  fs.mkdirSync(path.join(oc, 'workspace-rokhan', 'library', 'ghiduri-sogr'), { recursive: true });
  fs.writeFileSync(path.join(oc, 'workspace-rokhan', 'library', 'ghiduri-sogr', 'g.md'), 'ghid');
  const lessons = path.join(oc, 'workspace', 'projects', 'sogr-lecturi', 'data');
  for (const d of ['units', 'lessons', 'today', 'out']) fs.mkdirSync(path.join(lessons, d), { recursive: true });
  fs.writeFileSync(path.join(lessons, 'units', '01-1.json'), '{}');
  fs.writeFileSync(path.join(lessons, 'today', 'x.json'), '{}');
  fs.writeFileSync(path.join(lessons, 'state.json'), '{"v":1}');
  const dbDir = path.join(oc, 'agents', 'rokhan', 'agent');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'openclaw-agent.sqlite'));
  db.exec('CREATE TABLE session_transcript_fts_content (id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)');
  const ins = db.prepare('INSERT INTO session_transcript_fts_content (c0, c1, c2, c3, c4) VALUES (?, ?, ?, ?, ?)');
  for (const m of msgs('s1', Date.UTC(2026, 9, 20, 9, 0), 6)) ins.run(m.text, m.session, m.messageId, m.role, String(m.ts));
  db.close();

  const log = [];
  let r = run({ openclaw: oc, data, log: (l) => log.push(l) });
  assert.equal(r.ok, true, log.join('\n'));
  assert.ok(fs.existsSync(path.join(data, 'library', 'ghiduri-sogr', 'g.md')));
  assert.ok(fs.existsSync(path.join(data, 'lessons', 'units', '01-1.json')));
  assert.ok(!fs.existsSync(path.join(data, 'lessons', 'today')));
  assert.equal(fs.readFileSync(path.join(data, 'memory', 'profil.md'), 'utf8'), '## Cine este\n- Rezidentă de test.\n');
  assert.ok(fs.existsSync(path.join(data, 'memory', 'intrebari-deschise.md')));
  const reg = JSON.parse(fs.readFileSync(path.join(data, 'registru.json'), 'utf8'));
  assert.equal(reg.entries.length, 8);
  const conv = JSON.parse(fs.readFileSync(path.join(data, 'conversations', 'tg-20261020-1200.json'), 'utf8'));
  assert.equal(conv.messages.length, 6);
  assert.match(log.join('\n'), /8 babies \(5 vaginal, 3 caesarean\)/);

  // live data wins on a re-run
  fs.writeFileSync(path.join(data, 'memory', 'profil.md'), 'editat');
  fs.writeFileSync(path.join(data, 'lessons', 'state.json'), '{"v":2}');
  conv.title = 'editat';
  fs.writeFileSync(path.join(data, 'conversations', 'tg-20261020-1200.json'), JSON.stringify(conv));
  log.length = 0;
  r = run({ openclaw: oc, data, log: (l) => log.push(l) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(data, 'memory', 'profil.md'), 'utf8'), 'editat');
  assert.equal(fs.readFileSync(path.join(data, 'lessons', 'state.json'), 'utf8'), '{"v":2}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'conversations', 'tg-20261020-1200.json'), 'utf8')).title, 'editat');
  assert.equal(fs.readdirSync(path.join(data, 'conversations')).length, 1);
  assert.match(log.join('\n'), /registru: skipped/);

  // a mismatching page writes nothing
  fs.writeFileSync(path.join(wiki, 'registru-de-proceduri.md'), PAGE.replace('aduși pe lume: 8', 'aduși pe lume: 7'));
  const data2 = tmpDir('rokhan-data-');
  r = run({ openclaw: oc, data: data2, log: () => {} });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(data2), []);

  // --force replaces the logbook and memory
  fs.writeFileSync(path.join(wiki, 'registru-de-proceduri.md'), PAGE);
  r = run({ openclaw: oc, data, only: 'registru,memorie', force: true, log: () => {} });
  assert.equal(fs.readFileSync(path.join(data, 'memory', 'profil.md'), 'utf8'), '## Cine este\n- Rezidentă de test.\n');
});
