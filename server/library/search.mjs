// Full-text search over the library: an in-memory SQLite FTS5 table, one row per paragraph-block chunk.
// Tokenizer `unicode61 remove_diacritics 2` folds ă â î ș ț and the old cedilla forms ş ţ, so typing without diacritics works.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIN_CHUNK = 800;
const MAX_CHUNK = 1500;
const MIN_TAIL = 250;
const SEP_OPEN = '\u0001';
const SEP_CLOSE = '\u0002';

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Romanian function words that make a typed question miss (a short list is enough).
const STOP = new Set(('a ai al ale am are as asa ca cam care cat cand ce cei cel cu cum da daca de din dar deci doar e este esti '
  + 'fi fie fost iar il in intr intre l la le li lor lui ma mai mi mult ne ni nu o or ori pe pentru poate prin pot sa sau se si '
  + 'sunt te ti tot un una unei unor unui va vor vreau imi cine unde').split(' '));

/** FTS5 MATCH strings for a typed query: all terms ANDed first, then ORed. Terms of 5+ letters also match as prefixes. */
export function matchQueries(q) {
  const tokens = [...new Set(fold(String(q ?? '')).match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 1 || /\d/.test(t));
  const terms = tokens.filter((t) => !STOP.has(t));
  const use = terms.length ? terms : tokens;
  if (!use.length) return [];
  const group = (t) => {
    if (t.length < 5) return `"${t}"`;
    // a longer typed word (travaliul for travaliu) still hits through its shortened stem
    return t.length >= 7 ? `("${t}"* OR "${t.slice(0, -2)}"*)` : `"${t}"*`;
  };
  const groups = use.map(group);
  return groups.length === 1 ? [groups[0]] : [groups.join(' AND '), groups.join(' OR ')];
}

/**
 * Cuts a file into chunks of about MIN_CHUNK..MAX_CHUNK characters made of whole paragraph blocks, never across a heading or a section start.
 * `sections` = [{ from, label }] (1-based start lines). Returns [{ l1, l2, pagina, sectiune, text }].
 */
export function chunkLines(lines, sections = []) {
  const starts = new Set(sections.map((s) => s.from));
  const sorted = [...sections].sort((a, b) => a.from - b.from);
  const chunks = [];
  let page = null;
  let sec = null;
  let si = 0;
  let cur = null;
  const flush = () => {
    // a chunk made only of headings is dropped: the headings live on in the section label
    if (cur && cur.body && /[\p{L}\p{N}]/u.test(cur.text)) {
      const prev = chunks[chunks.length - 1];
      // a short tail of a section joins the chunk before it, so it cannot outrank real paragraphs by being short
      if (cur.text.length < MIN_TAIL && prev && prev.sectiune === cur.sectiune && prev.text.length + cur.text.length < MAX_CHUNK * 1.3) {
        prev.text += ` ${cur.text}`;
        prev.l2 = cur.l2;
      } else chunks.push({ l1: cur.l1, l2: cur.l2, pagina: cur.pagina, sectiune: cur.sectiune, text: cur.text });
    }
    cur = null;
  };
  const add = (piece, l1, l2, pg, isBody, label) => {
    if (cur && cur.text.length + 1 + piece.length > MAX_CHUNK) flush();
    if (!cur) cur = { l1, l2, pagina: pg, sectiune: label, text: '', body: false };
    if (isBody && !cur.body) { cur.pagina = pg; cur.sectiune = label; } // headings pending before the first paragraph: the chunk is where its text is
    cur.text += (cur.text ? ' ' : '') + piece;
    cur.l2 = l2;
    cur.body ||= isBody;
    if (cur.text.length >= MIN_CHUNK && cur.body) flush();
  };
  let block = [];
  const endBlock = () => {
    if (!block.length) return;
    const isBody = block.some((x) => !x.heading);
    const label = block[0].sec;
    // one paragraph; an over-long one is cut at line boundaries
    let piece = '';
    let l1 = block[0].n;
    let last = l1;
    let pg = block[0].pg;
    for (const { n, t, pg: page0 } of block) {
      if (piece && piece.length + 1 + t.length > MAX_CHUNK) { add(piece, l1, last, pg, isBody, label); piece = ''; l1 = n; pg = page0; }
      piece += (piece ? ' ' : '') + t;
      last = n;
    }
    if (piece) add(piece, l1, last, pg, isBody, label);
    block = [];
  };
  let body = false; // text other than headings is pending: a heading then closes the chunk (headings alone never form a chunk)
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    const heading = /^#{1,6}\s/.test(line);
    if (starts.has(n) || (heading && body)) { endBlock(); flush(); body = false; }
    while (si < sorted.length && sorted[si].from <= n) sec = sorted[si++].label;
    const marker = line.match(/^\[p\. (\d+)\]\s*$/);
    if (marker) { page = Number(marker[1]); continue; }
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) { endBlock(); continue; }
    const isHeading = heading || starts.has(n);
    block.push({ n, t, pg: page, sec, heading: isHeading });
    if (!isHeading) body = true;
  }
  endBlock();
  flush();
  return chunks;
}

