// Videotecă: films of operations in the order of her curriculum. Videos open outside the app, never embedded.
// Routes: #/videoteca (Start aici, chapters, resources; ?v=<video address> opens at that film),
// #/videoteca/capitol/<id> (?p=<procedure name> or ?v=<video address> opens at it).
import { html, api, toast, isOffline, onVisible } from '../api.js';
import { useState, useEffect } from '../vendor/preact-hooks-11.2.0.mjs';
import { ACCESS, LEVEL, TIER, NO_FILTERS, isFiltering, videosOf, totalTime, filterSections, shortBarem, registruLine } from '../lib/videoteca.js';
import { countWord, longDate } from '../lib/format.js';
import { Progress } from '../ui/progress.js';
import { Icon } from '../ui/icons.js';

const PARTS = [['start', 'Start aici'], ['capitole', 'Capitole'], ['resurse', 'Resurse']];
let cache = null; // the last catalog, so coming back to the tab is instant
let keptFilters = NO_FILTERS; // the search and the filters survive moving around
let keptPart = 'start';

const films = (n) => countWord(n, 'film', 'filme');
const chapterHref = (id, query = '') => `#/videoteca/capitol/${encodeURIComponent(id)}${query}`;
const seenOf = (videos, seen) => videos.filter((v) => seen.has(v.url)).length;

// Her "Văzut" ticks: shown at once, taken back when the server did not save them.
export function useTicks(start) {
  const [seen, setSeen] = useState(() => new Set(start));
  const mark = (url, on) => setSeen((cur) => {
    const next = new Set(cur);
    if (on) next.add(url);
    else next.delete(url);
    return next;
  });
  async function tick(url, on) {
    mark(url, on);
    try {
      await api('/videoteca/vazut', { method: 'PUT', body: { url, vazut: on } });
    } catch (e) {
      mark(url, !on);
      toast({ text: isOffline(e) ? 'Fără conexiune. Bifează din nou când ai semnal.' : 'Bifa nu s-a salvat. Încearcă din nou.' });
    }
  }
  return [seen, tick, (urls) => setSeen(new Set(urls))];
}

export function VideoRow({ v, step, text, seen, onTick, target }) {
  return html`<li class=${'vid' + (seen ? ' seen' : '') + (target ? ' target' : '')} data-url=${v.url}>
    <a class="vid-link" href=${v.url} target="_blank" rel="noopener noreferrer">
      <span class="vid-title">${step ? `${step}. ` : ''}${v.title}</span>${v.duration && html`<span class="vid-dur">${v.duration}</span>`}
    </a>
    <p class="vid-meta">${[v.source, TIER[v.source_tier], v.year].filter(Boolean).join(', ')}</p>
    ${text && html`<p class="vid-text">${text}</p>`}
    ${v.caveat_ro && html`<p class="vid-caveat"><b>Atenție:</b> ${v.caveat_ro}</p>`}
    <div class="vid-foot">
      <span class=${'tag' + (v.access === 'free' ? '' : ' gate')}>${ACCESS[v.access] ?? v.access}</span>
      <span class="tag">${LEVEL[v.level] ?? v.level}</span>
      <label class="check vid-seen"><input type="checkbox" checked=${seen} onChange=${(e) => onTick(v.url, e.target.checked)} aria-label=${`Văzut: ${v.title}`} />Văzut</label>
    </div>
  </li>`;
}

