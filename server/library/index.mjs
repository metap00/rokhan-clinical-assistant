// SOGR guideline library: guide list, tables of contents, line reads and search.
// Reads <dataDir>/library once (lazily); nothing here writes.
import fs from 'node:fs';
import path from 'node:path';
import { buildSearch } from './search.mjs';

export const MAX_LINES = 400;
const GUIDES_DIR = 'ghiduri-sogr';
const CURR_DIR = 'curriculum-rezidentiat-og-2019';
export const CURRICULUM_NR = 'curriculum';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Cells of every `| a | b |` row of a Markdown table (separator rows dropped). */
export function tableRows(md) {
  return md.split('\n')
    .filter((l) => l.trimStart().startsWith('|') && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

const range = (s) => {
  const m = String(s).match(/^(\d+)\s*[–-]\s*(\d+)$/) || String(s).match(/^(\d+)$/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
};

const normNr = (nr) => {
  const s = String(nr ?? '').trim().toLowerCase();
  return /^\d+$/.test(s) ? s.padStart(2, '0') : s;
};

const libraries = new Map();

/** One library per data directory. */
export function getLibrary(config) {
  const root = path.resolve(config.dataDir, 'library');
  if (!libraries.has(root)) libraries.set(root, createLibrary(root));
  return libraries.get(root);
}

function createLibrary(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const memo = {};
  const once = (k, fn) => (k in memo ? memo[k] : (memo[k] = fn()));

  const guides = () => once('guides', () => {
    if (!exists(`${GUIDES_DIR}/_book.md`)) return [];
    return tableRows(read(`${GUIDES_DIR}/_book.md`))
      .filter((r) => /^\d+$/.test(r[0]) && r.length >= 6)
      .map((r) => ({ nr: r[0], titlu: r[1], versiune: r[2], pagini: Number(r[3]) || null, fisier: `${GUIDES_DIR}/${r[5]}`, url: r[4] }));
  });

  const curriculumFiles = () => once('currFiles', () => {
    if (!fs.existsSync(path.join(root, CURR_DIR))) return [];
    return fs.readdirSync(path.join(root, CURR_DIR)).filter((f) => /^cap-\d+.*\.md$/.test(f)).sort().map((f) => `${CURR_DIR}/${f}`);
  });

  /** The residency curriculum as a pseudo-guide (nr "curriculum"), the last entry of GET /api/ghiduri. */
  const curriculum = () => once('curriculum', () => {
    const book = `${CURR_DIR}/_book.md`;
    if (!exists(book)) return null;
    const md = read(book);
    return {
      nr: CURRICULUM_NR,
      titlu: md.match(/^#\s+(.+)$/m)?.[1] ?? 'Curriculum de pregătire',
      versiune: md.match(/\((\d{4})\)/)?.[1] ?? null,
      pagini: Number(md.match(/(\d+)\s+pagini/)?.[1]) || null,
      fisier: book,
      url: md.match(/Sursa[^:\n]*:\s*(\S+)/)?.[1] ?? null,
    };
  });

  const find = (nr) => {
    const key = normNr(nr);
    if (key === CURRICULUM_NR) return curriculum();
    return guides().find((g) => g.nr === key) ?? null;
  };

  /** Physical file under the library folder, or an HTTP error. Never leaves the folder (not even through a symlink). */
  function resolveFile(fisier) {
    if (typeof fisier !== 'string' || !fisier || fisier.includes('\0')) throw httpError(400, 'fisier');
    const abs = path.resolve(root, fisier);
    if (!abs.startsWith(root + path.sep) || path.extname(abs) !== '.md') throw httpError(403, 'interzis');
    let real;
    try { real = fs.realpathSync(abs); } catch { throw httpError(404, 'negasit'); }
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) throw httpError(403, 'interzis');
    return { abs: real, rel: path.relative(root, abs).split(path.sep).join('/') };
  }

  const lineCache = new Map();
  const linesOf = (abs) => {
    if (!lineCache.has(abs)) {
      const l = fs.readFileSync(abs, 'utf8').replace(/\r/g, '').split('\n');
      if (l.length && l[l.length - 1] === '') l.pop();
      lineCache.set(abs, l);
    }
    return lineCache.get(abs);
  };

  /** Lines from..to (1-based, inclusive), clamped to the file and to MAX_LINES per call. */
  function readLines(fisier, from = 1, to) {
    const { abs, rel } = resolveFile(fisier);
    const lines = linesOf(abs);
    const total = lines.length;
    let a = Math.trunc(Number(from));
    if (!Number.isFinite(a)) throw httpError(400, 'interval');
    a = Math.max(1, a);
    let b = to === undefined || to === null || to === '' ? a + MAX_LINES - 1 : Math.trunc(Number(to));
    if (!Number.isFinite(b)) throw httpError(400, 'interval');
    if (b < a) throw httpError(400, 'interval');
    b = Math.min(b, a + MAX_LINES - 1, total);
    return { fisier: rel, from: a, to: Math.max(b, a - 1), total, text: a > total ? '' : lines.slice(a - 1, b).join('\n') };
  }

  const pagesOf = (lines) => {
    const p = lines.map((l) => l.match(/^\[p\. (\d+)\]\s*$/)?.[1]).filter(Boolean).map(Number);
    return p.length ? (Math.min(...p) === Math.max(...p) ? String(p[0]) : `${Math.min(...p)}–${Math.max(...p)}`) : '';
  };

  function curriculumToc() {
    const c = curriculum();
    const sectiuni = curriculumFiles().map((f) => {
      const lines = linesOf(path.join(root, f));
      const h1 = lines.find((l) => l.startsWith('# '))?.slice(2) ?? f;
      const m = h1.match(/Modulul\s+(\d+):\s*(.*)$/) || h1.match(/—\s*(.*)$/);
      const nr = f.match(/cap-(\d+)/)[1];
      return { nr, titlu: (m ? (m[2] ?? m[1]) : h1).trim() || h1, pagini: pagesOf(lines), linii: [1, lines.length], fisier: f };
    });
    return { nr: c.nr, titlu: c.titlu, versiune: c.versiune, url: c.url, fisier: c.fisier, sectiuni };
  }

  /** Table of contents of guide `nr`: sections with their pages and line ranges in the guide file. */
  function toc(nr) {
    const g = find(nr);
    if (!g) throw httpError(404, 'negasit');
    if (g.nr === CURRICULUM_NR) return curriculumToc();
    const name = path.posix.basename(g.fisier);
    const tocFile = `${GUIDES_DIR}/cuprins/${name}`;
    const sectiuni = !exists(tocFile) ? [] : tableRows(read(tocFile))
      .filter((r) => r.length >= 4 && range(r[3]))
      .map((r) => ({ nr: r[0], titlu: r[1], pagini: r[2], linii: range(r[3]), ghiduriNoi: r[4] ? range(r[4]) : null }));
    const upd = `${GUIDES_DIR}/actualizari/${name}`;
    let total = null;
    if (exists(g.fisier)) total = linesOf(path.join(root, g.fisier)).length;
    return { nr: g.nr, titlu: g.titlu, versiune: g.versiune, url: g.url, fisier: g.fisier, total, actualizari: exists(upd) ? upd : null, sectiuni };
  }

  let search_;
  const engine = () => (search_ ??= buildSearch({ root, guides: guides(), curriculum: curriculum(), curriculumFiles: curriculumFiles(), tocOf: toc, linesOf, exists }));

  return {
    root,
    guides,
    curriculum,
    toc,
    readLines,
    /** Full-text search, diacritics-insensitive. Fragments are HTML-safe with <mark> around the matches. */
    search: (q, opts = {}) => engine().search(q, { ...opts, ghid: opts.ghid ? normNr(opts.ghid) : undefined }),
    /** search() plus which pass found the hits: { hits, nivel: 'toate' | 'oricare' }. `strict` = all terms only, at most 3. */
    searchLevel: (q, opts = {}) => engine().searchLevel(q, { ...opts, ghid: opts.ghid ? normNr(opts.ghid) : undefined }),
    /** Builds the index now; { chunks, ms }. */
    indexInfo: () => engine().info,
  };
}
