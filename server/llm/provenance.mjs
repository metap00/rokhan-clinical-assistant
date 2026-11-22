// Where an address came from (review finding 1). deschide_url opens an address only when its host is one of the
// sources the system prompt names, or when that exact address was seen in this conversation: in one of her
// messages, in a web search result, in a library file or in a page opened earlier. An address the model builds
// around her data is in neither set, so a hostile page cannot make the model send her notes out through a URL.

/** The sources the system prompt names. A host matches when it is one of these or a subdomain of one. */
export const KNOWN_HOSTS = [
  'sogr.ro', 'anm.ro', 'ms.ro', // SOGR guidelines, the ANMDMR nomenclator (nomenclator.anm.ro), the Ministry of Health
  'nice.org.uk', 'rcog.org.uk', 'who.int', 'acog.org', 'figo.org', 'isuog.org', 'eshre.eu', 'esgo.org', 'smfm.org',
  'ncbi.nlm.nih.gov', // eutils, PubMed, PMC, Bookshelf
  'ebi.ac.uk', 'europepmc.org', 'cochranelibrary.com', 'cochrane.org',
  'ema.europa.eu',
];

export function isKnownHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return KNOWN_HOSTS.some((k) => h === k || h.endsWith(`.${k}`));
}

/** The form two addresses are compared in: parsed, without the fragment. null when it is not an http(s) URL. */
function canonical(raw) {
  try {
    const u = raw instanceof URL ? new URL(raw.href) : new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

const URL_RE = /https?:\/\/[^\s<>"'`\\]+/gi;
const OPENER = { ')': '(', ']': '[', '}': '{' };

/** Every http(s) address written in `text`, canonical. Closing punctuation after an address is not part of it. */
export function urlsIn(text) {
  const out = [];
  for (let [s] of String(text ?? '').matchAll(URL_RE)) {
    for (;;) {
      const last = s.at(-1);
      if ('.,;:!?*|'.includes(last) || (OPENER[last] && s.split(last).length > s.split(OPENER[last]).length)) s = s.slice(0, -1);
      else break;
    }
    const c = canonical(s);
    if (c) out.push(c);
  }
  return out;
}

const MAX_URLS = 5000; // per conversation; the oldest go first
const MAX_CONVERSATIONS = 200; // ponytail: kept in memory for one server run; after a restart the model searches again

/** The addresses seen in one conversation. `add` takes any text (or nested tool-result content) and keeps its addresses. */
export function createSeen() {
  const set = new Set();
  const add = (value) => {
    if (typeof value === 'string') {
      for (const u of urlsIn(value)) {
        set.delete(u);
        set.add(u);
        if (set.size > MAX_URLS) set.delete(set.values().next().value);
      }
    } else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  return { add, has: (url) => set.has(canonical(url)), get size() { return set.size; } };
}

/** One `seen` set per conversation id, for the life of the process. */
export function createProvenance() {
  const byConversation = new Map();
  return {
    of(conversationId) {
      if (conversationId == null) return createSeen();
      let seen = byConversation.get(conversationId);
      byConversation.delete(conversationId); // re-inserted below, so the map stays ordered by last use
      seen ??= createSeen();
      byConversation.set(conversationId, seen);
      if (byConversation.size > MAX_CONVERSATIONS) byConversation.delete(byConversation.keys().next().value);
      return seen;
    },
  };
}

export const REFUSAL = 'Adresă refuzată: pot deschide doar adrese primite de la rezidentă, dintr-un rezultat de căutare, dintr-o pagină deja deschisă sau de la sursele cunoscute. Caută pagina cu WebSearch și deschide adresa din rezultat.';
