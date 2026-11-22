// Spaced review of the lesson quiz questions: a fixed Leitner ladder, a short daily session, no backlog.
// Pure functions over the store { cards: { '<lessonId>#<k>': Card }, mutat }, Card = { box, due, seen, lapses, semnalat }.
// Dates are local 'YYYY-MM-DD' strings; the lessons service (index.mjs) owns the file and "today".
import { addDays } from './sogr/state.mjs';

export const LADDER = [1, 3, 7, 16, 35]; // days ahead after a correct answer, by the box the card lands in
export const TAIL_DAYS = 90; // a correct answer from the last box
export const SESSION = 10;
export const SEED_PER_DAY = 6;

export const cardId = (lessonId, k) => `${lessonId}#${k}`;
export const splitId = (id) => { const [lesson, k] = String(id).split('#'); return { lesson, k: Number(k) }; };

/**
 * Creates the missing cards. `reads` = [{ unit, data }] oldest first, one per lesson; `quizCount(id)` = how many quiz
 * questions the lesson has (0 when it cannot be read: its cards come later); `marks(id)` = the quiz marks she gave
 * when she read it ([true, false, ...] or null).
 * `seed` (the first run, before which no lesson had cards): cards are spread SEED_PER_DAY a day from `today`, oldest
 * read first. Otherwise a new lesson's question is due the day after it was read, or 3 days after when marked known.
 * Returns true when something was added.
 */
export function syncCards(store, { reads, quizCount, marks, today, seed }) {
  let added = 0;
  for (const { unit, data } of reads) {
    const n = Math.min(3, quizCount(unit));
    const m = seed ? null : marks(unit);
    for (let k = 1; k <= n; k++) {
      const id = cardId(unit, k);
      if (store.cards[id]) continue;
      const known = m?.[k - 1] === true;
      const due = seed ? addDays(today, Math.floor(added / SEED_PER_DAY)) : addDays(data ?? today, known ? LADDER[1] : LADDER[0]);
      store.cards[id] = { box: known ? 2 : 1, due, seen: 0, lapses: 0, semnalat: false };
      added++;
    }
  }
  return added > 0;
}

/** The answer to one card, on `today`: up one box (or the 90-day tail from the last), or back to box 1 tomorrow. */
export function answerCard(card, stiut, today) {
  card.seen++;
  if (!stiut) {
    card.box = 1;
    card.lapses++;
    card.due = addDays(today, LADDER[0]);
  } else if (card.box >= LADDER.length) {
    card.box = LADDER.length;
    card.due = addDays(today, TAIL_DAYS);
  } else {
    card.box++;
    card.due = addDays(today, LADDER[card.box - 1]);
  }
  return card;
}

/** Ids of the cards due on or before `today`, not flagged and accepted by `ok(id)`, most overdue first. */
export function dueIds(store, today, ok = () => true) {
  return Object.entries(store.cards)
    .filter(([id, c]) => !c.semnalat && c.due <= today && ok(id))
    .sort((a, b) => a[1].due.localeCompare(b[1].due)) // stable: equal dates keep the order the cards were made in
    .map(([id]) => id);
}

/** Moves every due date `zile` days ahead. */
export function pauseCards(store, zile) {
  for (const c of Object.values(store.cards)) c.due = addDays(c.due, zile);
}
