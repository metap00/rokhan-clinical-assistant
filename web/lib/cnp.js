// Romanian personal numeric code (CNP) detection. Pure, no dependencies: the browser can carry the same copy.
// A CNP is 13 digits: S YYMMDD JJ NNN C. S is 1-9, YYMMDD a real date, C the control digit.

const WEIGHTS = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
const CENTURY = { 1: 1900, 2: 1900, 3: 1800, 4: 1800, 5: 2000, 6: 2000 }; // 7, 8, 9 (residents, foreigners): any century

function plausibleDate(d) {
  const yy = +d.slice(1, 3);
  const mm = +d.slice(3, 5);
  const dd = +d.slice(5, 7);
  if (mm < 1 || mm > 12 || dd < 1) return false;
  // Feb 29 is valid in some century for every yy when S is 7-9; with a known century check the exact year.
  const year = (CENTURY[d[0]] ?? 2000) + yy;
  const leap = CENTURY[d[0]] ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 : yy % 4 === 0;
  return dd <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
}

/** True for a 13-digit string that is a valid CNP. */
export function isCnp(d) {
  if (!/^[1-9]\d{12}$/.test(d) || !plausibleDate(d)) return false;
  const r = WEIGHTS.reduce((s, w, i) => s + w * +d[i], 0) % 11;
  return (r === 10 ? 1 : r) === +d[12];
}

/**
 * True when the text holds a CNP: 13 digits written together or split by single spaces, dots or dashes,
 * and not part of a longer run of digits.
 */
export function containsCnp(text) {
  const re = /(?<!\d[ .-]?)\d(?:[ .-]?\d){12}(?![ .-]?\d)/g;
  for (const m of String(text ?? '').matchAll(re)) if (isCnp(m[0].replace(/\D/g, ''))) return true;
  return false;
}
