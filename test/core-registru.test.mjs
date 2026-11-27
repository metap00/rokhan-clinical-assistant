import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig } from './core-helpers.mjs';
import { getRegistru, seedRows, tintaOf } from '../server/store/registru.mjs';
import { dayIn } from '../server/store/files.mjs';

const fresh = () => getRegistru(makeConfig());

test('seed rows, in order, with tinta = lowest number in the barem', () => {
  const rows = seedRows();
  assert.equal(rows.length, 17);
  assert.equal(rows[0].id, 'nastere-vaginala');
  assert.equal(rows.at(-1).id, 'garzi');
  assert.deepEqual(rows.find((r) => r.id === 'cezariana-urgenta'), { id: 'cezariana-urgenta', nume: 'Cezariană în urgență', barem: 'min. 10-15', tinta: 10 });
  assert.equal(rows.find((r) => r.id === 'forceps').tinta, 0);
  assert.equal(rows.find((r) => r.id === 'garzi').tinta, null);
  assert.equal(tintaOf('15–20'), 15);
});

test('baby counter: efectuat births only, twins, other roles and rows never count', () => {
  const r = fresh();
  r.addEntry({ row: 'nastere-vaginala', n: 2, date: '2026-11-01' });
  r.addEntry({ row: 'cezariana', n: 1, copii: 2, date: '2026-10-15' }); // twins
  r.addEntry({ row: 'cezariana', rol: 'ajutat', n: 3, copii: 3, date: '2026-11-02' });
  r.addEntry({ row: 'nastere-vaginala', rol: 'observat', n: 1, date: '2026-11-02' });
  r.addEntry({ row: 'ventuza', n: 1, copii: 1, date: '2026-11-02' });
  r.addEntry({ row: 'cezariana-urgenta', n: 1, date: '2026-11-02' });
  const s = r.summary();
  assert.deepEqual(s.copii, { total: 4, vaginale: 2, cezariene: 2, primul: '2026-10-15' });
  assert.equal(s.urmatorulPrag, 10);
  const row = (id) => s.rows.find((x) => x.id === id);
  assert.deepEqual([row('cezariana').efectuat, row('cezariana').ajutat, row('cezariana').observat], [1, 3, 0]);
  assert.equal(row('nastere-vaginala').observat, 1);
  // copii is stored as 0 outside counted efectuat entries
  assert.ok(s.entries.filter((e) => e.rol !== 'efectuat' || !['nastere-vaginala', 'cezariana'].includes(e.row)).every((e) => e.copii === 0));
  // newest first
  assert.equal(s.entries.at(-1).date, '2026-10-15');
});

test('milestones', () => {
  const r = fresh();
  assert.equal(r.summary().urmatorulPrag, 1);
  r.addEntry({ row: 'nastere-vaginala', n: 10, date: '2026-11-01' });
  assert.equal(r.summary().urmatorulPrag, 25);
  r.addEntry({ row: 'nastere-vaginala', n: 990, date: '2026-11-01' });
  assert.equal(r.summary().urmatorulPrag, null);
});

test('name matching ignores case and diacritics; unknown names create a row', () => {
  const r = fresh();
  assert.equal(r.addEntry({ row: 'NASTERE VAGINALA' }).row, 'nastere-vaginala');
  assert.equal(r.addEntry({ row: 'cezariană' }).row, 'cezariana');
  assert.equal(r.addEntry({ row: 'Cezariana in urgenta' }).row, 'cezariana-urgenta');
  assert.equal(r.addEntry({ row: 'gărzi' }).row, 'garzi');
  const e = r.addEntry({ row: 'Histeroscopie diagnostică' });
  assert.equal(e.row, 'histeroscopie-diagnostica');
  const row = r.summary().rows.find((x) => x.id === e.row);
  assert.deepEqual([row.nume, row.barem, row.tinta, row.efectuat], ['Histeroscopie diagnostică', '', null, 1]);
  assert.equal(r.addEntry({ row: 'histeroscopie diagnostica' }).row, e.row); // second time it matches
});

