// Întreabă: the chat with Rokhan. Streams answers over SSE, falls back to polling when the stream breaks.
import { html, api, store, sleep, copyText, emit, isOffline } from '../api.js';
import { useState, useEffect, useRef, useLayoutEffect } from '../vendor/preact-hooks-11.2.0.mjs';
import { createSseParser } from '../lib/sse.js';
import { whenLabel, timeHM } from '../lib/format.js';
import { containsCnp } from '../lib/cnp.js';
import { wantsMatch, asksForGuideline, matchQuery, hitHref } from '../lib/ghid.js';
import { Answer } from '../ui/markdown.js';
import { CropView } from '../ui/crop.js';
import { Icon } from '../ui/icons.js';

const FRESH_MS = 4 * 3600e3;
const MAX_PHOTOS = 4;
const STARTERS = [
  ['Întrebare de gardă', 'Întrebare de gardă: '],
  ['Explică-mi un termen', 'Explică-mi un termen: '],
  ['Quiz din ce am greșit', 'Quiz din ce am greșit'],
  ['Cod CIM-10 pentru…', 'Cod CIM-10 pentru '],
];
const coarse = () => matchMedia('(pointer: coarse)').matches;

// Survives tab switches (the view unmounts), not reloads.
let currentId = null;
// The guideline match of the last question: { convId, at, hits, below }. Kept for the page session only,
// so it is still there when she comes back from reading one of its rows.
let sessionMatch = null;

// Keeps the screen on while a turn runs. The browser drops the lock when the page is hidden, so it is
// taken again when the page comes back and the turn still runs. Browsers without it, or that refuse, are ignored.
function useWakeLock(active) {
  useEffect(() => {
    if (!active || !navigator.wakeLock) return;
    let lock = null;
    let over = false;
    const take = async () => {
      if (over || lock || document.visibilityState !== 'visible') return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (over) return void l.release().catch(() => {});
        lock = l;
        l.addEventListener('release', () => lock === l && (lock = null));
      } catch {}
    };
    const onVisible = () => (document.visibilityState === 'visible' ? take() : lock?.release().catch(() => {}));
    take();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      over = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, [active]);
}