export function Videoteca({ rest, query }) {
  const [data, setData] = useState(cache);
  const [failed, setFailed] = useState(false);
  const [fresh, setFresh] = useState(false); // this visit has the catalog as the server has it now
  const [seen, tick, setSeen] = useTicks(cache?.vazute);
  const [f, setF] = useState(keptFilters);
  const [part, setPart] = useState(keptPart);
  const chapter = rest[0] === 'capitol' ? rest[1] : null;
  const filter = (patch) => setF((cur) => (keptFilters = { ...cur, ...patch }));
  const show = (p) => setPart((keptPart = p));

  // Fetched again when she comes back to the app, so ticks made on another device show up.
  useEffect(() => {
    const load = () => api('/videoteca').then(
      (d) => (setData((cache = d)), setSeen(d.vazute), setFailed(false), setFresh(true)),
      () => setFailed(true),
    );
    load();
    return onVisible(load);
  }, []);
  useEffect(() => {
    if (cache) cache.vazute = [...seen]; // so the next visit starts from her latest ticks
  }, [seen]);

  // Where to be after a route change: at the film or procedure asked for, else at the top.
  // A film missing from the kept catalog waits for the fresh one: a notification can be newer than it.
  const there = !!data && (!query.v || data.sections.some((s) => s.procedures.some((p) => p.videos.some((x) => x.url === query.v))));
  const waiting = !data || (!there && !fresh);
  useEffect(() => {
    if (waiting) return;
    const { v, p } = query;
    if (!v && !p) {
      document.querySelector('.main')?.scrollTo({ top: 0 });
      return;
    }
    filter(NO_FILTERS); // a filter must not hide what she was sent to
    if (v && !chapter) {
      if (data.start_here.some((x) => x.url === v)) show('start');
      else {
        const s = data.sections.find((s) => videosOf(s.procedures).some((x) => x.url === v));
        if (s) location.replace(chapterHref(s.id, `?v=${encodeURIComponent(v)}`));
        else toast({ text: 'Filmul nu mai e în catalog.' });
        return;
      }
    }
    const sel = v ? `[data-url="${CSS.escape(v)}"]` : `[data-proc="${CSS.escape(p)}"]`;
    setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), 80); // after the list is drawn
  }, [waiting, there, chapter, query.v, query.p]);

  const section = chapter && data?.sections.find((s) => s.id === chapter);
  const title = chapter ? section?.title_ro ?? 'Capitol' : 'Videotecă';
  const bar = html`<header class="bar">
    ${chapter ? html`<a class="icon-btn" href="#/videoteca" aria-label="Înapoi"><${Icon} name="back" /></a>` : ''}
    <h1 class=${'bar-title' + (chapter ? ' left' : '')}>${title}</h1>
    ${chapter ? html`<span class="bar-spacer" />` : ''}
  </header>`;
  if (!data || (chapter && !section)) {
    return html`<section class="view">${bar}<p class="muted center pad">${data ? 'Capitolul nu există.' : failed ? 'Videoteca nu se încarcă. Verifică conexiunea.' : 'Se încarcă…'}</p></section>`;
  }

  const rows = { seen, tick, target: query.v };
  const filtering = isFiltering(f);
  const scope = section ? [section] : data.sections;
  const results = filtering || section ? filterSections(scope, f, seen) : [];
  const all = videosOf(scope.flatMap((s) => s.procedures));
  const today = !section && !filtering && data.filmulZilei && all.find((v) => v.url === data.filmulZilei);

  return html`<section class="view">
    ${bar}
    <div class="page vlib">
      ${today && html`<h2 class="section">Filmul zilei</h2>
        <ul class="vids"><${VideoRow} v=${today} text=${today.covers_ro} seen=${seen.has(today.url)} onTick=${tick} target=${query.v === today.url} /></ul>`}
      <${Progress} label="Văzute" n=${seenOf(all, seen)} total=${all.length} />
      ${section?.intro_ro && html`<p class="muted">${section.intro_ro}</p>`}
      <form class="search" role="search" onSubmit=${(e) => e.preventDefault()}>
        <${Icon} name="search" />
        <input type="search" value=${f.q} onInput=${(e) => filter({ q: e.target.value })} placeholder=${section ? 'Caută în capitol' : 'Caută o operație sau un film'} aria-label="Caută o procedură sau un film" enterkeyhint="search" autocomplete="off" />
      </form>
      <div class="seg" role="radiogroup" aria-label="Nivel">
        ${[['all', 'Toate'], ...Object.entries(LEVEL)].map(([v, l]) => html`<label key=${v}><input type="radio" name="nivel" checked=${f.level === v} onChange=${() => filter({ level: v })} /><span>${l}</span></label>`)}
      </div>
      <div class="vfilters">
        <label class="check"><input type="checkbox" checked=${f.free} onChange=${(e) => filter({ free: e.target.checked })} />Doar fără cont</label>
        <label class="check"><input type="checkbox" checked=${f.hide} onChange=${(e) => filter({ hide: e.target.checked })} />Ascunde văzute</label>
      </div>

      ${section ? html`
        ${results[0]?.procedures.map((p) => html`<${Procedure} key=${p.name_ro} p=${p} ...${rows} />`)}
        ${!results.length && html`<${Nothing} />`}`
      : filtering ? html`
        ${results.map((s) => html`<div key=${s.id}>
          <h2 class="section">${s.title_ro} <span class="muted small">${films(videosOf(s.procedures).length)}</span></h2>
          ${s.procedures.map((p) => html`<${Procedure} key=${p.name_ro} p=${p} ...${rows} />`)}
        </div>`)}
        ${!results.length && html`<${Nothing} />`}`
      : html`
        <div class="seg vparts" role="radiogroup" aria-label="Ce arăt">
          ${PARTS.map(([v, l]) => html`<label key=${v}><input type="radio" name="parte" checked=${part === v} onChange=${() => show(v)} /><span>${l}</span></label>`)}
        </div>
        ${part === 'start' && html`<${Start} data=${data} ...${rows} />`}
        ${part === 'capitole' && html`<ul class="list progress">${data.sections.map((s, i) => {
          const videos = videosOf(s.procedures);
          const n = seenOf(videos, seen);
          return html`<li key=${s.id}><a class="list-item" href=${chapterHref(s.id)}>
            <span class="nr">${i + 1}</span><span class="grow">${s.title_ro}</span><span class="count">${n} din ${videos.length}</span>
            <span class="mini" aria-hidden="true"><span style=${{ width: (videos.length ? (100 * n) / videos.length : 0) + '%' }} /></span>
          </a></li>`;
        })}</ul>`}
        ${part === 'resurse' && html`<${Resources} data=${data} />`}`}
    </div>
  </section>`;
}

