// Acceptance questions through the real assistant. It only records; grading happens later.
//
//   node scripts/eval.mjs [questions.json|questions.md] [--only 1,4,9] [--model claude-opus-5-5] [--effort high] [--data <dir>]
//
// The question file is optional: without it, the invented three-question example
// (test/fixtures/llm/acceptance.example.json) is used. A .md file in the acceptance-set format
// (see parseAcceptanceSet) is parsed directly; a .json file is the parsed array.
//
// Each question is a fresh conversation sent through runTurn on the real services of the data directory
// (ROKHAN_DATA_DIR, --data, or <repo>/data). Urgent items are sent with urgent: true, as the app's switch does.
// The logbook and the memory pages are read-only here: writes the model attempts are recorded in the report and
// not applied. Output: eval-out/<timestamp>.md with question, answer, character count, automatic checks and the
// library calls in order (so a wrong guideline opened first is visible).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(root, 'test', 'fixtures', 'llm', 'acceptance.example.json');
export const LIMITS = { single: 900, multi: 1500, urgent: 750 }; // urgent: the prompt aims at 600, the rubric's hard bar is 750
export const MAX_SOURCES = 3;

/** The numbered items of an acceptance-set markdown file (`## 1. Title`, then **Question:**, **Must contain:**, **Fails if:**) as [{ nr, id, titlu, tip, capcana, intrebare, trebuie, pica }]. */
export function parseAcceptanceSet(markdown) {
  const items = [];
  for (const block of markdown.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) { // a Windows checkout has CRLF
    const head = /^(\d+)\.\s+(.*)$/.exec(block.split('\n', 1)[0]);
    if (!head) continue; // the closing sections are not questions
    const raw = (label) => new RegExp(`\\*\\*${label}[^*]*\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n|\\n\\*\\*|$)`).exec(block)?.[1].trim() ?? '';
    const field = (label) => raw(label).replace(/\s*\n\s*/g, ' ');
    const title = head[2].trim();
    items.push({
      nr: Number(head[1]),
      id: /\(([A-Z]\d+)/.exec(title)?.[1] ?? null,
      titlu: title,
      tip: /^urgent/i.test(title) ? 'urgent' : /^multi-part/i.test(title) ? 'multi' : 'single',
      capcana: /trap `([^`]+)`/.exec(title)?.[1] ?? null,
      intrebare: raw('Question:').split('\n')[0].trim(), // a note may follow on the next line; it is not part of what she asks
      trebuie: field('Must contain'),
      pica: field('Fails if:'),
    });
  }
  return items;
}

const EN = new Set('the and of to is are was with for this that these should must be not need needs page open which from have has will can it its on at by an as but if then into about check checking let me now first next'.split(' '));
const RO = new Set('și si este sunt sau la în in cu pentru nu se de din pe care ce că ca un o a al ale cel mai după dupa până pana fără fara dacă daca doar apoi când cand'.split(' '));
const englishSentence = (text) => text.split(/(?<=[.!?:])\s+|\n+/).find((s) => {
  const words = s.toLowerCase().match(/[a-zăâîșț]+/g) ?? [];
  const en = words.filter((w) => EN.has(w)).length;
  return words.length >= 4 && en >= 3 && en > words.filter((w) => RO.has(w)).length;
}) ?? null;

/** The automatic checks on one answer. Each is { ok, detail }. */
export function checkAnswer(answer, tip) {
  const text = String(answer ?? '').trim();
  const lines = text.split('\n').filter((l) => l.trim());
  const last = (lines.at(-1) ?? '').trim();
  const body = lines.filter((l) => !/^Surse:/.test(l.trim())).join('\n');
  const url = /https?:\/\/\S+|\bwww\.\S+/.exec(body)?.[0];
  const marker = /\[\d+\]/.exec(body)?.[0];
  const english = englishSentence(body);
  const sources = /^Surse:/.test(last) ? last.replace(/^Surse:\s*/, '').split(';').filter((s) => s.trim()).length : 0;
  return {
    lungime: { ok: text.length > 0 && text.length <= LIMITS[tip], detail: `${text.length} / ${LIMITS[tip]}` },
    surse: { ok: /^Surse:\s*\S/.test(last), detail: last.slice(0, 160) },
    surse_max3: { ok: sources <= MAX_SOURCES, detail: `${sources}` },
    fara_url: { ok: !url, detail: url ?? '' },
    fara_marcaje: { ok: !marker, detail: marker ?? '' },
    fara_engleza: { ok: !english, detail: english?.slice(0, 120) ?? '' },
  };
}

/**
 * Wraps the services for an eval run: logbook and memory writes are recorded in `attempts` and not applied;
 * library calls are recorded in `calls`, in order.
 */
function observed(deps, attempts, calls) {
  const wrap = (target, handler) => new Proxy(target, { get: (t, prop) => handler(prop, t) ?? (typeof t[prop] === 'function' ? t[prop].bind(t) : t[prop]) });
  const blocked = (names) => (prop) => (names.includes(prop) ? async (...a) => {
    attempts.push(`${String(prop)}(${JSON.stringify(a).slice(1, 200)})`);
    return prop === 'addEntry' ? { id: 'eval', row: a[0]?.row, rol: a[0]?.rol ?? 'efectuat', n: a[0]?.n ?? 1, date: a[0]?.date, copii: 0, nota: '' } : { ok: true };
  } : null);
  const short = (f) => String(f).replace(/^ghiduri-sogr\//, '').replace(/^(\d\d)-[^/]*\.md$/, '$1').replace(/^actualizari\/(\d\d)-.*$/, 'actualizari/$1').replace(/^curriculum-rezidentiat-og-2019\//, 'curriculum/');
  const logged = (prop, t) => {
    if (prop === 'toc') return (nr) => { calls.push(`cuprins ${nr}`); return t.toc(nr); };
    if (prop === 'readLines') return (f, a, b) => { calls.push(`citește ${short(f)}:${a}–${b}`); return t.readLines(f, a, b); };
    if (prop === 'search') return (q, o) => { calls.push(`caută „${q}”${o?.ghid ? ` în ${o.ghid}` : ''}`); return t.search(q, o); };
    return null;
  };
  return { ...deps, registru: wrap(deps.registru, blocked(['addEntry', 'updateEntry', 'deleteEntry', 'addRow'])), memorie: wrap(deps.memorie, blocked(['write'])), library: wrap(deps.library, logged) };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? EXAMPLE;
  const only = flag('only')?.split(',').map(Number);
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const items = (/\.md$/i.test(file) ? parseAcceptanceSet(text) : JSON.parse(text)).filter((q) => !only || only.includes(q.nr));
  const config = {
    root,
    dataDir: path.resolve(flag('data', process.env.ROKHAN_DATA_DIR || path.join(root, 'data'))),
    model: flag('model', process.env.ROKHAN_MODEL || 'claude-opus-5-5'),
    effort: flag('effort', process.env.ROKHAN_EFFORT || 'high'),
    tz: process.env.ROKHAN_TZ || 'Europe/Bucharest',
    fakeLlm: false,
  };
  const { getDeps } = await import(pathToFileURL(path.join(root, 'server', 'store', 'deps.mjs')));
  const { createAgent } = await import(pathToFileURL(path.join(root, 'server', 'llm', 'agent.mjs')));
  const attempts = [];
  const calls = [];
  const agent = createAgent({ config, deps: observed(await getDeps(config), attempts, calls) });

  const outDir = path.join(root, 'eval-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n'); // generated output stays out of git
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `${stamp}.md`);
  const sections = [];
  const rows = [];

  for (const q of items) {
    process.stdout.write(`${q.nr}. ${q.id ?? ''} ${q.tip} ... `);
    const steps = [];
    attempts.length = 0;
    calls.length = 0;
    const t0 = Date.now();
    let firstText = null;
    const emit = (event, data) => {
      if (event === 'status' && steps.at(-1) !== data.label) steps.push(data.label);
      if (event === 'delta') firstText ??= Date.now() - t0;
      if (event === 'clear') firstText = null;
    };
    const r = await agent.runTurn({ conversation: { id: `eval-${q.nr}`, sdkSessionId: null, messages: [] }, text: q.intrebare, images: [], urgent: q.tip === 'urgent', emit });
    const seconds = Math.round((Date.now() - t0) / 1000);
    await agent.forgetSession(r.sdkSessionId); // one question, one throwaway session
    const first = firstText === null ? '-' : Math.round(firstText / 1000);
    const checks = checkAnswer(r.text, q.tip);
    const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name);
    console.log(r.error ? `ERROR ${r.error.code}` : `${r.text.length} chars, ${seconds} s${failed.length ? `, checks failed: ${failed.join(', ')}` : ''}`);
    rows.push(`| ${q.nr} | ${q.id ?? ''} | ${q.tip} | ${r.text.length} | ${checks.surse_max3.detail} | ${first} | ${seconds} | ${calls[0] ?? '-'} | ${r.error ? `eroare ${r.error.code}` : failed.join(', ') || 'ok'} |`);
    sections.push([
      `## ${q.nr}. ${q.titlu}`,
      `**Întrebare:** ${q.tip === 'urgent' ? '[URGENT] ' : ''}${q.intrebare}`,
      r.error ? `**Eroare:** ${r.error.code}: ${r.error.message}` : '',
      `**Răspuns** (${r.text.length} caractere, primul text la ${first} s, total ${seconds} s):`,
      r.text.split('\n').map((l) => `> ${l}`).join('\n'),
      `**Verificări automate:** ${Object.entries(checks).map(([name, c]) => `${c.ok ? '✓' : '✗'} ${name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`,
      `**Pași:** ${steps.join(' → ')}`,
      `**Bibliotecă, în ordine:** ${calls.join('; ') || '-'}`,
      attempts.length ? `**Scrieri încercate (neaplicate):** ${attempts.join('; ')}` : '',
      `**Trebuie să conțină:** ${q.trebuie}`,
      `**Pică dacă:** ${q.pica}`,
    ].filter(Boolean).join('\n\n'));
    fs.writeFileSync(outFile, [
      `# Rokhan eval ${stamp}`,
      `Model ${config.model}, effort ${config.effort}, data ${config.dataDir}, real services. Recorded only, not graded.`,
      '| nr | id | tip | caractere | surse | primul text (s) | total (s) | primul apel în bibliotecă | verificări |\n|---|---|---|---|---|---|---|---|---|',
    ].join('\n\n') + `\n${rows.join('\n')}\n\n${sections.join('\n\n---\n\n')}\n`);
    if (r.error && ['limita', 'auth'].includes(r.error.code)) { console.log('Stopping: the model is not available.'); break; }
  }
  console.log(`-> ${path.relative(root, outFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
