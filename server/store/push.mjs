// Web push: the VAPID keys, the subscriptions, the settings, and the daily lesson nudge.
// Files: <dataDir>/vapid.json (key pair) and <dataDir>/push.json { setari, abonamente, ultimaTrimitere }.
import path from 'node:path';
import * as webpush from 'web-push';
import { readJson, writeJsonAtomic, httpError } from './files.mjs';

export const TTL_SECONDS = 6 * 3600;
export const MAX_SUBSCRIPTIONS = 10; // one person, a few devices
export const LATEST_HOUR = '23:00'; // the daily nudge is never sent from this time on (owner asked for evening times, 2026-11-22)
const DEFAULTS = { activ: false, ora: '07:00', raspuns: true }; // raspuns: "the answer is ready" when she left the app

/** A real push service address: https, a named host (never an IP or localhost), a sane length. */
function validEndpoint(e) {
  if (typeof e !== 'string' || e.length > 2048) return false;
  try {
    const u = new URL(e);
    return u.protocol === 'https:' && u.hostname.includes('.') && !/^[\d.]+$/.test(u.hostname) && !u.hostname.includes(':') && !u.username && !u.password;
  } catch { return false; }
}
const b64url = (s) => typeof s === 'string' && s.length > 0 && s.length < 256 && /^[A-Za-z0-9_-]+={0,2}$/.test(s);
export const validHora = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) && s < LATEST_HOUR;

/** Wall-clock parts of `now` in `tz`: { date: 'YYYY-MM-DD', hhmm: 'HH:MM', sunday }. */
export function clock(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, sunday: p.weekday === 'Sun' };
}

const instances = new WeakMap();

/**
 * One store per config. `sender(subscription, payload, options)` is what actually talks to the push service;
 * tests hand in a fake, the default uses web-push with this store's VAPID details.
 */
export function getPush(config, { sender } = {}) {
  if (instances.has(config)) return instances.get(config);
  const file = path.join(config.dataDir, 'push.json');
  const vapidFile = path.join(config.dataDir, 'vapid.json');

  const load = () => {
    const raw = readJson(file, {});
    return {
      setari: { ...DEFAULTS, ...raw.setari },
      abonamente: Array.isArray(raw.abonamente) ? raw.abonamente : [],
      ultimaTrimitere: raw.ultimaTrimitere ?? null,
    };
  };
  const save = (s) => writeJsonAtomic(file, s);
  const update = (fn) => { const s = load(); fn(s); save(s); return s; };

  // https URL of the app when it has one, else the contact address; null = push is not configured.
  const subject = () => {
    if (config.publicOrigin?.startsWith('https://')) return config.publicOrigin;
    const c = config.pushContact;
    return typeof c === 'string' && /^(mailto:|https:\/\/)\S+$/.test(c) ? c : null;
  };
  const configured = () => subject() !== null;

  function keys() {
    let k = readJson(vapidFile, null);
    if (!k?.publicKey || !k?.privateKey) {
      k = webpush.generateVAPIDKeys();
      writeJsonAtomic(vapidFile, k);
    }
    return k;
  }

  const realSender = (sub, payload, options) => {
    const k = keys();
    return webpush.sendNotification(sub, payload, { ...options, vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey } });
  };
  const send = sender ?? realSender;

  const api = {
    configured,
    publicKey: () => (configured() ? keys().publicKey : null),
    state: load,

    info() {
      const s = load();
      return { configurat: configured(), cheie: api.publicKey(), activ: s.setari.activ, ora: s.setari.ora, raspuns: s.setari.raspuns, abonamente: s.abonamente.length };
    },

    setSettings({ activ, ora, raspuns } = {}) {
      if (activ !== undefined && typeof activ !== 'boolean') throw httpError(400, 'activ');
      if (ora !== undefined && !validHora(ora)) throw httpError(400, 'ora');
      if (raspuns !== undefined && typeof raspuns !== 'boolean') throw httpError(400, 'raspuns');
      update((s) => {
        if (activ !== undefined) s.setari.activ = activ;
        if (ora !== undefined) s.setari.ora = ora;
        if (raspuns !== undefined) s.setari.raspuns = raspuns;
      });
      return api.info();
    },

    addSubscription(sub) {
      if (!validEndpoint(sub?.endpoint) || !b64url(sub?.keys?.p256dh) || !b64url(sub?.keys?.auth)) throw httpError(400, 'abonare');
      update((s) => {
        s.abonamente = s.abonamente.filter((a) => a.endpoint !== sub.endpoint);
        if (s.abonamente.length >= MAX_SUBSCRIPTIONS) s.abonamente.shift(); // the oldest device makes room
        s.abonamente.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: new Date().toISOString() });
        s.setari.activ = true;
      });
      return api.info();
    },

    /** Removes one subscription. When it was the last one the daily nudge switches itself off. */
    removeSubscription(endpoint) {
      if (typeof endpoint !== 'string') throw httpError(400, 'endpoint');
      update((s) => {
        s.abonamente = s.abonamente.filter((a) => a.endpoint !== endpoint);
        if (!s.abonamente.length) s.setari.activ = false;
      });
      return api.info();
    },

    markSent(date) { update((s) => { s.ultimaTrimitere = date; }); },

    /**
     * Sends { title, body, url } to every subscription. A 404 or 410 answer removes that subscription; any other
     * failure is counted and reported to `onError`. Resolves { trimise, esuate } and never throws.
     */
    async sendAll({ title, body, url }, onError = () => {}) {
      const payload = JSON.stringify({ title, body, url });
      let trimise = 0;
      let esuate = 0;
      const gone = [];
      for (const sub of load().abonamente) {
        try {
          await send({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: TTL_SECONDS });
          trimise++;
        } catch (e) {
          esuate++;
          if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(sub.endpoint);
          else onError(e);
        }
      }
      if (gone.length) update((s) => { s.abonamente = s.abonamente.filter((a) => !gone.includes(a.endpoint)); });
      return { trimise, esuate };
    },
  };
  instances.set(config, api);
  return api;
}