const Nothing = () => html`<p class="muted">Niciun film nu se potrivește. Șterge căutarea sau alege „Toate”.</p>`;

function Procedure({ p, seen, tick, target }) {
  return html`<article class="vproc" data-proc=${p.name_ro}>
    <div class="vproc-head"><h3>${p.name_ro}</h3>${shortBarem(p.barem) && html`<span class="tag">barem ${p.barem}</span>`}</div>
    <p class="vid-meta">${p.name_en}</p>
    ${p.barem && !shortBarem(p.barem) && html`<p class="vid-meta">Barem: ${p.barem}</p>`}
    ${p.registru?.map((r) => html`<p key=${r.id} class="vreg"><a href="#/registru">${registruLine(r, p.registru.length > 1)}</a></p>`)}
    ${p.note_ro && html`<p class="vid-caveat">${!p.videos.length && html`<b>Lipsă: </b>`}${p.note_ro}</p>`}
    ${!p.videos.length ? !p.note_ro && html`<p class="vid-caveat">Niciun film încă.</p>`
    : html`<ul class="vids">${p.videos.map((v) => html`<${VideoRow} key=${v.url} v=${v} text=${v.covers_ro} seen=${seen.has(v.url)} onTick=${tick} target=${target === v.url} />`)}</ul>`}
  </article>`;
}

function Start({ data, seen, tick, target }) {
  const byUrl = new Map(videosOf(data.sections.flatMap((s) => s.procedures)).map((v) => [v.url, v]));
  const list = data.start_here.map((x) => ({ ...byUrl.get(x.url), why: x.why_ro }));
  return html`<h2 class="section">Start aici</h2>
    <p class="muted">${films(list.length)}, ${totalTime(list)} în total, în ordinea recomandată.</p>
    <ol class="vids">${list.map((v, i) => html`<${VideoRow} key=${v.url} v=${v} step=${i + 1} text=${v.why} seen=${seen.has(v.url)} onTick=${tick} target=${target === v.url} />`)}</ol>`;
}

function Resources({ data }) {
  // "Obstetrică: ..." reads as a label and its text
  const gap = (g) => (g.indexOf(': ') > 0 ? html`<b>${g.slice(0, g.indexOf(': '))}:</b> ${g.slice(g.indexOf(': ') + 2)}` : g);
  return html`<h2 class="section">Biblioteci video</h2>
    <ul class="vids">${data.libraries.map((l) => html`<li key=${l.url} class="vid">
      <a class="vid-link" href=${l.url} target="_blank" rel="noopener noreferrer"><span class="vid-title">${l.name}</span><${Icon} name="ext" /></a>
      <p class="vid-text">${l.what_ro}</p>
      ${l.verified === false && html`<p class="vid-caveat"><b>Neverificat:</b> site-ul nu a putut fi deschis automat la verificare.</p>`}
      <div class="vid-foot"><span class=${'tag' + (l.access === 'free' ? '' : ' gate')}>${ACCESS[l.access] ?? l.access}</span></div>
    </li>`)}</ul>
    <h2 class="section">Lipsuri</h2>
    <p class="muted">Proceduri pentru care nu există încă un film bun și gratuit.</p>
    <ul class="plain">${data.gaps_ro.map((g) => html`<li>${gap(g)}</li>`)}</ul>
    <h2 class="section">De știut</h2>
    <ul class="plain">${data.notes_ro.map((n) => html`<li>${n}</li>`)}</ul>
    ${data.generated && html`<p class="muted small">Catalog din ${longDate(data.generated)}. Baremul de lângă proceduri este cel din curriculumul de rezidențiat OG din 2019. Pentru anul tău de intrare poate fi altul.</p>`}`;
}
