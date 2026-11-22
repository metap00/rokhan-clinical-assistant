// Rokhan app shell: session check, login, hash router, tab bar, toast, lightbox, offline banner.
import { html, render, api, bus } from './api.js';
import { useState, useEffect, useRef } from './vendor/preact-hooks-11.2.0.mjs';
import { Icon } from './ui/icons.js';
import { Chat } from './views/chat.js';
import { Registru, flushOutbox } from './views/registru.js';
import { Lecturi } from './views/lecturi.js';
import { Ghiduri } from './views/ghiduri.js';
import { MaiMult } from './views/mai-mult.js';

const TABS = [
  ['intreaba', 'Întreabă', 'chat', Chat],
  ['registru', 'Registru', 'registru', Registru],
  ['lecturi', 'Lecturi', 'lecturi', Lecturi],
  ['ghiduri', 'Ghiduri', 'ghiduri', Ghiduri],
  ['mai-mult', 'Mai mult', 'more', MaiMult],
];

// "#/ghiduri/18/3?l=555-577" -> { tab: 'ghiduri', rest: ['18', '3'], query: { l: '555-577' } }
function parseHash() {
  const [path, q = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const tab = TABS.some((t) => t[0] === parts[0]) ? parts[0] : 'intreaba';
  return { tab, rest: tab === parts[0] ? parts.slice(1) : [], query: Object.fromEntries(new URLSearchParams(q)) };
}

function App() {
  const [auth, setAuth] = useState(null);
  const [route, setRoute] = useState(parseHash);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const toastTimer = useRef(0);

  useEffect(() => {
    // Offline at start: the 180-day cookie is most likely still good, so show the app.
    api('/session').then((s) => setAuth(s.authenticated), () => setAuth(true));
    const onHash = () => setRoute(parseHash());
    const onOnline = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) flushOutbox();
    };
    const onVisible = () => document.visibilityState === 'visible' && flushOutbox();
    const onUnauth = () => setAuth(false);
    const onToast = (e) => {
      clearTimeout(toastTimer.current);
      const t = e.detail;
      setToast(t && { ...t, key: Date.now() });
      if (t) toastTimer.current = setTimeout(() => setToast(null), t.ms ?? (t.action ? 6000 : 3500));
    };
    const onLightbox = (e) => setLightbox(e.detail);
    const onNet = (e) => {
      setOnline(e.detail && navigator.onLine);
      if (e.detail) flushOutbox(); // the server answers again: send what waited
    };
    addEventListener('hashchange', onHash);
    addEventListener('online', onOnline);
    addEventListener('offline', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    bus.addEventListener('unauthorized', onUnauth);
    bus.addEventListener('toast', onToast);
    bus.addEventListener('lightbox', onLightbox);
    bus.addEventListener('net', onNet);
    flushOutbox();
    // Ask the browser, without a prompt of ours, not to evict our storage (the logbook's waiting list)
    // when the phone runs short of space. Asked once per start until it is granted.
    navigator.storage?.persisted?.().then((kept) => kept || navigator.storage.persist?.()).catch(() => {});
    return () => {
      removeEventListener('hashchange', onHash);
      removeEventListener('online', onOnline);
      removeEventListener('offline', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      bus.removeEventListener('unauthorized', onUnauth);
      bus.removeEventListener('toast', onToast);
      bus.removeEventListener('lightbox', onLightbox);
      bus.removeEventListener('net', onNet);
    };
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => e.key === 'Escape' && setLightbox(null);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (auth === null) return html`<div class="boot" aria-busy="true"></div>`;
  if (!auth) return html`<${Login} onOk=${() => setAuth(true)} />`;

  const View = TABS.find((t) => t[0] === route.tab)[3];
  return html`<div class="shell">
    ${!online && html`<p class="offline" role="status">Fără conexiune. Registrul păstrează ce adaugi și trimite când revine semnalul.</p>`}
    <main class="main"><${View} key=${route.tab} rest=${route.rest} query=${route.query} /></main>
    <nav class="tabs" aria-label="Secțiuni">
      ${TABS.map(([id, label, icon]) => html`<a key=${id} href=${'#/' + id} class="tab" aria-current=${route.tab === id ? 'page' : undefined}>
        <${Icon} name=${icon} /><span>${label}</span>
      </a>`)}
    </nav>
    ${toast && html`<div class="toast" role="status" key=${toast.key}>
      <div class="toast-text"><p>${toast.text}</p>${toast.line && html`<p class="toast-line">${toast.line}</p>`}</div>
      ${toast.action && html`<button class="toast-act" type="button" onClick=${() => { toast.action.run(); setToast(null); }}>${toast.action.label}</button>`}
    </div>`}
    ${lightbox && html`<div class="lightbox" role="dialog" aria-modal="true" aria-label="Desen pe tot ecranul" onClick=${(e) => e.target === e.currentTarget && setLightbox(null)}>
      <button class="icon-btn lightbox-x" type="button" onClick=${() => setLightbox(null)} aria-label="Închide"><${Icon} name="close" /></button>
      <img src=${lightbox} alt="Desen mărit" />
    </div>`}
  </div>`;
}

function Login({ onOk }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('/login', { method: 'POST', body: { password: pw } });
      onOk();
    } catch (e) {
      if (e.status === 401) setErr('Parola nu e bună.');
      else if (e.status === 429) {
        const min = Math.max(1, Math.ceil((e.data?.retryAfterSec ?? 60) / 60));
        setErr(`Prea multe încercări. Mai încearcă peste ${min === 1 ? 'un minut' : `${min} minute`}.`);
      } else if (!e.status) setErr('Nu ai conexiune. Încearcă din nou când ai semnal.');
      else setErr('Ceva n-a mers. Încearcă din nou.');
    } finally {
      setBusy(false);
    }
  }
  return html`<main class="login">
    <form class="login-box" onSubmit=${submit}>
      <svg class="login-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path class="lm-grid" d="M0 128H512M0 256H512M0 384H512M128 0V512M256 0V512M384 0V512" /><path class="lm-trace" d="M64 344C178 344 186 168 256 168C326 168 334 344 448 344" /></svg>
      <h1>Rokhan</h1>
      <label for="pw">Parola</label>
      <input id="pw" type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} autofocus />
      ${err && html`<p class="error" role="alert">${err}</p>`}
      <button class="btn primary wide" type="submit" disabled=${busy || !pw}>Intră</button>
    </form>
  </main>`;
}

render(html`<${App} />`, document.getElementById('app'));

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
