#!/usr/bin/env node
// Imports the Telegram bot's state (an ~/.openclaw directory) into a Rokhan data directory.
// node scripts/import-from-openclaw.mjs --openclaw <dir> --data <dir> [--only library,lessons,registru,memorie,conversations] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic, writeTextAtomic, readJson, plainDashes } from '../server/store/files.mjs';
import { DELETED_IMPORTED } from '../server/store/conversations.mjs';
import { seedRows, findRow, newRow, summarize, COUNTED, ROLES } from '../server/store/registru.mjs';

const START = '<!-- openclaw:wiki:generated:start -->';
const END = '<!-- openclaw:wiki:generated:end -->';
const MEMORY_PAGES = {
  'profil.md': 'profil',
  'jurnal-de-studiu.md': 'jurnal-de-studiu',
  'plan-de-studiu.md': 'plan-de-studiu',
  'surse.md': 'surse',
  'întrebări-deschise.md': 'intrebari-deschise',
  'corecții.md': 'corectii',
};
const GAP_MS = 4 * 3600 * 1000;

export function generatedBlock(md) {
  md = md.replace(/\r\n/g, '\n'); // a Windows checkout may hand us CRLF
  const a = md.indexOf(START);
  const b = md.indexOf(END, a);
  if (a < 0 || b < 0) return null;
  return md.slice(a + START.length, b).trim();
}

// Splits on `sep` where parentheses are balanced.
export function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim());
}

// `Name ×n (role, notes; more notes)` -> { name, n, rol, nota }
function parseProcedure(text) {
  const m = /^(.+?)\s*×\s*(\d+)\s*(?:\((.*)\))?$/s.exec(text.trim());
  if (!m) throw new Error(`procedure not understood: "${text}"`);
  const inner = (m[3] ?? '').trim();
  const r = /^(efectuat|ajutat|observat)\b[\s,;]*(.*)$/s.exec(inner);
  if (!r) throw new Error(`role missing or unknown in: "${text}"`);
  return { name: m[1].trim(), n: Number(m[2]), rol: r[1], nota: r[2].trim() };
}

// One `- YYYY-MM-DD ... — procedures — notes — 👶 +N` line.
export function parseEntryLine(line) {
  const parts = splitTop(line.replace(/^-\s*/, ''), ' — ');
  const dm = /^(\d{4}-\d{2}-\d{2})\s*(?:\((.*)\))?\s*(.*)$/s.exec(parts[0]);
  if (!dm || parts.length < 2) throw new Error(`entry line not understood: "${line}"`);
  let babies = null;
  if (parts.length > 2 && parts.at(-1).startsWith('👶')) {
    babies = Number((/\d+/.exec(parts.pop()) || [0])[0]);
  }
  const procedures = splitTop(parts[1], ';').filter(Boolean).map(parseProcedure);
  const notes = [dm[2], dm[3], ...parts.slice(2)].map((s) => (s ?? '').trim()).filter(Boolean);
  return { date: dm[1], procedures, notes, babies };
}

function section(block, prefix) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) return null;
  const out = [lines[i]];
  for (const l of lines.slice(i + 1)) {
    if (/^#{1,2} /.test(l)) break;
    out.push(l);
  }
  return out;
}

const stripParen = (s) => s.replace(/\s*\([^()]*\)\s*$/, '').trim();