test('dates: default today in tz, reject malformed and future dates', () => {
  const r = fresh();
  assert.equal(r.addEntry({ row: 'cerclaj' }).date, dayIn('Europe/Bucharest'));
  const tomorrow = dayIn('Europe/Bucharest', Date.now() + 24 * 3600e3);
  assert.equal(r.addEntry({ row: 'cerclaj', date: tomorrow }).date, tomorrow);
  for (const date of ['2026-13-01', '2026-02-30', '21.11.2026', '2099-01-01', 'azi']) {
    assert.throws(() => r.addEntry({ row: 'cerclaj', date }), (err) => err.status === 400, date);
  }
  assert.throws(() => r.addEntry({ row: 'cerclaj', rol: 'mana 2' }), (err) => err.status === 400);
  assert.throws(() => r.addEntry({ row: 'cerclaj', n: 0 }), (err) => err.status === 400);
  assert.throws(() => r.addEntry({ row: '' }), (err) => err.status === 400);
});

test('update keeps twins, role change resets copii, delete, 404s', () => {
  const r = fresh();
  const e = r.addEntry({ row: 'cezariana', n: 1, copii: 2, date: '2026-11-01' });
  assert.equal(r.updateEntry(e.id, { n: 2 }).copii, 3);
  assert.equal(r.updateEntry(e.id, { rol: 'ajutat' }).copii, 0);
  assert.equal(r.updateEntry(e.id, { rol: 'efectuat' }).copii, 2);
  assert.equal(r.updateEntry(e.id, { row: 'Ventuză' }).copii, 0);
  assert.equal(r.summary().copii.total, 0);
  assert.throws(() => r.updateEntry('nu', {}), (err) => err.status === 404);
  r.deleteEntry(e.id);
  assert.equal(r.summary().entries.length, 0);
  assert.throws(() => r.deleteEntry(e.id), (err) => err.status === 404);
});

test('addRow and the stored file holds no totals', () => {
  const config = makeConfig();
  const r = getRegistru(config);
  const row = r.addRow({ nume: 'Amniocenteză', barem: 'min. 5' });
  assert.deepEqual(row, { id: 'amniocenteza', nume: 'Amniocenteză', barem: 'min. 5', tinta: 5 });
  assert.throws(() => r.addRow({ nume: 'amniocenteza' }), (err) => err.status === 409);
  r.addEntry({ row: 'amniocenteza' });
  const stored = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'registru.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['entries', 'rows']);
  assert.ok(!('efectuat' in stored.rows[0]));
});

test('export: one line per entry, oldest first, date range', () => {
  const r = fresh();
  r.addEntry({ row: 'cezariana', date: '2026-11-21' });
  r.addEntry({ row: 'nastere-vaginala', n: 2, date: '2026-11-20' });
  r.addEntry({ row: 'cerclaj', rol: 'observat', date: '2026-10-01' });
  assert.equal(r.exportText(), '2026-10-01 - Cerclaj ×1 - observat\n2026-11-20 - Naștere vaginală ×2 - efectuat\n2026-11-21 - Cezariană ×1 - efectuat');
  assert.equal(r.exportText({ from: '2026-11-01', to: '2026-11-20' }), '2026-11-20 - Naștere vaginală ×2 - efectuat');
});

test('a logbook stored with long dashes reads with plain hyphens, and a name typed either way finds its row', () => {
  const config = makeConfig();
  const long = (s) => s.replace('-', String.fromCharCode(0x2013));
  const rows = seedRows().map((r) => ({ ...r, nume: long(r.nume), barem: long(r.barem) }));
  fs.writeFileSync(path.join(config.dataDir, 'registru.json'), JSON.stringify({ rows, entries: [] }));
  const r = getRegistru(config);
  const row = r.summary().rows.find((x) => x.id === 'sutura-rupturi');
  assert.deepEqual([row.nume, row.barem, row.tinta], ['Sutură rupturi perineale gr. 1-3', 'min. 10-15', 10]);
  for (const name of [long('Sutură rupturi perineale gr. 1-3'), 'Sutură rupturi perineale gr. 1-3']) {
    assert.equal(r.addEntry({ row: name }).row, 'sutura-rupturi', name);
  }
});
