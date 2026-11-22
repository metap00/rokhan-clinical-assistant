// Lecturi: lessons she pulls herself. Routes: #/lecturi, #/lecturi/<id> (reader), #/lecturi/recap,
// #/lecturi/repetitie (today's spaced review of the quiz questions).
import { html, api, toast, askRokhan, sleep, isOffline } from '../api.js';
import { useState, useEffect, useRef } from '../vendor/preact-hooks-11.2.0.mjs';
import { dayLabel, countWord } from '../lib/format.js';
import { marksOnly } from '../ui/markdown.js';
import { Icon } from '../ui/icons.js';

const POLL_MS = 10e3;
const POLL_FOR_MS = 5 * 60e3;
const REVIEW_MAX = 10; // the server serves at most ten review cards a day
let lastRead = null; // id just finished: the tab then asks "Încă una?"
let generating = null; // { id, until } survives leaving the tab

export function Lecturi({ rest }) {
  if (rest[0] === 'recap') return html`<${Recap} />`;
  if (rest[0] === 'repetitie') return html`<${Review} />`;
  if (rest[0]) return html`<${Reader} id=${rest[0]} />`;
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
  const [st, setSt] = useState(null);
  const [failed, setFailed] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [open, setOpen] = useState(null); // guideline row offering "Citește din acest ghid"
  const [allRead, setAllRead] = useState(false);
  const [wait, setWait] = useState(null); // null | 'scrie' | 'timeout'
  const [pauseOpen, setPauseOpen] = useState(false);

  useEffect(() => {
    api('/lecturi').then(setSt, () => setFailed(true));
  }, []);

  const next = st?.urmatoarea;
  useEffect(() => {
    if (next && !next.scrisa && generating?.id === next.id && Date.now() < generating.until) pollWritten(next.id);
  }, [next?.id]);

  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  async function pollWritten(id) {
    setWait('scrie');
    while (generating?.id === id && Date.now() < generating.until) {
      await sleep(POLL_MS);
      if (!alive.current) return;
      try {
        await api(`/lecturi/${id}`);
        generating = null;
        setWait(null);
        setSt(await api('/lecturi'));
        return;
      } catch (e) {
        if (e.status && e.status !== 404) break;
      }
    }
    if (alive.current && generating?.id === id) {
      generating = null;
      setWait('timeout');
    }
  }

  async function prepare() {
    try {
      const r = await api(`/lecturi/${next.id}/genereaza`, { method: 'POST' });
      if (r.status === 'scrisa') return setSt(await api('/lecturi'));
      generating = { id: next.id, until: Date.now() + POLL_FOR_MS };
      pollWritten(next.id);
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune.' : 'Ceva n-a mers. Încearcă din nou.' });
    }
  }

  async function act(path, body, done) {
    try {
      setSt(await api(path, { method: 'POST', body }));
      done?.();
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune.' : 'Ceva n-a mers. Încearcă din nou.' });
    }
  }

  // "Pauză" moves the whole review schedule forward: nothing piles up while she is away.
  async function pause(zile) {
    try {
      const r = await api('/lecturi/repetitie/pauza', { method: 'POST', body: { zile } });
      setSt((s) => ({ ...s, repetitie: r }));
      setPauseOpen(false);
      toast({ text: `Repetiția e în pauză ${zile} zile.` });
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune.' : 'Ceva n-a mers. Încearcă din nou.' });
    }
  }

  if (!st) return html`<section class="view"><${Bar} title="Lecturi" /><p class="muted center pad">${failed ? 'Lecturile nu se încarcă. Verifică conexiunea.' : 'Se încarcă…'}</p></section>`;

  const citite = allRead ? st.citite : st.citite.slice(0, 6);
  const due = Math.min(st.repetitie?.scadente ?? 0, REVIEW_MAX); // a session is at most ten: no backlog to look at
  return html`<section class="view">
    <${Bar} title="Lecturi" />
    <div class="page">
      ${due > 0 && html`<div class="review-card">
        <div class="review-card-text"><span class="recap-title">De repetat azi</span><span class="muted">${countWord(due, 'întrebare', 'întrebări')}</span></div>
        <a class="btn primary" href="#/lecturi/repetitie">Începe</a>
        <button class="icon-btn" type="button" aria-label="Repetiție: pauză" aria-expanded=${pauseOpen} onClick=${() => setPauseOpen(!pauseOpen)}><${Icon} name="dots" /></button>
        ${pauseOpen && html`<div class="review-pause" role="group" aria-label="Pauză"><span>Pauză</span>
          ${[3, 7, 14].map((z) => html`<button key=${z} class="btn" type="button" onClick=${() => pause(z)}>${z} zile</button>`)}
        </div>`}
      </div>`}
      ${next ? html`<div class="next">
        <p class="next-kicker">${lastRead ? 'Încă una?' : 'Lectura următoare'}</p>
        <p class="next-guide">${next.ghid.titlu}</p>
        ${next.scrisa ? html`<h2 class="next-title">${next.titlu}</h2>` : html`<p class="next-topics">${next.titlu}</p>`}
        <p class="next-meta">lectura ${next.k} din ${next.n}${next.minute ? `, cam ${next.minute} minute` : ''}</p>
        ${next.scrisa
          ? html`<a class="btn primary big wide" href=${`#/lecturi/${next.id}`}>Citește</a>`
          : wait === 'scrie' ? html`<p class="writing" role="status"><span class="pulse" aria-hidden="true"></span>Rokhan scrie lectura. Durează cam două minute.</p>`
          : html`${wait === 'timeout' && html`<p class="muted">Lectura nu e gata încă. Încearcă din nou puțin mai târziu.</p>`}
            <button class="btn primary big wide" type="button" onClick=${prepare}>Pregătește lectura</button>`}
        ${confirmSkip
          ? html`<div class="confirm-inline skip"><span>Sari peste lectura asta?</span>
              <button class="btn danger" type="button" onClick=${() => act(`/lecturi/${next.id}/sari`, undefined, () => setConfirmSkip(false))}>Da, sari</button>
              <button class="btn ghost" type="button" onClick=${() => setConfirmSkip(false)}>Nu</button></div>`
          : html`<button class="btn ghost skip" type="button" onClick=${() => setConfirmSkip(true)}>Sari peste</button>`}
      </div>` : html`<div class="next"><p class="next-title">Ai citit toate lecturile.</p></div>`}

      ${st.recap?.disponibil && html`<a class="recap-card" href="#/lecturi/recap">
        <span class="recap-title">Recapitularea săptămânii</span>
        <span class="muted">${st.recap.lectii.length === 1 ? 'o lectură' : `${st.recap.lectii.length} lecturi`} din ultimele 7 zile: puncte-cheie, cifre, quiz</span>
      </a>`}

      ${st.citite.length > 0 && html`<h2 class="section">Citite recent</h2>
        <ul class="list">${citite.map((c) => html`<li key=${c.id}><a class="list-item" href=${`#/lecturi/${c.id}`}>
          <span>${c.titlu}</span><span class="muted small">${dayLabel(c.data)}</span></a></li>`)}</ul>
        ${!allRead && st.citite.length > citite.length && html`<button class="btn wide" type="button" onClick=${() => setAllRead(true)}>Arată toate (${st.citite.length})</button>`}`}

      <h2 class="section">Progres pe ghiduri</h2>
      <ul class="list progress">${st.progres.map((g) => html`<li key=${g.nr}>
        <button class="list-item" type="button" aria-expanded=${open === g.nr} onClick=${() => setOpen(open === g.nr ? null : g.nr)}>
          <span class="nr">${g.nr}</span><span class="grow">${g.titlu}</span><span class="count">${g.citite}/${g.total}</span>
          <span class="mini" aria-hidden="true"><span style=${{ width: (g.total ? Math.round((g.citite / g.total) * 100) : 0) + '%' }} /></span>
        </button>
        ${open === g.nr && html`<div class="list-extra">
          ${g.citite >= g.total ? html`<p class="muted">Ai citit tot ghidul.</p>`
          : html`<button class="btn" type="button" onClick=${() => act('/lecturi/ordine', { ghid: g.nr }, () => {
              setOpen(null);
              document.querySelector('.main')?.scrollTo({ top: 0 });
              toast({ text: `Următoarea lectură e din „${g.titlu}”.` });
            })}>Citește din acest ghid</button>`}
        </div>`}
      </li>`)}</ul>
    </div>
  </section>`;
}

function LessonCard({ c }) {
  return html`<div class=${'lcard t-' + c.tip}>
    <p class="lcard-head"><span class="lc-type">${c.eticheta}</span>${c.grad && html`<span class="lc-grade">grad ${c.grad}</span>`}${c.pagina && html`<span class="lc-page">p. ${c.pagina}</span>`}</p>
    <p class="lcard-text" dangerouslySetInnerHTML=${{ __html: marksOnly(c.html) }} />
    ${c.explicatie && html`<p class="lcard-expl">${c.explicatie}</p>`}
    ${c.comentariu && html`<p class="lcard-expl">${c.comentariu}</p>`}
  </div>`;
}

function Quiz({ items, answers, setAnswers }) {
  const [shown, setShown] = useState([]);
  return html`<ol class="quiz">${items.map((q, i) => html`<li key=${i} class="quiz-q">
    <p class="quiz-text">${q.intrebare}</p>
    ${!shown[i] ? html`<button class="btn" type="button" onClick=${() => setShown((s) => Object.assign([...s], { [i]: true }))}>Arată răspunsul</button>`
    : html`<${LessonCard} c=${q.raspuns} />
      ${setAnswers && html`<div class="seg" role="radiogroup" aria-label=${`Întrebarea ${i + 1}`}>
        <label><input type="radio" name=${'q' + i} checked=${answers[i] === true} onChange=${() => setAnswers((a) => Object.assign([...a], { [i]: true }))} /><span>Am știut</span></label>
        <label><input type="radio" name=${'q' + i} checked=${answers[i] === false} onChange=${() => setAnswers((a) => Object.assign([...a], { [i]: false }))} /><span>N-am știut</span></label>
      </div>`}`}
  </li>`)}</ol>`;
}

function Reader({ id }) {
  const [l, setL] = useState(null);
  const [err, setErr] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/lecturi/${id}`).then(setL, (e) => setErr(e.status === 404 ? 'Lectura nu e scrisă încă.' : isOffline(e) ? 'Fără conexiune.' : 'Lectura nu se încarcă.'));
    document.querySelector('.main')?.scrollTo({ top: 0 });
  }, [id]);

  if (!l) return html`<section class="view"><${Bar} title="Lectură" back="#/lecturi" /><p class="muted center pad">${err || 'Se încarcă…'}</p></section>`;

  const done = l.quiz.length > 0 && l.quiz.every((_, i) => typeof answers[i] === 'boolean');
  async function finish() {
    setBusy(true);
    try {
      await api(`/lecturi/${id}/citita`, { method: 'POST', body: { quiz: l.quiz.map((_, i) => answers[i]) } });
      lastRead = id;
      location.hash = '#/lecturi';
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune. Apasă din nou când ai semnal.' : 'Ceva n-a mers. Încearcă din nou.' });
    } finally {
      setBusy(false);
    }
  }

  return html`<section class="view">
    <${Bar} title=${l.ghid.titlu} back="#/lecturi" />
    <article class="page lesson">
      <h1 class="lesson-title">${l.titlu}</h1>
      <p class="lesson-meta">Lectura ${l.k} din ${l.n}${l.minute ? `, cam ${l.minute} minute` : ''}${l.sursa?.pagini ? `, p. ${l.sursa.pagini[0]}-${l.sursa.pagini[1]}` : ''}</p>
      ${l.context && html`<p class="lesson-context">${l.context}</p>`}
      ${l.sectiuni.map((s, i) => html`<section key=${i} class="lesson-sec">
        <h2>${s.titlu}</h2>
        ${s.intro && html`<p>${s.intro}</p>`}
        ${s.carduri.map((c) => html`<${LessonCard} key=${c.ref} c=${c} />`)}
        ${s.argumentare?.map((c) => html`<${LessonCard} key=${c.ref} c=${c} />`)}
        ${s.puncte_cheie?.length > 0 && html`<div class="keypoints"><h3>Puncte-cheie</h3><ul>${s.puncte_cheie.map((p) => html`<li>${p}</li>`)}</ul></div>`}
      </section>`)}
      ${l.cifre?.length > 0 && html`<h2>Cifre de reținut</h2>
        <div class="tw"><table><thead><tr><th>Ce</th><th>Valoare</th><th>Sursa</th></tr></thead>
        <tbody>${l.cifre.map((c) => html`<tr><td>${c.eticheta}</td><td><strong>${c.valoare}</strong></td><td>${c.sursa}</td></tr>`)}</tbody></table></div>`}
      ${l.perle?.length > 0 && html`<h2>Perle clinice</h2><ul class="perle">${l.perle.map((p) => html`<li>${p}</li>`)}</ul>`}
      ${l.quiz.length > 0 && html`<h2>Quiz</h2><${Quiz} items=${l.quiz} answers=${answers} setAnswers=${setAnswers} />`}
      <div class="lesson-end">
        ${done && html`<button class="btn primary big wide" type="button" disabled=${busy} onClick=${finish}>Gata, am citit</button>`}
        <button class="btn wide" type="button" onClick=${() => askRokhan(`Am o întrebare din lectura ${l.id} (${l.titlu}): `)}><${Icon} name="chat" />Întreabă-l pe Rokhan</button>
        ${l.sursa?.url && html`<a class="btn ghost wide" href=${l.sursa.url} target="_blank" rel="noopener noreferrer"><${Icon} name="ext" />Ghidul original (PDF)</a>`}
      </div>
    </article>
  </section>`;
}