// Parses the registru wiki page into { rows, entries } and checks it against the page's own totals.
// Returns { data, errors }: errors lists every mismatch, both sides.
export function importRegistru(md, { now = Date.now() } = {}) {
  const block = generatedBlock(md);
  if (!block) throw new Error('registru page has no generated block');
  const rows = seedRows();
  const entries = [];
  const intrari = section(block, '## Intrări');
  if (!intrari) throw new Error('no "## Intrări" section');
  const lines = intrari.slice(1).filter((l) => l.startsWith('- ') && !l.startsWith('- (format:'));
  lines.forEach((line, idx) => {
    const e = parseEntryLine(line);
    const made = e.procedures.map((p) => {
      let row = findRow(rows, p.name) || findRow(rows, stripParen(p.name));
      if (!row) {
        row = newRow(rows, p.name);
        rows.push(row);
      }
      const counted = p.rol === 'efectuat' && row.id in COUNTED;
      return {
        id: '',
        date: e.date, row: row.id, rol: p.rol, n: p.n, copii: counted ? p.n : 0,
        nota: [p.nota, ...e.notes].filter(Boolean).join(' — '),
        createdAt: now - idx * 1000, // keeps the page order among same-day entries
      };
    });
    made.forEach((m, k) => (m.id = `imp-${String(lines.length - idx).padStart(4, '0')}-${k + 1}`));
    const sum = made.reduce((s, m) => s + m.copii, 0);
    const first = made.find((m) => m.copii > 0);
    if (e.babies != null && e.babies > sum && first) first.copii += e.babies - sum; // twins
    entries.push(...made);
  });

  const data = { rows, entries };
  const s = summarize(data);
  const errors = [];
  const counter = section(block, '## 👶');
  if (!counter) errors.push('page has no "## 👶 Copii aduși pe lume" heading');
  else {
    const want = Number((/(\d+)\s*$/.exec(counter[0]) || [])[1]);
    if (want !== s.copii.total) errors.push(`babies total: page ${want}, computed ${s.copii.total}`);
    const subs = counter.filter((l) => /^- .*:\s*\d+\s*$/.test(l)); // "- Din nașteri vaginale ...: 14"
    const vag = subs.find((l) => /vaginal/i.test(l));
    const cez = subs.find((l) => /cezar/i.test(l));
    const num = (l) => Number((/:\s*(\d+)/.exec(l ?? '') || [])[1]);
    if (num(vag) !== s.copii.vaginale) errors.push(`vaginal babies: page ${num(vag)}, computed ${s.copii.vaginale}`);
    if (num(cez) !== s.copii.cezariene) errors.push(`caesarean babies: page ${num(cez)}, computed ${s.copii.cezariene}`);
  }
  const totals = section(block, '## Totaluri') ?? [];
  for (const line of totals.slice(1)) {
    if (!line.startsWith('- ') || line.startsWith('- (')) continue;
    const full = /^- (.+?): efectuat (\d+) · ajutat (\d+) · observat (\d+)(?: · barem (.*))?$/.exec(line);
    const plain = /^- (.+?): (\d+)\b/.exec(line);
    const name = (full ?? plain)?.[1];
    const row = name && (findRow(rows, name) || findRow(rows, stripParen(name)));
    if (!row) {
      errors.push(`totals line names an unknown row: "${line}"`);
      continue;
    }
    const got = s.rows.find((r) => r.id === row.id);
    if (full) {
      for (const [k, v] of [['efectuat', full[2]], ['ajutat', full[3]], ['observat', full[4]]]) {
        if (Number(v) !== got[k]) errors.push(`${row.nume} ${k}: page ${v}, computed ${got[k]}`);
      }
      if (full[5] != null && plainDashes(full[5].trim()) !== row.barem) errors.push(`${row.nume} barem: page "${full[5].trim()}", seed "${row.barem}"`);
    } else {
      const total = ROLES.reduce((a, k) => a + got[k], 0);
      if (Number(plain[2]) !== total) errors.push(`${row.nume}: page ${plain[2]}, computed ${total}`);
    }
  }
  return { data, summary: s, errors };
}

// User text: attachments become `[fișier: name]`. Assistant text: no MEDIA: lines.
export function cleanText(role, text) {
  if (role === 'assistant') return text.split('\n').filter((l) => !l.startsWith('MEDIA:')).join('\n').trim();
  return text
    .replace(/<file\s+name="([^"]*)"[^>]*>[\s\S]*?<\/file>/g, (_, name) => `[fișier: ${name}]`)
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[fișier: atașament]')
    .trim();
}

