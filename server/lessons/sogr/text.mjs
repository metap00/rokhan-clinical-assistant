// Text normalisation helpers.

/** Cedilla -> comma diacritics, NFC. */
export function fixDiacritics(s) {
  return s.normalize('NFC')
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș')
    .replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');
}

/** ASCII-fold + lowercase, for keyword matching only. */
export function fold(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const GRADE_RE = '(?:Ia|Ib|IIa|IIb|III|IV|A|B|C|E)';

/**
 * Normalisation used when comparing LLM-quoted strings with unit text:
 * NFC, comma diacritics, lowercase, [p. N] markers and grade tokens removed,
 * whitespace collapsed.
 */
export function normalizeForMatch(s) {
  return fixDiacritics(s)
    .replace(/\[p\.\s*\d+\]/g, ' ')
    .replace(new RegExp(`\\s{2,}${GRADE_RE}\\s*$`, 'gm'), ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const countWords = (s) => (s.match(/\S+/g) || []).length;

export function slugify(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isCaps = (w) => w.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase();

/**
 * "1 Introducere → 5 Evaluare (5.1–5.3)" from the unit's headings. A shouted heading becomes sentence case,
 * but an acronym (all capitals, at most 6 letters) stays when the unit's own text writes it that way on its own
 * (RCIU, HIV, CTG), as opposed to inside a shouted phrase. Short words like "ȘI" or "CU" are told apart that way.
 */
export function sectionSummary(blocks) {
  const acr = new Set();
  for (const b of blocks) {
    if (b.tip === 'heading' || typeof b.text !== 'string') continue;
    const w = b.text.match(/\p{L}+/gu) ?? [];
    w.forEach((x, i) => { if (x.length <= 6 && isCaps(x) && !isCaps(w[i - 1] ?? '') && !isCaps(w[i + 1] ?? '')) acr.add(x); });
  }
  const sentence = (t) => {
    const s = t.toLowerCase().replace(/\p{L}+/gu, (w) => (acr.has(w.toUpperCase()) ? w.toUpperCase() : w));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const parts = [];
  let cur = null;
  for (const b of blocks) {
    if (b.tip !== 'heading') continue;
    if (b.level === 1 || (b.level === 2 && b.anexa)) {
      cur = { label: b.anexa ? b.num : `${b.num ? b.num + ' ' : ''}${b.text === b.text.toUpperCase() ? sentence(b.text) : b.text}`, subs: [] };
      parts.push(cur);
    } else if (b.level === 2 && cur && !b.continuare) cur.subs.push(b.num);
  }
  if (!parts.length) {
    const h = blocks.find((b) => b.tip === 'heading');
    return h ? `${h.num} ${h.text}` : '';
  }
  return parts.map((p) => {
    if (p.subs.length > 1) return `${p.label} (${p.subs[0]}–${p.subs[p.subs.length - 1]})`;
    if (p.subs.length === 1) return `${p.label} (${p.subs[0]})`;
    return p.label;
  }).join(' → ');
}