// Today's review: one question at a time, the answer is the guideline's own card, she marks herself.
function Review() {
  const [cards, setCards] = useState(null);
  const [err, setErr] = useState(null);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [score, setScore] = useState({ known: 0, answered: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/lecturi/repetitie').then((r) => setCards(r.azi), (e) => setErr(isOffline(e) ? 'Fără conexiune.' : 'Repetiția nu se încarcă.'));
  }, []);

  if (!cards) return html`<section class="view"><${Bar} title="Repetiție" back="#/lecturi" /><p class="muted center pad">${err || 'Se încarcă…'}</p></section>`;

  // known: true or false posts her mark; undefined flags the question as wrong. Either way the next one comes.
  async function move(known) {
    const c = cards[i];
    setBusy(true);
    try {
      const path = `/lecturi/repetitie/${encodeURIComponent(c.id)}`;
      if (known === undefined) await api(path + '/semnaleaza', { method: 'POST' });
      else {
        await api(path, { method: 'POST', body: { stiut: known } });
        setScore((s) => ({ known: s.known + (known ? 1 : 0), answered: s.answered + 1 }));
      }
      setShown(false);
      setI(i + 1);
      document.querySelector('.main')?.scrollTo({ top: 0 });
    } catch (e) {
      toast({ text: isOffline(e) ? 'Fără conexiune. Apasă din nou când ai semnal.' : 'Ceva n-a mers. Încearcă din nou.' });
    } finally {
      setBusy(false);
    }
  }

  const c = cards[i];
  return html`<section class="view">
    <${Bar} title="Repetiție" back="#/lecturi" />
    <article class="page review">
      ${!cards.length ? html`<p class="review-q">Nimic de repetat azi.</p>
          <a class="btn wide" href="#/lecturi">Înapoi la lecturi</a>`
      : !c ? html`<p class="review-q" role="status">Gata pe azi.</p>
          ${score.answered > 0 && html`<p class="review-sum">Ai știut ${score.known} din ${score.answered}.</p>`}
          <a class="btn primary big wide" href="#/lecturi">Înapoi la lecturi</a>`
      : html`<p class="review-step">${i + 1} din ${cards.length}</p>
          <p class="lesson-meta">${c.lectie.ghid.titlu}</p>
          <h2 class="review-q">${c.intrebare}</h2>
          ${!shown ? html`<button class="btn primary big wide" type="button" onClick=${() => setShown(true)}>Arată răspunsul</button>`
          : html`<${LessonCard} c=${c.raspuns} />
            <div class="review-marks">
              <button class="btn primary big" type="button" disabled=${busy} onClick=${() => move(true)}>Am știut</button>
              <button class="btn big" type="button" disabled=${busy} onClick=${() => move(false)}>N-am știut</button>
            </div>`}
          <button class="link-btn" type="button" disabled=${busy} onClick=${() => move(undefined)}>Întrebarea e greșită</button>`}
    </article>
  </section>`;
}