function stamp(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

// rows: [{ text, session, role, ts, messageId }] -> conversations ready to save.
export function buildConversations(rows, { tz = 'Europe/Bucharest' } = {}) {
  const sessions = new Map();
  for (const r of rows) {
    if (!sessions.has(r.session)) sessions.set(r.session, []);
    sessions.get(r.session).push(r);
  }
  const convs = [];
  let skipped = 0;
  for (const msgs of sessions.values()) {
    msgs.sort((a, b) => a.ts - b.ts);
    const users = msgs.filter((m) => m.role === 'user');
    const inter = users.filter((m) => m.text.startsWith('[Inter-session message]')).length;
    if (msgs.length < 6 || (users.length && inter / users.length >= 0.2)) {
      skipped++;
      continue;
    }
    let chunk = [];
    for (const m of msgs) {
      if (chunk.length && m.ts - chunk.at(-1).ts > GAP_MS) {
        convs.push(chunk);
        chunk = [];
      }
      chunk.push(m);
    }
    convs.push(chunk);
  }
  const used = new Set();
  const out = convs.map((chunk) => {
    let id = `tg-${stamp(chunk[0].ts, tz)}`;
    for (let i = 2; used.has(id); i++) id = `tg-${stamp(chunk[0].ts, tz)}-${i}`;
    used.add(id);
    const messages = chunk.map((m, i) => ({
      id: m.messageId || `${id}-${i}`, role: m.role, text: cleanText(m.role, m.text), images: [],
      ts: m.ts, urgent: false, state: 'ok', error: null,
    }));
    const firstUser = messages.find((m) => m.role === 'user');
    return {
      id, title: (firstUser?.text ?? 'Telegram').slice(0, 60), createdAt: chunk[0].ts, updatedAt: chunk.at(-1).ts,
      pending: false, imported: true, messages,
    };
  });
  return { conversations: out, skippedSessions: skipped };
}

function readTranscript(dbFile) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db
      .prepare(`SELECT c0 AS text, c1 AS session, c2 AS messageId, c3 AS role, c4 AS ts FROM session_transcript_fts_content
                WHERE c3 IN ('user', 'assistant') ORDER BY c1, CAST(c4 AS REAL), id`)
      .all()
      .map((r) => ({ text: String(r.text ?? ''), session: String(r.session), messageId: r.messageId ? String(r.messageId) : null, role: r.role, ts: Number(r.ts) }));
  } finally {
    db.close();
  }
}

