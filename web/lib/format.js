// Dates are 'YYYY-MM-DD' strings in the device's local calendar; timestamps are epoch ms.
export const pad = (n) => String(n).padStart(2, '0');

export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'))
    && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
}

const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];

// "22 noiembrie", with the year when it is not the current one.
export function longDate(iso, today = isoDate()) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${String(y) !== today.slice(0, 4) ? ' ' + y : ''}`;
}

// "azi", "ieri", else longDate.
export function dayLabel(iso, today = isoDate()) {
  const diff = daysBetween(iso, today);
  if (diff === 0) return 'azi';
  if (diff === 1) return 'ieri';
  return longDate(iso, today);
}

export function timeHM(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// For lists of conversations: the hour today, "ieri", else the date.
export function whenLabel(ts, now = Date.now()) {
  const day = isoDate(new Date(ts));
  return day === isoDate(new Date(now)) ? timeHM(ts) : dayLabel(day, isoDate(new Date(now)));
}

// Romanian puts "de" before nouns after 20, 21… 100, 120… (not after 1–19, 101–119).
export function countWord(n, one, many) {
  if (n === 1) return `1 ${one}`;
  const r = Math.abs(n) % 100;
  return `${n} ${r === 0 && n !== 0 || r >= 20 ? 'de ' : ''}${many}`;
}

// First and last day of a month, offset months from the one containing `today`.
export function monthRange(today, offset = 0) {
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
