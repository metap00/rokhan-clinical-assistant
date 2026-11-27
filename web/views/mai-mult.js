// Mai mult: what Rokhan knows about her, the gestational age calculator, settings, about.
// Routes: #/mai-mult, #/mai-mult/memorie/<pagina>.
import { html, api, store, toast, emit, isOffline } from '../api.js';
import { useState, useEffect } from '../vendor/preact-hooks-11.2.0.mjs';
import { isoDate, isIsoDate, longDate, dayLabel } from '../lib/format.js';
import { dumFromDpn, dumFromEco, dpnFromDum, gaOn, gaLabel } from '../lib/ga.js';
import { Md } from '../ui/markdown.js';
import { Icon } from '../ui/icons.js';

// The three looks (web/app.css has one token block for each). The first is the default.
const LOOKS = [
  ['instrument', 'Instrument', 'alb, negru, atât'],
  ['fisa', 'Fișă', 'foaie ziua, monitor noaptea'],
  ['darkspear', 'Darkspear', 'Insulele Ecou'],
];

export function applySettings(s) {
  store.set('setari', s);
  window.rokhanTheme.apply(s); // web/theme.js: look, theme, text size and the browser bar colour
}

export function MaiMult({ rest }) {
  if (rest[0] === 'memorie' && rest[1]) return html`<${MemoryPage} pagina=${rest[1]} />`;
  return html`<${Overview} />`;
}

function Bar({ title, back }) {
  return html`<header class="bar">
    ${back ? html`<a class="icon-btn" href=${back} aria-label="Înapoi"><${Icon} name="back" /></a>` : ''}
    <h1 class=${'bar-title' + (back ? ' left' : '')}>${title}</h1>
    ${back ? html`<span class="bar-spacer" />` : ''}
  </header>`;
}

