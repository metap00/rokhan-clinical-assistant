import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, httpError, fold, dayIn, plainDashes } from './files.mjs';

const SEED = `
nastere-vaginala | Naștere vaginală | 50
cezariana | Cezariană | 20
cezariana-uter-cicatricial | Cezariană pe uter cicatricial | 15-20
cezariana-urgenta | Cezariană în urgență | min. 10-15
ventuza | Ventuză obstetricală | 10-20
forceps | Forceps / spatule | 0-10
nastere-pelvina | Naștere în pelvină | 5
epiziotomie | Epiziotomie / epiziorafie | min. 10-15
sutura-rupturi | Sutură rupturi perineale gr. 1-3 | min. 10-15
extractie-placenta | Extracție manuală / instrumentală de placentă | min. 10-15
cerclaj | Cerclaj | 3
recoltare-cervico-vaginala | Recoltare probe cervico-vaginale | 50
chiuretaj-biopsic | Chiuretaj biopsic | 15
dilatare-aspiratie | Dilatare și aspirație / chiuretaj (avort spontan precoce) | 15
contraceptie | Contracepție (DIU, implant, diafragm) | 20
marsupializare | Marsupializare chist Bartholin | 5
garzi | Gărzi |`;

// Only babies she received herself count: efectuat in these two rows.
export const COUNTED = { 'nastere-vaginala': 'vaginale', cezariana: 'cezariene' };
export const ROLES = ['efectuat', 'ajutat', 'observat'];
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

export function tintaOf(barem) {
  const nums = String(barem ?? '').match(/\d+/g);
  return nums ? Math.min(...nums.map(Number)) : null;
}

export function seedRows() {
  return SEED.trim()
    .split('\n')
    .map((line) => {
      const [id, nume, barem = ''] = line.split('|').map((s) => s.trim());
      return { id, nume, barem, tinta: tintaOf(barem) };
    });
}

// A row id or a free name, matched ignoring case and diacritics against ids and names.
export function findRow(rows, name) {
  const key = (s) => fold(plainDashes(s));
  const want = key(name);
  if (!want) return null;
  return rows.find((r) => r.id === name) || rows.find((r) => key(r.id) === want || key(r.nume) === want) || null;
}

function slugify(name, rows) {
  const base = fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'procedura';
  let id = base;
  for (let i = 2; rows.some((r) => r.id === id); i++) id = `${base}-${i}`;
  return id;
}

export function newRow(rows, nume, barem = '') {
  nume = String(nume ?? '').trim();
  if (!nume) throw httpError(400, 'nume_lipsa');
  barem = plainDashes(barem).trim();
  return { id: slugify(nume, rows), nume, barem, tinta: tintaOf(barem) };
}

function checkDate(date, tz, now) {
  if (date == null || date === '') return dayIn(tz, now);
  const ok = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date + 'T00:00:00Z'))
    && new Date(date + 'T00:00:00Z').toISOString().startsWith(date);
  if (!ok) throw httpError(400, 'data_invalida');
  if (date > dayIn(tz, now + 24 * 3600 * 1000)) throw httpError(400, 'data_in_viitor');
  return date;
}

function checkInt(v, def, min, err) {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > 1000) throw httpError(400, err);
  return n;
}

// Builds a valid entry from loose input. `prev` is the entry being patched, if any.
export function normalizeEntry(input, { rowId, tz, now = Date.now(), prev }) {
  const rol = input.rol ?? 'efectuat';
  if (!ROLES.includes(rol)) throw httpError(400, 'rol_invalid');
  const n = checkInt(input.n, 1, 1, 'numar_invalid');
  const counted = rol === 'efectuat' && Object.hasOwn(COUNTED, rowId);
  let copii = 0;
  if (counted) {
    const extra = prev && prev.copii > prev.n ? prev.copii - prev.n : 0; // twins survive an edit of n
    copii = checkInt(input.copii, n + extra, 0, 'copii_invalid');
  }
  return {
    date: checkDate(input.date, tz, now),
    row: rowId,
    rol,
    n,
    copii,
    nota: String(input.nota ?? '').trim().slice(0, 2000),
  };
}

