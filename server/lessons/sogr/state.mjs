// Vendored from bin/lib/state.mjs (SPEC §8): the state file format and the date helpers. The paths and the time zone come from the caller
// (the original read them from bin/lib/paths.mjs); decide(), the Telegram opening lines and the daily-push logic are not copied.
import fs from 'node:fs';
import path from 'node:path';

export const emptyState = () => ({
  plan: [], cursor: 0, sent: [], pauza_pana_la: null, inceput: null,
  extra_azi: null, repeta_azi: null, comenzi_servite: {}, sarite: [],
});

export function loadState(file) {
  return fs.existsSync(file) ? { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : emptyState();
}

/** Atomic write (temp file + rename): a crash never leaves half a JSON file. */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const saveState = (state, file) => writeJsonAtomic(file, state);

/** Unit ids (NN-k) of a units directory, in curriculum order (guideline number, then k). */
export function allUnitIds(unitsDir) {
  if (!fs.existsSync(unitsDir)) return [];
  return fs.readdirSync(unitsDir).filter((f) => /^\d\d-\d+\.json$/.test(f)).map((f) => f.replace('.json', ''))
    .sort((a, b) => {
      const [na, ka] = a.split('-').map(Number);
      const [nb, kb] = b.split('-').map(Number);
      return na - nb || ka - kb;
    });
}

export const unitGuideline = (id) => id.split('-')[0];

/** Today's date (YYYY-MM-DD) in time zone `tz`. */
export function todayString(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const toUtc = (s) => new Date(`${s}T00:00:00Z`);
export function addDays(s, n) {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
