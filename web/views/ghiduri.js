// Ghiduri: the SOGR library. Routes: #/ghiduri (search + list), #/ghiduri/<nr> (contents),
// #/ghiduri/<nr>/<section index>[?l=<from>-<to>] (section text, a search hit highlighted),
// #/ghiduri/<nr>/cauta?l=<from>-<to>&f=<file> (a search hit: finds its section, then shows it).
import { html, api, askRokhan, isOffline } from '../api.js';
import { useState, useEffect, useRef } from '../vendor/preact-hooks-11.2.0.mjs';
import { cleanGuideText } from '../lib/blocks.js';
import { hitHref } from '../lib/ghid.js';
import { mdToHtml, marksOnly, pageBadges } from '../ui/markdown.js';
import { Icon } from '../ui/icons.js';

const MAX_LINES = 400; // the server reads at most this many lines per call
const tocs = new Map();
let guidesCache = null;
let last = { q: '', hits: null }; // the search survives going into a guideline and back

const getToc = async (nr) => tocs.get(nr) ?? tocs.set(nr, await api(`/ghiduri/${encodeURIComponent(nr)}`)).get(nr);
const sectionLabel = (s) => (s ? `${s.nr ? s.nr + ' ' : ''}${s.titlu}` : '');

export function Ghiduri({ rest, query }) {
  if (rest[0] && rest[1] !== undefined) return html`<${Section} nr=${rest[0]} which=${rest[1]} query=${query} />`;
  if (rest[0]) return html`<${Contents} nr=${rest[0]} />`;
  return html`<${Library} />`;
}

function Bar({ title, back }) {
  return html`<header class="bar">
    ${back ? html`<a class="icon-btn" href=${back} aria-label="Înapoi"><${Icon} name="back" /></a>` : ''}
    <h1 class=${'bar-title' + (back ? ' left' : '')}>${title}</h1>
    ${back ? html`<span class="bar-spacer" />` : ''}
  </header>`;
}

