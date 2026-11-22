// The instant guideline match in the chat: when to ask the library, and when "nothing found" is worth a line.
export const wordCount = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

// Only a typed question of three words or more, without a photo, is looked up.
export const wantsMatch = (text, photos = 0) => photos === 0 && wordCount(text) >= 3;

// "avem ghid pentru…", "exista ghid sogr…": she asks whether a guideline exists, so "no" is an answer too.
export function asksForGuideline(text) {
  const t = String(text ?? '').toLowerCase();
  return t.includes('ghid') && ['avem', 'exista', 'există', 'sogr'].some((w) => t.includes(w));
}

// What is sent to the library: her text without the words of the question itself ("avem ghid sogr pentru…").
// The strict search wants every term in one passage, and guideline text does not say "avem" or "ghid" next
// to the topic, so with those words left in, a question about a guideline we do have would find nothing.
// ponytail: a short fixed list; if real questions still miss, widen it or move the list to the server's search.
const ASKING = /^(ghid\p{L}*|avem|exist[aă]|sogr|vreun|vreo|pt|despre|privind)$/iu;
export const matchQuery = (text) => (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}/.,+-]*/gu) ?? []).map((w) => w.replace(/[.,]+$/, '')).filter((w) => !ASKING.test(w)).join(' ').slice(0, 300);

// Address of a search hit in the Ghiduri reader (the section that holds the lines, with the lines marked).
export const hitHref = (h) => `#/ghiduri/${encodeURIComponent(h.nr)}/cauta?${new URLSearchParams({ l: `${h.linii[0]}-${h.linii[1]}`, f: h.fisier })}`;
