import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import registerGhiduri from '../server/routes/ghiduri.mjs';
import registerLecturi from '../server/routes/lecturi.mjs';
import { fakeApp, libraryConfig, makeLessonsData, readJson } from './content-helpers.mjs';

test('library routes: list (curriculum last), toc, text and search', async () => {
  const app = fakeApp();
  registerGhiduri(app);
  const config = libraryConfig();

  const list = await app.call('GET', '/api/ghiduri', { config });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((g) => g.nr), ['01', '02', 'curriculum']);

  const toc = await app.call('GET', '/api/ghiduri/:nr', { config, params: { nr: '01' } });
  assert.equal(toc.body.sectiuni.length, 3);
  assert.equal((await app.call('GET', '/api/ghiduri/:nr', { config, params: { nr: '77' } })).status, 404);

  const text = await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: '01' }, query: { from: '21', to: '23' } });
  assert.deepEqual([text.body.from, text.body.to, text.body.total], [21, 23, 35]);
  assert.match(text.body.markdown, /^6\.3 Administrarea corticoterapiei/);
  const noRange = await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: '02' } });
  assert.equal(noRange.body.from, 1);
  assert.equal((await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: '01' }, query: { from: 'abc' } })).status, 400);
  assert.equal((await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: '01' }, query: { from: '-1' } })).status, 400);
  const curr = await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: 'curriculum' } });
  assert.match(curr.body.markdown, /Curriculum OG 2019/);
  // a file outside the library cannot be reached through the curriculum's ?fisier=
  const esc = await app.call('GET', '/api/ghiduri/:nr/text', { config, params: { nr: 'curriculum' }, query: { fisier: '../../../package.json' } });
  assert.ok([403, 404].includes(esc.status), String(esc.status));

  const s = await app.call('GET', '/api/cauta', { config, query: { q: 'nastere inainte de termen' } });
  assert.ok(s.body.hits.length > 0);
  assert.match(s.body.hits[0].fragment, /<mark>/);
  const filtered = await app.call('GET', '/api/cauta', { config, query: { q: 'placenta', ghid: '01' } });
  assert.deepEqual(filtered.body, { hits: [], nivel: 'toate' });
  assert.deepEqual((await app.call('GET', '/api/cauta', { config, query: {} })).body, { hits: [], nivel: 'toate' });
});

test('lessons routes: the whole read-a-lesson flow', async () => {
  const app = fakeApp();
  registerLecturi(app);
  const { config } = makeLessonsData();
  const call = (m, p, o = {}) => app.call(m, p, { config, ...o });

  const st = await call('GET', '/api/lecturi');
  assert.equal(st.body.urmatoarea.id, '01-1');

  const lesson = await call('GET', '/api/lecturi/:id', { params: { id: '01-1' } });
  assert.equal(lesson.status, 200);
  assert.equal(lesson.body.id, '01-1');
  assert.equal((await call('GET', '/api/lecturi/:id', { params: { id: '08-2' } })).body.error, 'nescrisa');
  assert.equal((await call('GET', '/api/lecturi/:id', { params: { id: '99-9' } })).status, 404);

  const read = await call('POST', '/api/lecturi/:id/citita', { params: { id: '01-1' }, body: { quiz: [true, true, false] } });
  assert.equal(read.status, 200);
  assert.equal(read.body.urmatoarea.id, '07-1');
  assert.equal((await call('POST', '/api/lecturi/:id/citita', { params: { id: '07-1' }, body: { quiz: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/lecturi/:id/citita', { params: { id: '07-1' }, body: null })).status, 200);

  const order = await call('POST', '/api/lecturi/ordine', { body: { ghid: '08' } });
  assert.equal(order.body.urmatoarea.id, '08-1');
  assert.equal((await call('POST', '/api/lecturi/ordine', { body: {} })).status, 404);

  const skipped = await call('POST', '/api/lecturi/:id/sari', { params: { id: '08-1' } });
  assert.equal(skipped.body.urmatoarea.id, '08-2');

  // generate: 200 scrisa when it exists, else 202 in_lucru and the unit is queued for the writer
  const done = await call('POST', '/api/lecturi/:id/genereaza', { params: { id: '07-2' } });
  assert.deepEqual([done.status, done.body], [200, { status: 'scrisa' }]);
  const queued = await call('POST', '/api/lecturi/:id/genereaza', { params: { id: '08-2' } });
  assert.deepEqual([queued.status, queued.body], [202, { status: 'in_lucru' }]);
  assert.deepEqual(readJson(path.join(config.dataDir, 'lessons', 'requests.json')) && Object.keys(readJson(path.join(config.dataDir, 'lessons', 'requests.json'))), ['08-2']);
  assert.equal((await call('POST', '/api/lecturi/:id/genereaza', { params: { id: '99-9' } })).status, 404);
});

test('GET /api/lecturi/recap works whatever route the router matches', async () => {
  const app = fakeApp();
  registerLecturi(app);
  const { config } = makeLessonsData();
  const direct = await app.call('GET', '/api/lecturi/recap', { config });
  assert.equal(direct.status, 200);
  assert.deepEqual(Object.keys(direct.body).sort(), ['cifre', 'disponibil', 'lectii', 'quiz']);
  const viaId = await app.call('GET', '/api/lecturi/:id', { config, params: { id: 'recap' } });
  assert.deepEqual(viaId.body, direct.body);
});