export function run({ openclaw, data, only, force = false, tz = 'Europe/Bucharest', log = console.log }) {
  if (force && !only) {
    log('--force replaces live data: name the parts with --only (for example --only registru,memorie).');
    return { ok: false, report: {} };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Copies an existing file to <file>.bak-<stamp> before it is replaced. Returns the backup path or null.
  const backup = (file) => {
    if (!fs.existsSync(file)) return null;
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
    return `${file}.bak-${stamp}`;
  };
  // File by file: new files are copied; existing ones are kept unless --force (then backed up and replaced).
  const copyTree = (src, dst, skip = () => false) => {
    const n = { copied: 0, replaced: 0, kept: 0 };
    for (const d of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!d.isFile()) continue;
      const from = path.join(d.parentPath, d.name);
      const rel = path.relative(src, from);
      if (skip(rel.split(path.sep))) continue;
      const to = path.join(dst, rel);
      if (fs.existsSync(to)) {
        if (!force || fs.readFileSync(to).equals(fs.readFileSync(from))) {
          n.kept++;
          continue;
        }
        backup(to);
        n.replaced++;
      } else n.copied++;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    return n;
  };
  const describe = (n) => `${n.copied} files copied, ${n.replaced} replaced (old kept as .bak-${stamp}), ${n.kept} already present and kept`;
  const want = new Set(only ? only.split(',').map((s) => s.trim()) : ['library', 'lessons', 'registru', 'memorie', 'conversations']);
  const wiki = path.join(openclaw, 'wiki', 'rokhan', 'syntheses');
  const report = {};

  // Parse and check the logbook first: a mismatch must stop the run before anything is written.
  let registru;
  if (want.has('registru')) {
    const r = importRegistru(fs.readFileSync(path.join(wiki, 'registru-de-proceduri.md'), 'utf8'));
    if (r.errors.length) {
      log('registru: the parsed entries do not match the page:');
      r.errors.forEach((e) => log('  - ' + e));
      return { ok: false, report };
    }
    registru = r;
  }

  if (want.has('library')) {
    const n = copyTree(path.join(openclaw, 'workspace-rokhan', 'library'), path.join(data, 'library'));
    report.library = describe(n);
  }

  if (want.has('lessons')) {
    const src = path.join(openclaw, 'workspace', 'projects', 'sogr-lecturi', 'data');
    const n = copyTree(src, path.join(data, 'lessons'), (rel) => rel[0] === 'today' || rel[0] === 'out');
    report.lessons = describe(n);
  }

  if (registru) {
    const file = path.join(data, 'registru.json');
    if (fs.existsSync(file) && !force) report.registru = 'skipped: data/registru.json exists (use --force --only registru to replace it)';
    else {
      const bak = backup(file);
      writeJsonAtomic(file, registru.data);
      const c = registru.summary.copii;
      report.registru = `${registru.data.entries.length} entries, ${c.total} babies (${c.vaginale} vaginal, ${c.cezariene} caesarean), first ${c.primul}${bak ? `; old file kept as ${path.basename(bak)}` : ''}`;
    }
  }

  if (want.has('memorie')) {
    const done = [];
    const skipped = [];
    for (const [src, pagina] of Object.entries(MEMORY_PAGES)) {
      const from = path.join(wiki, src);
      if (!fs.existsSync(from)) continue;
      const to = path.join(data, 'memory', pagina + '.md');
      if (fs.existsSync(to) && !force) {
        skipped.push(pagina);
        continue;
      }
      const body = generatedBlock(fs.readFileSync(from, 'utf8'));
      if (body == null) continue;
      backup(to);
      writeTextAtomic(to, body + '\n');
      done.push(pagina);
    }
    report.memorie = `${done.length} pages written${done.length ? ` (${done.join(', ')})` : ''}` +
      (skipped.length ? `; skipped, already present: ${skipped.join(', ')} (use --force --only memorie)` : '');
  }

  if (want.has('conversations')) {
    const { conversations, skippedSessions } = buildConversations(readTranscript(path.join(openclaw, 'agents', 'rokhan', 'agent', 'openclaw-agent.sqlite')), { tz });
    const dir = path.join(data, 'conversations');
    const deleted = new Set(readJson(path.join(data, DELETED_IMPORTED), []));
    let written = 0;
    let existing = 0;
    for (const conv of conversations) {
      const file = path.join(dir, conv.id + '.json');
      if (fs.existsSync(file) || deleted.has(conv.id)) {
        existing++;
        continue;
      }
      writeJsonAtomic(file, conv);
      written++;
    }
    const msgs = conversations.reduce((a, c) => a + c.messages.length, 0);
    report.conversations = `${written} written, ${existing} already present or deleted in the app, ${msgs} messages in ${conversations.length} conversations; ${skippedSessions} sessions skipped (short or inter-session)`;
  }

  for (const [k, v] of Object.entries(report)) log(`${k}: ${v}`);
  return { ok: true, report };
}


if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { openclaw: { type: 'string' }, data: { type: 'string' }, only: { type: 'string' }, force: { type: 'boolean', default: false } },
  });
  if (!values.openclaw || !values.data) {
    console.error('usage: node scripts/import-from-openclaw.mjs --openclaw <dir> --data <dir> [--only library,lessons,registru,memorie,conversations] [--force]');
    process.exit(2);
  }
  const { ok } = run({ openclaw: path.resolve(values.openclaw), data: path.resolve(values.data), only: values.only, force: values.force, tz: process.env.ROKHAN_TZ || 'Europe/Bucharest' });
  process.exit(ok ? 0 : 1);
}
