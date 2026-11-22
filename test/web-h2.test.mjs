// The pure parts behind the five "do first" screens: the "does a guideline exist" rule and the logbook outbox.
// (The CNP check is tested in web-lib.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount, wantsMatch, asksForGuideline, matchQuery, hitHref } from '../web/lib/ghid.js';
import { makeItem, adopt, flush, memoryStore, firstWorking, newId } from '../web/lib/outbox.js';

test('ghid: three words without a photo are looked up; "does a guideline exist" needs ghid plus avem, exista or sogr', () => {
  assert.equal(wordCount('  avem   ghid\npentru  '), 3);
  assert.equal(wantsMatch('placenta praevia diagnostic'), true);
  assert.equal(wantsMatch('placenta praevia'), false);
  assert.equal(wantsMatch('ce vezi in poza asta', 1), false);
  assert.equal(wantsMatch(''), false);
  for (const yes of ['avem ghid pentru placenta praevia?', 'Exista ghid SOGR pt colestaza', 'EXISTĂ un ghid pentru asta', 'ghidul sogr de inducere', 'ce zice SOGR, e vreun ghid?']) assert.equal(asksForGuideline(yes), true, yes);
  for (const no of ['ce doza de oxitocina dau', 'avem paturi libere?', 'ghidul NICE spune altceva', 'sogr recomanda ceva?', '', null]) assert.equal(asksForGuideline(no), false, String(no));
  // the lookup drops the words of the question itself, keeps the topic and its numbers
  assert.equal(matchQuery('avem ghid pentru placenta praevia?'), 'pentru placenta praevia');
  assert.equal(matchQuery('Exista ghid SOGR pt colestaza de sarcina'), 'colestaza de sarcina');
  assert.equal(matchQuery('există vreun ghid despre ruptura prematură de membrane'), 'ruptura prematură de membrane');
  assert.equal(matchQuery('ce fac la TA 150/100, 34 SA'), 'ce fac la TA 150/100 34 SA');
  assert.equal(matchQuery('avem ghid sogr?'), '');
  assert.equal(hitHref({ nr: '10', linii: [120, 131], fisier: 'ghiduri-sogr/10/text.md' }), '#/ghiduri/10/cauta?l=120-131&f=ghiduri-sogr%2F10%2Ftext.md');
});

test('outbox: an item carries one id in the body; old items are adopted with valid ids', () => {
  const a = makeItem({ row: 'cezariana', n: 1 }, { now: 5 });
  assert.match(a.id, /^[a-z0-9-]{8,64}$/);
  assert.equal(a.body.id, a.id);
  assert.equal(a.createdAt, 5);
  assert.notEqual(newId(), newId());
  const [x, y] = adopt([{ id: 'TMP_1', body: { row: 'ventuza' }, createdAt: 1 }, { id: '0b9c2a44-1111-4222-8333-444455556666', body: { row: 'forceps' }, createdAt: 2 }, { id: 'broken' }]);
  assert.notEqual(x.id, 'TMP_1');
  assert.match(x.id, /^[a-z0-9-]{8,64}$/);
  assert.deepEqual([x.body.row, x.body.id, x.createdAt], ['ventuza', x.id, 1]);
  assert.equal(y.id, '0b9c2a44-1111-4222-8333-444455556666');
  assert.deepEqual(adopt(null), []);
});

test('outbox: flush sends oldest first, stops without network, drops what the server refuses, and a resend keeps the id', async () => {
  const items = [makeItem({ row: 'b' }, { now: 2 }), makeItem({ row: 'a' }, { now: 1 }), makeItem({ row: 'c' }, { now: 3 })];
  const store = memoryStore(items);
  const seen = [];
  // 1: no network on the first item: nothing is lost
  let r = await flush(store, async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual([r.sent, r.rejected.length, r.left, (await store.all()).length], [0, 0, 3, 3]);
  // 2: the answer to "a" is lost after the server stored it
  r = await flush(store, async (body) => { seen.push(body.id); throw new TypeError('lost'); });
  assert.deepEqual([r.sent, r.left, seen.length], [0, 3, 1]);
  // 3: back online: "a" goes again under the same id, "b" is refused (400), "c" is stored
  r = await flush(store, async (body) => {
    seen.push(body.id);
    if (body.row === 'b') throw Object.assign(new Error('data_in_viitor'), { status: 400 });
  });
  assert.deepEqual([r.sent, r.rejected.map((x) => x.item.body.row), r.left], [2, ['b'], 0]);
  assert.deepEqual(seen, [items[1].id, items[1].id, items[0].id, items[2].id]);
  assert.deepEqual(await store.all(), []);
  // a 401 keeps the queue for after the next login
  const again = memoryStore([makeItem({ row: 'a' })]);
  r = await flush(again, async () => { throw Object.assign(new Error('neautorizat'), { status: 401 }); });
  assert.deepEqual([r.left, (await again.all()).length], [1, 1]);
});

test('outbox: firstWorking falls back for good once the first store throws', async () => {
  const fail = async () => { throw new Error('idb'); };
  const spare = memoryStore();
  const s = firstWorking({ all: fail, put: fail, remove: fail }, spare);
  const it = makeItem({ row: 'a' });
  await s.put(it);
  assert.deepEqual(await s.all(), [it]);
  await s.remove(it.id);
  assert.deepEqual(await spare.all(), []);
});