function Library() {
  const [guides, setGuides] = useState(guidesCache);
  const [q, setQ] = useState(last.q);
  const [hits, setHits] = useState(last.hits);
  const [state, setState] = useState(null); // null | 'caut' | 'eroare'
  const timer = useRef(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!guidesCache) api('/ghiduri').then((g) => setGuides((guidesCache = g)), () => setState('lista'));
  }, []);

  function onInput(e) {
    const v = e.target.value;
    setQ(v);
    clearTimeout(timer.current);
    if (v.trim().length < 3) {
      last = { q: v, hits: null };
      setHits(null);
      setState(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      setState('caut');
      try {
        const r = await api('/cauta?q=' + encodeURIComponent(v.trim()));
        if (mine !== seq.current) return;
        last = { q: v, hits: r.hits };
        setHits(r.hits);
        setState(null);
      } catch {
        if (mine === seq.current) setState('eroare');
      }
    }, 250);
  }

  return html`<section class="view">
    <${Bar} title="Ghiduri" />
    <div class="page">
      <form class="search" role="search" onSubmit=${(e) => e.preventDefault()}>
        <${Icon} name="search" />
        <input type="search" value=${q} onInput=${onInput} placeholder="Caută în ghiduri, și fără diacritice" aria-label="Caută în ghiduri" enterkeyhint="search" />
      </form>
      ${state === 'caut' && html`<p class="muted small" role="status">Caut…</p>`}
      ${state === 'eroare' && html`<p class="muted small" role="status">Căutarea nu merge acum. Verifică conexiunea.</p>`}
      ${state === 'lista' && !hits && html`<p class="muted small" role="status">Lista ghidurilor nu se încarcă. Verifică conexiunea.</p>`}
      ${hits && (hits.length
        ? html`<ul class="hits">${hits.map((h, i) => html`<li key=${i}><a class="hit" href=${hitHref(h)}>
            <span class="hit-guide">${h.titlu}</span>
            <span class="hit-sec">${h.sectiune}${h.pagina ? `, p. ${h.pagina}` : ''}${h.fisier.includes('/actualizari/') ? ', ghiduri noi' : ''}</span>
            <span class="hit-frag" dangerouslySetInnerHTML=${{ __html: marksOnly(h.fragment) }} />
          </a></li>`)}</ul>`
        : html`<p class="muted">Nimic găsit pentru „${last.q.trim()}”.</p>`)}
      ${!hits && html`<ul class="list guides">${(guides ?? []).map((g) => html`<li key=${g.nr}><a class="list-item" href=${`#/ghiduri/${encodeURIComponent(g.nr)}`}>
        <span class="nr">${g.nr === 'curriculum' ? '' : g.nr}</span><span class="grow">${g.titlu}</span><span class="count">${g.versiune}</span>
      </a></li>`)}</ul>`}
    </div>
  </section>`;
}

function Contents({ nr }) {
  const [toc, setToc] = useState(tocs.get(nr) ?? null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    getToc(nr).then(setToc, (e) => setErr(e.status === 404 ? 'Ghidul nu există.' : 'Cuprinsul nu se încarcă.'));
  }, [nr]);
  if (!toc) return html`<section class="view"><${Bar} title="Ghid" back="#/ghiduri" /><p class="muted center pad">${err || 'Se încarcă…'}</p></section>`;
  return html`<section class="view">
    <${Bar} title=${toc.titlu} back="#/ghiduri" />
    <div class="page">
      <h2 class="guide-title">${toc.titlu}</h2>
      <p class="muted">${toc.versiune}${toc.url ? html`, <a href=${toc.url} target="_blank" rel="noopener noreferrer">PDF original</a>` : ''}</p>
      <ul class="list toc">${toc.sectiuni.map((s, i) => html`<li key=${i}><a class="list-item" href=${`#/ghiduri/${encodeURIComponent(nr)}/${i}`}>
        <span class="nr">${s.nr}</span><span class="grow">${s.titlu}</span><span class="count">p. ${s.pagini}</span>
      </a></li>`)}</ul>
    </div>
  </section>`;
}

// Index of the section a search hit belongs to.
function sectionOfHit(toc, from, fisier) {
  if (toc.nr === 'curriculum') return Math.max(0, toc.sectiuni.findIndex((s) => s.fisier === fisier));
  if (fisier?.includes('/actualizari/')) {
    const i = toc.sectiuni.findIndex((s) => s.ghiduriNoi && from >= s.ghiduriNoi[0] && from <= s.ghiduriNoi[1]);
    return i < 0 ? 0 : i;
  }
  let idx = 0;
  toc.sectiuni.forEach((s, i) => {
    if (s.linii[0] <= from) idx = i;
  });
  return idx;
}

async function readRange(nr, from, to, fisier) {
  const lines = [];
  for (let a = from; a <= to; a += MAX_LINES) {
    const q = new URLSearchParams({ from: a, to: Math.min(to, a + MAX_LINES - 1) });
    if (fisier) q.set('fisier', fisier);
    const r = await api(`/ghiduri/${encodeURIComponent(nr)}/text?${q}`);
    lines.push(...r.markdown.split('\n'));
    if (r.to >= r.total) break;
  }
  return lines;
}

function Section({ nr, which, query }) {
  const [toc, setToc] = useState(tocs.get(nr) ?? null);
  const [lines, setLines] = useState(null);
  const [err, setErr] = useState(null);
  const hitRef = useRef(null);
  const [hitFrom, hitTo] = (query.l || '').split('-').map(Number);
  const fromUpdates = which === 'cauta' && query.f?.includes('/actualizari/');
  const i = toc ? (which === 'cauta' ? sectionOfHit(toc, hitFrom, query.f) : Number(which)) : null;
  const sec = toc?.sectiuni[i];

  useEffect(() => {
    getToc(nr).then(setToc, (e) => setErr(isOffline(e) ? 'Fără conexiune.' : 'Ghidul nu se încarcă.'));
  }, [nr]);
  useEffect(() => {
    if (!sec) return;
    setLines(null);
    readRange(nr, sec.linii[0], sec.linii[1], sec.fisier).then(setLines, (e) => setErr(isOffline(e) ? 'Fără conexiune.' : 'Textul nu se încarcă.'));
  }, [nr, i]);
  useEffect(() => {
    if (lines) (hitRef.current ? hitRef.current.scrollIntoView({ block: 'start' }) : document.querySelector('.main')?.scrollTo({ top: 0 }));
  }, [lines]);

  const back = `#/ghiduri/${encodeURIComponent(nr)}`;
  if (!toc || (toc && !sec)) return html`<section class="view"><${Bar} title="Ghid" back=${back} /><p class="muted center pad">${err || (toc ? 'Secțiunea nu există.' : 'Se încarcă…')}</p></section>`;

  // Split the section around the hit, so the hit can be marked and scrolled to.
  const start = sec.linii[0];
  const parts = [];
  if (lines) {
    const hasHit = !fromUpdates && hitFrom >= start && hitFrom <= start + lines.length - 1;
    if (!hasHit) parts.push({ text: lines.join('\n') });
    else {
      const a = hitFrom - start;
      const b = Math.min(lines.length, (hitTo || hitFrom) - start + 1);
      parts.push({ text: lines.slice(0, a).join('\n') }, { text: lines.slice(a, b).join('\n'), hit: true }, { text: lines.slice(b).join('\n') });
    }
  }
  const prev = toc.sectiuni[i - 1];
  const next = toc.sectiuni[i + 1];

  return html`<section class="view">
    <${Bar} title=${toc.titlu} back=${back} />
    <article class="page guide">
      <h2 class="guide-sec">${sectionLabel(sec)}</h2>
      <p class="muted small">p. ${sec.pagini}</p>
      ${fromUpdates && html`<p class="card calm small">Rezultatul vine din comparația cu ghidurile internaționale noi; aici e secțiunea din ghidul SOGR la care se referă.</p>`}
      ${!lines ? html`<p class="muted">${err || 'Se încarcă…'}</p>` : parts.map((p, k) => p.text.trim() && html`<div key=${k} ref=${p.hit ? hitRef : null} class=${'md guide-text' + (p.hit ? ' hit-lines' : '')}
          dangerouslySetInnerHTML=${{ __html: pageBadges(mdToHtml(cleanGuideText(p.text))) }} />`)}
      <nav class="sec-nav" aria-label="Secțiuni">
        ${prev ? html`<a class="btn" href=${`${back}/${i - 1}`}><${Icon} name="back" /><span>${sectionLabel(prev)}</span></a>` : html`<span />`}
        ${next ? html`<a class="btn next" href=${`${back}/${i + 1}`}><span>${sectionLabel(next)}</span><span class="flip"><${Icon} name="back" /></span></a>` : html`<span />`}
      </nav>
      <div class="lesson-end">
        <button class="btn wide" type="button" onClick=${() => askRokhan(`Din ghidul SOGR „${toc.titlu}”, secțiunea „${sectionLabel(sec)}”: `)}><${Icon} name="chat" />Întreabă-l pe Rokhan despre asta</button>
        ${toc.url && html`<a class="btn ghost wide" href=${toc.url} target="_blank" rel="noopener noreferrer"><${Icon} name="ext" />PDF original</a>`}
      </div>
    </article>
  </section>`;
}
