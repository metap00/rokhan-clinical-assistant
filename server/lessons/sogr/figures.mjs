// Verbatim figures (SPEC-ROUND6). A figure (number + unit chain, percentile, N+d gestational age, ratio …) is valid only in
// the guideline's own words: the comparison/negation vocabulary is used ONLY to find how many words around the figure must
// travel with it ("required span"); no sign is ever assigned, translated or compared.
import { fixDiacritics } from './text.mjs';
import { numUnitPairs, foldDiacritics, normalizeFigures } from './highlight.mjs';

/**
 * Matching normalisation: NFC/NFKC, [p. N], bullets, one space. `spanNormKeep` keeps quotes and dashes as printed (used to show the
 * guideline's words back); `spanNorm` also unifies them. Both have the same length, so offsets of one are offsets of the other.
 */
export function spanNormKeep(s) { return spanNormMarked(s).replace(/[\uE000-\uE002]/g, ';'); }
/** Line-break markers of `spanNormMarked` (same length as the ' ; ' of spanNormKeep, so offsets agree): a list item starts / a wrapped line continues / a sentence or paragraph ended. */
const BR_ITEM = '\uE000', BR_WRAP = '\uE001', BR_HARD = '\uE002';
const ITEM_NEXT = /^(?:\d+[.)]|[a-z]\))\s/;
/** Like `spanNormKeep`, but each line break is a private-use character telling what kind of break it was (SPEC-ROUND13 R1 splits sentences with it). */
function spanNormMarked(s) {
  return normalizeFigures(fixDiacritics(s))
    .replace(/^\s*[-•−⬜□]\s+/, '')
    .replace(/[ \t]*\n\s*(?:[-•−⬜□]\s+|o\s+)?/g, (m, off, str) => { // a line / list item ends the clause (SPEC-ROUND7 B3)
      const marker = m.replace(/^[ \t]*\n\s*/, '').length > 0 || ITEM_NEXT.test(str.slice(off + m.length)); // a bullet was swallowed, or a numbered / lettered item follows
      const prev = str.slice(0, off).trimEnd().slice(-1);
      const kind = marker ? BR_ITEM : ((m.match(/\n/g) || []).length >= 2 || /[.!?;]/.test(prev)) ? BR_HARD : BR_WRAP;
      return ` ${kind} `;
    })
    .replace(/\[p\.\s*\d+\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
export const unifyPunct = (s) => s.replace(/[„”“‟«»"]/g, '"').replace(/[‘’‚´`]/g, "'").replace(/[‐‑‒–—―−]/g, '-');
export const spanNorm = (s) => unifyPunct(spanNormKeep(s));

/** SA ≡ săptămâni ≡ săptămâni de amenoree/gestație and "34 de săptămâni" ≡ "34 săptămâni": for comparing two wordings only, never for display (SPEC-ROUND6 A.4). */
const saCanon = (x) => x // input is folded and lower-cased
  .replace(/(?<=\d)\s+(?:de\s+)?(?:sa|s\.a\.)(?![\p{L}\d])/gu, ' saptamani')
  .replace(/(?<=\d)\s+de\s+(?=saptamani|saptamana)/gu, ' ')
  .replace(/(saptamani|saptamana)\s+de\s+(?:amenoree|gestatie)/gu, '$1');
const tight = (x) => saCanon(foldDiacritics(x.toLowerCase())).replace(/([≥≤<>≈])\s+/g, '$1');

// ---- vocabulary (detector only; text is diacritic-folded and lower-cased) ----
const SINGLE = new Set(['peste', 'sub', 'minim', 'minimum', 'maxim', 'maximum', 'depasi', 'depaseste', 'depaseasca', 'depasesc', 'depasind', 'depasit',
  'inainte', 'dupa', 'superior', 'superioara', 'superioare', 'inferior', 'inferioara', 'inferioare', 'decat', 'cel', 'niciodata', 'nici', 'nicio', 'niciun', 'niciuna', 'nu',
  'pana', 'intre', 'incepand', 'primele', '≥', '≤', '>', '<', '≈', '>=', '<=']);
const NEG = new Set(['nu', 'nici', 'nicio', 'niciun', 'niciuna', 'niciodata', 'interzis', 'interzisa', 'interzise', 'interzisi',
  'contraindicat', 'contraindicata', 'contraindicate', 'contraindicati']);
const AFTER_MAI = new Set(['mare', 'mari', 'mic', 'mica', 'mici', 'mult', 'multa', 'multe', 'putin', 'putina', 'putine', 'tarziu', 'devreme']);
const AFTER_CEL = new Set(['mult', 'putin', 'tarziu']);
const LINKERS = new Set(['de', 'decat', 'cu', 'la']);
const SUBORD = new Set(['daca', 'cand', 'deoarece', 'intrucat']); // "Dacă nu sângerează, sub 2 ore": the comma ends the subordinate clause
const CONTRAST = new Set(['iar', 'dar', 'insa']);
const strip = (w) => w.replace(/^[("'„]+|[)"',;:.!?]+$/g, '');

/**
 * Tokens with a clause id (`cl`) and a parenthesis depth. Clause breaks: . ; : ! ? (and the ";" the normaliser puts at every line / list
 * item), "(" and ")" (the text of a finished parenthesis is skipped over, not part of the clause that continues after it), and a comma
 * that ends a subordinate clause or is followed by iar / dar / însă / și apoi. Other commas do not end the clause (SPEC-ROUND7 B1).
 */
function tokenize(lower, cased = lower) {
  const raw = [...lower.matchAll(/\S+?(?:(?<=\.)(?=\()|(?=\s|$))/g)]; // a full stop glued to a citation parenthesis ends the token (SPEC-ROUND8 F3)
  const tk = [];
  let cur = 0, next = 1;
  const stack = [];
  const subord = new Set();
  // sentence restart without punctuation: "… beneficiilor dovedite PS scade …", "… nu poate fi evaluată To Fără …", "… Nu este recomandat Metronidazol 1g …"
  // (a participle / adjective ending a clause, then a short capitalised token or a capitalised word followed by a number). Narrow on purpose:
  // a wrong break would drop a negation, a missed break only makes the required span longer.
  const cap = (j) => cased.slice(raw[j].index, raw[j].index + raw[j][0].length).replace(/[^\p{L}\d]/gu, '');
  const restart = (i) => {
    const w0 = raw[i]?.[0], n1 = raw[i + 1], n2 = raw[i + 2];
    if (!n1 || !/^\p{Ll}{5,}$/u.test(w0) || !/(?:at|ut|it|ite|ate|ute|ise|ice|ită|ată|ută)$/.test(w0)) return false;
    const c1 = cap(i + 1);
    if (/^(?:\p{Lu}{2,4}|\p{Lu}\p{Ll}{1,2})$/u.test(c1) && n2 && /^[\p{L}]/u.test(n2[0])) return /^\p{Ll}/u.test(n2[0]) || /^\p{Lu}/u.test(n2[0]);
    return /^\p{Lu}\p{Ll}{3,}$/u.test(c1) && n2 && /^\d/.test(n2[0]);
  };
  raw.forEach((m, i) => {
    const w0 = m[0], w = strip(w0);
    const opens = (w0.match(/^[("'„]*/)[0].match(/\(/g) || []).length;
    for (let k = 0; k < opens; k++) { stack.push(cur); cur = next++; }
    const t = { s: m.index, e: m.index + w0.length, w, cl: cur, depth: stack.length, comma: /,$/.test(w0) };
    tk.push(t);
    if (SUBORD.has(w)) subord.add(cur);
    const tail = w0.match(/[)"',;:.!?]+$/)?.[0] || '';
    const closes = (tail.match(/\)/g) || []).length;
    for (let k = 0; k < closes; k++) { if (stack.length) cur = stack.pop(); else cur = next++; }
    const hard = /[;:.!?]/.test(tail) && !/^[<>≥≤]/.test(w0);
    const nx = strip(raw[i + 1]?.[0] || '');
    if (restart(i)) cur = next++;
    else if (hard || (w0 === ';')) cur = next++;
    else if (tail.includes(',') && (subord.has(cur) || CONTRAST.has(nx) || (nx === 'si' && strip(raw[i + 2]?.[0] || '') === 'apoi'))) cur = next++;
  });
  const cmp = tk.map(() => false);
  const neg = tk.map(() => false);
  const at = (i) => tk[i]?.w;
  tk.forEach((t, i) => {
    const w = t.w;
    if (SINGLE.has(w) && !(w === 'cel') && !(w === 'pana') && !(w === 'incepand') && !(w === 'primele')) cmp[i] = true;
    if (NEG.has(w) || /^n-/.test(w)) { neg[i] = true; if (SINGLE.has(w) || /^n-/.test(w)) cmp[i] = true; }
    if (w === 'mai' && AFTER_MAI.has(at(i + 1))) { cmp[i] = cmp[i + 1] = true; }
    if (w === 'cel' && AFTER_CEL.has(at(i + 1))) { cmp[i] = cmp[i + 1] = true; }
    if (w === 'pana' && at(i + 1) === 'la') { cmp[i] = cmp[i + 1] = true; }
    if (w === 'in' && at(i + 1) === 'primele') { cmp[i] = cmp[i + 1] = true; }
    if (w === 'incepand' && at(i + 1) === 'cu') { cmp[i] = cmp[i + 1] = true; }
    if (w === 'fara' && /^(a|sa)$/.test(at(i + 1) || '')) { cmp[i] = cmp[i + 1] = true; neg[i] = true; }
    if (w === 'sa' && at(i + 1) === 'nu') { cmp[i] = true; }
  });
  tk.forEach((t, i) => { if (i > 0 && cmp[i - 1] && !cmp[i] && LINKERS.has(t.w) && tk[i - 1].cl === t.cl) cmp[i] = true; });
  return { tk, cmp, neg };
}

const NOUN_STOP = new Set(['de', 'la', 'in', 'pe', 'cu', 'si', 'sau', 'ori', 'din', 'per', 'iar', 'dar', 'insa', 'nu', 'se', 'este', 'sunt', 'a', 'au', 'sa', 'fie', 'ca', 'care', 'pentru', 'dupa', 'inainte', 'peste', 'sub', 'intre', 'pana', 'mai', 'cel', 'sau']);
const lead = (w) => w.length - w.replace(/^[("'„]+/, '').length;
const trail = (w) => w.length - w.replace(/[)"',;:.!?]+$/, '').length;

const NEG_REACH = 12, NEG_MAX = 16, NEG_PHRASE_MAX = 8, MAX_SPAN_WORDS = 20;
const NEG_PHRASE_STOP = new Set(['cu', 'de', 'la', 'in', 'pe', 'din', 'pentru', 'fata', 'comparativ', 'dupa', 'inainte', 'peste', 'sub', 'intre', 'pana', 'sau', 'si', 'iar', 'dar', 'insa', 'care', 'decat', 'ca', 'daca', 'cand', 'fara', 'prin', 'ci', 'dintre']);
const NUMB = '\\d+(?:[.,]\\d+)*';
const BARE_RE = () => new RegExp(`(?<![\\p{L}\\d.,/+])(${NUMB})(?:(\\s?[-–]\\s?|\\s+si\\s+)(${NUMB})|\\s+(?:la|per|din)\\s+(${NUMB})|\\s?[/:]\\s?(${NUMB}))?(?![\\p{L}\\d]|[.,]\\d)`, 'gu'); // 5 = denominator after / or : (SPEC-ROUND8 F2)
const CITATION_RE = /\(\s*\d+(?:\s*[,;–-]\s*\d+)*\s*(?:\)|$|(?=\s*;))/g; // "(1,2,8)", "(171,172" cut at the end of the text: a citation tail never belongs to a span
const canonN = (n) => n.replace(/(?<=\d)\.(?=\d{3}(?!\d))/g, '').replace(',', '.');
const YEARISH = (n) => /^(19|20)\d\d$/.test(n);

/** Text analysis: figures with their required spans. `text` must already be normalised (spanNorm). */
export function analyse(text, orig = text) {
  const folded = foldDiacritics(text);
  const lower = folded.toLowerCase();
  const { tk, cmp, neg } = tokenize(lower, folded);
  const tokAt = (pos) => tk.findIndex((t) => pos >= t.s && pos < t.e);
  const isNum = (i) => i >= 0 && /^\d[\d.,]*$/.test(tk[i]?.w || '');
  const pairs = numUnitPairs(text).filter((p) => p.index !== undefined);
  const inFigure = (i) => pairs.some((p) => tk[i].s >= p.index && tk[i].s < p.end && !(p.group)); // a number that is part of a figure (percentile 10, 4-6 cm) is not the unitless half of a group

  /**
   * negation tokens earlier in the clause of token `a` (finished parentheses are skipped over), ascending. A negation further than
   * NEG_REACH tokens back counts only when no comma lies between it and the figure (past a comma a long enumeration is a new thought);
   * none counts beyond NEG_MAX tokens, so a required span stays readable (≤ 20 words, corpus test).
   */
  function negBefore(a) {
    const out = [];
    let comma = false, n = 0;
    for (let j = a - 1; j >= 0; j--) {
      if (tk[j].cl === tk[a].cl) {
        n++;
        if (neg[j] && n <= NEG_MAX && !(n > NEG_REACH && comma)) out.push(j);
        if (tk[j].comma) comma = true;
      } else if (tk[j].depth > tk[a].depth) continue; else break;
    }
    return out.reverse();
  }

  /**
   * Required span [from, to) of the figure at [start, end), the comparison-only span `cspan`, and its negation state `neg`.
   * `limit` = last token of the previous figure's span: a span never reaches back into another figure.
   */
  function spanFor(start, end, limit = -1) {
    const a0 = tokAt(start), b0 = tokAt(end - 1);
    if (a0 < 0 || b0 < 0) return { span: [start, end], cspan: [start, end], neg: 'pos', negEnd: -1 };
    const symbolic = /^[≥≤<>≈]/.test(folded.slice(start, end));
    const same = (j, i) => tk[j].cl === tk[i].cl;
    const left = (from, sym = false) => {
      // nearest comparison/negation token within 6 tokens, same clause, after the previous figure
      let k = sym ? from : -1;
      if (!sym && from > 0 && same(from - 1, from)) {
        for (let j = from - 1; j >= Math.max(0, from - 6, limit + 1); j--) {
          if (!same(j, from)) break;
          if (cmp[j]) { k = j; break; }
        }
      }
      if (k < 0) return from;
      while (k > 0 && k - 1 > limit && cmp[k - 1] && same(k - 1, k)) k--;
      return k;
    };
    // comparison phrase
    let c = symbolic ? left(a0, true) : left(a0);
    let cext = c < a0;
    // negation anywhere earlier in the clause (after the previous figure): the span starts at the earliest one
    const negs = negBefore(a0);
    const anchor = negs.find((j) => j > limit);
    let a = c, extended = cext;
    if (anchor !== undefined && anchor < a) {
      a = anchor;
      while (a > 0 && a - 1 > limit && cmp[a - 1] && same(a - 1, a)) a--;
      extended = true;
    }
    // restrictive "nu … decât": the figure after "decât" is positive
    const comparative = (j) => AFTER_MAI.has(tk[j - 1]?.w) && tk[j - 2]?.w === 'mai' || (tk[j - 1]?.w === 'de' && AFTER_MAI.has(tk[j - 2]?.w) && tk[j - 3]?.w === 'mai'); // "mai mică (de) decât": SPEC-ROUND8 N1
    const restrictive = negs.length > 0 && tk.some((t, j) => j > negs[0] && j < a0 && t.w === 'decat' && t.cl === tk[a0].cl && !comparative(j));
    // 'neg' = negation earlier in the clause; 'after' = none earlier but one follows the figure in the same clause ("după 16 săptămâni nu a avut beneficiu"): such a clause cannot license a plain positive statement
    let negState = negs.length > 0 && !restrictive ? 'neg' : 'pos';
    let negEnd = -1;
    if (negState === 'pos' && !restrictive) {
      for (let j = b0 + 1, n = 0; j < tk.length && n < NEG_MAX; j++, n++) {
        if (tk[j].cl !== tk[b0].cl) { if (tk[j].depth > tk[b0].depth) continue; break; }
        if (/\d/.test(tk[j].w) || CONTRAST.has(tk[j].w)) break; // another figure (or a contrasting clause) starts: a negation after that point is not this figure's
        if (neg[j]) {
          if (tk.slice(j, j + NEG_PHRASE_MAX + 1).some((x) => x.cl === tk[j].cl && /\d/.test(x.w))) break; // the negation governs a figure that follows
          // the negated phrase: the negation, its verb and object, up to a preposition / conjunction / relative or the end of the clause
          let k = j;
          for (let m = j + 1; m < tk.length && m - j <= NEG_PHRASE_MAX && tk[m].cl === tk[j].cl && tk[m].w !== '' && !NEG_PHRASE_STOP.has(tk[m].w) && !tk[k].comma; m++) k = m;
          if (k - a + 1 > MAX_SPAN_WORDS) break; // too far to be this figure's negation: a span stays readable
          negState = 'after'; negEnd = tk[k].e - trail(lower.slice(tk[k].s, tk[k].e));
          break;
        }
      }
    }
    let b = b0, bext = false;
    if (tk[b0 + 1]?.w === 'sau' && tk[b0 + 2]?.w === 'mai' && AFTER_MAI.has(tk[b0 + 3]?.w) && same(b0 + 3, b0)) { b = b0 + 3; bext = true; }
    // grouped figures sharing a unit: "sub 110 sau peste 160 bpm"
    if (a > 1 && a - 2 > limit && /^(sau|si|ori)$/.test(tk[a - 1].w) && isNum(a - 2) && same(a - 2, a) && !inFigure(a - 2)) {
      const g = left(a - 2); a = g; c = Math.min(c, g); extended = cext = true;
    }
    const pos = (idx, ext0) => (!ext0 && idx === a0 ? start : tk[idx].s + lead(lower.slice(tk[idx].s, tk[idx].e)));
    const to = !bext && b === b0 ? end : tk[b].e - trail(lower.slice(tk[b].s, tk[b].e));
    // the whole negative clause, even when it reaches back past the previous figure (F1: the negation must travel with every figure it governs)
    let negFrom = -1;
    if (negState === 'neg') { let a2 = negs[0]; while (a2 > 0 && cmp[a2 - 1] && same(a2 - 1, a2)) a2--; negFrom = Math.min(pos(a2, true), start); }
    return { negFrom, span: [Math.min(pos(a, extended), start), Math.max(to, end, negEnd)], cspan: [Math.min(pos(c, c < a0), start), Math.max(to, end)], neg: negState, negEnd };
  }

  // figures and bare numbers in order, so every span can stop at the previous one
  const items = [];
  const groups = new Map();
  for (const p of pairs) {
    const f = { start: p.index, end: p.end, key: p.key.replace(/^[≥≤<>]/, ''), endpoints: p.endpoints, text: text.slice(p.index, p.end), group: p.group };
    items.push(f);
  }
  const citations = [...folded.matchAll(CITATION_RE)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of folded.matchAll(BARE_RE())) {
    const st = m.index, en = m.index + m[0].length;
    if (items.some((f) => !f.bare && st < f.end && en > f.start)) continue;
    if (citations.some(([a, b]) => st >= a && en <= b)) continue;
    if (m[5] !== undefined && YEARISH(m[5])) continue; // a date "12/2019" is not a ratio
    let f;
    if (m[3] !== undefined && /^\s+si\s+$/.test(m[2]) && !/(?:^|\s)intre(?:\s+\S+){0,3}\s+$/.test(lower.slice(0, st))) { // "4 și 5" outside "între …": two numbers, not a range
      const s2 = en - m[3].length;
      items.push({ kind: 'single', key: `${m[1]}|`, start: st, end: st + m[1].length, text: m[1], bare: true }, { kind: 'single', key: `${m[3]}|`, start: s2, end: en, text: m[3], bare: true });
      continue;
    }
    if (m[3] !== undefined) f = { kind: 'range', key: `${canonN(m[1])}-${canonN(m[3])}|`, endpoints: [`${canonN(m[1])}|`, `${canonN(m[3])}|`] };
    else if (m[4] !== undefined || m[5] !== undefined) f = { kind: 'ratio', key: `${canonN(m[1])}la${canonN(m[4] ?? m[5])}|ratio` };
    else f = { kind: 'single', key: `${m[1]}|` };
    items.push({ ...f, start: st, end: en, text: m[0], bare: true });
  }
  items.sort((x, y) => x.start - y.start || x.end - y.end);
  const spanEnds = [];
  for (const f of items) {
    const lim = Math.max(-1, ...spanEnds.filter((x) => !(f.group && x.f.group === f.group)).map((x) => x.tok));
    Object.assign(f, spanFor(f.start, f.end, lim));
    if (f.bare && f.kind === 'single') { // a unitless figure carries the noun it counts: "nu mai mult de 2 embrioni" (SPEC-ROUND8 F3)
      const t = tokAt(f.end - 1);
      const nx = tk[t + 1], nx2 = tk[t + 2];
      const noun = (x) => x && x.cl === tk[t].cl && /^\p{L}{3,}$/u.test(x.w) && !NOUN_STOP.has(x.w);
      let n = -1;
      if (noun(nx)) n = t + 1;
      else if (nx?.w === 'de' && nx.cl === tk[t].cl && noun(nx2)) n = t + 2;
      if (n >= 0 && tk[n].e > f.span[1]) { const e = tk[n].e - trail(lower.slice(tk[n].s, tk[n].e)); f.span[1] = e; }
    }
    spanEnds.push({ f, tok: tokAt(f.span[1] - 1) });
    if (f.group) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); }
  }
  for (const members of groups.values()) {
    const s = Math.min(...members.map((m) => m.span[0])), e = Math.max(...members.map((m) => m.span[1]));
    const cs = Math.min(...members.map((m) => m.cspan[0])), ce = Math.max(...members.map((m) => m.cspan[1]));
    for (const m of members) { m.span = [s, e]; m.cspan = [cs, ce]; }
  }
  const figs = items.filter((f) => !f.bare);
  const barePool = items.filter((f) => f.bare);

  /** bare numbers (no unit next to them) inside [s, e) that are not part of a figure and not the unitless half of a group */
  function bare(s, e) {
    return barePool.filter((f) => {
      if (f.start < s || f.end > e) return false;
      const nextFig = figs.find((x) => x.start >= f.end);
      if (nextFig && /^\s+(?:sau|si|ori)(?:\s+[a-z≥≤<>≈]+){0,3}\s+$/.test(lower.slice(f.end, nextFig.start))) return false;
      return true;
    });
  }
  return { text, orig, figs, bare, negBefore, lower, tk };
}

const isAlnum = (c) => c !== undefined && /[\p{L}\d]/u.test(c);
/** Offsets where `needle` occurs in `hay` as whole words / whole numbers (lower-cased inputs). */
export function occurrences(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay.slice(0, i), after = hay.slice(i + needle.length);
    const f = needle[0], l = needle[needle.length - 1];
    if (isAlnum(f) && (isAlnum(before.at(-1)) || /\d[.,]$/.test(before) || /\d\s?-$/.test(before))) continue;
    if (isAlnum(l) && (isAlnum(after[0]) || /^[.,]\d/.test(after) || /^\s?-\d/.test(after) || /^\/\p{L}/u.test(after))) continue;
    out.push([i, i + needle.length]);
  }
  return out;
}

/**
 * The original (not normalised) text behind the normalised span [a, b) of `text`, so that a message can be copied verbatim (µ/μ, º/°,
 * ş/ș … stay as printed). Falls back to the normalised text when the two cannot be aligned.
 */
export function originalSlice(text, a, b) {
  const norm = spanNormKeep(text);
  const fallback = norm.slice(a, b);
  const L = (i) => spanNormKeep(`${text.slice(0, i)}\u0001`).length - 1;
  let s = -1, e = -1;
  for (let i = 1; i <= text.length; i++) {
    const l = L(i);
    if (s < 0 && l > a) s = i - 1;
    if (l >= b) { e = i; break; }
  }
  if (s < 0 || e < 0) return fallback;
  const cand = text.slice(s, e).trim().replace(/^[-•−⬜□]\s+/, ''); // a list marker is not part of the guideline's words
  return spanNorm(cand).toLowerCase() === unifyPunct(fallback).toLowerCase() ? cand : fallback;
}

// ---- F3: list items under a negated header (SPEC-ROUND12) ----
const NEG_HEADER = /(?:^|[^a-z])(nu(?! neaparat)|nici|nicio|niciun|niciodata|fara|contraindicat\w*|interzis\w*|evit\w*|nerecomandat\w*)(?![a-z])/;
const CONDITION_BEFORE = /(?:^|[^a-z])(?:daca|cand|care|unde|deoarece|intrucat|conditia)(?![a-z])/;
/**
 * Regions of the normalised block text `q` that are list items under a header line ending in ":" which carries a negation ("Nu recomandăm
 * NVDC următoarelor gravide:"). A negation after a subordinator ("dacă pacienta nu prezintă alergii:") only states a condition and does not count.
 * @returns {{from:number,to:number,header:string}[]}
 */
export function negatedRegions(q) {
  const segs = [];
  for (let at = 0; at <= q.length;) {
    const i = q.indexOf(' ; ', at);
    const end = i < 0 ? q.length : i;
    segs.push([at, end]);
    if (i < 0) break;
    at = i + 3;
  }
  const out = [];
  // from the first negated header to the end of the block: a nested sub-header does not lift the negation
  for (const [k, [a, b]] of segs.entries()) {
    const text = q.slice(a, b);
    if (!/:\s*$/.test(text) || k >= segs.length - 1) continue;
    // a header sentence may be wrapped over several lines: take the lines back to the previous sentence end
    let from = a;
    for (let j = k - 1; j >= 0 && !/[.!?:;]\s*$/.test(q.slice(segs[j][0], segs[j][1])); j--) from = segs[j][0];
    const whole = q.slice(from, b);
    const f = foldDiacritics(whole).toLowerCase().split(/[.!?]\s+/).pop(); // the last sentence: an earlier sentence's negation is not the list's
    const m = NEG_HEADER.exec(f);
    if (m && !CONDITION_BEFORE.test(f.slice(0, m.index + 1))) { out.push({ from: b, to: q.length, header: whole.split(/[.!?]\s+/).pop().replace(/^\s*\([\d,;\s–-]+\)\s*;?\s*/, '').replace(/ ; /g, ' ') }); break; }
  }
  return out;
}
// ---- R1: conservative rule (SPEC-ROUND13) ----
/**
 * Negation / restriction words (folded, lower case). A figure whose sentence — or, for a list item, whose header — holds one of them anywhere,
 * before or after the figure, is not a `cifre` entry: no span or scope is parsed. Superset of the spec's list on purpose: exclu[sd]* (exclusiv,
 * excludere), contra-indic*, abtin*.
 */
const LEXICON_WORDS = ['nu', 'nici\\w*', 'fara', 'niciodata', 'contra-?indic\\w*', 'evit\\w*', 'interzi\\w*', 'abtin\\w*', 'renunt\\w*', 'exclu[sd]\\w*', 'inutil\\w*', 'ineficient\\w*',
  'nejustificat\\w*', 'nerecomandat\\w*', 'neindicat\\w*',
  // review 12: negated gerunds and "nemai-" ("riscul nefiind mai mare după 5 ani", "neavând", "neexistând", "neputând")
  'ne[a-z]+(?:and|ind)', 'nemai[a-z]*'];
export const LEXICON_RE = new RegExp(`(?<![a-z])(?:${LEXICON_WORDS.join('|')})(?![a-z])|(?<![a-z])n-`);
/** The first lexicon word of a string (diacritics folded here), or null. */
export const lexiconWord = (s) => LEXICON_RE.exec(foldDiacritics(s).toLowerCase())?.[0] ?? null;

/**
 * Sentences of a block as `spanNormMarked` text: split at . ? ! (followed by a capital, digit or bracket) and ; outside parentheses, at a paragraph
 * break and at every list item. A wrapped line does not split; a colon does not split. An item remembers its headers: the last non-item
 * sentence before the list and the items of the list that end with ":".
 */
function sentencesOf(qm) {
  const sents = [];
  let from = 0, depth = 0, nextItem = false;
  const push = (to, item) => { const text = qm.slice(from, to).replace(/[\uE000-\uE002]/g, ' '); if (text.trim()) sents.push({ from, to, text, item }); }; // blank pieces (a break right after a ';') are not sentences
  for (let i = 0; i <= qm.length; i++) {
    const c = qm[i];
    if (c === undefined) { if (i > from) push(i, nextItem); break; }
    if (c >= '\uE000' && c <= '\uE002') {
      if (i > from) push(i, nextItem);
      from = i + 1; depth = 0; nextItem = c === '\uE000';
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ((c === ';') || (/[.?!]/.test(c) && (i === qm.length - 1 || /^ (?:[\p{Lu}\d[(„"«]|[\uE000-\uE002])/u.test(qm.slice(i + 1, i + 3)))))) {
      const hasWordAfter = qm.slice(from, i).trim().length > 0;
      if (hasWordAfter) { push(i + 1, nextItem); from = i + 1; nextItem = false; } // the rest of a list item after a full stop is no longer under the header
    }
  }
  sents.forEach((x, k) => {
    x.hdr = [];
    if (!x.item) return;
    let j = k - 1;
    while (j >= 0 && sents[j].item) { if (/:\s*$/.test(sents[j].text)) x.hdr.push(j); j--; }
    if (j >= 0) x.hdr.push(j);
  });
  return sents;
}
const sentCache = new Map();
function sentencesFor(text) {
  let hit = sentCache.get(text);
  if (!hit) {
    const qm = unifyPunct(spanNormMarked(text));
    hit = { qm, sents: sentencesOf(qm) };
    if (sentCache.size > 2000) sentCache.clear();
    sentCache.set(text, hit);
  }
  return hit;
}
/** A window of the guideline's words around the lexicon word `w` found in `text`. */
function lexiconContext(text, w) {
  const i = foldDiacritics(text).toLowerCase().search(LEXICON_RE);
  const words = [...text.matchAll(/\S+/g)];
  const k = Math.max(0, words.findIndex((m) => m.index + m[0].length > i));
  return words.slice(Math.max(0, k - 2), k + 4).map((m) => m[0]).join(' ');
}
/**
 * Does the sentence holding [a, b) of the block text (or, for a list item, its header) hold a negation / restriction word?
 * `text` is the block text; [a, b) are offsets in its `spanNorm` form. Returns {word, shown} or null.
 */
export function lexiconHit(text, a, b) {
  const { sents } = sentencesFor(text);
  for (const [k, x] of sents.entries()) {
    if (x.to <= a || x.from >= b) continue;
    for (const j of [k, ...x.hdr]) {
      const w = lexiconWord(sents[j].text);
      if (w) return { word: w, shown: lexiconContext(sents[j].text, w) };
    }
  }
  return null;
}
const lexiconMessage = (hit) => `cifra se află într-o propoziție cu negație sau restricție („${hit.shown}”); nu o pune în tabel, rândul apare oricum ca card`;
const headerShown = (h) => `${h.split(' ').slice(0, 4).join(' ')} …`;
const underNegatedHeader = (q, pos) => negatedRegions(q).find((r) => pos >= r.from && pos < r.to);
/** The characters the guideline prints for a valoare that validated: the block's own text, never the writer's string (SPEC-ROUND12 F2). */
export function shownValoare(blockText, valoare) {
  const v = fixDiacritics(valoare).trim();
  const t = fixDiacritics(blockText);
  const i = t.indexOf(v);
  if (i < 0) throw new Error(`cifre.valoare „${valoare}” nu este copiată exact din rând; lecția nu se tipărește`);
  return t.slice(i, i + v.length);
}

/**
 * Why `valoare` is not an acceptable figure of the block text `citat` (SPEC-ROUND6 A, ROUND11 A.2), or null. `valoare` must be a verbatim
 * fragment of the block that holds a whole figure together with the comparison/negation words the guideline puts around it (the negation
 * earlier in the clause, the whole range, the negated phrase that follows the figure). `opts.label` names the source in messages.
 */
export function valoareProblem(valoare, citat, opts = {}) {
  const label = opts.label ?? 'citat';
  const qk = spanNormKeep(citat), q = unifyPunct(qk), v = spanNorm(valoare);
  if (!v) return 'valoare goală';
  const A = analyse(q, qk);
  const copyThis = (span) => `scrie „${originalSlice(citat, span[0], span[1])}” (copiat din ${label})`;
  const ql = q.toLowerCase(), vl = v.toLowerCase();
  // "> 9,8 cm" and ">9,8 cm" are the same text (spacing after a symbol is typography, the symbol itself must be the block's)
  const variants = [...new Set([vl, vl.replace(/([≥≤<>≈])\s+(?=\d)/g, '$1'), vl.replace(/([≥≤<>≈])(?=\d)/g, '$1 ')])];
  const occ = variants.flatMap((x) => occurrences(ql, x).map(([a, b]) => [a, b]));
  // one boundary rule for the span builder and the matcher: a fragment that is exactly the required span of a figure is always an occurrence (SPEC-ROUND8 F3)
  for (const f of [...A.figs, ...A.bare(0, q.length)]) {
    const sp = ql.slice(f.span[0], f.span[1]);
    if (variants.includes(sp) && !occ.some(([a, b]) => a === f.span[0] && b === f.span[1])) occ.push([f.span[0], f.span[1]]);
  }
  const exact = occ.some(([a, b]) => [...A.figs, ...A.bare(0, q.length)].some((f) => f.span[0] === a && f.span[1] === b));
  if (v.split(' ').length > 20 && !exact) return `e prea lungă; păstrează doar cifra cu cuvintele ghidului din jurul ei, copiate din ${label}`;
  if (!occ.length) {
    const hint = hintFor(v, A, copyThis);
    return `nu e un fragment copiat literal din ${label} (nu adăuga niciun semn sau cuvânt)${hint ? `; ${hint}` : ''}`;
  }
  // R1: a figure in a sentence (or list header) with a negation / restriction word is never a `cifre` entry; checked before any span advice, so the writer is not asked to copy a longer span first
  if (opts.lexicon !== false) for (const [s, e] of occ) { // `lexicon: false` exists for the span-rule tests only; no caller in bin/ sets it
    const hit = lexiconHit(citat, s, e);
    if (hit) return lexiconMessage(hit);
  }
  const problems = [];
  const good = [];
  for (const [s, e] of occ) {
    const partial = A.figs.find((f) => f.start < e && f.end > s && !(f.start >= s && f.end <= e));
    if (partial) { problems.push(`taie cifra „${partial.text}” din ${label}; ${copyThis(partial.span)}`); continue; }
    const items = [...A.figs.filter((f) => f.start >= s && f.end <= e), ...A.bare(s, e)];
    if (!items.length) { const f = A.figs.find((x) => x.key); problems.push(`nu conține nicio cifră${f ? `; ${copyThis(f.span)}` : ''}`); continue; }
    const missing = items.find((f) => f.span[0] < s || f.span[1] > e);
    if (missing) { problems.push(`lipsesc cuvintele ghidului din jurul cifrei; ${copyThis(missing.span)}`); continue; }
    good.push([s, e]);
  }
  if (!good.length) return problems[0];
  // F2: the writer's string must be the guideline's own characters (NFC + comma diacritics are the only tolerated difference)
  const want = fixDiacritics(valoare).trim();
  const exactOcc = good.filter(([s, e]) => fixDiacritics(originalSlice(citat, s, e)) === want);
  if (!exactOcc.length) return `scrie exact „${originalSlice(citat, good[0][0], good[0][1])}”`;
  // F3: a figure in a list item under a negated header ("Nu recomandăm …:") cannot stand alone (nor can a text that also occurs there: it would be ambiguous)
  const under = exactOcc.map(([s]) => underNegatedHeader(q, s));
  if (under.some(Boolean)) return `cifra se află sub un antet negat („${headerShown(under.find(Boolean).header)}”); nu o pune în tabel, rândul apare oricum ca card`;
  return null;
}

/** For a valoare that is not in the block: the block's own wording of the figures it names. */
function hintFor(v, A, copyThis) {
  const V = analyse(v);
  const spans = [];
  for (const f of [...V.figs, ...V.bare(0, v.length)]) {
    const hit = A.figs.find((x) => x.key === f.key || x.endpoints?.includes(f.key)) || (f.bare ? A.bare(0, A.text.length).find((x) => x.text === f.text) : null);
    if (hit) spans.push(copyThis(hit.span));
  }
  const uniq = [...new Set(spans)];
  return uniq.length ? uniq.join(' / ') : '';
}

// ---- distinct figures of a unit (minimum number of `cifre`) ----
const unitCache = new WeakMap();
function unitAnalysis(unit) {
  let hit = unitCache.get(unit);
  if (!hit) {
    const forms = new Set();
    for (const b of unit.blocuri) {
      if (!b.id || typeof b.text !== 'string') continue;
      const raw = spanNormKeep(b.text);
      const q = unifyPunct(raw);
      const A = analyse(q, raw);
      for (const f of A.figs) {
        // a figure that cannot be quoted does not count towards the minimum: under a negated header (F3), or with the same words also standing in a sentence with a lexicon word (R1: valoareProblem refuses every occurrence)
        const words = q.slice(f.span[0], f.span[1]).toLowerCase();
        if (underNegatedHeader(q, f.start) || occurrences(q.toLowerCase(), words).concat([[f.span[0], f.span[1]]]).some(([a, e]) => lexiconHit(b.text, a, e))) continue; // such a figure cannot be a `cifre` entry (F3), so it does not count towards the minimum
        forms.add(f.key); for (const k of f.endpoints || []) forms.add(k);
      }
    }
    hit = { forms };
    unitCache.set(unit, hit);
  }
  return hit;
}

/** Distinct figure keys in the unit (for the minimum number of `cifre`). */
export const unitFigureCount = (unit) => unitAnalysis(unit).forms.size;

/** Every required span of `text` (figures and bare numbers), for the corpus span test. */
export function requiredSpans(text) {
  const q = spanNorm(text);
  const A = analyse(q, spanNormKeep(text));
  return [...A.figs, ...A.bare(0, q.length)].map((f) => ({ ...f, spanText: A.orig.slice(f.span[0], f.span[1]) }));
}
