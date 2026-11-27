// Registru: the procedure logbook. One tap for a birth or a caesarean, everything else in a form.
// Entries that cannot be posted for lack of network wait in an outbox kept in IndexedDB. Every entry gets
// its id here, on the phone, so sending it again after a lost answer cannot add it twice.
import { html, api, store, toast, bus, emit, isOffline, copyText, onVisible } from '../api.js';
import { useState, useEffect } from '../vendor/preact-hooks-11.2.0.mjs';
import { isoDate, dayLabel, longDate, countWord, monthRange } from '../lib/format.js';
import { withPending, milestoneCrossed, COUNTED } from '../lib/registru.js';
import { makeItem, adopt, flush, idbStore, firstWorking } from '../lib/outbox.js';
import { videosOf } from '../lib/videoteca.js';
import { Icon } from '../ui/icons.js';
import { VideoRow, useTicks } from './videoteca.js';

const OLD_OUTBOX = 'registru-outbox'; // localStorage, before the outbox moved to IndexedDB
// Fallback when IndexedDB is refused: the same list in localStorage.
const localBox = {
  all: async () => store.get('registru-outbox-2', []),
  put: async (item) => store.set('registru-outbox-2', [...store.get('registru-outbox-2', []).filter((x) => x.id !== item.id), item]),
  remove: async (id) => store.set('registru-outbox-2', store.get('registru-outbox-2', []).filter((x) => x.id !== id)),
};
const box = firstWorking(idbStore(), localBox);
// Entries that waited in the old place are moved once.
const ready = (async () => {
  for (const item of adopt(store.get(OLD_OUTBOX, []))) await box.put(item);
  store.set(OLD_OUTBOX, null);
})().catch(() => {});
const QUICK = [['nastere-vaginala', 'Naștere', 'Naștere vaginală'], ['cezariana', 'Cezariană', 'Cezariană']];
const ROLES = [['efectuat', 'Efectuat'], ['ajutat', 'Ajutat'], ['observat', 'Observat']];
const ERRORS = {
  data_in_viitor: 'Data e în viitor.',
  data_invalida: 'Data nu e bună.',
  numar_invalid: 'Numărul nu e bun.',
  procedura_lipsa: 'Alege procedura.',
  nume_lipsa: 'Scrie numele procedurii.',
};
const errorText = (e) => ERRORS[e?.message] || 'Ceva n-a mers. Încearcă din nou.';
const milestoneLine = (m) => (m === 1 ? 'Primul copil adus pe lume de mâna ta.' : `${countWord(m, 'copil', 'copii')} aduși pe lume. Mâini bune.`);
// Sends what waits. Called at start, when the page becomes visible, when the network or the server is back.
let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    await ready;
    const r = await flush(box, (body) => api('/registru/entries', { method: 'POST', body }));
    for (const x of r.rejected) toast({ text: `O intrare din așteptare a fost respinsă: ${errorText(x.error)}` });
    if (r.sent || r.rejected.length) emit('registru');
    if (r.sent) toast({ text: r.sent === 1 ? 'Intrarea din așteptare a fost salvată.' : `${r.sent} intrări din așteptare au fost salvate.` });
  } catch {
    // the waiting list could not be read: nothing was sent, nothing is lost
  } finally {
    flushing = false;
  }
}

