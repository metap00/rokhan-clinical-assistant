// Videotecă: the catalog of operation videos and her "Văzut" ticks.
// Catalog: <dataDir>/library/videoteca.json when it exists, else content/videoteca.json (shipped with the code).
// Replacing either file is enough, it is read again when it changes. Ticks are keyed by video URL, so they
// survive a new catalog: <dataDir>/videoteca-vazute.json { vazute: { <url>: <ISO time> } }.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, httpError, plainDashes } from './files.mjs';

const isWeb = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const list = (v) => (Array.isArray(v) ? v : []);

/** The catalog JSON, checked and cleaned: only web addresses reach a link. Throws when the shape is wrong. */
export function parseCatalog(text) {
  const c = JSON.parse(text, (key, v) => (typeof v === 'string' && key !== 'url' ? plainDashes(v) : v));
  if (!Array.isArray(c?.sections) || !c.sections.every((s) => s?.id && Array.isArray(s.procedures))) throw new Error('not a video catalog');
  const sections = c.sections.map((s) => ({
    ...s,
    procedures: s.procedures.map((p) => ({ ...p, videos: list(p.videos).filter((v) => isWeb(v?.url)) })),
  }));
  const videos = new Map(); // url -> video, in catalog order
  for (const s of sections) for (const p of s.procedures) for (const v of p.videos) if (!videos.has(v.url)) videos.set(v.url, v);
  if (!videos.size) throw new Error('the catalog has no videos');
  return {
    title: c.title,
    generated: c.generated,
    start_here: list(c.start_here).filter((x) => videos.has(x?.url)),
    sections,
    libraries: list(c.libraries).filter((l) => isWeb(l?.url)),
    gaps_ro: list(c.gaps_ro),
    notes_ro: list(c.notes_ro),
    videos,
  };
}

/** The next video she has not ticked: "Start aici" in its order, then the catalog order. Null when all are seen. */
export function filmOfDay(catalog, seen) {
  const url = [...catalog.start_here.map((x) => x.url), ...catalog.videos.keys()].find((u) => !seen.has(u));
  return url ? catalog.videos.get(url) : null;
}

const instances = new Map();

export function getVideoteca(config) {
  if (!instances.has(config.dataDir)) instances.set(config.dataDir, createVideoteca(config));
  return instances.get(config.dataDir);
}

function createVideoteca(config) {
  const ticks = path.join(config.dataDir, 'videoteca-vazute.json');
  const files = [path.join(config.dataDir, 'library', 'videoteca.json'), path.join(config.root, 'content', 'videoteca.json')];
  let cache = { stamp: null, catalog: null };

  function catalog() {
    const found = files.flatMap((file) => {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      return st ? [{ file, stamp: `${file}:${st.mtimeMs}:${st.size}` }] : [];
    });
    const stamp = found.map((f) => f.stamp).join('|');
    if (stamp === cache.stamp) return cache.catalog;
    for (const { file } of found) {
      try {
        cache = { stamp, catalog: parseCatalog(fs.readFileSync(file, 'utf8')) };
        return cache.catalog;
      } catch (err) {
        console.warn(`[rokhan] video catalog ${file} cannot be used: ${err.message}`); // a broken new file: the other one
      }
    }
    throw httpError(500, 'catalog_video');
  }

  const load = () => readJson(ticks, null) ?? { vazute: {} };
  /** The ticked videos that are in the catalog. Ticks of videos that left it stay in the file. */
  const seen = () => {
    const { vazute } = load();
    return [...catalog().videos.keys()].filter((u) => Object.hasOwn(vazute, u));
  };

  return {
    catalog,
    seen,
    setSeen(url, vazut) {
      if (typeof url !== 'string' || typeof vazut !== 'boolean') throw httpError(400, 'vazut');
      const data = load();
      if (!vazut) delete data.vazute[url];
      else if (!catalog().videos.has(url)) throw httpError(404, 'film_necunoscut');
      else data.vazute[url] ??= new Date().toISOString();
      writeJsonAtomic(ticks, data);
      return seen();
    },
    filmOfDay: () => filmOfDay(catalog(), new Set(seen())),
  };
}