function Overview() {
  const [pages, setPages] = useState(null);
  const [about, setAbout] = useState(null);
  const [s, setS] = useState(() => store.get('setari', { tema: 'sistem', text: 'normal' }));
  useEffect(() => {
    api('/memorie').then(setPages, () => setPages(false));
    api('/stare').then(setAbout, () => {});
  }, []);
  const set = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    applySettings(next);
  };
  async function logout() {
    try {
      await api('/logout', { method: 'POST' });
    } catch {}
    emit('unauthorized');
  }

  return html`<section class="view">
    <${Bar} title="Mai mult" />
    <div class="page">
      <h2 class="section">Ce știe Rokhan despre mine</h2>
      ${pages === false ? html`<p class="muted">Paginile nu se încarcă. Verifică conexiunea.</p>` : !pages ? html`<p class="muted">Se încarcă…</p>` : !pages.length ? html`<p class="muted">Nicio pagină încă.</p>`
      : html`<ul class="list">${pages.map((p) => html`<li key=${p.pagina}><a class="list-item" href=${`#/mai-mult/memorie/${p.pagina}`}>
          <span class="grow">${p.titlu}</span><span class="count">${dayLabel(isoDate(new Date(p.updatedAt)))}</span>
        </a></li>`)}</ul>`}

      <h2 class="section">Vârsta gestațională</h2>
      <${GaCalc} />

      <h2 class="section">Setări</h2>
      <span class="label" id="s-aspect">Aspect</span>
      <div class="looks" role="radiogroup" aria-labelledby="s-aspect">
        ${LOOKS.map(([v, name, note]) => html`<label key=${v} class="look">
          <input type="radio" name="aspect" checked=${document.documentElement.dataset.look === v} onChange=${() => set({ aspect: v })} />
          <span class="look-card">
            <span class="look-swatch" data-look=${v} aria-hidden="true">
              <span class="sw-bar">Rokhan</span>
              <span class="sw-body"><span class="sw-num">24</span><span class="sw-keys"><i class="k1" /><i class="k2" /><i class="k3" /></span></span>
            </span>
            <span class="look-name">${name}</span>
            <span class="look-note">${note}</span>
          </span>
        </label>`)}
      </div>
      <span class="label" id="s-tema">Temă</span>
      <div class="seg" role="radiogroup" aria-labelledby="s-tema">
        ${[['sistem', 'Sistem'], ['luminos', 'Luminos'], ['intunecat', 'Întunecat']].map(([v, l]) => html`<label key=${v}><input type="radio" name="tema" checked=${s.tema === v} onChange=${() => set({ tema: v })} /><span>${l}</span></label>`)}
      </div>
      <span class="label" id="s-text">Mărimea textului</span>
      <div class="seg" role="radiogroup" aria-labelledby="s-text">
        ${[['normal', 'Normal'], ['mare', 'Mare']].map(([v, l]) => html`<label key=${v}><input type="radio" name="text" checked=${s.text === v} onChange=${() => set({ text: v })} /><span>${l}</span></label>`)}
      </div>
      <${Notificari} />
      <div class="row"><button class="btn" type="button" onClick=${logout}>Ieși din cont</button></div>

      <h2 class="section">Despre</h2>
      <p class="about">${about ? html`Rokhan ${about.versiune}, model ${about.model}${about.fakeLlm ? ' (de test)' : ''}.` : 'Rokhan.'}</p>
      <p class="about strong">Nu trimite date care identifică pacienta.</p>
    </div>
  </section>`;
}

// ---- Notificări: the daily lesson and the film of the day through web push (server: /api/push) ----

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = (b64) => Uint8Array.from(atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (sub, key) => {
  const k = sub.options?.applicationServerKey;
  return !!k && new Uint8Array(k).join() === key.join();
};
// The page's service worker, or null when it is not there (plain http on a real address, a blocked worker).
const worker = () => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);

function Notificari() {
  const [info, setInfo] = useState(null); // server state; false = cannot be read
  const [sub, setSub] = useState(null); // this phone's push subscription
  const [perm, setPerm] = useState(() => (canPush() ? Notification.permission : 'default'));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      let i;
      try { i = await api('/push'); } catch { setInfo(false); return; }
      setInfo(i);
      if (!canPush()) return;
      const reg = await worker();
      const s = reg && (await reg.pushManager.getSubscription().catch(() => null));
      setSub(s);
      // The server may have dropped this phone (a stale address): tell it again.
      if (s && i.activ && i.configurat) api('/push/abonare', { method: 'POST', body: { subscription: s.toJSON() } }).then(setInfo, () => {});
    })();
  }, []);

  const fail = (e) => toast({ text: isOffline(e) ? 'Fără conexiune. Încearcă din nou când ai semnal.' : 'Ceva n-a mers cu notificările. Încearcă din nou.' });

  // This phone's subscription, made if it is missing. Null when she refuses or the app cannot subscribe.
  // Subscribing switches the daily lesson on (the server does that), so the caller sets what it wants after.
  async function subscribed() {
    if (sub) return sub;
    const asked = await Notification.requestPermission(); // must start from the tap
    setPerm(asked);
    if (asked !== 'granted') return null;
    const reg = await worker();
    if (!reg) { toast({ text: 'Aplicația nu e pregătită pentru notificări. Reîncarcă pagina și încearcă din nou.' }); return null; }
    const key = keyBytes(info.cheie);
    let s = await reg.pushManager.getSubscription();
    if (s && !sameKey(s, key)) { // made for another server key: start again
      await api('/push/abonare', { method: 'DELETE', body: { endpoint: s.endpoint } }).catch(() => {});
      await s.unsubscribe();
      s = null;
    }
    s ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/push/abonare', { method: 'POST', body: { subscription: s.toJSON() } });
    setSub(s);
    return s;
  }

  // The two switches share the subscription: it is made when the first goes on and dropped when both are off.
  // which: 'activ' (the daily lesson) or 'raspuns' (the answer is ready).
  async function toggle(which, on) {
    const other = which === 'activ' ? 'raspuns' : 'activ';
    const otherOn = !!sub && info[other];
    setBusy(true);
    try {
      if (on) {
        if (!(await subscribed())) return;
        setInfo(await api('/push/setari', { method: 'PUT', body: { [which]: true, [other]: otherOn } }));
      } else if (otherOn) {
        setInfo(await api('/push/setari', { method: 'PUT', body: { [which]: false } }));
      } else {
        setInfo(await api('/push/abonare', { method: 'DELETE', body: { endpoint: sub.endpoint } }));
        await sub.unsubscribe().catch(() => {});
        setSub(null);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function setTime(ora) {
    if (!ora) return;
    try {
      setInfo(await api('/push/setari', { method: 'PUT', body: { ora } }));
    } catch (e) {
      if (e.status === 400) toast({ text: 'Ora trebuie să fie înainte de 23:00.' });
      else fail(e);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api('/push/test', { method: 'POST', body: {} });
      toast({ text: r.trimise ? 'Test trimis. Notificarea apare în câteva secunde.' : 'Testul nu a ajuns la niciun telefon. Oprește și pornește din nou notificările.' });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // Needs no subscription of its own: it only adds a line to the daily nudge.
  async function setFilm(film) {
    try {
      setInfo(await api('/push/setari', { method: 'PUT', body: { film } }));
    } catch (e) {
      fail(e);
    }
  }

  let body;
  if (info === null) body = html`<p class="muted small">Se încarcă…</p>`;
  else if (info === false) body = html`<p class="muted small">Starea notificărilor nu se încarcă. Verifică conexiunea.</p>`;
  else if (!info.configurat) body = html`<p class="muted small">Notificările nu sunt configurate pe server.</p>`;
  else if (isIos() && !isInstalled()) body = html`<p class="muted small">Pe iPhone: adaugă Rokhan pe ecranul principal, deschide-l de acolo, apoi pornește notificările.</p>`;
  else if (!canPush()) body = html`<p class="muted small">Acest browser nu poate trimite notificări.</p>`;
  else if (perm === 'denied') body = html`<p class="muted small">Notificările sunt blocate pentru Rokhan în setările telefonului.</p>`;
  else {
    const on = info.activ && !!sub;
    const answerOn = info.raspuns && !!sub;
    body = html`<label class="check"><input type="checkbox" role="switch" checked=${on} disabled=${busy} onChange=${() => toggle('activ', !on)} />Lectura zilnică</label>
      <p class="muted small">O notificare pe zi, cu lectura de azi. Duminica: recapitularea săptămânii. Lectura nu vine dacă ai citit deja una în ziua aceea.</p>
      <label for="notif-ora">La ce oră</label>
      <input id="notif-ora" type="time" value=${info.ora} max="22:59" onChange=${(e) => setTime(e.target.value)} />
      <label class="check"><input type="checkbox" role="switch" checked=${info.film} onChange=${() => setFilm(!info.film)} />Filmul zilei</label>
      <p class="muted small">Pune următorul film nevăzut în capul Videotecii și în notificarea zilnică. În zilele fără lectură, notificarea are numai filmul și atingerea ei îl deschide.${on ? '' : ' Vine numai cu lectura zilnică pornită.'}</p>
      <label class="check"><input type="checkbox" role="switch" checked=${answerOn} disabled=${busy} onChange=${() => toggle('raspuns', !answerOn)} />Anunță-mă când răspunsul e gata</label>
      <p class="muted small">Vine doar dacă ai ieșit din aplicație cât timp Rokhan încă scria.</p>
      <div class="row"><button class="btn" type="button" disabled=${busy || !sub} onClick=${test}>Trimite un test</button></div>`;
  }
  return html`<h3 class="subsection">Notificări</h3>${body}`;
}

let ga = { mode: 'dpn', date: '', ecoW: '', ecoD: '0', on: '' }; // kept while she switches tabs

function GaCalc() {
  const [st, setSt] = useState(ga);
  const today = isoDate();
  const set = (patch) => setSt((s) => (ga = { ...s, ...patch }));

  let dum = null;
  if (isIsoDate(st.date)) {
    if (st.mode === 'dpn') dum = dumFromDpn(st.date);
    else if (st.mode === 'dum') dum = st.date;
    else if (st.ecoW !== '' && Number(st.ecoW) >= 0 && Number(st.ecoW) <= 44 && Number(st.ecoD) >= 0 && Number(st.ecoD) <= 6) dum = dumFromEco(st.date, st.ecoW, st.ecoD);
  }
  const now = dum && gaOn(dum, today);
  const on = dum && isIsoDate(st.on) && gaOn(dum, st.on);

  return html`<div class="ga">
    <div class="seg" role="radiogroup" aria-label="Pornesc de la">
      ${[['dpn', 'DPN'], ['dum', 'DUM'], ['eco', 'Ecografie']].map(([v, l]) => html`<label key=${v}><input type="radio" name="ga" checked=${st.mode === v} onChange=${() => set({ mode: v })} /><span>${l}</span></label>`)}
    </div>
    ${st.mode === 'eco' ? html`<label for="ga-date">Data ecografiei</label>
      <input id="ga-date" type="date" value=${st.date} onInput=${(e) => set({ date: e.target.value })} />
      <div class="form-2">
        <div><label for="ga-w">Săptămâni</label><input id="ga-w" type="number" inputmode="numeric" min="0" max="44" value=${st.ecoW} onInput=${(e) => set({ ecoW: e.target.value })} /></div>
        <div><label for="ga-d">Zile</label><input id="ga-d" type="number" inputmode="numeric" min="0" max="6" value=${st.ecoD} onInput=${(e) => set({ ecoD: e.target.value })} /></div>
      </div>`
    : html`<label for="ga-date">${st.mode === 'dpn' ? 'Data probabilă a nașterii (DPN)' : 'Prima zi a ultimei menstruații (DUM)'}</label>
      <input id="ga-date" type="date" value=${st.date} onInput=${(e) => set({ date: e.target.value })} />`}
    ${now && html`<div class="ga-out" aria-live="polite">
      <p class="ga-big">${now.total < 0 ? 'Data e după ziua de azi.' : gaLabel(now)}</p>
      <p class="ga-sub">${now.total >= 0 ? 'azi, ' : ''}${longDate(today, today)}</p>
      <p>DPN: <strong>${longDate(dpnFromDum(dum), today)}</strong>${st.mode !== 'dum' ? html`<br />DUM: ${longDate(dum, today)}` : ''}</p>
      ${now.weeks >= 42 && html`<p class="muted small">Peste 42 de săptămâni: verifică data introdusă.</p>`}
      <label for="ga-on">Vârsta la altă dată</label>
      <input id="ga-on" type="date" value=${st.on} onInput=${(e) => set({ on: e.target.value })} />
      ${on && html`<p class="ga-at">${on.total < 0 ? 'Înainte de DUM.' : `${longDate(st.on, today)}: ${gaLabel(on)}`}</p>`}
    </div>`}
  </div>`;
}

function MemoryPage({ pagina }) {
  const [page, setPage] = useState(null);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/memorie/${encodeURIComponent(pagina)}`).then(setPage, (e) => setErr(e.status === 404 ? 'Pagina nu există.' : 'Pagina nu se încarcă.'));
  }, [pagina]);

  async function save() {
    setBusy(true);
    try {
      setPage(await api(`/memorie/${encodeURIComponent(pagina)}`, { method: 'PUT', body: { markdown: draft } }));
      setDraft(null);
      toast({ text: 'Salvat.' });
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune. Textul a rămas aici, salvează din nou când ai semnal.' : e.message === 'prea_mare' ? 'Pagina e prea lungă.' : 'Ceva n-a mers. Încearcă din nou.' });
    } finally {
      setBusy(false);
    }
  }

  return html`<section class="view">
    <${Bar} title=${page?.titlu ?? 'Pagină'} back="#/mai-mult" />
    <div class="page memory">
      ${!page ? html`<p class="muted center pad">${err || 'Se încarcă…'}</p>`
      : draft !== null ? html`<label for="mem-edit">Textul paginii (Markdown)</label>
          <textarea id="mem-edit" class="mem-edit" value=${draft} onInput=${(e) => setDraft(e.target.value)} />
          <div class="row"><button class="btn primary" type="button" disabled=${busy} onClick=${save}>Salvează</button><button class="btn ghost" type="button" onClick=${() => setDraft(null)}>Renunță</button></div>`
      : html`<p class="muted small">Actualizată ${dayLabel(isoDate(new Date(page.updatedAt)))}</p>
          <${Md} text=${page.markdown} class="md answer" />
          <div class="row"><button class="btn" type="button" onClick=${() => setDraft(page.markdown)}>Editează</button></div>`}
    </div>
  </section>`;
}
