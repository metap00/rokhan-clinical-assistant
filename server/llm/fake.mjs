import crypto from 'node:crypto';

// Stand-in for server/llm/agent.mjs: same interface, canned Romanian answers, no network.
// A user text containing "incet" streams the same answer after a 25 second pause (to test the elapsed-time label).

const ANSWER = `Pe scurt: **da**, se poate, cu monitorizare. Acesta este un răspuns de test generat de modelul fals, ca să vezi cum arată un răspuns în interfață.

La gardă: verifici întâi semnele vitale și BCF, apoi decizi. Dacă apare ceva neașteptat, anunți medicul de gardă.

| Parametru | Valoare țintă |
|---|---|
| TA | < 140/90 mmHg |
| Puls | 60–100 bpm |
| BCF | 110–160 bpm |
`;

const DRAWING = `
\`\`\`mermaid
flowchart TD
  A[Internare] --> B{Travaliu?}
  B -->|Da| C[Sala de nașteri]
  B -->|Nu| D[Monitorizare]
\`\`\`
`;

const SOURCES = '\nSurse: SOGR, Ghid de test (2026), p. 1.';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

function chunks(text, size = 12) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function createAgent({ config } = {}) {
  async function runTurn({ conversation, text = '', signal, emit = () => {} } = {}) {
    const sdkSessionId = conversation?.sdkSessionId || `fake-${crypto.randomUUID()}`;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const lower = text.toLowerCase();
    let shown = '';
    const stopped = () => ({ text: shown, sdkSessionId, usage, error: { code: 'oprit', message: 'Oprit.', resetAt: null } });

    emit('status', { label: 'Mă gândesc…' });
    await sleep(100, signal);
    if (signal?.aborted) return stopped();

    if (lower.includes('eroare')) {
      return {
        text: '', sdkSessionId, usage,
        error: { code: 'limita', message: 'Limita de utilizare a fost atinsă.', resetAt: new Date(Date.now() + 3600e3).toISOString() },
      };
    }

    if (lower.includes('narare')) {
      for (const piece of chunks('Mă uit în ghidul SOGR potrivit. ')) {
        shown += piece;
        emit('delta', { text: piece });
        await sleep(30, signal);
      }
      emit('clear', {});
      shown = '';
      emit('status', { label: 'Caut în ghiduri…' });
      await sleep(200, signal);
      if (signal?.aborted) return stopped();
    }

    if (lower.includes('incet')) {
      await sleep(25000, signal);
      if (signal?.aborted) return stopped();
    }

    const answer = ANSWER + (lower.includes('desen') ? DRAWING : '') + SOURCES;
    const parts = chunks(answer);
    const step = Math.max(5, Math.round(1500 / parts.length));
    for (const piece of parts) {
      if (signal?.aborted) return stopped();
      shown += piece;
      emit('delta', { text: piece });
      await sleep(step, signal);
    }
    if (signal?.aborted) return stopped();
    // "notez" in her text stands for a logbook entry, so the interface can show what a turn changed.
    return { text: shown, sdkSessionId, usage, error: null, writes: lower.includes('notez') ? ['registru:adauga'] : [] };
  }

  async function runJob() {
    return { text: 'Răspuns de test de la modelul fals.', error: null };
  }

  // The real agent deletes the SDK's session transcript here. The fake has none: it only remembers the ids.
  const forgotten = [];
  async function forgetSession(sdkSessionId) {
    forgotten.push(sdkSessionId);
    return false;
  }

  return { runTurn, runJob, forgetSession, forgotten, fake: true, model: config?.model };
}
