import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, readSse } from './core-helpers.mjs';

// Review finding 4: the server, not the model, records which write tools ran in a turn.
test('the assistant message carries `writes`, in the stream and in the stored conversation', async () => {
  const s = await boot();
  try {
    await s.login();
    const conv = (await s.api('POST', '/api/conversations')).json;
    const send = async (text) => {
      const res = await fetch(`${s.url}/api/conversations/${conv.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie }, body: JSON.stringify({ text }) });
      return (await readSse(res)).find((e) => e.event === 'done').data.message;
    };
    assert.deepEqual((await send('Notez o cezariană de azi')).writes, ['registru:adauga']);
    assert.deepEqual((await send('ce e un chist?')).writes, []);
    assert.deepEqual((await send('dă-mi o eroare')).writes, []); // a failed turn still has the field
    const stored = (await s.api('GET', `/api/conversations/${conv.id}`)).json.messages.filter((m) => m.role === 'assistant');
    assert.deepEqual(stored.map((m) => m.writes), [['registru:adauga'], [], []]);
    assert.ok(stored.every((m) => !('sdkSessionId' in m)));
  } finally {
    await s.close();
  }
});