export function Registru() {
  const [server, setServer] = useState(null);
  const [failed, setFailed] = useState(false);
  const [inflight, setInflight] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const readBox = () => ready.then(() => box.all()).then(setOutbox, () => {});
  const [form, setForm] = useState(null); // { mode: 'quick'|'other'|'edit', row?, entry? }
  const [all, setAll] = useState(false);
  const [films, setFilms] = useState({}); // row id -> the procedures of the Videotecă that match it
  const [openFilms, setOpenFilms] = useState(null);
  const [seen, tick, setSeen] = useTicks();
  useEffect(() => {
    const loadFilms = () => api('/videoteca/registru').then((r) => (setFilms(r.randuri), setSeen(r.vazute)), () => {});
    loadFilms();
    return onVisible(loadFilms);
  }, []);

  // The last summary is kept so the tab (and its + buttons) still work when the app starts offline.
  const load = () => api('/registru').then(
    (s) => (setServer(s), setFailed(false), store.set('registru-ultim', s)),
    () => (setFailed(true), setServer((cur) => cur ?? store.get('registru-ultim'))),
  );
  useEffect(() => {
    load();
    readBox();
    const onChange = () => {
      readBox();
      load();
    };
    bus.addEventListener('registru', onChange);
    return () => bus.removeEventListener('registru', onChange);
  }, []);

  const today = isoDate();
  const data = server && [...outbox, ...inflight].reduce((s, item) => withPending(s, item, today), server);
  const rowName = (id) => data?.rows.find((r) => r.id === id)?.nume ?? id;

  async function add(body) {
    body = { ...body, date: body.date || today };
    const item = makeItem(body);
    const before = data.copii.total;
    const label = `${rowName(body.row)}, ${dayLabel(body.date, today)}`;
    setInflight((l) => [...l, item]);
    try {
      const r = await api('/registru/entries', { method: 'POST', body: item.body });
      setServer(r.registru);
      store.set('registru-ultim', r.registru);
      const m = milestoneCrossed(before, r.registru.copii.total);
      toast({ text: `Adăugat: ${label}`, line: m && milestoneLine(m), action: { label: 'Anulează', run: () => remove(r.entry.id) } });
    } catch (e) {
      if (isOffline(e)) {
        await box.put(item);
        await readBox();
        toast({ text: `Fără conexiune: ${label} rămâne în așteptare.`, action: { label: 'Anulează', run: () => dropPending(item.id) } });
      } else toast({ text: errorText(e) });
    } finally {
      setInflight((l) => l.filter((x) => x !== item));
    }
  }

  async function dropPending(id) {
    await box.remove(id).catch(() => {});
    readBox();
  }

  async function remove(id) {
    try {
      setServer((await api(`/registru/entries/${id}`, { method: 'DELETE' })).registru);
      toast({ text: 'Șters.' });
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune. Șterge din nou când ai semnal.' : errorText(e) });
    }
  }

  async function save(entry, body) {
    try {
      setServer((await api(`/registru/entries/${entry.id}`, { method: 'PATCH', body })).registru);
      toast({ text: 'Salvat.' });
      return true;
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune. Salvează din nou când ai semnal.' : errorText(e) });
      return false;
    }
  }

  if (!data) {
    return html`<section class="view"><header class="bar"><h1 class="bar-title">Registru</h1></header>
      <p class="muted center pad">${failed ? 'Registrul nu se încarcă. Verifică conexiunea.' : 'Se încarcă…'}</p></section>`;
  }

  const { copii } = data;
  const rows = data.rows.filter((r) => r.barem || r.efectuat + r.ajutat + r.observat > 0);
  const entries = all ? data.entries : data.entries.slice(0, 40);
  const days = [];
  for (const e of entries) {
    if (days.at(-1)?.date !== e.date) days.push({ date: e.date, list: [] });
    days.at(-1).list.push(e);
  }

  return html`<section class="view">
    <header class="bar"><h1 class="bar-title">Registru</h1></header>
    <div class="page">
      <div class="counter">
        <p class="counter-big"><span class="vh">${copii.total}</span>${[...String(copii.total)].map((d) => html`<span class="digit" aria-hidden="true">${d}</span>`)}</p>
        <p class="counter-label">${copii.total === 1 ? 'copil adus pe lume' : 'copii aduși pe lume'}</p>
        <p class="counter-sub"><span class="n">${copii.vaginale}</span> din nașteri vaginale<br /><span class="n">${copii.cezariene}</span> din cezariene</p>
        ${copii.primul && html`<p class="counter-meta">Primul: ${longDate(copii.primul, today)}</p>`}
        ${data.urmatorulPrag && html`<p class="counter-meta">încă ${data.urmatorulPrag - copii.total} până la ${data.urmatorulPrag}</p>`}
      </div>

      <div class="quick">
        ${QUICK.map(([row, short, full]) => html`<div class="quick-row" key=${row}>
          <button class="btn primary big" type="button" onClick=${() => add({ row, rol: 'efectuat', n: 1 })}>+ ${short}</button>
          <button class="btn big more" type="button" aria-label=${`${full}: altă dată, mai multe sau gemeni`} onClick=${() => setForm({ mode: 'quick', row })}><${Icon} name="dots" /></button>
        </div>`)}
        <button class="btn wide" type="button" onClick=${() => setForm({ mode: 'other' })}>Altă procedură</button>
      </div>

      <h2 class="section">Proceduri</h2>
      <ul class="rows">
        ${rows.map((r) => {
          const pct = r.tinta ? Math.min(100, Math.round((r.efectuat / r.tinta) * 100)) : 0;
          return html`<li key=${r.id}>
            <div class="rows-top"><span>${r.nume}</span><span class="rows-n">${r.efectuat}${r.tinta ? html`<span class="muted"> / ${r.tinta}</span>` : ''}</span></div>
            ${r.tinta ? html`<div class="bar-track" role="progressbar" aria-label=${r.nume} aria-valuemin="0" aria-valuemax=${r.tinta} aria-valuenow=${r.efectuat}><span style=${{ width: pct + '%' }} /></div>` : ''}
            <p class="rows-meta">${[r.barem && `barem ${r.barem}`, r.ajutat && `ajutat ${r.ajutat}`, r.observat && `observat ${r.observat}`].filter(Boolean).join(', ')}</p>
            ${films[r.id] && html`<${RowFilms} procedures=${films[r.id]} open=${openFilms === r.id} onToggle=${() => setOpenFilms(openFilms === r.id ? null : r.id)} seen=${seen} tick=${tick} />`}
          </li>`;
        })}
      </ul>

      <h2 class="section">Intrări</h2>
      ${!days.length && html`<p class="muted">Nicio intrare încă.</p>`}
      ${days.map((d) => html`<div class="day" key=${d.date}>
        <h3 class="day-label">${dayLabel(d.date, today)}</h3>
        <ul class="entries">${d.list.map((e) => html`<li key=${e.id}>
          <button class="entry" type="button" onClick=${() => setForm({ mode: 'edit', entry: e })}>
            <span class="entry-main">${rowName(e.row)}${e.n > 1 ? ` ×${e.n}` : ''}${e.rol !== 'efectuat' ? html` <span class="muted">· ${e.rol}</span>` : ''}${e.copii > e.n ? html` <span class="muted">· gemeni</span>` : ''}</span>
            ${e.pending && html`<span class="tag">în așteptare</span>`}
            ${e.nota && html`<span class="entry-note">${e.nota}</span>`}
          </button>
        </li>`)}</ul>
      </div>`)}
      ${!all && data.entries.length > entries.length && html`<button class="btn wide" type="button" onClick=${() => setAll(true)}>Arată toate (${data.entries.length})</button>`}

      <${Export} today=${today} />
    </div>

    ${form && html`<${EntryForm} form=${form} rows=${data.rows} today=${today} onClose=${() => setForm(null)}
      onAdd=${(body) => { setForm(null); add(body); }}
      onSave=${async (entry, body) => (await save(entry, body)) && setForm(null)}
      onDelete=${(entry) => { setForm(null); entry.pending ? dropPending(entry.id) : remove(entry.id); }} />`}
  </section>`;
}

