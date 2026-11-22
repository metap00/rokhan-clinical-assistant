import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, httpError } from './files.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const DELETED_IMPORTED = 'imported-deleted.json'; // in the data directory
export const INTERRUPTED = 'Răspunsul a fost întrerupt. Trimite din nou.';

const instances = new Map();

export function getConversations(config) {
  if (!instances.has(config.dataDir)) instances.set(config.dataDir, createConversations(config));
  return instances.get(config.dataDir);
}

export function summaryOf(conv) {
  const last = conv.messages.at(-1);
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pending: !!conv.pending,
    imported: !!conv.imported,
    preview: (last?.text ?? '').slice(0, 80),
  };
}

function createConversations(config) {
  const dir = path.join(config.dataDir, 'conversations');
  const fileOf = (id) => path.join(dir, id + '.json');

  function all() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return files.map((f) => readJson(path.join(dir, f), null)).filter(Boolean);
  }

  function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return readJson(fileOf(id), null);
  }

  function save(conv) {
    if (!ID_RE.test(conv?.id ?? '')) throw httpError(400, 'id_invalid');
    writeJsonAtomic(fileOf(conv.id), conv);
    return conv;
  }

  return {
    list: () => all().map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt),
    get,
    save,
    exists: (id) => ID_RE.test(id) && fs.existsSync(fileOf(id)),
    create() {
      const now = Date.now();
      return save({ id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now, pending: false, imported: false, sdkSessionId: null, messages: [] });
    },
    remove(id) {
      const conv = get(id);
      if (!conv) throw httpError(404, 'negasit');
      if (conv.imported) {
        // The importer reads this list so a re-run does not bring the conversation back.
        const file = path.join(config.dataDir, DELETED_IMPORTED);
        writeJsonAtomic(file, [...new Set([...readJson(file, []), id])]);
      }
      fs.rmSync(fileOf(id), { force: true });
      fs.rmSync(path.join(config.dataDir, 'uploads', id), { recursive: true, force: true });
      return { ok: true };
    },
    // Every message since tsMs, oldest first, tagged with its conversation.
    messagesSince(tsMs) {
      return all()
        .flatMap((c) => c.messages.filter((m) => m.ts >= tsMs).map((m) => ({ ...m, conversationId: c.id })))
        .sort((a, b) => a.ts - b.ts);
    },
    // Startup: a turn cannot survive a restart, so close any that was still running.
    recoverInterrupted() {
      let n = 0;
      for (const conv of all()) {
        if (!conv.pending) continue;
        conv.messages.push({
          id: crypto.randomUUID(), role: 'assistant', text: '', images: [], ts: Date.now(), urgent: false,
          state: 'error', error: { code: 'intern', message: INTERRUPTED, resetAt: null },
        });
        conv.pending = false;
        conv.updatedAt = Date.now();
        save(conv);
        n++;
      }
      return n;
    },
  };
}