function Recap() {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api('/lecturi/recap').then(setR, (e) => setErr(isOffline(e) ? 'Fără conexiune.' : 'Recapitularea nu se încarcă.'));
  }, []);
  if (!r) return html`<section class="view"><${Bar} title="Recapitulare" back="#/lecturi" /><p class="muted center pad">${err || 'Se încarcă…'}</p></section>`;
  return html`<section class="view">
    <${Bar} title="Recapitularea săptămânii" back="#/lecturi" />
    <article class="page lesson">
      ${!r.disponibil && html`<p class="muted">Nicio lectură citită în ultimele 7 zile.</p>`}
      ${r.lectii.map((l) => html`<section key=${l.id} class="lesson-sec">
        <h2><a href=${`#/lecturi/${l.id}`}>${l.titlu}</a></h2>
        <p class="lesson-meta">${l.ghid.titlu}</p>
        <ul>${l.sectiuni.flatMap((s) => s.puncte_cheie).map((p) => html`<li>${p}</li>`)}</ul>
      </section>`)}
      ${r.cifre.length > 0 && html`<h2>Cifre de reținut</h2>
        <div class="tw"><table><thead><tr><th>Ce</th><th>Valoare</th><th>Sursa</th></tr></thead>
        <tbody>${r.cifre.map((c) => html`<tr><td>${c.eticheta}</td><td><strong>${c.valoare}</strong></td><td>${c.sursa}</td></tr>`)}</tbody></table></div>`}
      ${r.quiz.length > 0 && html`<h2>Quiz</h2><${Quiz} items=${r.quiz} />`}
    </article>
  </section>`;
}