export function Chat() {
  const [conv, setConv] = useState(undefined); // undefined: loading; null: new, not created yet
  const [live, setLive] = useState(null); // { text, status } while a turn runs or is being polled
  const [notice, setNotice] = useState(null); // a send that never reached the server
  const [history, setHistory] = useState(null); // list when the panel is open
  const [jos, setJos] = useState(false);
  const [match, setMatch] = useState(null);
  const matchSeq = useRef(0);
  const liveText = useRef('');
  liveText.current = live?.text ?? '';
  useWakeLock(!!live);
  const alive = useRef(true);
  const scroller = useRef(null);
  const content = useRef(null);
  const pinned = useRef(true);
  const streamAbort = useRef(null);
  const composer = useRef(null);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        let c = null;
        if (currentId) c = await api(`/conversations/${currentId}`).catch(() => null);
        if (!c) {
          const list = await api('/conversations');
          const recent = list[0];
          if (recent && Date.now() - recent.updatedAt < FRESH_MS) c = await api(`/conversations/${recent.id}`);
        }
        open(c);
      } catch (err) {
        if (alive.current) setConv(null);
      }
    })();
    const onVisible = () => document.visibilityState === 'visible' && currentId && !streamAbort.current && refreshPending(currentId);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      streamAbort.current?.abort(); // the server keeps the turn going; we poll when we come back
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  function open(c) {
    if (!alive.current) return;
    currentId = c?.id ?? null;
    pinned.current = true;
    matchSeq.current++;
    setMatch(sessionMatch && sessionMatch.convId === (c?.id ?? null) ? sessionMatch : null);
    setNotice(null);
    setLive(null);
    setConv(c);
    if (c?.pending) poll(c.id);
  }

  async function refreshPending(id) {
    const c = await api(`/conversations/${id}`).catch(() => null);
    if (c && alive.current && currentId === id) {
      setConv(c);
      if (c.pending) poll(id);
      else setLive(null);
    }
  }

  const polling = useRef(null);
  async function poll(id) {
    if (polling.current === id) return;
    polling.current = id;
    setLive((l) => ({ text: l?.text ?? '', status: l?.status ?? 'Aștept răspunsul…' }));
    try {
      while (alive.current && currentId === id) {
        await sleep(2000);
        const c = await api(`/conversations/${id}`).catch((e) => (e.status === 404 ? 'gone' : null));
        if (c === 'gone') return alive.current && open(null);
        if (c && !c.pending && alive.current && currentId === id) {
          setConv(c);
          setLive(null);
          return;
        }
      }
    } finally {
      if (polling.current === id) polling.current = null;
    }
  }

  async function send({ text, images = [], urgent = false }) {
    if (live) return false;
    setNotice(null);
    let id = conv?.id;
    const tmp = { id: 'tmp-' + Date.now(), role: 'user', text, images: images.map((d, i) => ({ id: 'l' + i, url: d })), ts: Date.now(), urgent, state: 'ok' };
    pinned.current = true;
    setLive({ text: '', status: 'Trimit…' });
    try {
      if (!id) {
        const c = await api('/conversations', { method: 'POST' });
        id = c.id;
        currentId = id;
        setConv({ ...c, messages: [] });
      }
      setConv((c) => ({ ...c, messages: [...c.messages, tmp] }));
      lookUp(id, text, images.length, conv?.id === id ? conv.messages.length : 0);
      const ctrl = new AbortController();
      streamAbort.current = ctrl;
      const res = await fetch(`/api/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images: images.map((dataUrl) => ({ dataUrl })), urgent }),
        signal: ctrl.signal,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) emit('unauthorized');
        if (res.status === 409) return void poll(id); // a turn is already running there
        if (res.status === 422 && err.error === 'cnp') { // the server's own check: nothing was stored
          forgetMatch();
          setConv((cv) => cv && { ...cv, messages: cv.messages.filter((m) => m.id !== tmp.id) });
          setLive(null);
          return 'cnp';
        }
        throw Object.assign(new Error(err.error || 'http'), { status: res.status });
      }
      await readStream(res, id, tmp.id);
      return true;
    } catch (err) {
      if (!alive.current) return false;
      // Lost before or during the post: if the server has it, wait for the answer; else give the text back.
      const c = id && (await api(`/conversations/${id}`).catch(() => null));
      if (c?.pending || c?.messages.some((m) => m.role === 'user' && m.ts >= tmp.ts - 60e3 && m.text === text)) {
        setConv(c);
        if (c.pending) poll(id);
        else setLive(null);
        return true;
      }
      forgetMatch();
      setConv((cv) => cv && { ...cv, messages: cv.messages.filter((m) => m.id !== tmp.id) });
      setLive(null);
      setNotice(isOffline(err) ? 'Mesajul n-a plecat: nu ai conexiune. Trimite din nou când ai semnal.' : 'Mesajul n-a plecat. Încearcă din nou.');
      return false;
    } finally {
      streamAbort.current = null;
    }
  }

  // The instant guideline match: asked at the same time as the message, shown above the answer that is
  // still being written. `at` is the place of her message in the list. If the answer has already started
  // when the hits arrive, the block goes under the text instead, so nothing she is reading moves.
  function forgetMatch() {
    matchSeq.current++;
    sessionMatch = null;
    setMatch(null);
  }
  function lookUp(convId, text, photos, at) {
    forgetMatch();
    const q = matchQuery(text);
    if (!wantsMatch(text, photos) || !q) return;
    const mine = matchSeq.current;
    api('/cauta?q=' + encodeURIComponent(q) + '&strict=1').then((r) => {
      if (mine !== matchSeq.current || currentId !== convId) return;
      const hits = (r.hits ?? []).slice(0, 3);
      if (!hits.length && !asksForGuideline(text)) return;
      sessionMatch = { convId, at, hits, below: liveText.current.length > 0 };
      if (alive.current) setMatch(sessionMatch);
    }, () => {});
  }

  async function readStream(res, id, tmpId) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const feed = createSseParser();
    let finished = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const { event, data } of feed(value)) {
          if (!alive.current || currentId !== id) continue;
          if (event === 'start') setConv((c) => ({ ...c, pending: true, title: c.title || data.userMessage.text.slice(0, 60), messages: c.messages.map((m) => (m.id === tmpId ? data.userMessage : m)) }));
          else if (event === 'status') setLive((l) => l && { ...l, status: data.label });
          else if (event === 'delta') setLive((l) => l && { ...l, text: l.text + (data.text ?? '') });
          else if (event === 'clear') setLive((l) => l && { ...l, text: '' });
          else if (event === 'done') {
            finished = true;
            setConv((c) => ({ ...c, pending: false, messages: [...c.messages, data.message] }));
            setLive(null);
          }
          // 'error' is always followed by 'done' with the stored message, which carries the error.
        }
      }
    } catch {}
    if (!finished && alive.current && currentId === id) poll(id);
  }

  const stop = () => conv?.id && api(`/conversations/${conv.id}/stop`, { method: 'POST' }).catch(() => {});

  function newConversation() {
    if (live) return;
    open(null);
    composer.current?.focus();
  }

  async function openHistory() {
    setHistory([]);
    try {
      setHistory(await api('/conversations'));
    } catch {
      setHistory(null);
    }
  }

  // Keep the newest text in view unless she scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !content.current) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content.current);
    ro.observe(el); // the composer growing (photos, long text) shrinks the scroll box
    return () => ro.disconnect();
  }, [conv === undefined]);

  // Only her own scrolling unpins the view; layout changes (a diagram replacing its placeholder,
  // the browser clamping scrollTop) must not.
  const lastInput = useRef(0);
  const touched = () => (lastInput.current = Date.now());
  const onScroll = () => {
    const el = scroller.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) pinned.current = true;
    else if (Date.now() - lastInput.current < 1000) pinned.current = false;
    else if (pinned.current) el.scrollTop = el.scrollHeight;
    setJos(!pinned.current);
  };
  const toBottom = () => {
    pinned.current = true;
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  const messages = conv?.messages ?? [];
  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const showChips = !live && last?.role === 'assistant' && last.state === 'ok';
  // Above the answer: right after her message. Below: after the answer's text (stored or still live).
  const matchAfter = match && (match.below ? match.at + 1 : match.at);
  const matchBlock = match && html`<${GuideMatch} hits=${match.hits} />`;

  return html`<section class="view chat">
    <header class="bar">
      <button class="icon-btn" type="button" onClick=${openHistory} aria-label="Istoric conversații"><${Icon} name="history" /></button>
      <h1 class="bar-title">${conv?.title || 'Conversație nouă'}</h1>
      <button class="icon-btn labelled" type="button" onClick=${newConversation} disabled=${!!live} aria-label="Conversație nouă"><${Icon} name="plus" /><span aria-hidden="true">Nouă</span></button>
    </header>

    <div class="chat-scroll" ref=${scroller} onScroll=${onScroll} onWheel=${touched} onTouchMove=${touched} onPointerDown=${touched} onKeyDown=${touched}>
      <div class="chat-content" ref=${content}>
        ${conv === undefined ? html`<p class="muted center pad">Se încarcă…</p>`
        : !messages.length && !live ? html`<${Empty} onPick=${(t) => composer.current?.fill(t)} />`
        : messages.map((m, i) => html`<${Message} key=${m.id} m=${m} newest=${m === last && !live} onResend=${() => lastUser && send({ text: lastUser.text })} />${i === matchAfter && matchBlock}`)}
        ${live && html`<div class="msg assistant live">
          ${live.text && html`<${Answer} text=${live.text} />`}
          ${match?.below && matchAfter === messages.length && matchBlock}
          <p class="status" role="status"><span class="pulse" aria-hidden="true"></span>${live.status || 'Mă gândesc…'}<${Elapsed} /></p>
        </div>`}
        ${showChips && html`<${FollowUps} onSend=${(text) => send({ text })} />`}
        ${notice && html`<p class="notice" role="alert">${notice}</p>`}
      </div>
    </div>

    ${jos && html`<div class="jos-wrap"><button class="jos" type="button" onClick=${toBottom}>jos<${Icon} name="down" /></button></div>`}

    <${Composer} handle=${composer} convId=${conv?.id} running=${!!live} disabled=${conv === undefined} onSend=${send} onStop=${stop} />

    ${history && html`<${History} list=${history} currentId=${conv?.id} onClose=${() => setHistory(null)}
      onOpen=${async (id) => { setHistory(null); open(await api(`/conversations/${id}`).catch(() => null)); }}
      onDeleted=${(id) => { setHistory((h) => h.filter((c) => c.id !== id)); if (id === conv?.id) open(null); }} />`}
  </section>`;
}

function Empty({ onPick }) {
  return html`<div class="empty">
    <p class="greet">Sunt aici. Întreabă scurt, cu sau fără diacritice, și îți răspund scurt.</p>
    <div class="chips">${STARTERS.map(([label, fill]) => html`<button class="chip" type="button" onClick=${() => onPick(fill)}>${label}</button>`)}</div>
  </div>`;
}

// "Din ghiduri": what the library itself has on her question, before the model has answered.
function GuideMatch({ hits }) {
  if (!hits.length) return html`<p class="match-none" role="status">Niciun ghid SOGR din bibliotecă nu acoperă direct asta.</p>`;
  return html`<aside class="match" aria-label="Din ghiduri">
    <p class="match-title">Din ghiduri</p>
    <ul class="match-rows">${hits.map((h, i) => html`<li key=${i}><a class="match-row" href=${hitHref(h)}>
      <span class="match-guide">${h.titlu}</span>
      <span class="match-sec">${h.sectiune}${h.pagina ? `, p. ${h.pagina}` : ''}</span>
    </a></li>`)}</ul>
  </aside>`;
}

function Message({ m, newest, onResend }) {
  if (m.role === 'user') {
    return html`<div class="msg user">
      ${m.urgent && html`<span class="tag urgent">Urgent</span>`}
      ${m.images?.length > 0 && html`<div class="msg-photos">${m.images.map((im) => (im.sters || !im.url
        ? html`<span key=${im.id} class="thumb gone">Poză ștearsă</span>`
        : html`<button key=${im.id} type="button" class="thumb" onClick=${() => emit('lightbox', im.url)} aria-label="Mărește poza"><img src=${im.url} alt="Poză trimisă" /></button>`))}</div>`}
      ${m.text && html`<p class="bubble">${m.text}</p>`}
    </div>`;
  }
  const code = m.state === 'error' ? m.error?.code : null;
  return html`<div class="msg assistant">
    ${m.text && html`<${Answer} text=${m.text} />`}
    ${m.state === 'oprit' && html`<p class="tag stopped">Oprit</p>`}
    ${code === 'limita' && html`<div class="card calm" role="status">
      <p>Rokhan a atins limita de utilizare.${m.error.resetAt ? ` Revine după ${timeHM(Date.parse(m.error.resetAt))}.` : ''} Registrul, lecturile și ghidurile merg în continuare.</p>
    </div>`}
    ${code && code !== 'limita' && html`<div class="card calm" role="status">
      <p>${code === 'intern' && m.error?.message?.startsWith('Răspunsul a fost întrerupt') ? m.error.message : 'Ceva n-a mers. Încearcă din nou.'}</p>
      ${newest && html`<button class="btn" type="button" onClick=${onResend}>Trimite din nou</button>`}
    </div>`}
    ${Array.isArray(m.writes) && m.writes.length > 0 && html`<${Writes} writes=${m.writes} />`}
    ${m.text && html`<${CopyButton} text=${m.text} />`}
  </div>`;
}

// What Rokhan changed in her data during this answer: ["memorie:profil", "registru:adauga"].
const PAGE_NAMES = { 'jurnal-de-studiu': 'jurnal de studiu', 'plan-de-studiu': 'plan de studiu', 'intrebari-deschise': 'întrebări deschise', corectii: 'corecții' };
function Writes({ writes }) {
  const pages = [...new Set(writes.filter((w) => typeof w === 'string' && w.startsWith('memorie:')).map((w) => w.slice(8)))];
  const logbook = writes.some((w) => typeof w === 'string' && w.startsWith('registru:'));
  if (!pages.length && !logbook) return null;
  return html`<p class="writes">
    ${pages.length > 0 && html`A notat în: ${pages.map((p, i) => html`${i ? ', ' : ''}${/^[a-z0-9-]+$/.test(p)
      ? html`<a href=${`#/mai-mult/memorie/${p}`}>${PAGE_NAMES[p] ?? p.replace(/-/g, ' ')}</a>` : p}`)}`}
    ${pages.length > 0 && logbook ? '. ' : ''}
    ${logbook && html`<a href="#/registru">A modificat registrul</a>`}
  </p>`;
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return html`<button class="link-btn copy" type="button" onClick=${async () => {
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }
  }}><${Icon} name="copy" />${done ? 'Copiat' : 'Copiază'}</button>`;
}

function FollowUps({ onSend }) {
  const [wrong, setWrong] = useState(null);
  const field = useRef(null);
  useEffect(() => void (wrong !== null && field.current?.focus()), [wrong !== null]);
  if (wrong !== null) {
    return html`<form class="wrong" onSubmit=${(e) => { e.preventDefault(); if (wrong.trim()) onSend(`Greșit: ${wrong.trim()}`); }}>
      <label for="wrong-text">Ce e greșit?</label>
      <textarea id="wrong-text" ref=${field} rows="2" value=${wrong} onInput=${(e) => setWrong(e.target.value)} />
      <div class="row">
        <button class="btn primary" type="submit" disabled=${!wrong.trim()}>Trimite</button>
        <button class="btn ghost" type="button" onClick=${() => setWrong(null)}>Renunță</button>
      </div>
    </form>`;
  }
  return html`<div class="chips follow">
    <button class="chip" type="button" onClick=${() => onSend('Mai detaliat')}>Mai detaliat</button>
    <button class="chip" type="button" onClick=${() => onSend('Surse')}>Surse</button>
    <button class="chip" type="button" onClick=${() => setWrong('')}>Greșit</button>
  </div>`;
}

// The composer keeps its own text, photos and urgent flag; the parent only sends.
// Plain-text elapsed time after 20 s of a running turn (mounted with the live block, gone when the turn ends).
// aria-hidden: a screen reader should not announce every second.
function Elapsed() {
  const [t0] = useState(Date.now);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const s = Math.floor((Date.now() - t0) / 1000);
  return s < 20 ? null : html`<span class="elapsed" aria-hidden="true">· ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>`;
}

function Composer({ handle, convId, running, disabled, onSend, onStop }) {
  const key = 'draft:' + (convId || 'nou');
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState([]);
  const [queue, setQueue] = useState([]);
  const [urgent, setUrgent] = useState(false);
  const [cnp, setCnp] = useState(false); // her text holds a personal numeric code: nothing is sent
  const ta = useRef(null);
  const file = useRef(null);

  // Drafts are read and written only once the conversation is known (disabled = still loading):
  // otherwise a draft from a lesson or guideline lands on 'nou' and the recent conversation hides it.
  useEffect(() => {
    if (disabled) return;
    const incoming = store.get('draft-in');
    if (incoming) store.set('draft-in', null);
    setText(incoming || store.get(key, ''));
  }, [key, disabled]);
  useEffect(() => void (!disabled && store.set(key, text || null)), [text, key, disabled]);
  useLayoutEffect(() => {
    const el = ta.current;
    const max = innerHeight * 0.35;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, max) + 'px';
    el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }, [text]);

  if (handle) handle.current = {
    focus: () => ta.current?.focus(),
    fill: (t) => {
      setText(t);
      requestAnimationFrame(() => {
        ta.current.focus();
        ta.current.setSelectionRange(t.length, t.length);
      });
    },
  };

  async function submit() {
    const t = text.trim();
    if ((!t && !photos.length) || running || disabled) return;
    if (containsCnp(t)) return setCnp(true);
    const sent = { text: t, images: photos, urgent };
    setText('');
    setPhotos([]);
    setUrgent(false);
    store.set(key, null);
    store.set('draft:nou', null);
    const ok = await onSend(sent);
    if (ok === 'cnp') setCnp(true);
    if (ok === false || ok === 'cnp') {
      setText(sent.text);
      setPhotos(sent.images);
      setUrgent(sent.urgent);
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) {
      e.preventDefault();
      submit();
    }
  };
  const pick = (e) => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
    e.target.value = '';
    setQueue(files);
  };
  const full = photos.length >= MAX_PHOTOS;

  return html`<div class=${'composer' + (urgent ? ' urgent' : '')}>
    ${photos.length > 0 && html`<div class="photos">${photos.map((p, i) => html`<div class="thumb" key=${i}>
      <img src=${p} alt=${`Poza ${i + 1}`} />
      <button type="button" class="thumb-x" aria-label=${`Scoate poza ${i + 1}`} onClick=${() => setPhotos(photos.filter((_, j) => j !== i))}>×</button>
    </div>`)}</div>`}
    ${cnp && html`<p class="cnp-line" id="cnp-line" role="alert">Mesajul pare să conțină un CNP. Șterge-l înainte să trimiți.</p>`}
    <div class="composer-row">
      <textarea ref=${ta} rows="1" value=${text} placeholder="Întreabă-l pe Rokhan…" aria-label="Mesaj"
        aria-describedby=${cnp ? 'cnp-line' : undefined}
        onInput=${(e) => { setText(e.target.value); if (cnp && !containsCnp(e.target.value)) setCnp(false); }} onKeyDown=${onKey} enterkeyhint=${coarse() ? 'enter' : 'send'} />
      ${running
        ? html`<button class="send stop" type="button" onClick=${onStop} aria-label="Oprește răspunsul"><${Icon} name="stop" /></button>`
        : html`<button class="send" type="button" onClick=${submit} disabled=${disabled || (!text.trim() && !photos.length)} aria-label="Trimite"><${Icon} name="send" /></button>`}
    </div>
    <div class="composer-tools">
      <button class="tool" type="button" onClick=${() => file.current.click()} disabled=${full} aria-label="Adaugă poză (cameră sau galerie)"><${Icon} name="camera" /><span>Poză${photos.length ? ` ${photos.length}/${MAX_PHOTOS}` : ''}</span></button>
      <button class=${'tool' + (urgent ? ' on' : '')} type="button" aria-pressed=${urgent} onClick=${() => setUrgent(!urgent)}><${Icon} name="bolt" /><span>Urgent</span></button>
      <input ref=${file} type="file" accept="image/*" multiple hidden onChange=${pick} />
    </div>
    ${queue[0] && html`<${CropView} file=${queue[0]}
      onDone=${(dataUrl) => { setPhotos((p) => [...p, dataUrl].slice(0, MAX_PHOTOS)); setQueue((q) => q.slice(1)); }}
      onCancel=${() => setQueue((q) => q.slice(1))} />`}
  </div>`;
}

function History({ list, currentId, onClose, onOpen, onDeleted }) {
  const [confirm, setConfirm] = useState(null);
  const del = async (id) => {
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' });
      onDeleted(id);
    } catch {}
    setConfirm(null);
  };
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="sheet-back" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Conversații">
      <header class="sheet-head"><h2>Conversații</h2><button class="icon-btn" type="button" onClick=${onClose} aria-label="Închide"><${Icon} name="close" /></button></header>
      ${!list.length ? html`<p class="muted pad">Nicio conversație încă.</p>` : html`<ul class="conv-list">
        ${list.map((c) => html`<li key=${c.id} class=${c.id === currentId ? 'current' : ''}>
          ${confirm === c.id ? html`<div class="confirm">
            <span>Ștergi conversația?</span>
            <button class="btn danger" type="button" onClick=${() => del(c.id)}>Da, șterge</button>
            <button class="btn ghost" type="button" onClick=${() => setConfirm(null)}>Nu</button>
          </div>` : html`<button class="conv" type="button" onClick=${() => onOpen(c.id)}>
            <span class="conv-top"><span class="conv-title">${c.title || 'Fără titlu'}</span><span class="conv-when">${whenLabel(c.updatedAt)}</span></span>
            <span class="conv-prev">${c.imported && html`<span class="tag">Telegram</span>`}${c.preview.replace(/\*\*|__|`|^#+\s*/gm, '')}</span>
          </button>
          <button class="icon-btn del" type="button" aria-label=${`Șterge „${c.title || 'Fără titlu'}”`} onClick=${() => setConfirm(c.id)}><${Icon} name="trash" /></button>`}
        </li>`)}
      </ul>`}
    </div>
  </div>`;
}
