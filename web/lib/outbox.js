// The logbook's waiting list: entries made on the phone that the server has not confirmed yet.
// The logic is pure and works over a small async store { all, put, remove }; idbStore() is the browser's.

const VALID_ID = /^[a-z0-9-]{8,64}$/; // what POST /api/registru/entries accepts as a client-made id

// crypto.randomUUID needs a secure context; the fallback builds the same shape from random bytes.
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// One waiting entry. The id is made once, here, and travels in the body: the server stores the entry
// under it, so sending the same item again (after a lost answer) cannot add it twice.
export function makeItem(body, { id = newId(), now = Date.now() } = {}) {
  return { id, body: { ...body, id }, createdAt: now };
}

// Items from the old localStorage outbox keep their id when the server would accept it, else get a new one.
export const adopt = (old) => (Array.isArray(old) ? old : []).filter((it) => it?.body).map((it) => makeItem(it.body, { id: VALID_ID.test(it.id) ? it.id : undefined, now: it.createdAt }));

// Sends what waits, oldest first. post(body) resolves when the server stored (or already had) the entry.
// An error without a status (no network) or a 401 stops the run and keeps everything that is left.
// Any other answer is the server refusing that entry: it is dropped and reported.
export async function flush(store, post) {
  const items = (await store.all()).sort((a, b) => a.createdAt - b.createdAt);
  const out = { sent: 0, rejected: [], left: 0 };
  for (const [i, item] of items.entries()) {
    try {
      await post(item.body);
      out.sent++;
    } catch (error) {
      if (!error?.status || error.status === 401) {
        out.left = items.length - i;
        break;
      }
      out.rejected.push({ item, error });
    }
    await store.remove(item.id);
  }
  return out;
}

// A store in memory: for the tests.
export function memoryStore(items = []) {
  const map = new Map(items.map((it) => [it.id, it]));
  return { all: async () => [...map.values()], put: async (it) => void map.set(it.id, it), remove: async (id) => void map.delete(id) };
}

// The same three calls over IndexedDB (database "rokhan", object store "outbox", key "id").
export function idbStore(name = 'rokhan', storeName = 'outbox') {
  let opened;
  const db = () => (opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  };
  return { all: () => run('readonly', (s) => s.getAll()), put: (item) => run('readwrite', (s) => s.put(item)), remove: (id) => run('readwrite', (s) => s.delete(id)) };
}

// Uses the first store until it throws once (IndexedDB refused, as some private windows do), then the second.
export function firstWorking(primary, fallback) {
  let use = primary;
  const call = (op) => async (arg) => {
    try {
      return await use[op](arg);
    } catch (e) {
      if (use === fallback) throw e;
      use = fallback;
      return fallback[op](arg);
    }
  };
  return { all: call('all'), put: call('put'), remove: call('remove') };
}
