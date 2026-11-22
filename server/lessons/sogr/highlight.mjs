// Number+unit detection, shared by the HTML highlighter (SPEC §7.4) and the
// validator's invented-dose check (SPEC §6 addition).
import { escapeHtml } from './text.mjs';

// Single units (no slash). A unit is ONE chain "unit(/unit)*" or "unit pe unit" (SPEC-ROUND4 B2): "g/oră" is not "g".
// Matching runs on diacritic-folded text (SPEC-ROUND4 B4), so every entry here is written without diacritics.
const ATOMS = [
  'mmHg', 'mmol', 'mEq', 'mUI', 'mcg', 'mg', 'µg', 'μg', 'ng', 'pg', 'kg', 'UI', 'mL', 'ml', 'dl', 'cm', 'mm', 'min', 'zi', 'g', 'U', 'l', 'h', 'x', 'sec', 'kcal',
  'luna', 'picaturi', 'picatura', 'comprimate', 'comprimat', 'fiole', 'fiola', 'doze', 'doza', 'ori', 'luni', 'ani',
  'saptamani', 'saptamana', 'minute', 'minut', 'zile', 'ore', 'ora', 'secunde',
  'unitati', 'unitate', 'kilograme', 'kilogram', 'grame', 'gram', 'gr', 'miligrame', 'miligram', 'micrograme', 'microgram',
  'mililitri', 'mililitru', 'litri', 'litru', 'centimetri', 'centimetru', 'milimetri', 'milimetru', 'metri', 'metru',
  'procente', 'procent', 'la suta', 'grade', 'bpm',
];
const SPECIALS = ['batai pe minut', 'respiratii pe minut', 'batai/min', 'respiratii/min', '\u00b0 ?C', 'º ?C', '/min', 'x 10\\^9/l', '/mm3', '/mm\u00b3', '/mmc', '/\u00b5l', '/\u03bcl'];
const TIME_ATOMS = 'zi|ora|ore|minut|min|kg|h|l|dl|ml|sec|secunda';
const esc1 = (u) => u.replace(/ /g, '\\s+');
const atomAlt = [...ATOMS].sort((a, b) => b.length - a.length).map(esc1).join('|');
const specAlt = SPECIALS.map((u) => u.replace(/\//g, '\\/').replace(/ (?!\?)/g, '\\s+')).join('|');
const CHAIN = `(?:${atomAlt})(?:\\/[\\p{L}µμ]+|\\s+pe\\s+(?:${TIME_ATOMS})(?![\\p{L}]))*`;
const unitAlt = `${specAlt}|${CHAIN}`;
const NUM = '\\d+(?:[.,]\\d+)*';
const PREFIX = '(?:[≥≤<>]=?\\s?)?';
const UNIT = `(?<unit>%|s\\.a\\.|(?:de\\s+)?(?:SA(?![\\p{L}\\d])|S\\.A\\.)|(?:de\\s+)?(?:${unitAlt})(?![\\p{L}\\d/]))`;
// "între 4 și 6 cm", "de la 24 la 48 de ore": one range figure (SPEC-ROUND5 B4)
const WORD_RANGE = `(?:[Ii]ntre\\s+${NUM}\\s+si\\s+${NUM}|[Dd]e\\s+la\\s+${NUM}\\s+la\\s+${NUM})`;
// ratio "24,5 la 1.000" (SPEC-ROUND6 A.4)
const RATIO = `(?<ratio>${NUM}\\s+la\\s+\\d{1,3}(?:[. \\u00a0]\\d{3})+(?![\\d]))`;
const BODY =
  `(?:${WORD_RANGE}|${PREFIX}${NUM}(?:\\s?[-–]\\s?${NUM})?)` + // range in words, or optional prefix, number, optional hyphen range
  `[\\s\\u00a0]?${UNIT}`;
// blood pressure "140/90 mmHg"; gestational age "13+6", "11-13+6 săptămâni"; risk fractions "1/50", "1/1.000"
const BP = `${PREFIX}(?<bp>\\d{2,3}\\/\\d{2,3}[\\s\\u00a0]?mmHg(?![\\p{L}\\d]))`;
const GA1 = '\\d{1,2}(?:\\+[0-6])?(?:\\s?[-–]\\s?\\d{1,2})?\\+[0-6](?!\\d)';
const GA_UNIT = '(?:[\\s\\u00a0]?(?:saptamani|saptamana|s\\.a\\.|SA|S\\.A\\.))?';
const GA = `(?<ga>(?:[Ii]ntre\\s+${GA1}\\s+si\\s+${GA1}|${GA1})${GA_UNIT})`;
// percentiles are figures too: "sub percentila 10", "p90" (SPEC-ROUND5 B3)
const PCT = '(?<pct>(?:[Pp]ercentil[ae]?|[Cc]entil[ae]?)\\s+\\d{1,2}(?![\\d]|[.,]\\d)|p(?:3|5|10|25|50|75|90|95|97)(?![\\p{L}\\d]|[.,]\\d))';
const FRAC = '(?<frac>1\\/(?:\\d{1,3}(?:[. \\u00a0]\\d{3})+|\\d{2,3})(?![\\d/]))';
const START = '(?<![\\p{L}\\d.,/+])';
export const NUM_UNIT_RE = () => new RegExp(`${START}(?:${BP}|${GA}|${PCT}|${RATIO}|${BODY}|${FRAC})`, 'gu');

/** Strip diacritics one character at a time, so indexes of the result are indexes of the original (SPEC-ROUND4 B4). */
export const foldDiacritics = (s) => s.replace(/[^\u0000-\u007f]/gu, (c) => {
  const d = c.normalize('NFD').replace(/\p{M}/gu, '');
  return d.length === 1 ? d : c;
});

/** Wrap number+unit matches of `text` in <mark>; everything else is HTML-escaped. */
export function highlightHtml(text) {
  let out = '';
  let last = 0;
  for (const m of foldDiacritics(text).matchAll(NUM_UNIT_RE())) {
    out += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(text.slice(m.index, m.index + m[0].length))}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const UNIT_CANON = {
  saptamana: 'sapt', saptamani: 'sapt', 's.a.': 'sapt',
  minute: 'min', minut: 'min', min: 'min', zi: 'zi', zile: 'zi', ore: 'h', ora: 'h', h: 'h',
  doze: 'doza', secunde: 'sec', secunda: 'sec', sec: 'sec', mcg: 'µg', 'μg': 'µg',
  unitati: 'ui', unitate: 'ui', u: 'ui', ui: 'ui',
  kilograme: 'kg', kilogram: 'kg', grame: 'g', gram: 'g', gr: 'g', miligrame: 'mg', miligram: 'mg', micrograme: 'µg', microgram: 'µg',
  mililitri: 'ml', mililitru: 'ml', litri: 'l', litru: 'l', centimetri: 'cm', centimetru: 'cm', milimetri: 'mm', milimetru: 'mm',
  metri: 'm', metru: 'm', procente: '%', procent: '%', 'la suta': '%',
  luna: 'luni', picaturi: 'picatura', comprimate: 'comprimat', fiole: 'fiola',
  grade: '°c', bpm: '/min', sa: 'sapt',
};
const canonAtom = (a) => UNIT_CANON[a] ?? a;
/** One canonical string per unit chain: "g/oră" -> "g/h", "UI pe kg" -> "ui/kg", "bătăi pe minut" -> "/min". */
function canonUnit(raw) {
  const u = raw.replace(/^de\s+/, '').replace(/\s+/g, ' ').toLowerCase().replace(/ ?º ?c$|° ?c$/, '°c');
  if (u === '°c') return u;
  if (/^(?:batai|respiratii)(?: pe minut|\/min)$/.test(u) || u === '/min') return '/min';
  return u.replace(/ pe /g, '/').split('/').map(canonAtom).join('/');
}
const canonNumber = (n) => n.replace(/(?<=\d)\.(?=\d{3}(?!\d))/g, '').replace(',', '.');

/** NFKC both sides (micro sign, non-breaking spaces, ℃ …) and a single mu, so spelling variants compare equal. */
export const normalizeFigures = (s) => s.replace(/º/g, '°')
  .replace(/[x×]\s?10\s?(?:\^\s?9|⁹|9)\s?\/\s?[lL](?![\p{L}\d])/gu, 'x 10^9/l') // "×10⁹/l", "x10 9 /l" (before NFKC flattens the superscript)
  .normalize('NFKC').replace(/μ/g, 'µ');

// "sub 110 sau peste 160 bpm": the unit belongs to the number before the connector too
const SHARED_RE = new RegExp(`(?<![\\p{L}\\d.,/+])(${NUM})\\s+(?:sau|si|ori)\\s+(?:[≥≤<>]=?\\s?|(?:peste|sub|minimum|maximum|cel\\s+putin|cel\\s+mult|dupa|inainte(?:\\s+de)?|mai\\s+(?:mult|putin|mare|mic)(?:\\s+de)?)\\s+)?$`, 'iu');

/**
 * Canonical figures found in `text`: {raw, key, endpoints?, index, end}. key = "<number>|<unit>" (no sign is ever assigned, SPEC-ROUND6); a range is
 * one figure "500-3000|ml" (endpoints lists the bare end keys): it must exist as a range in the source.
 * Used to check that every dose-like figure in LLM text exists in the source unit.
 */
export function numUnitPairs(rawText) {
  const text = normalizeFigures(rawText);
  const folded = foldDiacritics(text); // same indexes as `text`: matching runs folded, `raw` is the original spelling
  const pairs = [];
  let prevEnd = 0; // end of the previous figure: a number inside it cannot be the unitless first half of "A sau B unit"
  for (const m of folded.matchAll(NUM_UNIT_RE())) {
    const from = prevEnd;
    prevEnd = m.index + m[0].length;
    const raw = text.slice(m.index, m.index + m[0].length);
    if (m.groups.ga) { // weeks+days: keep the whole figure, "11-13+6" and "11 - 13+6" are the same
      const core = m.groups.ga.replace(/(?:[\s ]?(?:saptamani|saptamana|s\.a\.))$/i, '').replace(/^intre\s+(\S+)\s+si\s+/i, '$1-').replace(/\s/g, '').replace(/–/g, '-');
      pairs.push({ raw, key: `${core}|ga`, index: m.index, end: m.index + m[0].length });
      continue;
    }
    if (m.groups.ratio) { const [a, b] = m.groups.ratio.split(/\s+la\s+/); pairs.push({ raw, key: `${canonNumber(a)}la${b.replace(/[. \u00a0]/g, '')}|ratio`, index: m.index, end: m.index + m[0].length }); continue; }
    if (m.groups.pct) { pairs.push({ raw, key: `${m.groups.pct.match(/\d+/)[0]}|percentila`, index: m.index, end: m.index + m[0].length }); continue; }
    if (m.groups.frac) { pairs.push({ raw, key: `${m.groups.frac.replace(/[.  ]/g, '')}|frac`, index: m.index, end: m.index + m[0].length }); continue; }
    if (m.groups.bp) { pairs.push({ raw, key: `${m.groups.bp.replace(/\s|mmHg/g, '')}|mmhg`, index: m.index, end: m.index + m[0].length }); continue; }
    const unit = canonUnit(m.groups.unit);
    const numPart = m[0].slice(0, m[0].length - m.groups.unit.length);
    const nums = (numPart.match(/\d+(?:[.,]\d+)*/g) || []).map(canonNumber);
    if (nums.length === 2) { pairs.push({ raw, key: `${nums[0]}-${nums[1]}|${unit}`, endpoints: nums.map((n) => `${n}|${unit}`), index: m.index, end: m.index + m[0].length }); continue; }
    const mine = { raw, key: `${nums[0]}|${unit}`, index: m.index, end: m.index + m[0].length };
    const sh = SHARED_RE.exec(folded.slice(0, m.index));
    if (sh && sh.index >= from) {
      const first = { raw: sh[1], key: `${canonNumber(sh[1])}|${unit}` };
      first.index = sh.index; first.end = sh.index + sh[1].length;
      first.group = mine.group = [first, mine];
      pairs.push(first);
    }
    pairs.push(mine);
  }
  return pairs;
}

/** Telegram "De reținut" item and library cell: `eticheta: valoare` (the card behind it is in the PDF, SPEC-ROUND11 A.2). */
export const cifraLine = (c) => `${c.eticheta}: ${c.valoare}`;
