#!/usr/bin/env node
// npm run demo: the app with the fake model and invented data, no API key and no private data.
// demo/ is copied to a fresh temporary data directory on every run (the repository is never written to),
// dates are moved next to today, the logbook is filled through the real store, then the server starts.
// Password: demo (or ROKHAN_PASSWORD). Port: PORT or 8787.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from '../server/config.mjs';
import { startServer } from '../server/index.mjs';
import { getRegistru } from '../server/store/registru.mjs';
import { getVideoteca } from '../server/store/videoteca.mjs';
import { getCitit } from '../server/store/citit.mjs';
import { todayString, addDays } from '../server/lessons/sogr/state.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-demo-'));
fs.cpSync(path.join(ROOT, 'demo'), dataDir, { recursive: true });
// A placeholder push contact, so the notification settings show. The demo runs no jobs: nothing is sent on its own.
const config = loadConfig({
  ...process.env,
  ROKHAN_DATA_DIR: dataDir,
  ROKHAN_FAKE_LLM: '1',
  ROKHAN_PASSWORD: process.env.ROKHAN_PASSWORD || 'demo',
  ROKHAN_PUSH_CONTACT: process.env.ROKHAN_PUSH_CONTACT || 'https://example.org',
});
const today = todayString(config.tz);
const day = (n) => addDays(today, -n);
const writeJson = (rel, obj) => fs.writeFileSync(path.join(dataDir, rel), JSON.stringify(obj, null, 2) + '\n');

// Lessons: 01-1 read two days ago, 07-1 is next, 07-2 has no lesson yet.
writeJson('lessons/state.json', { plan: ['01-1', '07-1', '07-2'], cursor: 0, sent: [{ unit: '01-1', data: day(2), tip: 'lectura' }], sarite: [] });
writeJson('lessons/quiz-log.json', [{ id: '01-1', date: day(2), quiz: [true, false, true] }]);

// Conversations: the stored ones end a few hours ago.
const convDir = path.join(dataDir, 'conversations');
fs.readdirSync(convDir).forEach((f, i) => {
  const file = path.join(convDir, f);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const end = Date.now() - (i + 1) * 5 * 3600e3;
  c.messages.forEach((m, j) => { m.ts = end - (c.messages.length - 1 - j) * 60e3; });
  c.createdAt = c.messages[0].ts;
  c.updatedAt = c.messages.at(-1).ts;
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
});

// Logbook: invented entries over the last weeks.
const registru = getRegistru(config);
for (const e of [
  { row: 'nastere-vaginala', n: 1, date: day(40), nota: 'prima naștere (demo)' },
  { row: 'cezariana', rol: 'ajutat', n: 2, date: day(30), nota: 'mâna 2' },
  { row: 'garzi', n: 1, date: day(30) },
  { row: 'nastere-vaginala', n: 2, copii: 3, date: day(21), nota: 'una cu gemeni' },
  { row: 'epiziotomie', n: 2, date: day(21) },
  { row: 'ventuza', rol: 'observat', n: 1, date: day(14) },
  { row: 'garzi', n: 2, date: day(14) },
  { row: 'cezariana', n: 1, date: day(7), nota: 'mâna 1' },
  { row: 'nastere-vaginala', n: 1, date: day(3) },
  { row: 'sutura-rupturi', n: 1, date: day(3) },
  { row: 'garzi', n: 1, date: day(1) },
]) registru.addEntry(e);

// Videotecă: the first two "Start aici" films and one film about the uncomplicated birth are ticked.
const videoteca = getVideoteca(config);
const catalog = videoteca.catalog();
const birth = catalog.sections.flatMap((s) => s.procedures).find((p) => p.name_ro === 'Asistența nașterii necomplicate');
for (const v of [...catalog.start_here.slice(0, 2), ...(birth?.videos.slice(0, 1) ?? [])]) videoteca.setSeen(v.url, true);

// Ghiduri: the first guideline is read, the second is half way, and she stopped in its second section.
const citit = getCitit(config);
citit.tick('01', { citit: true });
for (const sectiune of [0, 1]) citit.tick('07', { sectiune, citita: true });
citit.setLast({ nr: '07', sectiune: 1, scroll: 0.35 });

const { url, close } = await startServer(config);
console.log(`[rokhan demo] ${url}  password: ${config.password}  (fake model, data in ${dataDir})`);
const stop = () => close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
