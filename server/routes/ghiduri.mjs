// Guideline library routes. Search and reading work without the model.
import { getLibrary, CURRICULUM_NR } from '../library/index.mjs';

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const intOrUndef = (v, name) => {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(String(v))) throw bad(name);
  return Number(v);
};

export default function register(app) {
  // 40 guidelines, then the residency curriculum as the last entry
  app.get('/api/ghiduri', async (c) => {
    const lib = getLibrary(c.config);
    const curriculum = lib.curriculum();
    return [...lib.guides(), ...(curriculum ? [curriculum] : [])];
  });

  app.get('/api/ghiduri/:nr', async (c) => getLibrary(c.config).toc(c.params.nr));

  // The curriculum is one file per module: pass ?fisier=<file of the section> (default: the first module).
  app.get('/api/ghiduri/:nr/text', async (c) => {
    const lib = getLibrary(c.config);
    const toc = lib.toc(c.params.nr);
    const fisier = toc.nr === CURRICULUM_NR ? (c.query.fisier || toc.sectiuni[0]?.fisier) : toc.fisier;
    const r = lib.readLines(fisier, intOrUndef(c.query.from, 'from') ?? 1, intOrUndef(c.query.to, 'to'));
    return { fisier: r.fisier, from: r.from, to: r.to, total: r.total, markdown: r.text };
  });

  app.get('/api/cauta', async (c) => {
    const q = String(c.query.q ?? '').slice(0, 300);
    const limit = intOrUndef(c.query.limit, 'limit');
    const { hits, nivel } = getLibrary(c.config).searchLevel(q, { ghid: c.query.ghid || undefined, limit, strict: c.query.strict === '1' });
    return { hits, nivel };
  });
}