// The films of one logbook row: one tap shows them here, a procedure name opens it in the Videotecă.
function RowFilms({ procedures, open, onToggle, seen, tick }) {
  return html`<button class="link-btn" type="button" aria-expanded=${open} onClick=${onToggle}>
      <${Icon} name="video" />${open ? 'Ascunde filmele' : countWord(videosOf(procedures).length, 'film', 'filme')}
    </button>
    ${open && procedures.map((p) => html`<div key=${p.name_ro} class="rows-films">
      <a class="rows-proc" href=${`#/videoteca/capitol/${encodeURIComponent(p.capitol)}?p=${encodeURIComponent(p.name_ro)}`}>${p.name_ro}</a>
      <ul class="vids">${p.videos.map((v) => html`<${VideoRow} key=${v.url} v=${v} text=${v.covers_ro} seen=${seen.has(v.url)} onTick=${tick} />`)}</ul>
    </div>`)}`;
}

function EntryForm({ form, rows, today, onClose, onAdd, onSave, onDelete }) {
  const e = form.entry;
  const [row, setRow] = useState(e?.row ?? form.row ?? rows[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [rol, setRol] = useState(e?.rol ?? 'efectuat');
  const [n, setN] = useState(String(e?.n ?? 1));
  const [date, setDate] = useState(e?.date ?? today);
  const [twins, setTwins] = useState(e ? e.copii > e.n : false);
  const [nota, setNota] = useState(e?.nota ?? '');
  const [confirm, setConfirm] = useState(false);
  const quick = form.mode === 'quick';
  const isNew = row === '__nou';
  const counted = !isNew && COUNTED[row] && (quick || rol === 'efectuat');
  const title = quick ? rows.find((r) => r.id === row)?.nume : e ? 'Intrare' : 'Altă procedură';

  useEffect(() => {
    const onKey = (ev) => ev.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  function submit(ev) {
    ev.preventDefault();
    const count = Math.max(1, parseInt(n, 10) || 1);
    const body = { row: isNew ? newName.trim() : row, rol: quick ? 'efectuat' : rol, n: count, date, nota: nota.trim() };
    if (counted) body.copii = count + (twins ? 1 : 0);
    if (!body.row) return;
    if (e) onSave(e, body);
    else onAdd(body);
  }

  return html`<div class="sheet-back bottom" onClick=${(ev) => ev.target === ev.currentTarget && onClose()}>
    <form class="sheet form-sheet" role="dialog" aria-modal="true" aria-label=${title} onSubmit=${submit}>
      <header class="sheet-head"><h2>${title}</h2><button class="icon-btn" type="button" onClick=${onClose} aria-label="Închide"><${Icon} name="close" /></button></header>
      <div class="form-body">
        ${e?.pending && html`<p class="muted">Intrarea e în așteptare și pleacă singură când revine conexiunea.</p>`}
        ${!quick && !e?.pending && html`
          <label for="f-row">Procedura</label>
          <select id="f-row" value=${row} onChange=${(ev) => setRow(ev.target.value)}>
            ${rows.map((r) => html`<option key=${r.id} value=${r.id}>${r.nume}</option>`)}
            <option value="__nou">Procedură nouă…</option>
          </select>
          ${isNew && html`<label for="f-new">Numele procedurii</label><input id="f-new" value=${newName} onInput=${(ev) => setNewName(ev.target.value)} required />`}
          <span class="label" id="f-rol">Rol</span>
          <div class="seg" role="radiogroup" aria-labelledby="f-rol">
            ${ROLES.map(([v, l]) => html`<label key=${v}><input type="radio" name="rol" value=${v} checked=${rol === v} onChange=${() => setRol(v)} /><span>${l}</span></label>`)}
          </div>`}
        ${!e?.pending && html`
          <div class="form-2">
            <div><label for="f-date">Data</label><input id="f-date" type="date" value=${date} max=${today} onInput=${(ev) => setDate(ev.target.value)} required /></div>
            <div><label for="f-n">Număr</label><input id="f-n" type="number" inputmode="numeric" min="1" max="1000" value=${n} onInput=${(ev) => setN(ev.target.value)} /></div>
          </div>
          ${counted && html`<label class="check"><input type="checkbox" checked=${twins} onChange=${(ev) => setTwins(ev.target.checked)} />Gemeni (o naștere cu doi copii)</label>`}
          <label for="f-nota">Notă</label>
          <textarea id="f-nota" rows="2" value=${nota} onInput=${(ev) => setNota(ev.target.value)} />`}
      </div>
      <div class="form-actions">
        ${!e?.pending && html`<button class="btn primary" type="submit">${e ? 'Salvează' : 'Adaugă'}</button>`}
        ${e && (confirm
          ? html`<span class="confirm-inline">Sigur? <button class="btn danger" type="button" onClick=${() => onDelete(e)}>Da, șterge</button></span>`
          : html`<button class="btn ghost" type="button" onClick=${() => setConfirm(true)}>${e.pending ? 'Anulează intrarea' : 'Șterge'}</button>`)}
      </div>
    </form>
  </div>`;
}

function Export({ today }) {
  const [range, setRange] = useState(null);
  const [custom, setCustom] = useState({ from: monthRange(today).from, to: today });
  const [text, setText] = useState(null);
  const [copied, setCopied] = useState(false);
  const RANGES = [['luna', 'Luna aceasta', monthRange(today)], ['trecuta', 'Luna trecută', monthRange(today, -1)], ['tot', 'Tot', {}], ['alte', 'Alte date', null]];

  async function run(r) {
    setText(null);
    const q = new URLSearchParams(Object.entries(r).filter(([, v]) => v)).toString();
    try {
      setText((await api('/registru/export' + (q ? '?' + q : ''))).text);
    } catch (e) {
      setText(isOffline(e) ? null : '');
      toast({ text: isOffline(e) ? 'Fără conexiune.' : 'Ceva n-a mers. Încearcă din nou.' });
    }
  }
  const pick = ([id, , r]) => {
    setRange(id);
    if (r) run(r);
    else setText(null);
  };

  return html`<h2 class="section">Export</h2>
    <div class="seg" role="radiogroup" aria-label="Perioada">
      ${RANGES.map((r) => html`<label key=${r[0]}><input type="radio" name="exp" checked=${range === r[0]} onChange=${() => pick(r)} /><span>${r[1]}</span></label>`)}
    </div>
    ${range === 'alte' && html`<div class="form-2">
      <div><label for="x-from">De la</label><input id="x-from" type="date" value=${custom.from} onInput=${(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></div>
      <div><label for="x-to">Până la</label><input id="x-to" type="date" value=${custom.to} onInput=${(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></div>
    </div>
    <div class="row"><button class="btn" type="button" onClick=${() => run(custom)}>Arată</button></div>`}
    ${text === '' && html`<p class="muted">Nimic în perioada asta.</p>`}
    ${text && html`<textarea class="export-text" readonly rows="8" aria-label="Textul exportat" value=${text} />
      <div class="row">
        <button class="btn" type="button" onClick=${async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}><${Icon} name="copy" />${copied ? 'Copiat' : 'Copiază'}</button>
        ${navigator.share && html`<button class="btn" type="button" onClick=${() => navigator.share({ title: 'Registru', text }).catch(() => {})}><${Icon} name="share" />Trimite</button>`}
      </div>`}`;
}
