// Daily lessons: progress, the printed lesson for the browser, validation and saving of lessons written by the model.
// Works on <dataDir>/lessons: units/NN-k.json, lessons/NN-k.json, state.json (old format), curriculum.json,
// plus the app's own quiz-log.json and requests.json. The resident pulls lessons when she wants; nothing is pushed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLesson, printedLesson, itemsOf, SCHEMA } from './sogr/lesson.mjs';
import { highlightHtml } from './sogr/highlight.mjs';
import { setCorpusDir } from './sogr/prose.mjs';
import { loadState, saveState, writeJsonAtomic, allUnitIds, unitGuideline, todayString, addDays } from './sogr/state.mjs';
import { sectionSummary } from './sogr/text.mjs';
import { refreshPlan, reorderPlan } from './sogr/plan.mjs';
import { syncCards, answerCard, dueIds, pauseCards, splitId, SESSION } from './review.mjs';

const WORDS_PER_MIN = 200;
const RECAP_DAYS = 7;
const RECAP_MIN = 3;
const READ_LIST = 14;
const PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generator-prompt.md');

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const ID_RE = /^\d\d-\d{1,3}$/;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const skippedId = (s) => (typeof s === 'string' ? s : s.unit);

const TIP = {
  Standard: { tip: 'standard', eticheta: 'Standard' },
  Recomandare: { tip: 'recomandare', eticheta: 'Recomandare' },
  'Opțiune': { tip: 'optiune', eticheta: 'Opțiune' },
  Argumentare: { tip: 'argumentare', eticheta: 'Argumentare' },
};
const pageLabel = (b) => (b.pagina_final && b.pagina_final !== b.pagina ? `${b.pagina}-${b.pagina_final}` : String(b.pagina));

/** A block of a unit as a card for the browser; `html` is the guideline's own text, escaped, with numbers and units marked. */
function card(block, explicatie = null) {
  const t = block.tip === 'row' ? TIP[block.tip_rand] ?? { tip: 'ghid', eticheta: block.tip_rand } : { tip: 'ghid', eticheta: 'Din ghid' };
  return { ref: block.id, tip: t.tip, eticheta: t.eticheta, grad: block.grad || null, pagina: pageLabel(block), html: highlightHtml(block.text), explicatie };
}

const instances = new Map();

/** One service per data directory. `opts.now` (a function returning a Date) lets tests fix "today". */
export function getLessons(config, opts = {}) {
  const dir = path.resolve(config.dataDir, 'lessons');
  if (!instances.has(dir)) instances.set(dir, createLessons(dir, config.tz || 'Europe/Bucharest', opts.now || (() => new Date())));
  return instances.get(dir);
}

