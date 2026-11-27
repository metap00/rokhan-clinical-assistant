// What she has read in the guideline library, and where she stopped.
// <dataDir>/ghiduri-citite.json { ghiduri: { <nr>: { citit: <ISO>|null, sectiuni: { <key>: <ISO> } } },
// ultima: { nr, cheie, scroll } }. Reads the library, never writes into it.
// A guide is "citit" when she ticks it, or when she ticks its last section. Unticking a section unticks the
// guide; unticking the guide keeps the sections.
import path from 'node:path';
import { readJson, writeJsonAtomic, httpError, fold } from './files.mjs';
import { getLibrary, CURRICULUM_NR } from '../library/index.mjs';

/** A stable key per section of a table of contents: its number and title (the file for a curriculum module). */
export function sectionKeys(toc) {
  const used = new Map();
  return toc.sectiuni.map((s) => {
    const base = s.fisier ? path.posix.basename(s.fisier) : `${s.nr}|${fold(s.titlu)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

const instances = new Map();

export function getCitit(config) {
  if (!instances.has(config.dataDir)) instances.set(config.dataDir, createCitit(config));
  return instances.get(config.dataDir);
}

function createCitit(config) {
  const file = path.join(config.dataDir, 'ghiduri-citite.json');
  const load = () => {
    const d = readJson(file, null) ?? {};
    return { ghiduri: d.ghiduri ?? {}, ultima: d.ultima ?? null };
  };
  const library = () => getLibrary(config);

  const view = (data, toc) => {
    const g = data.ghiduri[toc.nr];
    return { citit: !!g?.citit, sectiuni: sectionKeys(toc).map((k) => !!g?.sectiuni?.[k]) };
  };

  return {
    /** Every document of the library with its progress; the overall count is of the SOGR guides only. */
    summary() {
      const data = load();
      const curriculum = library().curriculum();
      const ghiduri = {};
      let citite = 0;
      let total = 0;
      for (const g of [...library().guides(), ...(curriculum ? [curriculum] : [])]) {
        const v = view(data, library().toc(g.nr));
        ghiduri[g.nr] = { citit: v.citit, sectiuni: v.sectiuni.length, bifate: v.sectiuni.filter(Boolean).length };
        if (g.nr === CURRICULUM_NR) continue;
        total++;
        if (v.citit) citite++;
      }
      return { citite, total, ghiduri, ultima: this.last(data) };
    },

    /** Where she stopped, resolved against the library as it is now. Null when that document is gone. */
    last(data = load()) {
      const u = data.ultima;
      if (!u) return null;
      let toc;
      try {
        toc = library().toc(u.nr);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      const i = sectionKeys(toc).indexOf(u.cheie);
      const s = toc.sectiuni[i];
      return s
        ? { nr: toc.nr, titlu: toc.titlu, sectiune: i, sectiuneTitlu: s.titlu, sectiuneNr: s.nr, scroll: u.scroll }
        : { nr: toc.nr, titlu: toc.titlu, sectiune: null, sectiuneTitlu: null, sectiuneNr: null, scroll: 0 };
    },

    guide(nr) {
      const toc = library().toc(nr); // 404 for an unknown guide
      return view(load(), toc);
    },

    /** { citit } ticks the guide; { sectiune: <index>, citita } ticks one of its sections. */
    tick(nr, { citit, sectiune, citita } = {}) {
      const toc = library().toc(nr);
      const keys = sectionKeys(toc);
      const data = load();
      const g = (data.ghiduri[toc.nr] ??= { citit: null, sectiuni: {} });
      const now = new Date().toISOString();
      if (sectiune !== undefined) {
        if (!Number.isInteger(sectiune) || !keys[sectiune] || typeof citita !== 'boolean') throw httpError(400, 'sectiune');
        if (citita) {
          g.sectiuni[keys[sectiune]] ??= now;
          if (keys.every((k) => g.sectiuni[k])) g.citit ??= now;
        } else {
          delete g.sectiuni[keys[sectiune]];
          g.citit = null;
        }
      } else {
        if (typeof citit !== 'boolean') throw httpError(400, 'citit');
        g.citit = citit ? g.citit ?? now : null;
      }
      writeJsonAtomic(file, data);
      return view(data, toc);
    },

    /** The section she is reading now and how far down she is (0 to 1). */
    setLast({ nr, sectiune, scroll = 0 } = {}) {
      const toc = library().toc(nr);
      const cheie = Number.isInteger(sectiune) ? sectionKeys(toc)[sectiune] : undefined;
      if (!cheie) throw httpError(400, 'sectiune');
      if (typeof scroll !== 'number' || !Number.isFinite(scroll)) throw httpError(400, 'scroll');
      const data = load();
      data.ultima = { nr: toc.nr, cheie, scroll: Math.min(1, Math.max(0, scroll)) };
      writeJsonAtomic(file, data);
      return { ok: true };
    },
  };
}
