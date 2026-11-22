// web/sw.js push and notificationclick handlers, run in a vm with a fake service worker scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'sw.js'), 'utf8');

function load({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { claim: async () => {} },
  };
  const ctx = vm.createContext({
    self, URL, location: { origin: 'http://localhost:8798' }, caches: {}, console,
    clients: { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); } },
  });
  vm.runInContext(SRC, ctx);
  return { handlers, shown, opened };
}
const event = (extra) => { const e = { waitUntil: (p) => { e.done = p; }, ...extra }; return e; };

test('push: the payload becomes a notification with icon, badge and the address to open', async () => {
  const { handlers, shown } = load();
  const e = event({ data: { json: () => ({ title: 'Lectura de azi', body: 'Preeclampsia: x (cam 7 minute)', url: '/#/lecturi' }) } });
  handlers.push(e);
  await e.done;
  assert.equal(shown[0].title, 'Lectura de azi');
  assert.deepEqual(JSON.parse(JSON.stringify(shown[0].options)), { body: 'Preeclampsia: x (cam 7 minute)', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/#/lecturi' } });
});

test('push: an empty or broken payload still shows a notification (the browser requires one); a foreign address is not kept', async () => {
  const a = load();
  const e1 = event({ data: null });
  a.handlers.push(e1);
  await e1.done;
  assert.equal(a.shown[0].title, 'Rokhan');
  assert.equal(a.shown[0].options.data.url, '/');
  const e2 = event({ data: { json: () => { throw new Error('not json'); }, text: () => 'salut' } });
  a.handlers.push(e2);
  await e2.done;
  assert.deepEqual([a.shown[1].title, a.shown[1].options.body], ['Rokhan', 'salut']);
  for (const url of ['//evil.example/x', 'https://evil.example/x']) {
    const e = event({ data: { json: () => ({ title: 't', url }) } });
    a.handlers.push(e);
    await e.done;
    assert.equal(a.shown.at(-1).options.data.url, '/');
  }
});

test('click: closes the notification, focuses an open window of the app and navigates it', async () => {
  const calls = [];
  const win = { url: 'http://localhost:8798/#/registru', focus: async () => calls.push('focus'), navigate: async (u) => calls.push(`navigate ${u}`) };
  const other = { url: 'http://evil.example/', focus: async () => calls.push('wrong'), navigate: async () => calls.push('wrong') };
  const { handlers, opened } = load({ windows: [other, win] });
  let closed = false;
  const e = event({ notification: { close: () => { closed = true; }, data: { url: '/#/lecturi' } } });
  handlers.notificationclick(e);
  await e.done;
  assert.equal(closed, true);
  assert.deepEqual(calls, ['focus', 'navigate /#/lecturi']);
  assert.deepEqual(opened, []);
});

test('click: no window open, or one that cannot navigate: a new window opens at the address', async () => {
  const none = load();
  const e1 = event({ notification: { close() {}, data: { url: '/#/lecturi' } } });
  none.handlers.notificationclick(e1);
  await e1.done;
  assert.deepEqual(none.opened, ['/#/lecturi']);
  const stuck = load({ windows: [{ url: 'http://localhost:8798/', focus: async () => {}, navigate: async () => { throw new Error('no'); } }] });
  const e2 = event({ notification: { close() {}, data: {} } });
  stuck.handlers.notificationclick(e2);
  await e2.done;
  assert.deepEqual(stuck.opened, ['/']);
});
