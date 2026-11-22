import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openSse } from '../http/router.mjs';
import { getConversations, summaryOf } from '../store/conversations.mjs';
import { getAgent } from '../store/deps.mjs';
import { httpError } from '../store/files.mjs';
import { containsCnp } from '../store/cnp.mjs';
import { getPush } from '../store/push.mjs';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// convId -> { controller, listeners: Set<sse>, stopped }. Turns outlive the request that started them.
const running = new Map();

export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Decodes and checks every image before anything is written.
function decodeImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpError(400, 'imagini_invalide');
  if (list.length > MAX_IMAGES) throw httpError(400, 'prea_multe_imagini');
  return list.map((img) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(img?.dataUrl ?? '');
    if (!m) throw httpError(400, 'imagine_invalida');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw httpError(400, 'imagine_prea_mare');
    const mime = sniffImage(buf);
    if (!mime) throw httpError(400, 'imagine_invalida');
    return { buf, mime };
  });
}

const publicConv = ({ sdkSessionId, ...rest }) => rest;

export default function register(app) {
  const { config } = app;
  const conversations = getConversations(config);
  const uploadsDir = path.join(config.dataDir, 'uploads');
  const mustGet = (id) => conversations.get(id) ?? (() => { throw httpError(404, 'negasit'); })();

  app.get('/api/conversations', async () => conversations.list());
  app.post('/api/conversations', async () => publicConv(conversations.create()));
  app.get('/api/conversations/:id', async (c) => {
    const conv = mustGet(c.params.id);
    const { preview, ...head } = summaryOf(conv);
    return { ...head, messages: conv.messages };
  });
  app.delete('/api/conversations/:id', async (c) => {
    const conv = mustGet(c.params.id);
    stop(c.params.id);
    const removed = conversations.remove(c.params.id);
    // The Agent SDK keeps its own transcript of the conversation; it goes too. Best effort: the delete already succeeded.
    if (conv.sdkSessionId) {
      try {
        await (await getAgent(config)).forgetSession?.(conv.sdkSessionId);
      } catch (err) {
        console.error('[rokhan] forgetSession:', err);
      }
    }
    return removed;
  });
  app.post('/api/conversations/:id/stop', async (c) => {
    mustGet(c.params.id);
    return { ok: true, running: stop(c.params.id) };
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const conv = mustGet(c.params.id);
    if (running.has(conv.id)) throw httpError(409, 'in_lucru');
    const body = c.body ?? {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > 20000) throw httpError(400, 'text_prea_lung');
    const decoded = decodeImages(body.images);
    if (!text && !decoded.length) throw httpError(400, 'mesaj_gol');
    if (containsCnp(text)) throw httpError(422, 'cnp'); // a patient's personal code: nothing is stored, no turn starts

    // Claim the slot before the first await so a parallel post gets 409.
    const turn = { controller: new AbortController(), listeners: new Set(), stopped: false };
    running.set(conv.id, turn);
    try {
      const before = { id: conv.id, sdkSessionId: conv.sdkSessionId ?? null, messages: [...conv.messages] };
      const images = decoded.map(({ buf, mime }) => {
        const id = crypto.randomBytes(12).toString('hex');
        const file = path.join(uploadsDir, conv.id, `${id}.${EXT[mime]}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        return { id, url: `/api/uploads/${conv.id}/${id}`, path: file, mime };
      });
      const now = Date.now();
      const userMessage = {
        id: crypto.randomUUID(), role: 'user', text,
        images: images.map(({ id, url }) => ({ id, url })),
        ts: now, urgent: !!body.urgent, state: 'ok', error: null,
      };
      conv.messages.push(userMessage);
      if (!conv.title) conv.title = (text || 'Imagine').slice(0, 60);
      conv.pending = true;
      conv.updatedAt = now;
      conversations.save(conv);

      const assistantMessageId = crypto.randomUUID();
      const sse = openSse(c.res);
      turn.listeners.add(sse);
      c.res.on('close', () => turn.listeners.delete(sse));
      sse.send('start', { userMessage, assistantMessageId });

      runDetached({ turn, before, text, urgent: !!body.urgent, images: images.map(({ path: p, mime }) => ({ path: p, mime })), assistantMessageId });
    } catch (err) {
      running.delete(conv.id);
      throw err;
    }
  }, { bodyLimit: 25 * 1024 * 1024 });

  function stop(id) {
    const turn = running.get(id);
    if (!turn) return false;
    turn.stopped = true;
    turn.controller.abort();
    return true;
  }

  // Best effort: a failure is logged and changes nothing else.
  async function notifyReady() {
    try {
      const push = getPush(config);
      const st = push.state();
      if (!push.configured() || !st.abonamente.length || !st.setari.raspuns) return;
      await push.sendAll({ title: 'Rokhan a răspuns', body: 'Răspunsul la întrebarea ta e gata.', url: '/#/intreaba' }, (e) => console.warn(`[rokhan] push raspuns: ${e?.statusCode ?? ''} ${e?.message ?? e}`));
    } catch (e) {
      console.warn(`[rokhan] push raspuns: ${e?.message ?? e}`);
    }
  }

  async function runDetached({ turn, before, text, urgent, images, assistantMessageId }) {
    const broadcast = (event, data) => turn.listeners.forEach((l) => l.send(event, data));
    let shown = '';
    const emit = (event, data) => {
      if (event === 'delta') shown += data?.text ?? '';
      if (event === 'clear') shown = '';
      broadcast(event, data);
    };
    let result;
    try {
      const agent = await getAgent(config);
      result = await agent.runTurn({ conversation: before, text, images, urgent, signal: turn.controller.signal, emit });
    } catch (err) {
      console.error('[rokhan] runTurn:', err);
      result = { text: shown, error: { code: 'intern', message: 'Eroare internă. Încearcă din nou.', resetAt: null } };
    }
    let error = result?.error ?? null;
    if (turn.stopped) error = { code: 'oprit', message: 'Oprit.', resetAt: null };
    const state = !error ? 'ok' : error.code === 'oprit' ? 'oprit' : 'error';
    const message = {
      id: assistantMessageId, role: 'assistant',
      text: state === 'ok' ? (result.text ?? shown) : (shown || result?.text || ''),
      images: [], ts: Date.now(), urgent: false, state,
      error: error ? { code: error.code, message: error.message ?? '', resetAt: error.resetAt ?? null } : null,
      // What the turn changed, recorded by the server and not by the model: memorie:<pagina>, registru:adauga | modifica | sterge.
      writes: Array.isArray(result?.writes) ? result.writes : [],
    };
    let orphanSession = null;
    try {
      const conv = conversations.get(before.id); // may have been deleted meanwhile
      if (conv) {
        conv.messages.push(message);
        if (result?.sdkSessionId) conv.sdkSessionId = result.sdkSessionId;
        conv.pending = false;
        conv.updatedAt = message.ts;
        conversations.save(conv);
      } else orphanSession = result?.sdkSessionId ?? null; // deleted while the turn ran: its SDK transcript goes too
    } catch (err) {
      console.error('[rokhan] saving the answer:', err);
    } finally {
      running.delete(before.id);
    }
    // She left the app while the turn ran: tell her the answer is there. Never the text itself: it shows on the lock screen.
    if (!turn.listeners.size && state !== 'oprit') notifyReady();
    if (message.error) broadcast('error', message.error);
    broadcast('done', { message });
    turn.listeners.forEach((l) => l.close());
    if (orphanSession) {
      try {
        await (await getAgent(config)).forgetSession?.(orphanSession);
      } catch (err) {
        console.error('[rokhan] forgetSession:', err);
      }
    }
  }
}
