// Lesson JSON validation against its unit (SPEC §6, schema 3).
import { countWords, fixDiacritics, fold } from './text.mjs';
import { valoareProblem, unitFigureCount, shownValoare, lexiconWord } from './figures.mjs';
import { proseProblem } from './prose.mjs';

const ROW_KINDS = new Set(['Standard', 'Recomandare', 'Opțiune']);
export const PROSE_MIN_COVERAGE = 0.6;
export const WORDS_PER_MIN = 200;
export const MIN_MINUTES = 4, MAX_MINUTES = 9, TARGET_MINUTES = [6, 8];
export const MAX_EXPLICATIE = 40;
/** Rows and paragraphs of a unit by id (R… and P…). */
export const itemsOf = (unit) => new Map(unit.blocuri.filter((b) => b.id && (b.tip === 'row' || b.tip === 'paragraf')).map((b) => [b.id, b]));
const isRowBlock = (b) => b.tip === 'row';
const wordsOf = (b) => b.cuvinte ?? countWords(b.text);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');

export const figureProblem = valoareProblem;
/** F5 / R2: a label with a negation or restriction word (the SPEC-ROUND13 R1 lexicon) would reverse or soften the figure printed beside it. */

export const SCHEMA = 3;
export const MAX_QUIZ_COMENTARIU = 25;
/** The old shape, named in the message that rejects a schema-2 lesson. */
const SCHEMA2_MSG = 'schema 3 a schimbat câmpurile: quiz[] = {intrebare, ref, comentariu?} (fără citat; răspunsul este tot rândul ref) și cifre[] = {eticheta, ref, valoare} (fără citat și fără pagina); regenerează lecția după GENERATOR.md';

/** A lesson with every string in comma diacritics (a legacy ş/ţ typed by the LLM is shown as ș/ț). */
export function normalizeLessonText(x) {
  if (typeof x === 'string') return fixDiacritics(x);
  if (Array.isArray(x)) return x.map(normalizeLessonText);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, normalizeLessonText(v)]));
  return x;
}

/**
 * The lesson as it is printed: normalised text, and every `cifre[].valoare` replaced by the guideline's own characters (the slice of the
 * block it names), never the LLM's string (SPEC-ROUND12 F2).
 */
export function printedLesson(unit, lessonIn) {
  const lesson = normalizeLessonText(lessonIn);
  if (!Array.isArray(lesson.cifre)) return lesson;
  const rows = itemsOf(unit);
  return { ...lesson, cifre: lesson.cifre.map((c) => (rows.has(c.ref) ? { ...c, valoare: shownValoare(rows.get(c.ref).text, c.valoare) } : c)) };
}

/** Strings written by the LLM, with a path for error messages. */
export function llmStrings(lesson) {
  const out = [];
  const add = (path, v) => { if (typeof v === 'string') out.push({ path, text: v }); };
  add('context', lesson.context);
  add('titlu', lesson.titlu);
  arr(lesson.sectiuni).forEach((s, i) => {
    add(`sectiuni[${i}].titlu`, s?.titlu);
    add(`sectiuni[${i}].intro`, s?.intro);
    arr(s?.explicatii).forEach((e, j) => add(`sectiuni[${i}].explicatii[${j}].text`, e?.text));
    arr(s?.puncte_cheie).forEach((t, j) => add(`sectiuni[${i}].puncte_cheie[${j}]`, t));
  });
  arr(lesson.perle).forEach((t, i) => add(`perle[${i}]`, t));
  arr(lesson.quiz).forEach((q, i) => { add(`quiz[${i}].intrebare`, q?.intrebare); add(`quiz[${i}].comentariu`, q?.comentariu); });
  arr(lesson.rezumat_telegram).forEach((t, i) => add(`rezumat_telegram[${i}]`, t));
  arr(lesson.cifre).forEach((c, i) => add(`cifre[${i}].eticheta`, c?.eticheta));
  return out;
}

/** Throws a readable error when `lesson` is not valid for `unit` (used wherever a lesson JSON is read). */
export function assertValidLesson(unit, lesson, id = unit?.id) {
  const { errors } = validateLesson(unit, lesson);
  if (errors.length) throw new Error(`lecția ${id} nu e validă:\n  - ${errors.join('\n  - ')}`);
}

/** @returns {{errors:string[], warnings:string[], info:object}} */
export function validateLesson(unit, lesson, opts = {}) {
  // last-resort net: an unexpected shape is reported as an error, never as a stack trace
  try { return validateLessonShape(unit, lesson, opts); } catch (e) {
    return { errors: [`structura lecției nu poate fi verificată (${e.message})`], warnings: [], info: {} };
  }
}

