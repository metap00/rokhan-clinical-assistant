// Text written by the LLM (SPEC-ROUND11 B): a character allow-list (so no digit of any script, no symbol, no look-alike can pass) and
// a complete ban on number words. Numbers reach the reader only inside the guideline's own blocks (cards, the figures table).
import fs from 'node:fs';
import path from 'node:path';
// vendored: the corpus directory (units/) comes from the app, see setCorpusDir()
let CORPUS_DIR = null;
/** Point the vocabulary / measure-word scan at <dataDir>/lessons/units (null = static lists only). */
export const setCorpusDir = (dir) => { CORPUS_DIR = dir; };
import { fixDiacritics, fold } from './text.mjs';
import { foldDiacritics } from './highlight.mjs';

// ---- B.1 character allow-list ----
const LETTERS = /^[A-Za-zăâîșțĂÂÎȘȚşţŞŢ]$/u;
// SPEC-ROUND12 F1: the only whitespace is a plain space, a line feed and a tab (no U+FEFF / U+200B / U+2009 … that split a word invisibly)
const SPACES = new Set([' ', '\n', '\t']);
const PUNCT = new Set('.,;:!?()„”«»"\'’-–—/…&');
/** First character that is not a letter, Romanian diacritic, space / line feed / tab or one of `. , ; : ! ? ( ) „ ” « » " ' ’ - – — / … &`; null when none. */
export function badChar(text) {
  for (const ch of text.normalize('NFC')) if (!LETTERS.test(ch) && !SPACES.has(ch) && !PUNCT.has(ch)) return ch;
  return null;
}
/** Printable form of a rejected character for messages: invisible ones (spaces, format, control) are named by code point. */
export const showChar = (ch) => (/^[\p{Z}\p{Cf}\p{Cc}\p{Cn}\p{Co}\p{Cs}]$/u.test(ch) ? `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : ch);

// ---- B.2 Roman numerals ----
const ROMAN_VALID = /^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
/** Runs of Roman letters that are Romanian words ("li se recomandă", "vi se va cere", "vii" = plural of viu, "ci", "mi", "mix", "civ"); lower case or Capitalised only. */
export const ROMAN_ALLOWED = new Set(['li', 'vi', 'ci', 'mi', 'vii', 'mix', 'civ']);

// ---- B.3 number words (diacritics folded, lower case) ----
const CARDINAL = new RegExp('^(?:unu|doi|doua|doilea|trei|treilea|treia|patru|patrulea|patra|cinci|cincilea|cincea|sase|saselea|sasea|sapte|saptelea|saptea|' +
  'opt|optulea|noulea|zero|sut(?:a|e|ele|elor|ei|elea|ea)|mii|miile|miilor|miilea|milio\\w*|miliard\\w*|' +
  'amandoi|amandoua|ambele|ambelor|ambii|ambilor|pereche|perechi|duzina|duzini|decada|decade|deceniu|decenii|' +
  '(?:(?:un|doi|doua|trei|pai|patru|cin|cinci|sai|sapte|opt|noua)sprezec(?:e|ea|elea)|(?:un|doi|doua|trei|patru|cin|cinci|sai|pai|sapte|opt|noua)spe|(?:doua|trei|patru|cinci|sai|sapte|opt|noua)zec(?:i|ilea|ea|elea)|zec(?:e|ea|elea|i|ile|ilor|ilea)))$');
/** Words that are number words only in some uses: rejected when the next word is a measure word or "de" (nouă ore) — "noua recomandare", "a opta pentru" pass. */
const NINE_OR_VERB = new Set(['noua', 'opta']);
/** English number words, bis in die abbreviations. */
const ENGLISH = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|twice|thrice|daily|weekly|monthly|bid|tid|qid|od|bis|ter|semel|quater|quarter|quarters|hundreds|thousands|millions|once|dozen|dozens|double|doubled|triple|tripled|tenfold|hundredfold|thousandfold|fold|[a-z]+fold)$/;
const FRACTION = /^(?:sutim[ei]\w*|miim[ei]\w*|jumat\w*|injumat\w*|sfert\w*|sferturi|treim[ei]\w*|doim[ei]\w*|patrim[ei]\w*|optim[ei]\w*|zecim[ei]\w*)$/;
const MULTIPLE = /^(?:inzecit\w*|insutit\w*|inmiit\w*|inzeci\w*|insuti\w*|dubl\w*|tripl\w*|cvadrupl\w*|indoit\w*)$/;
const FREQUENCY = /^(?:bi(?:lunar|anual|annual|enal|zilnic|saptaman)\w*|zilnic\w*|saptaman(?:al|ale|ali)\w*|bisaptaman\w*|lunar\w*|orar(?:a|e|i)?|trimestrial\w*|anual\w*|semestrial\w*)$/;
// "ori de câte ori", "de multe ori", "de câteva ori", "ori" = or are prose; "de <number word> ori" is caught by the number word itself (F6)
const PHRASES = [/\bin die\b/, /\b(?:o|un) ori\b/, /\bde (?:data|dati)\b(?! (?:aceasta|asta|aceea)\b)/, /\bun (?:data|dati)\b/, /\bdin ora in ora\b/, /\bdin zi in zi\b/, /\bzi de zi\b/, /\bdin doua in doua\b/];
/** "la fiecare" / "în fiecare" + a time or measure noun is a frequency ("la fiecare pacientă" is not). */
const EVERY_TIME = new Set(['zi', 'ora', 'saptamana', 'luna', 'an', 'minut', 'secunda', 'trimestru', 'semestru', 'ciclu', 'doza', 'ore', 'zile', 'saptamani', 'luni', 'ani']);
/** "o dată" followed by one of these (or by nothing) is an adverb of frequency ("o dată pe zi"); "o dată probabilă a nașterii" is a noun phrase. */
const DATA_ADVERB_NEXT = new Set(['pe', 'la', 'per', 'in', 'dupa', 'inainte', 'cu', 'si', 'sau', 'iar', 'dar', 'ca', 'daca', 'cand', 'pana', 'peste', 'sub', 'intre', 'de', 'fara', 'se', 'nu', 'mai', 'doar', 'intr', 'pentru']);
const ACRONYMS = new Set(['CMV', 'MCV']);
const GRADE_TOKEN = /^(?:I{1,3}|IV)[ab]$/;
const GRADE_CONTEXT = new Set(['nivel', 'nivelul', 'grad', 'gradul', 'clasa', 'categoria', 'evidenta']);
const SEROTYPE_BEFORE = new Set(['grup', 'grupul', 'hepatita', 'vitamina']);
const SINGLE_LETTERS = new Set(['l', 'I', 'S', 'B', 'Z']);

// ---- B.4 article + measure word ----
/** Round-10 list of measure words (folded). */
const MEASURE_STATIC = ['g', 'gram', 'grame', 'mg', 'µg', 'mcg', 'kg', 'ml', 'mililitri', 'mililitru', 'l', 'litri', 'litru', 'ui', 'unitati', 'mmhg', 'bpm', 'batai', 'meq', 'mmol',
  'procent', 'procente', 'cm', 'mm', 'm', 'ora', 'ore', 'minut', 'minute', 'secunda', 'secunde', 'zi', 'zile', 'saptamana', 'saptamani', 'luna', 'luni', 'an', 'ani',
  'ciclu', 'cicluri', 'doza', 'doze', 'comprimat', 'comprimate', 'fiola', 'fiole', 'picaturi', 'ori', 'data', 'punct', 'puncte', 'procentul'];
/** Words that follow a number in running text without being measures ("34 SA se", "2 poate"): never measure words. */
const NOT_MEASURE = new Set(['a', 'ai', 'am', 'au', 'are', 'nu', 'se', 'sa', 'si', 'sau', 'la', 'in', 'din', 'cu', 'de', 'pe', 'pentru', 'ca', 'daca', 'cand', 'pana', 'fara', 'dupa', 'inainte',
  'este', 'sunt', 'poate', 'ale', 'al', 'cel', 'mai', 'un', 'o', 'iar', 'ci', 'dar', 'insa', 'dintre', 'prin', 'peste', 'sub', 'intre', 'ar', 'va', 'vor', 'fi', 'fost', 'trebuie']);
const ADJECTIVES = new Set(['singur', 'singura', 'intreg', 'intreaga', 'scurt', 'scurta', 'lung', 'lunga', 'bun', 'buna', 'mic', 'mica', 'mare']);
let measureCache = null;
/**
 * Measure words: the static list plus, collected once from the 238 units of the corpus (data/units, not the test world), every token that
 * follows a number — except function words, one-letter tokens and ordinary nouns (a token that follows a number fewer than three times or in less than a tenth of its
 * occurrences, e.g. "sarcina", "caz": "o sarcină" is prose, not a quantity).
 */
export function measureWords(dir = CORPUS_DIR) {
  if (measureCache?.dir === dir) return measureCache.set;
  const set = new Set(MEASURE_STATIC);
  try {
    const after = new Map(), total = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const text = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).blocuri.map((b) => b.text).join('\n');
      for (const m of text.matchAll(/[\p{L}µ°%]+/gu)) { const w = fold(m[0]); total.set(w, (total.get(w) || 0) + 1); }
      for (const m of text.matchAll(/\d(?:[.,]\d+)*\s?(?:de\s+)?([\p{L}µ°%]+)/gu)) { const w = fold(m[1]); after.set(w, (after.get(w) || 0) + 1); }
    }
    for (const [w, n] of after) if (w.length > 1 && !NOT_MEASURE.has(w) && n >= 3 && n / (total.get(w) || n) >= 0.1) set.add(w);
  } catch { /* no corpus on this machine: the static list only */ }
  measureCache = { dir, set };
  return set;
}

const shownOf = (text, from, to) => text.slice(from, to).replace(/\s+/g, ' ');
const WORDS_MSG = (shown) => `număr scris în litere („${shown}”); numerele, chiar în litere, apar doar în carduri și în tabelul de cifre`;

// ---- SPEC-ROUND13 R3 ----
/** Count nouns that make "nouă paciente", "V comprimate" a quantity (besides the measure words). */
const COUNT_NOUNS = new Set(['paciente', 'pacienti', 'femei', 'cazuri', 'capsule', 'tablete', 'ampule', 'sarcini', 'nasteri', 'persoane', 'flacoane', 'plicuri', 'comprimate', 'comprimat']);
/** Nouns of time / sequence: "ziua a opta", "luna a noua" (ordinal after the noun). */
const ORDINAL_NOUNS = new Set(['zi', 'ziua', 'zilei', 'luna', 'lunii', 'saptamana', 'saptamanii', 'ora', 'orei', 'doza', 'dozei', 'etapa', 'faza', 'treapta', 'perioada', 'trimestrul', 'zile', 'saptamani', 'luni', 'ore']);
const ROMAN_LETTERS = /^[VCDMLX]$/;
const LETTER_BEFORE_OK = new Set(['grup', 'grupul', 'hepatita', 'vitamina', 'vitaminele', 'tip', 'tipul', 'factor', 'factorul', 'clasa', 'clasei', 'tipurile']);
/** Short function words that legitimately sit side by side ("să se" reads as `sase` when glued): never pieces of a split number word. */
const FUNCTION_PIECES = new Set(['sa', 'se', 'si', 'la', 'le', 'li', 'a', 'o', 'i', 'ai', 'au', 'ar', 'va', 'mi', 'ti', 'ne', 'nu', 'de', 'pe', 'cu', 'in', 'ce', 'ca', 'al', 'un', 'ii', 'te', 'ia', 'ma', 'ea', 'ei', 'el']);
const isNumberWord = (f) => CARDINAL.test(f) || ENGLISH.test(f) || FRACTION.test(f) || MULTIPLE.test(f) || FREQUENCY.test(f);
let vocabCache = null;
/** Every word (folded) of the corpus: a piece of a number word split by a space ("do uă") is not a word of the guideline. */
function vocabulary(dir = CORPUS_DIR) {
  if (vocabCache?.dir === dir) return vocabCache.set;
  const set = new Set();
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const text = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).blocuri.map((b) => b.text).join('\n');
      for (const m of text.matchAll(/\p{L}+/gu)) set.add(fold(m[0]));
    }
  } catch { /* no corpus: only the hyphen / single-letter checks */ }
  vocabCache = { dir, set };
  return set;
}
/**
 * Number words hidden by separators (R3): letters joined across hyphens / full stops ("do-uă", "do.uă", "b.i.d."), runs of single letters
 * ("p a t r u", "q.d.s."), and a number word cut in two or three pieces by spaces ("do uă") when a piece is not a word of the corpus.
 */
function splitNumberWord(G, tokens, plainGap) {
  for (const m of G.matchAll(/[A-Za-z]+(?:[-–—.][A-Za-z]+)+/g)) {
    const f = m[0].replace(/[^A-Za-z]/g, '').toLowerCase();
    if (isNumberWord(f)) return WORDS_MSG(m[0]);
  }
  for (const m of G.matchAll(/(?<![A-Za-z])[A-Za-z](?![A-Za-z])(?:[ \t.\-–—]+[A-Za-z](?![A-Za-z]))+/g)) {
    const f = m[0].replace(/[^A-Za-z]/g, '').toLowerCase();
    if (f.length >= 3 || isNumberWord(f)) return `litere separate care formează un cuvânt („${m[0]}”); scrie cuvântul întreg, fără numere în litere`;
  }
  const vocab = vocabulary();
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const n of [2, 3]) {
      const piece = tokens.slice(i, i + n);
      if (piece.length < n || !piece.every((x, k) => k === 0 || plainGap(i + k - 1, i + k))) continue;
      const f = piece.map((x) => x.f).join('');
      if (f.length >= 3 && isNumberWord(f) && !piece.every((x) => FUNCTION_PIECES.has(x.f)) && (piece.some((x) => !vocab.has(x.f)) || piece.some((x) => x.f.length <= 2)) && !isNumberWord(piece[0].f)) return WORDS_MSG(G.slice(piece[0].s, piece.at(-1).e));
    }
  }
  return null;
}

/**
 * First problem of a string written by the LLM, or null. Order: character, Roman numeral, single letter, number word, article + measure word.
 * The messages tell the writer which word to take out; none of them tells a number.
 */
export function proseProblem(raw, measures = measureWords()) {
  const text = fixDiacritics(raw);
  const bad = badChar(text);
  if (bad !== null) return `caracter nepermis în text scris de tine („${showChar(bad)}”); folosește doar litere și semne de punctuație`;
  const G = foldDiacritics(text); // same indexes as `text`
  const tokens = [...G.matchAll(/[A-Za-z]+/g)].map((m) => ({ w: m[0], f: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length }));
  const next = (i) => tokens[i + 1];
  const plainGap = (x, y) => /^[ \n\t]+$/.test(G.slice(tokens[x].e, tokens[y].s));
  const nextIs = (i, set) => { const n = next(i); return !!n && plainGap(i, i + 1) && set(n.f); };
  const hidden = splitNumberWord(G, tokens, plainGap);
  if (hidden) return hidden;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    if (t.w.length >= 2 && /^[IVXLCDMivxlcdm]+$/.test(t.w) && ROMAN_VALID.test(t.f)) {
      const ok = (ROMAN_ALLOWED.has(t.f) && (t.w === t.f || t.w === t.f[0].toUpperCase() + t.f.slice(1))) || ACRONYMS.has(t.w);
      if (!ok) return `cifră romană în text scris de tine („${t.w}”); numerele, chiar cu cifre romane, apar doar în carduri și în tabelul de cifre`;
    }
    // grade words (Ia, IIb …) only in a "nivel …" phrase: elsewhere they read as numbers
    if (GRADE_TOKEN.test(t.w) && !tokens.slice(Math.max(0, i - 3), i).some((x) => GRADE_CONTEXT.has(x.f))) {
      return `cifră romană în text scris de tine („${t.w}”); numerele, chiar cu cifre romane, apar doar în carduri și în tabelul de cifre`;
    }
    if (t.w.length === 1 && SINGLE_LETTERS.has(t.w) && !/[-'’]/.test(G[t.s - 1] ?? '') && !/[-'’]/.test(G[t.e] ?? '')) {
      const named = t.w === 'B' && prev && plainGap(i - 1, i) && SEROTYPE_BEFORE.has(prev.f); // "grup B", "hepatita B", "vitamina B"
      if (!named) return `literă singură folosită ca cifră („${shownOf(text, t.s, next(i) ? next(i).e : t.e)}”); scrie cuvântul întreg`;
    }
    if (ROMAN_LETTERS.test(t.w) && !/[-'’]/.test(G[t.s - 1] ?? '') && !/[-'’]/.test(G[t.e] ?? '') && !(prev && plainGap(i - 1, i) && LETTER_BEFORE_OK.has(prev.f)) && nextIs(i, (f) => measures.has(f) || COUNT_NOUNS.has(f))) {
      return `literă singură folosită ca cifră („${shownOf(text, t.s, next(i).e)}”); scrie cuvântul întreg`; // "V comprimate"
    }
    if (NINE_OR_VERB.has(t.f)) {
      if (prev?.f === 'a' && tokens[i - 2] && ORDINAL_NOUNS.has(tokens[i - 2].f) && plainGap(i - 2, i - 1) && plainGap(i - 1, i)) return WORDS_MSG(text.slice(tokens[i - 2].s, t.e)); // "ziua a opta"
      if (nextIs(i, (f) => f === 'de' || measures.has(f) || COUNT_NOUNS.has(f))) return WORDS_MSG(text.slice(t.s, next(i).e));
      continue;
    }
    if (t.f === 'una' || t.f === 'unul') {
      if (nextIs(i, (f) => f === 'dintre' || f === 'din')) continue; // "una dintre cauze"
      return WORDS_MSG(text.slice(t.s, t.e));
    }
    if (t.f === 'mie') {
      if (prev && plainGap(i - 1, i) && prev.f === 'o') return WORDS_MSG(text.slice(prev.s, t.e)); // "o mie"; "mie mi se pare" is the pronoun
      continue;
    }
    if (CARDINAL.test(t.f) || ENGLISH.test(t.f) || FRACTION.test(t.f) || MULTIPLE.test(t.f) || FREQUENCY.test(t.f)) return WORDS_MSG(text.slice(t.s, t.e));
    if ((t.f === 'la' || t.f === 'in') && nextIs(i, (f) => f === 'fiecare')) {
      const n2 = tokens[i + 2];
      if (n2 && plainGap(i + 1, i + 2) && (EVERY_TIME.has(n2.f) || measures.has(n2.f))) return WORDS_MSG(text.slice(t.s, n2.e));
    }
    if (t.f === 'o' && nextIs(i, (f) => f === 'data' || f === 'dati')) {
      const n2 = tokens[i + 2];
      if (!n2 || !plainGap(i + 1, i + 2) || DATA_ADVERB_NEXT.has(n2.f) || measures.has(n2.f)) return WORDS_MSG(text.slice(t.s, n2 && plainGap(i + 1, i + 2) ? n2.e : tokens[i + 1].e));
    }
  }
  const words = tokens.map((t) => t.f).join(' ');
  for (const re of PHRASES) {
    const m = re.exec(words);
    if (!m) continue;
    const from = words.slice(0, m.index).split(' ').filter(Boolean).length; // index of the first token of the phrase
    const to = from + m[0].split(' ').length - 1;
    return WORDS_MSG(text.slice(tokens[from].s, tokens[to].e));
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.f !== 'un' && t.f !== 'o') continue;
    const gap = (a, b) => /^[\s„”«»"'’()\-–—/]+$/.test(G.slice(tokens[a].e, tokens[b].s)); // quotes, brackets and dashes between the article and the noun do not hide it (F4)
    const n1 = next(i);
    if (!n1 || !gap(i, i + 1)) continue;
    if (n1.f !== 'data' && n1.f !== 'dati' && measures.has(n1.f)) return `valoare medicală scrisă în litere („${text.slice(t.s, n1.e)}”); numerele, chiar în litere, apar doar în carduri și în tabelul de cifre`;
    const n2 = tokens[i + 2];
    if (ADJECTIVES.has(n1.f) && n2 && gap(i + 1, i + 2) && measures.has(n2.f)) return `valoare medicală scrisă în litere („${text.slice(t.s, n2.e)}”); numerele, chiar în litere, apar doar în carduri și în tabelul de cifre`;
  }
  return null;
}