/** Sections of an `actualizari/` file: the `##` headings ("§6.3 Title" -> "6.3 Title"). */
const headingSections = (lines) => lines.flatMap((l, i) => (/^##\s/.test(l) ? [{ from: i + 1, label: l.replace(/^##\s+§?\s*/, '').trim() }] : []));

export function buildSearch({ root, guides, curriculum, curriculumFiles, tocOf, linesOf, exists }) {
  const t0 = performance.now();
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE c USING fts5(text, ctx, fisier UNINDEXED, nr UNINDEXED, titlu UNINDEXED, sectiune UNINDEXED,
    pagina UNINDEXED, l1 UNINDEXED, l2 UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
  const ins = db.prepare('INSERT INTO c (text, ctx, fisier, nr, titlu, sectiune, pagina, l1, l2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let count = 0;
  const addFile = (fisier, nr, titlu, sections, fixedSection, dropFront = false) => {
    const lines = linesOf(path.join(root, fisier));
    for (const ch of chunkLines(lines, sections)) {
      if (dropFront && ch.sectiune === null) continue;
      const sectiune = ch.sectiune ?? fixedSection ?? null;
      // ctx = guideline and section titles: a question about "corticoterapie in nasterea inainte de termen" finds the right guide even when the chunk itself says NpT
      ins.run(ch.text, `${titlu} ${sectiune ?? ''}`, fisier, nr, titlu, sectiune, ch.pagina, ch.l1, ch.l2);
      count++;
    }
  };
  db.exec('BEGIN');
  try {
    for (const g of guides) {
      if (!exists(g.fisier)) continue;
      const sections = tocOf(g.nr).sectiuni.map((s) => ({ from: s.linii[0], label: `${s.nr} ${s.titlu}` }));
      // the title page and contents list before the first section are noise
      addFile(g.fisier, g.nr, g.titlu, sections, null, sections.length > 0);
      const upd = `ghiduri-sogr/actualizari/${path.posix.basename(g.fisier)}`;
      if (exists(upd)) addFile(upd, g.nr, g.titlu, headingSections(linesOf(path.join(root, upd))));
    }
    if (curriculum) {
      for (const f of curriculumFiles) {
        const lines = linesOf(path.join(root, f));
        const title = (lines.find((l) => l.startsWith('# ')) ?? f).slice(2).replace(/^Curriculum OG 2019\s*—\s*/, '');
        addFile(f, curriculum.nr, curriculum.titlu, [], title);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const sql = (filtered) => `SELECT fisier, nr, titlu, sectiune, pagina, l1, l2,
      snippet(c, 0, char(1), char(2), '…', 40) AS frag
    FROM c WHERE c MATCH ?${filtered ? ' AND nr = ?' : ''} ORDER BY bm25(c, 1.0, 0.6) LIMIT ?`;
  const stmts = { all: db.prepare(sql(false)), one: db.prepare(sql(true)) };

  /**
   * { hits, nivel }: nivel 'toate' when every term matched (the first pass, or a one-term query), 'oricare' when only
   * the any-term pass found something. `strict` runs the first pass only, at most 3 hits. No hits: the last pass tried.
   */
  function searchLevel(q, { ghid, limit = 8, strict = false } = {}) {
    const lim = strict ? 3 : Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 8));
    const passes = matchQueries(q).slice(0, strict ? 1 : 2);
    for (const [i, m] of passes.entries()) {
      let rows;
      try { rows = ghid ? stmts.one.all(m, ghid, lim) : stmts.all.all(m, lim); } catch { rows = []; }
      if (rows.length) {
        return { nivel: i === 0 ? 'toate' : 'oricare', hits: rows.map((r) => ({
          fisier: r.fisier, nr: r.nr, titlu: r.titlu, sectiune: r.sectiune, pagina: r.pagina,
          linii: [r.l1, r.l2],
          fragment: escapeHtml(r.frag).replaceAll(SEP_OPEN, '<mark>').replaceAll(SEP_CLOSE, '</mark>'),
        })) };
      }
    }
    return { nivel: passes.length > 1 ? 'oricare' : 'toate', hits: [] };
  }
  const search = (q, opts) => searchLevel(q, opts).hits;
  return { search, searchLevel, info: { chunks: count, ms: Math.round(performance.now() - t0) } };
}
