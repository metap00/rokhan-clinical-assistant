// Videotecă: the catalog with her ticks and her Registru counts. Works without the model.
import { getVideoteca } from '../store/videoteca.mjs';
import { getRegistru } from '../store/registru.mjs';
import { getPush } from '../store/push.mjs';
import { REGISTRU_VIDEOTECA } from '../store/registru-videoteca.mjs';

// procedure name_ro -> the Registru rows it counts for, with her number of "efectuat"
function registruByProcedure(config) {
  const rows = new Map(getRegistru(config).summary().rows.map((r) => [r.id, r]));
  const out = new Map();
  for (const [id, names] of Object.entries(REGISTRU_VIDEOTECA)) {
    const r = rows.get(id);
    if (!r) continue;
    for (const name of names) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push({ id, nume: r.nume, barem: r.barem, efectuat: r.efectuat });
    }
  }
  return out;
}

export default function register(app) {
  app.get('/api/videoteca', async (c) => {
    const videoteca = getVideoteca(c.config);
    const { videos, sections, ...catalog } = videoteca.catalog();
    const registru = registruByProcedure(c.config);
    const film = getPush(c.config).state().setari.film ? videoteca.filmOfDay() : null;
    return {
      ...catalog,
      sections: sections.map((s) => ({ ...s, procedures: s.procedures.map((p) => ({ ...p, registru: registru.get(p.name_ro) ?? [] })) })),
      vazute: videoteca.seen(),
      filmulZilei: film?.url ?? null, // shown at the top of the tab
    };
  });

  // For the Registru tab: only the rows that have at least one video.
  app.get('/api/videoteca/registru', async (c) => {
    const videoteca = getVideoteca(c.config);
    const found = new Map();
    for (const s of videoteca.catalog().sections) for (const p of s.procedures) if (p.videos.length) found.set(p.name_ro, { capitol: s.id, name_ro: p.name_ro, videos: p.videos });
    const randuri = {};
    for (const [id, names] of Object.entries(REGISTRU_VIDEOTECA)) {
      const procs = names.flatMap((n) => found.get(n) ?? []);
      if (procs.length) randuri[id] = procs;
    }
    return { randuri, vazute: videoteca.seen() };
  });

  app.put('/api/videoteca/vazut', async (c) => ({ vazute: getVideoteca(c.config).setSeen(c.body?.url, c.body?.vazut) }));
}
