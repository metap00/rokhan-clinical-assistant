// Strict guideline search, the idempotent logbook post, reviews in the daily notification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeConfig } from './core-helpers.mjs';
import { getPush, runDailyPush } from '../server/store/push.mjs';
import { fakeApp, libraryConfig } from './content-helpers.mjs';
import registerGhiduri from '../server/routes/ghiduri.mjs';

test('GET /api/cauta strict=1: only all-term hits, at most 3, same fields; nivel on every answer', async () => {
  const app = fakeApp();
  registerGhiduri(app);
  const config = libraryConfig();
  const q = (query) => app.call('GET', '/api/cauta', { config, query });

  const normal = (await q({ q: 'nastere termen' })).body;
  assert.equal(normal.nivel, 'toate');
  assert.ok(normal.hits.length > 3);
  const strict = (await q({ q: 'nastere termen', strict: '1' })).body;
  assert.equal(strict.nivel, 'toate');
  assert.equal(strict.hits.length, 3);
  assert.deepEqual(strict.hits, normal.hits.slice(0, 3));
  assert.deepEqual(Object.keys(strict.hits[0]).sort(), ['fisier', 'fragment', 'linii', 'nr', 'pagina', 'sectiune', 'titlu']);

  // one term missing: the any-term pass answers without strict, nothing with it
  const any = (await q({ q: 'placenta xyzzy' })).body;
  assert.equal(any.nivel, 'oricare');
  assert.ok(any.hits.length > 0);
  assert.deepEqual((await q({ q: 'placenta xyzzy', strict: '1' })).body, { hits: [], nivel: 'toate' });
  assert.deepEqual((await q({ q: 'xyzzyq', strict: '1' })).body, { hits: [], nivel: 'toate' });
});

test('POST /api/registru/entries with a client id: stored under it; a resend returns the same entry and adds nothing', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  await app.login();
  const body = { id: 'queue-7f3a9c21', row: 'cezariana', n: 1, date: '2026-11-20' };
  const first = await app.api('POST', '/api/registru/entries', body);
  assert.equal(first.status, 200);
  assert.equal(first.json.entry.id, 'queue-7f3a9c21');
  const again = await app.api('POST', '/api/registru/entries', { ...body, n: 5 });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.entry, first.json.entry);
  assert.equal(again.json.registru.entries.length, 1);
  assert.equal(again.json.registru.copii.cezariene, 1);
  for (const id of ['short', 'UPPER-case-id', 'a'.repeat(65), 'with space x', 12345678]) {
    assert.equal((await app.api('POST', '/api/registru/entries', { ...body, id })).status, 400, String(id));
  }
  const plain = await app.api('POST', '/api/registru/entries', { row: 'cezariana' });
  assert.match(plain.json.entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(plain.json.registru.entries.length, 2);
});

// ---------- the daily notification ----------

const MON = '2026-11-23';
const at = (hhmm) => new Date(`${MON}T${hhmm}:00+02:00`);
const next = { id: '14-1', ghid: { nr: '14', titlu: 'Preeclampsia' }, k: 1, n: 5, titlu: 'Diagnostic și severitate', scrisa: true, minute: 7 };
const lessons = ({ citite = [], scadente = 0, urmatoarea = next } = {}) => ({
  status: () => ({ urmatoarea, progres: [], citite, recap: { disponibil: false, lectii: [] }, repetitie: { scadente } }),
  requestGenerate: () => ({ status: 'in_lucru' }),
});
function setup() {
  const config = makeConfig({ pushContact: 'mailto:test@example.com' });
  const sent = [];
  const push = getPush(config, { sender: async (s, payload) => { sent.push(JSON.parse(payload)); } });
  push.addSubscription({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: 'BPk-abc_123', auth: 'au-th_9' } });
  push.setSettings({ activ: true, ora: '07:00' });
  return { sent, run: (l, hhmm = '07:00') => runDailyPush({ config, lessons: l, now: at(hhmm) }) };
}

test('the lesson notification counts the reviews due', async () => {
  const a = setup();
  await a.run(lessons({ scadente: 4 }));
  assert.deepEqual(a.sent, [{ title: 'Lectura de azi', body: 'Preeclampsia: Diagnostic și severitate (cam 7 minute) · 4 întrebări de repetat', url: '/#/lecturi' }]);
  const b = setup();
  await b.run(lessons({ scadente: 1 }));
  assert.equal(b.sent[0].body, 'Preeclampsia: Diagnostic și severitate (cam 7 minute) · 1 întrebare de repetat');
  const c = setup();
  await c.run(lessons());
  assert.equal(c.sent[0].body, 'Preeclampsia: Diagnostic și severitate (cam 7 minute)');
});

test('lesson already read today: "De repetat azi" when reviews are due, silence otherwise; still one a day', async () => {
  const a = setup();
  const readToday = [{ id: '13-4', titlu: 'x', data: MON }];
  await a.run(lessons({ citite: readToday, scadente: 6 }));
  await a.run(lessons({ citite: readToday, scadente: 6 }), '08:00');
  assert.deepEqual(a.sent, [{ title: 'De repetat azi', body: '6 întrebări din lecturile citite.', url: '/#/lecturi' }]);
  const b = setup();
  assert.equal(await b.run(lessons({ citite: readToday })), 'citita deja');
  await b.run(lessons({ citite: readToday, scadente: 3 }), '08:00'); // the day is already marked
  assert.equal(b.sent.length, 0);
  const c = setup(); // the plan is finished but reviews are due
  await c.run(lessons({ urmatoarea: null, scadente: 2 }));
  assert.deepEqual(c.sent, [{ title: 'De repetat azi', body: '2 întrebări din lecturile citite.', url: '/#/lecturi' }]);
});