// Everything derived is computed here, from entries, on every read.
export function summarize({ rows, entries }) {
  const copii = { total: 0, vaginale: 0, cezariene: 0, primul: null };
  const byRow = new Map(rows.map((r) => [r.id, { ...r, efectuat: 0, ajutat: 0, observat: 0 }]));
  for (const e of entries) {
    const r = byRow.get(e.row);
    if (r) r[e.rol] += e.n;
    if (e.rol === 'efectuat' && Object.hasOwn(COUNTED, e.row) && e.copii > 0) {
      copii.total += e.copii;
      copii[COUNTED[e.row]] += e.copii;
      if (!copii.primul || e.date < copii.primul) copii.primul = e.date;
    }
  }
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  return {
    copii,
    rows: [...byRow.values()],
    entries: sorted,
    urmatorulPrag: MILESTONES.find((m) => m > copii.total) ?? null,
  };
}

const instances = new Map();

export function getRegistru(config) {
  if (!instances.has(config.dataDir)) instances.set(config.dataDir, createRegistru(config));
  return instances.get(config.dataDir);
}

function createRegistru(config) {
  const file = path.join(config.dataDir, 'registru.json');
  // Rows saved before 2026-11-27 carry long dashes ("10–20"): read with a plain hyphen, saved so on the next write.
  const load = () => {
    const data = readJson(file, null) ?? { rows: seedRows(), entries: [] };
    return { ...data, rows: data.rows.map((r) => ({ ...r, nume: plainDashes(r.nume), barem: plainDashes(r.barem) })) };
  };
  const save = (data) => writeJsonAtomic(file, { rows: data.rows, entries: data.entries });
  // The old entry, before every change or deletion: a trace and a way back.
  const history = (action, entry) =>
    fs.appendFileSync(path.join(config.dataDir, 'registru-history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action, entry }) + '\n');

  function resolveRow(data, name) {
    if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'procedura_lipsa');
    let row = findRow(data.rows, name.trim());
    if (!row) {
      row = newRow(data.rows, name);
      data.rows.push(row);
    }
    return row;
  }

  return {
    summary: () => summarize(load()),

    // `input.id` (optional, chosen by the client) makes a resend safe: an entry with that id is returned as it is.
    addEntry(input = {}) {
      const data = load();
      if (input.id != null) {
        if (typeof input.id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(input.id)) throw httpError(400, 'id_invalid');
        const existing = data.entries.find((e) => e.id === input.id);
        if (existing) return existing;
      }
      const row = resolveRow(data, input.row);
      const entry = { id: input.id ?? crypto.randomUUID(), ...normalizeEntry(input, { rowId: row.id, tz: config.tz }), createdAt: Date.now() };
      data.entries.push(entry);
      save(data);
      return entry;
    },

    updateEntry(id, patch = {}) {
      const data = load();
      const i = data.entries.findIndex((e) => e.id === id);
      if (i < 0) throw httpError(404, 'negasit');
      const prev = data.entries[i];
      const rowId = patch.row != null ? resolveRow(data, patch.row).id : prev.row;
      const merged = { ...prev, ...patch };
      if (patch.copii == null) delete merged.copii; // recompute from n unless given
      const entry = { ...prev, ...normalizeEntry(merged, { rowId, tz: config.tz, prev }) };
      history('update', prev);
      data.entries[i] = entry;
      save(data);
      return entry;
    },

    deleteEntry(id) {
      const data = load();
      const i = data.entries.findIndex((e) => e.id === id);
      if (i < 0) throw httpError(404, 'negasit');
      history('delete', data.entries[i]);
      data.entries.splice(i, 1);
      save(data);
      return { ok: true };
    },

    addRow({ nume, barem } = {}) {
      const data = load();
      if (findRow(data.rows, String(nume ?? '').trim())) throw httpError(409, 'exista_deja');
      const row = newRow(data.rows, nume, barem);
      data.rows.push(row);
      save(data);
      return row;
    },

    exportText({ from, to } = {}) {
      const data = load();
      const names = new Map(data.rows.map((r) => [r.id, r.nume]));
      return data.entries
        .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
        .map((e) => `${e.date} - ${names.get(e.row) ?? e.row} ×${e.n} - ${e.rol}`)
        .join('\n');
    },
  };
}