/** [min, max] minutes. SOGR_LENGTH_LIMITS="0,99" widens them: the test suite keeps frozen 2400-word fixture units that the 9-minute cap would refuse. */
function lengthLimits(opts) {
  if (opts?.limits) return opts.limits;
  const e = process.env.SOGR_LENGTH_LIMITS;
  if (e) { const [a, b] = e.split(',').map(Number); if (Number.isFinite(a) && Number.isFinite(b)) return [a, b]; }
  return [MIN_MINUTES, MAX_MINUTES];
}

function validateLessonShape(unit, lesson, opts) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (!isObj(lesson)) return { errors: ['lecția nu este un obiect JSON'], warnings, info: {} };
  if (lesson.unit !== unit.id) err(`unit: așteptat "${unit.id}", găsit "${lesson.unit}"`);
  if (lesson.schema !== SCHEMA) return { errors: [...errors, `schema: trebuie ${SCHEMA} (găsit ${JSON.stringify(lesson.schema)}); ${SCHEMA2_MSG}`], warnings, info: {} };
  if (!isStr(lesson.titlu)) err('titlu lipsește sau e gol');
  if (!isStr(lesson.context)) err('context lipsește sau e gol');

  const rows = itemsOf(unit);
  const lessonRows = new Set(); // Standard/Recomandare/Opțiune rows referenced in `recomandari`
  const lessonParas = new Set(); // paragraphs referenced in `recomandari`
  const lessonArg = new Set(); // everything referenced in `argumentare`
  const dupCheck = new Map();

  // sections
  const sections = Array.isArray(lesson.sectiuni) ? lesson.sectiuni : [];
  if (!Array.isArray(lesson.sectiuni)) err('sectiuni trebuie să fie listă');
  if (sections.length < 2 || sections.length > 4) err(`sectiuni: ${sections.length} (trebuie 2–4)`);
  sections.forEach((s, i) => {
    const at = `sectiuni[${i}]`;
    if (!isObj(s)) { err(`${at} trebuie să fie obiect`); return; }
    if (!isStr(s.titlu)) err(`${at}.titlu lipsește`);
    if (!isStr(s.intro)) err(`${at}.intro lipsește`);
    // shapes first: a wrong type is reported, never a crash
    const list = (v, name) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) { err(`${at}.${name} trebuie să fie listă de id-uri (șiruri)`); return []; }
      return v;
    };
    const rec = list(s.recomandari, 'recomandari');
    const arg = list(s.argumentare, 'argumentare');
    if (s.explicatii !== undefined && !Array.isArray(s.explicatii)) err(`${at}.explicatii trebuie să fie listă`);
    for (const id of rec) {
      const r = rows.get(id);
      if (!r) { err(`${at}.recomandari: id inexistent în unitate: ${id}`); continue; }
      if (isRowBlock(r) && !ROW_KINDS.has(r.tip_rand)) err(`${at}.recomandari: ${id} este ${r.tip_rand}, nu Standard/Recomandare/Opțiune`);
      if (dupCheck.has(id)) err(`${id} apare de două ori (${dupCheck.get(id)} și ${at}.recomandari)`);
      else dupCheck.set(id, `${at}.recomandari`);
      (isRowBlock(r) ? lessonRows : lessonParas).add(id);
    }
    if (arg.length > 3) err(`${at}.argumentare: ${arg.length} rânduri (max 3)`);
    for (const id of arg) {
      const r = rows.get(id);
      if (!r) { err(`${at}.argumentare: id inexistent în unitate: ${id}`); continue; }
      if (isRowBlock(r) && r.tip_rand !== 'Argumentare') err(`${at}.argumentare: ${id} este ${r.tip_rand}, nu Argumentare`);
      if (dupCheck.has(id)) err(`${id} apare de două ori (${dupCheck.get(id)} și ${at}.argumentare)`);
      else dupCheck.set(id, `${at}.argumentare`);
      lessonArg.add(id);
    }
    arr(s.explicatii).forEach((e, j) => {
      if (!isObj(e)) { err(`${at}.explicatii[${j}] trebuie să fie obiect {ref, text}`); return; }
      if (!rows.has(e.ref)) err(`${at}.explicatii[${j}].ref: id inexistent în unitate: ${e.ref}`);
      else if (!rec.includes(e.ref) && !arg.includes(e.ref)) err(`${at}.explicatii[${j}].ref: ${e.ref} nu este în secțiunea aceasta`);
      if (!isStr(e.text)) err(`${at}.explicatii[${j}].text lipsește sau nu e text`);
    });
    const pk = s.puncte_cheie;
    if (!isStrArr(pk) || pk.length < 1 || pk.length > 5) err(`${at}.puncte_cheie: trebuie 1–5 șiruri nevide`);
  });

  // coverage: every Standard/Recomandare/Opțiune appears exactly once; prose units: >= 60 % of paragraph words
  const required = [...rows.values()].filter((r) => isRowBlock(r) && ROW_KINDS.has(r.tip_rand));
  const missing = required.filter((r) => !lessonRows.has(r.id));
  if (missing.length) {
    err(`acoperire incompletă: ${missing.length} rânduri lipsesc din recomandari: ` +
      missing.slice(0, 12).map((r) => `${r.id} (${r.tip_rand})`).join(', ') + (missing.length > 12 ? ', …' : ''));
  }
  const prose = !required.length;
  const paraTotal = [...rows.values()].filter((b) => !isRowBlock(b)).reduce((a, b) => a + wordsOf(b), 0);
  const paraCovered = [...lessonParas].reduce((a, id) => a + wordsOf(rows.get(id)), 0);
  const prozaPct = paraTotal ? (100 * paraCovered) / paraTotal : 100;
  if (prose && prozaPct < PROSE_MIN_COVERAGE * 100) {
    err(`acoperire proză insuficientă: ${prozaPct.toFixed(1)} % din cuvintele paragrafelor (${paraCovered} din ${paraTotal}), minimum ${PROSE_MIN_COVERAGE * 100} %`);
  }

  // numbers: a figure is a verbatim span of the block it names (SPEC-ROUND11 A.2)
  const cifre = lesson.cifre ?? [];
  if (!Array.isArray(cifre)) err('cifre: trebuie să fie listă');
  else {
    const minCifre = Math.min(3, unitFigureCount(unit));
    if (cifre.length > 5 || cifre.length < minCifre) err(`cifre: ${cifre.length} (trebuie ${minCifre === 3 ? '3' : `${minCifre}`}–5)`);
  }
  (Array.isArray(cifre) ? cifre : []).forEach((c, i) => {
    const at = `cifre[${i}]`;
    if (!isObj(c)) { err(`${at} trebuie să fie obiect {eticheta, ref, valoare}`); return; }
    for (const old of ['citat', 'pagina']) if (c[old] !== undefined) err(`${at}.${old} nu mai există (schema 3): scrie doar eticheta, ref (id-ul rândului) și valoare (copiată din rând)`);
    if (!isStr(c.eticheta) || !isStr(c.valoare) || !isStr(c.ref)) { err(`${at}: eticheta, ref și valoare sunt obligatorii (șiruri)`); return; }
    const row = rows.get(c.ref);
    if (!row) { err(`${at}.ref: id inexistent în unitate: ${c.ref}`); return; }
    let why = valoareProblem(c.valoare, row.text, { label: `rândul ${c.ref}` });
    // review 12: a block that starts with a list item may sit under a header ending the previous block ("Contraindicații" in 38-7 P39 → items in P40)
    if (!why && /^\s*(?:[-–−•▪○●]|\(?[a-z0-9]{1,2}[.)])\s/i.test(row.text)) {
      const i = unit.blocuri.findIndex((b) => b.id === c.ref);
      const prev = i > 0 ? unit.blocuri[i - 1] : null;
      const tail = prev ? String(prev.text || '').trim().split(/[.!?]\s+|\n/).filter((x) => x.trim()).pop() || '' : '';
      // only a previous block that does not end a sentence (ends with ':' or runs on into the list) heads the list
      const w = /[.!?]\s*$/.test(String(prev?.text || '').trim()) ? null : lexiconWord(fold(tail));
      if (w) why = `cifra se află într-o listă sub un antet cu negație sau restricție din blocul anterior („${tail.trim().split(/\s+/).slice(-6).join(' ')}”); nu o pune în tabel, rândul apare oricum ca card`;
    }
    if (why) err(`${at}.valoare "${c.valoare}" ${why}`);
    if (lexiconWord(fold(c.eticheta))) err(`${at}.eticheta nu poate conține negații sau restricții; descrie neutru ce măsoară valoarea`);
  });

  // perle, quiz, telegram
  const perle = lesson.perle;
  if (!isStrArr(perle) || perle.length < 2 || perle.length > 3) err('perle: trebuie 2–3 șiruri');
  const quiz = lesson.quiz;
  if (!Array.isArray(quiz) || quiz.length !== 3) err(`quiz: ${Array.isArray(quiz) ? quiz.length : 'lipsă'} întrebări (trebuie exact 3)`);
  (Array.isArray(quiz) ? quiz : []).forEach((q, i) => {
    if (!isObj(q)) { err(`quiz[${i}] trebuie să fie obiect {intrebare, ref, comentariu?}`); return; }
    for (const old of ['raspuns', 'citat']) if (q[old] !== undefined) err(`quiz[${i}].${old} nu mai există (schema 3): răspunsul este tot rândul ref; scrie doar intrebare, ref și, opțional, comentariu`);
    if (!isStr(q.intrebare) || !isStr(q.ref)) err(`quiz[${i}]: intrebare și ref sunt obligatorii`);
    if (q.comentariu !== undefined && !isStr(q.comentariu)) err(`quiz[${i}].comentariu trebuie să fie text nevid sau să lipsească`);
    if (isStr(q.comentariu) && countWords(q.comentariu) > MAX_QUIZ_COMENTARIU) err(`quiz[${i}].comentariu: ${countWords(q.comentariu)} cuvinte (max ${MAX_QUIZ_COMENTARIU})`);
    if (isStr(q.ref) && !rows.has(q.ref)) err(`quiz[${i}].ref: id inexistent în unitate: ${q.ref}`);
  });
  const tg = lesson.rezumat_telegram;
  if (!isStrArr(tg) || tg.length < 3 || tg.length > 4) err('rezumat_telegram: trebuie 3–4 șiruri');
  (Array.isArray(tg) ? tg : []).forEach((t, i) => {
    if (isStr(t) && countWords(t) > 25) err(`rezumat_telegram[${i}]: ${countWords(t)} cuvinte (max 25)`);
  });

  // markup, characters and number words in LLM-written strings (SPEC-ROUND11 B): numbers reach the reader only inside the guideline's own blocks
  for (const { path, text } of llmStrings(lesson)) {
    if (/<\s*[A-Za-z/!?]|[`*_]|^\s*#/m.test(text) || /\[[^\]]*\]\([^)]*\)/.test(text)) {
      err(`${path}: conține Markdown/HTML (etichete <…>, *, _, \`, [text](url) sau # la început de linie; strică mesajul Telegram): "${text.slice(0, 60)}"`);
      continue;
    }
    const d = proseProblem(text);
    if (d) err(`${path}: ${d}`);
  }

  // warnings + reading length
  let llmWords = 0;
  const count = (t) => { llmWords += countWords(str(t)); };
  count(lesson.context);
  sections.forEach((s) => {
    count(s?.intro);
    arr(s?.explicatii).forEach((e) => {
      count(e?.text);
      if (countWords(str(e?.text)) > MAX_EXPLICATIE) err(`explicație prea lungă (${countWords(e.text)} cuvinte, max ${MAX_EXPLICATIE}) pentru ${e.ref}`);
    });
    arr(s?.puncte_cheie).forEach(count);
  });
  arr(perle).forEach(count);
  if (llmWords > 450) warnings.push(`textul scris de LLM are ${llmWords} cuvinte (> 450; ținta e ≤ 350)`);
  const rowWords = [...lessonRows, ...lessonParas, ...lessonArg].reduce((a, id) => a + wordsOf(rows.get(id) || { text: '' }), 0);
  const totalWords = llmWords + rowWords;
  const info = { llmWords, rowWords, totalWords, minutes: Math.round(totalWords / WORDS_PER_MIN) };
  const [lo, hi] = lengthLimits(opts);
  if (totalWords / WORDS_PER_MIN < lo) err(`lectura e prea scurtă: ~${info.minutes} min (${totalWords} cuvinte; minim ${lo} min = ${lo * WORDS_PER_MIN} cuvinte, ținta ${TARGET_MINUTES[0]}–${TARGET_MINUTES[1]} min)`);
  else if (totalWords / WORDS_PER_MIN > hi) err(`lectura e prea lungă: ~${info.minutes} min (${totalWords} cuvinte; maxim ${hi} min = ${hi * WORDS_PER_MIN} cuvinte, ținta ${TARGET_MINUTES[0]}–${TARGET_MINUTES[1]} min); scoate rânduri Argumentare sau paragrafe opționale`);
  else if (info.minutes < TARGET_MINUTES[0] || info.minutes > TARGET_MINUTES[1]) warnings.push(`lungime ~${info.minutes} min, în afara țintei ${TARGET_MINUTES[0]}–${TARGET_MINUTES[1]} min`);
  if (prose) info.proza = { pct: prozaPct, cuvinte: paraCovered, total: paraTotal };
  return { errors, warnings, info };
}