function createLessons(dir, tz, now) {
  const unitsDir = path.join(dir, 'units');
  const lessonsDir = path.join(dir, 'lessons');
  const stateFile = path.join(dir, 'state.json');
  const f = (name) => path.join(dir, name);
  const today = () => todayString(tz, now());

  function loadUnit(id) {
    if (!ID_RE.test(String(id))) throw httpError(404, 'negasit');
    const file = path.join(unitsDir, `${id}.json`);
    if (!fs.existsSync(file)) throw httpError(404, 'negasit');
    return readJson(file);
  }
  /** The lesson JSON when it exists and has the current schema, else null. */
  function loadLesson(id) {
    const file = path.join(lessonsDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try { const l = readJson(file); return l.schema === SCHEMA ? l : null; } catch { return null; }
  }
  const curriculum = () => (fs.existsSync(f('curriculum.json')) ? readJson(f('curriculum.json')) : []);

  const sets = (state) => ({
    read: new Set(state.sent.filter((s) => s.tip === 'lectura').map((s) => s.unit)),
    skipped: new Set(state.sarite.map(skippedId)),
  });

  /** The state, with the plan refreshed against the units on disk and the cursor moved past read and skipped units. Not saved. */
  function load() {
    const state = loadState(stateFile);
    state.sarite = state.sarite || [];
    state.plan = refreshPlan(state, allUnitIds(unitsDir));
    advance(state);
    return state;
  }
  function advance(state) {
    const { read, skipped } = sets(state);
    state.cursor = Math.min(Math.max(0, state.cursor), state.plan.length);
    while (state.cursor < state.plan.length && (read.has(state.plan[state.cursor]) || skipped.has(state.plan[state.cursor]))) state.cursor++;
  }
  const save = (state) => saveState(state, stateFile);

  function minutes(unit, lesson) {
    if (lesson) { setCorpusDir(unitsDir); const m = validateLesson(unit, lesson).info.minutes; if (Number.isFinite(m)) return m; }
    return Math.round((unit.cuvinte || 0) / WORDS_PER_MIN);
  }
  const titleOf = (id) => loadLesson(id)?.titlu ?? null;

  function status() {
    const state = load();
    const { read } = sets(state);
    const id = state.plan[state.cursor] ?? null;
    let urmatoarea = null;
    if (id) {
      const unit = loadUnit(id);
      const lesson = loadLesson(id);
      urmatoarea = {
        id, ghid: { nr: unit.ghid.nr, titlu: unit.ghid.titlu }, k: unit.k, n: unit.n,
        titlu: lesson?.titlu ?? ((unit.blocuri ? sectionSummary(unit.blocuri) : unit.titlu_sectiuni) || `Lectura ${unit.k} din ${unit.n}`),
        scrisa: !!lesson, minute: minutes(unit, lesson),
      };
    }
    const unitCount = {};
    for (const u of state.plan) unitCount[unitGuideline(u)] = (unitCount[unitGuideline(u)] || 0) + 1;
    const guides = curriculum();
    const progres = (guides.length ? guides : Object.keys(unitCount).map((nr) => ({ nr, titlu: nr }))).map((g) => ({
      nr: g.nr, titlu: g.titlu, total: g.unitati || unitCount[g.nr] || 0,
      citite: [...read].filter((u) => unitGuideline(u) === g.nr).length,
    }));
    const reads = state.sent.filter((s) => s.tip === 'lectura');
    const latest = new Map();
    for (const s of reads) latest.set(s.unit, s); // a unit read twice counts once, by its latest date
    const ordered = [...latest.values()].reverse();
    const citite = ordered.slice(0, READ_LIST).map((s) => ({ id: s.unit, titlu: titleOf(s.unit) ?? s.unit, data: s.data }));
    const since = addDays(today(), -(RECAP_DAYS - 1));
    const lectii = ordered.filter((s) => s.data >= since).map((s) => ({ id: s.unit, titlu: titleOf(s.unit) ?? s.unit, data: s.data }));
    return { urmatoarea, progres, citite, recap: { disponibil: lectii.length >= RECAP_MIN, lectii }, repetitie: { scadente: reviewDue().length } };
  }

  /** The lesson as printed, for the browser. */
  function get(id) {
    const unit = loadUnit(id);
    const raw = loadLesson(id);
    if (!raw) throw httpError(404, 'nescrisa');
    const lesson = printedLesson(unit, raw);
    const rows = itemsOf(unit);
    const g = unit.ghid;
    const answer = (q) => { const b = rows.get(q.ref); return { ...card(b), comentariu: q.comentariu ?? null }; };
    return {
      id, ghid: { nr: g.nr, titlu: g.titlu }, k: unit.k, n: unit.n, titlu: lesson.titlu, minute: minutes(unit, raw),
      sursa: { titlu: g.titlu, versiune: g.versiune, url: g.url, pagini: unit.pagini },
      context: lesson.context,
      sectiuni: lesson.sectiuni.map((s) => {
        const expl = new Map((s.explicatii || []).map((e) => [e.ref, e.text]));
        const cards = (ids) => (ids || []).map((r) => card(rows.get(r), expl.get(r) ?? null));
        return { titlu: s.titlu, intro: s.intro, carduri: cards(s.recomandari), argumentare: cards(s.argumentare), puncte_cheie: s.puncte_cheie };
      }),
      cifre: (lesson.cifre || []).map((c) => ({ eticheta: c.eticheta, valoare: c.valoare, sursa: `p. ${pageLabel(rows.get(c.ref))}`, ref: c.ref })),
      perle: lesson.perle,
      quiz: lesson.quiz.map((q) => ({ intrebare: q.intrebare, raspuns: answer(q) })),
    };
  }

  function markRead(id, { quiz } = {}) {
    loadUnit(id);
    if (quiz !== undefined && quiz !== null && !(Array.isArray(quiz) && quiz.length <= 10 && quiz.every((x) => typeof x === 'boolean'))) throw httpError(400, 'quiz');
    const state = load();
    const date = today();
    if (!sets(state).read.has(id)) {
      state.sent.push({ unit: id, data: date, tip: 'lectura' });
      state.sarite = state.sarite.filter((s) => skippedId(s) !== id); // read after all: not skipped
      state.inceput ??= date;
    }
    advance(state);
    save(state);
    const log = fs.existsSync(f('quiz-log.json')) ? readJson(f('quiz-log.json')) : [];
    log.push({ id, date, quiz: quiz ?? null });
    writeJsonAtomic(f('quiz-log.json'), log);
    return status();
  }

  /** The unread units of guideline `nr` move to the cursor, in their order; everything else keeps its order. */
  function setNextGuide(nr) {
    const key = String(nr ?? '').trim().padStart(2, '0');
    const state = load();
    if (!state.plan.some((u) => unitGuideline(u) === key)) throw httpError(404, 'negasit');
    state.plan = reorderPlan(state.plan, state.cursor, [key]);
    advance(state);
    save(state);
    return status();
  }

  function skip(id) {
    loadUnit(id);
    const state = load();
    const { read, skipped } = sets(state);
    if (!read.has(id) && !skipped.has(id)) state.sarite.push({ unit: id, data: today() });
    advance(state);
    save(state);
    return status();
  }

  const requests = () => (fs.existsSync(f('requests.json')) ? readJson(f('requests.json')) : {});
  function requestGenerate(id) {
    loadUnit(id);
    if (loadLesson(id)) return { status: 'scrisa' };
    const r = requests();
    r[id] ??= now().toISOString();
    writeJsonAtomic(f('requests.json'), r);
    return { status: 'in_lucru' };
  }

  /**
   * The unit to write next: a requested unwritten one first, else the first unwritten among the next `lead` units from the cursor.
   * Units in `exclude` (ids the writer gave up on or is resting) are passed over, requested or not.
   */
  function nextMissing(lead = 3, exclude = []) {
    const state = load();
    const { read, skipped } = sets(state);
    const out = new Set(exclude);
    const asked = Object.entries(requests()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id]) => id)
      .find((id) => !out.has(id) && ID_RE.test(id) && fs.existsSync(path.join(unitsDir, `${id}.json`)) && !loadLesson(id));
    const id = asked ?? state.plan.slice(state.cursor).filter((u) => !skipped.has(u) && !read.has(u) && !out.has(u)).slice(0, lead).find((u) => !loadLesson(u));
    return id ? { id, unit: loadUnit(id) } : null;
  }

  let prompt;
  const generatorPrompt = () => (prompt ??= fs.readFileSync(PROMPT_FILE, 'utf8'));

  /** `lessonJson` may be the object or the model's raw text (a code fence around it is tolerated). */
  function parse(lessonJson) {
    if (typeof lessonJson !== 'string') return { lesson: lessonJson };
    const text = lessonJson.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return { lesson: JSON.parse(text) }; } catch (e) { return { error: `JSON invalid: ${e.message}` }; }
  }

  function validate(id, lessonJson) {
    let unit;
    try { unit = loadUnit(id); } catch { return { ok: false, errors: [`unitatea ${id} nu există`], warnings: [], minutes: null }; }
    const { lesson, error } = parse(lessonJson);
    if (error) return { ok: false, errors: [error], warnings: [], minutes: null };
    setCorpusDir(unitsDir);
    const r = validateLesson(unit, lesson);
    return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, minutes: r.info.minutes ?? null };
  }

  function save_(id, lessonJson) {
    const r = validate(id, lessonJson);
    if (!r.ok) throw httpError(422, `lecția ${id} nu e validă:\n  - ${r.errors.join('\n  - ')}`, { errors: r.errors });
    writeJsonAtomic(path.join(lessonsDir, `${id}.json`), parse(lessonJson).lesson);
    const asked = requests();
    if (id in asked) { delete asked[id]; writeJsonAtomic(f('requests.json'), asked); }
    return { id, warnings: r.warnings, minutes: r.minutes };
  }

  /** Key points, figures and quiz questions of the lessons read in the last week (the lessons of status().recap). */
  function recap() {
    const { recap: r } = status();
    const lectii = [];
    const cifre = [];
    const quiz = [];
    setCorpusDir(unitsDir);
    for (const { id } of r.lectii) {
      const raw = loadLesson(id);
      if (!raw) continue;
      const unit = loadUnit(id);
      if (validateLesson(unit, raw).errors.length) continue; // an invalid lesson is not summarised
      const l = get(id);
      lectii.push({ id, titlu: l.titlu, ghid: l.ghid, sectiuni: l.sectiuni.map((s) => ({ titlu: s.titlu, puncte_cheie: s.puncte_cheie })) });
      for (const c of l.cifre) cifre.push({ id, ...c });
      for (const q of l.quiz) quiz.push({ id, ...q });
    }
    return { disponibil: r.disponibil, lectii, cifre, quiz };
  }

  // ---------- spaced review (review.mjs): <dir>/review.json, <dir>/review-flags.jsonl ----------

  const reviewFile = f('review.json');
  /** True when the lesson file exists and still validates. Cached by file time: validating costs ~10 ms a lesson. */
  const validCache = new Map();
  function lessonValid(id) {
    const file = path.join(lessonsDir, `${id}.json`);
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
    const hit = validCache.get(id);
    if (hit?.mtime === mtime) return hit.ok;
    let ok = false;
    try {
      const raw = loadLesson(id);
      setCorpusDir(unitsDir);
      ok = !!raw && validateLesson(loadUnit(id), raw).errors.length === 0;
    } catch { ok = false; }
    validCache.set(id, { mtime, ok });
    return ok;
  }

  /** The review store with a card for every quiz question of every lesson read; saved when cards were added. */
  function reviewStore() {
    const seed = !fs.existsSync(reviewFile); // the first run: lessons read before the review existed are spread out
    const store = seed ? { cards: {}, mutat: null } : readJson(reviewFile);
    store.cards ??= {};
    const first = new Map();
    for (const r of load().sent) if (r.tip === 'lectura' && !first.has(r.unit)) first.set(r.unit, r);
    const reads = [...first.values()].sort((a, b) => String(a.data).localeCompare(String(b.data)));
    const quizLog = fs.existsSync(f('quiz-log.json')) ? readJson(f('quiz-log.json')) : [];
    const marks = (id) => quizLog.findLast((e) => e.id === id)?.quiz ?? null;
    const quizCount = (id) => { const q = loadLesson(id)?.quiz; return Array.isArray(q) ? q.length : 0; };
    if (syncCards(store, { reads, quizCount, marks, today: today(), seed }) || seed) saveReview(store);
    return store;
  }
  function saveReview(store) {
    store.mutat = now().toISOString();
    writeJsonAtomic(reviewFile, store);
  }
  const reviewDue = (store = reviewStore()) => dueIds(store, today(), (id) => lessonValid(splitId(id).lesson));
  function mustCard(store, id) {
    const card = Object.hasOwn(store.cards, String(id)) ? store.cards[id] : null;
    if (!card) throw httpError(404, 'negasit');
    return card;
  }

  /** Today's session: the SESSION most overdue cards, each with its question and the answer as the lesson prints it. */
  function review() {
    const ids = reviewDue();
    const printed = new Map();
    const azi = [];
    for (const id of ids.slice(0, SESSION)) {
      const { lesson, k } = splitId(id);
      if (!printed.has(lesson)) printed.set(lesson, get(lesson));
      const l = printed.get(lesson);
      const q = l.quiz[k - 1];
      if (q) azi.push({ id, lectie: { id: lesson, titlu: l.titlu, ghid: l.ghid }, intrebare: q.intrebare, raspuns: q.raspuns });
    }
    return { scadente: ids.length, azi };
  }

  function reviewAnswer(id, stiut) {
    if (typeof stiut !== 'boolean') throw httpError(400, 'stiut');
    const store = reviewStore();
    answerCard(mustCard(store, id), stiut, today());
    saveReview(store);
    return { scadente: reviewDue(store).length };
  }

  /** "This question is wrong": never served again, and a line for the owner in review-flags.jsonl. */
  function reviewFlag(id) {
    const store = reviewStore();
    mustCard(store, id).semnalat = true;
    saveReview(store);
    fs.appendFileSync(f('review-flags.jsonl'), JSON.stringify({ ts: now().toISOString(), id }) + '\n');
    return { scadente: reviewDue(store).length };
  }

  /** Away for `zile` days: every due date moves that far ahead, so nothing piles up. */
  function reviewPause(zile) {
    if (!Number.isInteger(zile) || zile < 1 || zile > 30) throw httpError(400, 'zile');
    const store = reviewStore();
    pauseCards(store, zile);
    saveReview(store);
    return { scadente: reviewDue(store).length };
  }

  return { review, reviewAnswer, reviewFlag, reviewPause, status, get, markRead, setNextGuide, skip, requestGenerate, nextMissing, generatorPrompt, validate, save: save_, recap };
}