/**
 * The daily nudge, called on every scheduler tick. Resolves a short description of what it did, or null when
 * there was nothing to do. Never throws.
 * lessons = the lessons service; log(status, detail) writes a line to the jobs log.
 */
export async function runDailyPush({ config, lessons, now = new Date(), log = () => {} }) {
  try {
    const push = getPush(config);
    const st = push.state();
    const { date, hhmm, sunday } = clock(now, config.tz);
    const { activ, ora } = st.setari;
    if (!activ || !push.configured() || !st.abonamente.length) return null;
    if (hhmm < ora || hhmm >= LATEST_HOUR || st.ultimaTrimitere === date) return null;

    const status = lessons.status();
    const due = status.repetitie?.scadente ?? 0; // quiz questions of the spaced review due today
    const reviewNote = { title: 'De repetat azi', body: `${due} ${due === 1 ? 'întrebare' : 'întrebări'} din lecturile citite.` };
    let note;
    if (status.citite[0]?.data === date) { // she read one today: no lesson nudge, only the reviews if any are due
      if (!due) { push.markSent(date); return 'citita deja'; }
      note = reviewNote;
    } else if (sunday && status.recap.disponibil) {
      note = { title: 'Recapitularea săptămânii', body: 'Punctele-cheie din lecturile ultimei săptămâni.' };
    } else {
      const next = status.urmatoarea;
      if (!next && !due) return null; // the plan is finished
      if (next && !next.scrisa) { lessons.requestGenerate(next.id); return null; } // ask the writer, try again on the next tick
      note = next ? { title: 'Lectura de azi', body: `${next.ghid.titlu}: ${next.titlu} (cam ${next.minute} minute)` } : reviewNote;
    }
    if (due && note !== reviewNote) note = { ...note, body: `${note.body} · ${due} ${due === 1 ? 'întrebare' : 'întrebări'} de repetat` };
    const r = await push.sendAll({ ...note, url: '/#/lecturi' }, (e) => log('eroare', String(e?.message ?? e).slice(0, 200)));
    push.markSent(date); // one attempt a day: a failing push service must not be hammered every minute
    log(r.trimise ? 'ok' : 'eroare', `${note.title}: trimise=${r.trimise} esuate=${r.esuate}`);
    return `trimis ${r.trimise}/${r.trimise + r.esuate}`;
  } catch (e) {
    log('eroare', String(e?.message ?? e).slice(0, 300));
    return null;
  }
}
