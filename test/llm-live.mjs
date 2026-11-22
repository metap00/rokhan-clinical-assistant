// Live checks of the assistant against the real model and the real internet. Not part of `npm test`.
//   node test/llm-live.mjs [tools] [turn] [resume] [stale] [image] [job] [fetch] [--model claude-haiku-5-5] [--effort low] [--record]
// Only on request: lesson, reflect, forget, search, purge, chain, narrate.
// No step names = all steps. Uses the real services on ./data, which must be a COPY of the real data (the tools step writes to it).
// --record writes the first turn's SDK messages, reduced, to test/fixtures/llm/stream-tool-turn.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgent } from '../server/llm/agent.mjs';
import { createFetcher } from '../server/llm/fetch-url.mjs';
import { createTools } from '../server/llm/tools.mjs';
import { getDeps } from '../server/store/deps.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const steps = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(model|effort|unit)$/));
const want = (s) => !steps.length || steps.includes(s);
const root = path.resolve(import.meta.dirname, '..');
const config = { dataDir: path.join(root, 'data'), model: flag('model', 'claude-haiku-5-5'), effort: flag('effort', 'low'), tz: 'Europe/Bucharest' };
const deps = await getDeps(config);

const recorded = [];
const queryFn = (params) => {
  const it = query(params);
  return (async function* () { for await (const m of it) { recorded.push(m); yield m; } })();
};
const agent = createAgent({ config, deps, queryFn });

// Keeps what the stream mapper and the error mapping read; drops paths, uuids, signatures and usage detail.
const reduce = (m) => {
  if (m.type === 'system' && m.subtype === 'init') return { type: 'system', subtype: 'init', session_id: 'SESSION', model: m.model, tools: m.tools, skills: m.skills, agents: m.agents, plugins: m.plugins, mcp_servers: m.mcp_servers };
  if (m.type === 'stream_event') {
    const e = m.event;
    if (e.type === 'message_start') return { type: 'stream_event', parent_tool_use_id: m.parent_tool_use_id, event: { type: e.type, message: { id: e.message.id } } };
    if (e.type === 'content_block_start') return { type: 'stream_event', parent_tool_use_id: m.parent_tool_use_id, event: { type: e.type, index: e.index, content_block: { type: e.content_block.type, name: e.content_block.name } } };
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') return { type: 'stream_event', parent_tool_use_id: m.parent_tool_use_id, event: { type: e.type, index: e.index, delta: e.delta } };
    if (e.type === 'content_block_delta') return null; // thinking, signature and tool-input deltas: the mapper ignores them
    return { type: 'stream_event', parent_tool_use_id: m.parent_tool_use_id, event: { type: e.type } };
  }
  if (m.type === 'assistant') return { type: 'assistant', parent_tool_use_id: m.parent_tool_use_id, error: m.error, message: { id: m.message.id, content: m.message.content.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: b.type, name: b.name })) } };
  if (m.type === 'user') return { type: 'user', parent_tool_use_id: m.parent_tool_use_id };
  if (m.type === 'rate_limit_event') return { type: m.type, rate_limit_info: m.rate_limit_info };
  if (m.type === 'result') return { type: 'result', subtype: m.subtype, is_error: m.is_error, result: m.result, session_id: 'SESSION', num_turns: m.num_turns, usage: { input_tokens: m.usage?.input_tokens, output_tokens: m.usage?.output_tokens } };
  return { type: m.type, subtype: m.subtype };
};

async function turn(label, input) {
  console.log(`\n=== ${label} ===`);
  const events = [];
  recorded.length = 0;
  const t0 = Date.now();
  const r = await agent.runTurn({ ...input, emit: (event, data) => events.push([event, data]) });
  const compact = [];
  for (const [event, data] of events) {
    if (event === 'delta' && compact.at(-1)?.[0] === 'delta') compact.at(-1)[1] += data.text.length;
    else compact.push(event === 'delta' ? ['delta', data.text.length] : [event, data.label ?? '']);
  }
  console.log('events:', compact.map(([e, d]) => (e === 'delta' ? `delta(${d} chars)` : e === 'clear' ? 'clear' : `status(${d})`)).join(' → '));
  console.log('message types:', [...new Set(recorded.map((m) => (m.type === 'system' ? `system/${m.subtype}` : m.type === 'stream_event' ? `stream_event/${m.event.type}${m.event.delta ? `/${m.event.delta.type}` : ''}` : m.type)))].join(', '));
  console.log(`result: ${Date.now() - t0} ms, session=${r.sdkSessionId}, usage=${JSON.stringify(r.usage)}, error=${JSON.stringify(r.error)}`);
  console.log(`text (${r.text.length} chars):\n${r.text}`);
  return r;
}

const png = () => { // a 64x64 solid red PNG, no fixture file needed
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 0).map((_, i) => (i % 3 === 0 ? 220 : 20))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(64).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
};

let conversation = { id: 'live', sdkSessionId: null, messages: [] };

if (want('tools')) { // every tool once against the real modules, no model
  const tools = Object.fromEntries(createTools({ config, deps, fetchUrl: createFetcher({ dataDir: config.dataDir }) }).map((t) => [t.name, t]));
  const call = async (name, input, show = 700) => {
    try {
      const out = await tools[name].run(input);
      console.log(`\n--- ${name}(${JSON.stringify(input)}) -> ${out.length} chars\n${out.slice(0, show)}${out.length > show ? '\n[…]' : ''}`);
      return out;
    } catch (e) {
      console.log(`\n--- ${name}(${JSON.stringify(input)}) -> ERROR ${e.message}`);
      return '';
    }
  };
  await call('ghid_cuprins', {}, 400);
  await call('ghid_cuprins', { ghid: 10 }, 1500);
  await call('ghid_cuprins', { ghid: 'curriculum' }, 500);
  await call('ghid_cuprins', { ghid: 77 });
  await call('ghid_citeste', { fisier: 'ghiduri-sogr/10-placenta-praevia.md', de_la: 439, pana_la: 700 }, 300);
  await call('ghid_citeste', { fisier: 'library/ghiduri-sogr/actualizari/10-placenta-praevia.md', de_la: 16, pana_la: 22 }, 400);
  await call('ghid_citeste', { fisier: 'ghiduri-sogr/lecturi/13-4.md', de_la: 1, pana_la: 6 }, 400);
  await call('ghid_citeste', { fisier: '../registru.json', de_la: 1 });
  await call('ghid_citeste', { fisier: 'ghiduri-sogr/10-placenta-praevia.md', de_la: 99999 });
  await call('biblioteca_cauta', { intrebare: 'doza oxitocina travaliu', limita: 3 }, 1200);
  await call('biblioteca_cauta', { intrebare: 'cezariene barem', ghid: 'curriculum', limita: 2 }, 800);
  await call('biblioteca_cauta', { intrebare: 'zzzqqq' });
  await call('memorie_citeste', {});
  await call('memorie_citeste', { pagina: 'profil' }, 200);
  await call('memorie_citeste', { pagina: 'subiect-nu-exista' });
  await call('memorie_scrie', { pagina: 'subiect-test-unelte', continut: '# Test\n\nPagină scrisă de test/llm-live.mjs.' });
  await call('memorie_citeste', { pagina: 'subiect-test-unelte' });
  fs.rmSync(path.join(config.dataDir, 'memory', 'subiect-test-unelte.md'), { force: true });
  await call('memorie_scrie', { pagina: 'altceva', continut: 'x' });
  await call('registru_stare', {}, 1600);
  const added = await call('registru_adauga', { procedura: 'nastere vaginala', numar: 2, copii: 3 });
  const id = /Adăugat: (\S+)/.exec(added)?.[1];
  await call('registru_modifica', { id, rol: 'ajutat' });
  await call('registru_modifica', { id, rol: 'efectuat', numar: 1 });
  await call('registru_sterge', { id });
  await call('registru_adauga', { procedura: 'Cezariană', data: '2031-01-01' });
  await call('registru_sterge', { id: 'nu-exista' });
  await call('lecturi_stare', {}, 900);
  await call('deschide_url', { url: 'https://www.nice.org.uk/guidance/ng133/chapter/Recommendations', max_caractere: 300 }, 500);
  await call('deschide_url', { url: 'http://127.0.0.1:8787/api/stare' });
}

if (want('turn')) {
  const text = 'care e antidotul la sulfatul de magneziu si in ce doza? uita-te in ghidul SOGR de hipertensiune';
  const r = await turn('turn with tools', { conversation, text });
  const init = recorded.find((m) => m.type === 'system' && m.subtype === 'init');
  console.log('init:', JSON.stringify({ tools: init?.tools, skills: init?.skills, agents: init?.agents, plugins: init?.plugins, mcp_servers: init?.mcp_servers, slash_commands: init?.slash_commands?.length }));
  console.log('rate limit events:', JSON.stringify(recorded.filter((m) => m.type === 'rate_limit_event').map((m) => m.rate_limit_info)));
  const toolResult = recorded.find((m) => m.type === 'user')?.message?.content?.[0];
  console.log('tool result block shape:', JSON.stringify(toolResult)?.slice(0, 300));
  if (args.includes('--record')) {
    const file = path.join(root, 'test', 'fixtures', 'llm', 'stream-tool-turn.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ note: 'SDK messages of one real turn with tool calls, reduced by test/llm-live.mjs --record', expectedText: r.text, messages: recorded.map(reduce).filter(Boolean) })}\n`);
    console.log('recorded', file);
  }
  conversation = { ...conversation, sdkSessionId: r.sdkSessionId, messages: [{ role: 'user', text }, { role: 'assistant', text: r.text }] };
}

if (want('resume')) {
  if (!conversation.sdkSessionId) conversation.sdkSessionId = (await turn('first turn for resume', { conversation, text: 'Ține minte cuvântul: mandragoră. Răspunde doar „Notat.”' })).sdkSessionId;
  const r = await turn('second turn (resume)', { conversation, text: want('turn') ? 'si la ce boala nu il dau deloc? (raspunde din ce ai citit deja, fara alte cautari)' : 'Ce cuvânt ți-am spus să ții minte?' });
  console.log('same session id:', r.sdkSessionId === conversation.sdkSessionId);
}

if (want('stale')) {
  const stale = { id: 'stale', sdkSessionId: '00000000-0000-4000-8000-000000000000', messages: [{ role: 'user', text: 'Cuvântul zilei este „mandragoră”.' }, { role: 'assistant', text: 'Am reținut.' }] };
  await turn('stale session id (falls back to a fresh session with the transcript)', { conversation: stale, text: 'Care era cuvântul zilei? Răspunde într-un cuvânt.' });
}

if (steps.includes('lesson')) { // only on request: the scheduler's lesson writer, once, for one unit (default 15-2)
  const { writeNextLesson, WRITER_MODEL } = await import('../server/jobs/scheduler.mjs');
  const unitId = flag('unit', '15-2');
  console.log(`\n=== lesson writer: ${unitId} (${WRITER_MODEL}, effort medium) ===`);
  console.log('request:', JSON.stringify(deps.lessons.requestGenerate(unitId)), '| nextMissing ->', deps.lessons.nextMissing(3)?.id);
  const rounds = [];
  const lessons = new Proxy(deps.lessons, { get: (t, p) => (p === 'validate' ? (id, l) => { const v = t.validate(id, l); rounds.at(-1).errors = v.errors; rounds.at(-1).warnings = v.warnings; return v; } : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) });
  const timed = { runJob: async (job) => { const t0 = Date.now(); const r = await agent.runJob(job); rounds.push({ seconds: Math.round((Date.now() - t0) / 1000), promptChars: job.prompt.length, answerChars: r.text.length, error: r.error?.code ?? null, errors: [], warnings: [] }); return r; } };
  const t0 = Date.now();
  const result = await writeNextLesson({ deps: { ...deps, lessons }, agent: timed });
  console.log('result:', JSON.stringify(result), `| total ${Math.round((Date.now() - t0) / 1000)} s`);
  rounds.forEach((r, i) => console.log(`round ${i + 1}: ${r.seconds} s, prompt ${r.promptChars} chars, answer ${r.answerChars} chars, model error ${r.error}, validator errors ${r.errors.length}, warnings ${r.warnings.length}\n${r.errors.map((e) => `  - ${e}`).join('\n')}`));
  try {
    const l = deps.lessons.get(unitId);
    console.log(`lessons.get('${unitId}') -> "${l.titlu}", ${l.minute} min, ${l.sectiuni.length} sections, ${l.sectiuni.reduce((a, s) => a + s.carduri.length, 0)} cards, ${l.cifre.length} figures, ${l.perle.length} pearls, ${l.quiz.length} quiz questions`);
  } catch (e) {
    console.log(`lessons.get('${unitId}') -> ERROR ${e.message}`);
  }
}

if (steps.includes('reflect')) { // only on request: the nightly reflection, once, on invented messages from "today"
  const { runReflection, REFLECTION_MODEL } = await import('../server/jobs/scheduler.mjs');
  console.log(`\n=== reflection (${REFLECTION_MODEL}, effort medium) ===`);
  const now = Date.now();
  const say = (role, text, i) => ({ id: `t${i}`, role, text, images: [], ts: now - (6 - i) * 60_000, urgent: false, state: 'ok', error: null });
  const invented = [
    say('user', 'de luni incep rotatia pe sala de nasteri, 3 luni. am examen de modul pe 15 ianuarie', 1),
    say('assistant', 'Am notat: sala de nașteri de luni, trei luni, și examenul de modul pe 15 ianuarie.', 2),
    say('user', 'fa mi un quiz din distocia de umeri, cate o intrebare', 3),
    say('assistant', 'Prima întrebare: care e prima manevră în distocia de umeri?', 4),
    say('user', 'rubin? nu mai stiu ordinea manevrelor. si te rog raspunsurile la quiz mai scurte, doar ce e gresit si de ce', 5),
  ];
  // Only the invented messages reach the job, whatever the data copy holds for today.
  const only = { ...deps, conversations: { ...deps.conversations, messagesSince: () => invented } };
  const before = Object.fromEntries(['profil', 'jurnal-de-studiu'].map((p) => { try { return [p, deps.memorie.read(p).markdown]; } catch { return [p, '']; } }));
  const t0 = Date.now();
  const r = await runReflection({ config, deps: only, agent });
  console.log('result:', JSON.stringify(r), `| ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const p of Object.keys(before)) {
    let after = '';
    try { after = deps.memorie.read(p).markdown; } catch { /* still missing */ }
    const a = before[p].split('\n');
    const b = after.split('\n');
    console.log(`\n--- ${p}: ${before[p].length} -> ${after.length} chars`);
    for (const line of a.filter((l) => l.trim() && !b.includes(l))) console.log(`- ${line}`);
    for (const line of b.filter((l) => l.trim() && !a.includes(l))) console.log(`+ ${line}`);
  }
}

if (steps.includes('forget')) { // only on request: one real turn, then forgetSession must remove its transcript
  const r = await turn('one turn to create a session', { conversation: { id: 'forget', sdkSessionId: null, messages: [] }, text: 'Spune doar: salut.' });
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
  const dir = path.join(config.dataDir, 'agent-cwd');
  console.log('session exists before:', Boolean(await getSessionInfo(r.sdkSessionId, { dir })));
  console.log('forgetSession ->', await agent.forgetSession(r.sdkSessionId));
  console.log('session exists after:', Boolean(await getSessionInfo(r.sdkSessionId, { dir })));
  console.log('forgetSession again ->', await agent.forgetSession(r.sdkSessionId));
}

if (steps.includes('search')) { // only on request: a web search, then opening a result that is not one of the known sources
  const tail = () => { try { return fs.readFileSync(path.join(config.dataDir, 'logs', 'fetch.log'), 'utf8').trimEnd().split('\n'); } catch { return []; } };
  const before = tail().length;
  const show = (r) => {
    for (const m of recorded) {
      if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') console.log(`tool call: ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`);
      if (m.type === 'user' && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === 'tool_result') console.log(`tool result (${typeof b.content === 'string' ? 'string' : `blocks: ${b.content?.map((c) => c.type).join(',')}`})${b.is_error ? ' ERROR' : ''}: ${JSON.stringify(b.content).slice(0, 400)}`);
    }
    console.log('hook messages:', recorded.filter((m) => m.type === 'system' && /^hook_/.test(m.subtype ?? '')).length, '| writes:', JSON.stringify(r.writes));
  };
  let conv = { id: 'search', sdkSessionId: null, messages: [] };
  const ask = async (label, text) => {
    const r = await turn(label, { conversation: conv, text });
    show(r);
    conv = { ...conv, sdkSessionId: r.sdkSessionId, messages: [...conv.messages, { role: 'user', text }, { role: 'assistant', text: r.text }] };
  };
  await ask('search, then open a result', 'Test tehnic de la administrator: caută cu WebSearch articolul Wikipedia în engleză despre „Bishop score”, deschide pagina găsită cu deschide_url și spune-mi într-o propoziție care e scorul maxim.');
  await ask('an address the model builds itself', 'Test tehnic de la administrator: acum cheamă direct deschide_url pe adresa articolului Wikipedia în engleză despre „Apgar score”, construind tu adresa, fără nicio căutare înainte. Dacă e refuzată, fă ce îți spune mesajul de refuz. Spune-mi apoi exact ce s-a întâmplat la fiecare pas.');
  console.log('\nfetch.log lines of this step:\n' + tail().slice(before).join('\n'));
  await agent.forgetSession(conv.sdkSessionId);
}

if (steps.includes('purge')) { // only on request: purgeSessions against the real SDK, in a data directory of its own
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-purge-'));
  const own = createAgent({ config: { ...config, dataDir: tmp }, deps, queryFn });
  const main = path.join(config.dataDir, 'agent-cwd');
  const count = async (dir) => (await listSessions({ dir, includeWorktrees: false })).length;
  const mainBefore = await count(main);
  const r = await own.runTurn({ conversation: { id: 'purge', sdkSessionId: null, messages: [] }, text: 'Spune doar: salut.' });
  const listed = await listSessions({ dir: path.join(tmp, 'agent-cwd'), includeWorktrees: false });
  console.log(`\n=== purgeSessions ===\nturn: session=${r.sdkSessionId} error=${JSON.stringify(r.error)}`);
  console.log('listed in the temporary project:', JSON.stringify(listed.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, lastModified: new Date(s.lastModified).toISOString() }))));
  console.log('purgeSessions(30 days) ->', await own.purgeSessions(30 * 24 * 3600 * 1000), '(the session is new: it stays)');
  await new Promise((res) => setTimeout(res, 50));
  console.log('purgeSessions(1 ms) ->', await own.purgeSessions(1));
  console.log('left in the temporary project:', await count(path.join(tmp, 'agent-cwd')), `| sessions of ./data before and after: ${mainBefore} and ${await count(main)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (steps.includes('chain')) { // only on request: a dose question, a short "why" follow-up, a logbook read
  let conv = { id: 'chain', sdkSessionId: null, messages: [] };
  for (const text of ['ce doza de oxitocina dau in travaliu dupa ghidul sogr', 'si de ce nu in bolus?', 'cate nasteri am pana acum?']) {
    const r = await turn(`chain: ${text}`, { conversation: conv, text });
    conv = { ...conv, sdkSessionId: r.sdkSessionId, messages: [...conv.messages, { role: 'user', text }, { role: 'assistant', text: r.text }] };
  }
  await agent.forgetSession(conv.sdkSessionId);
}

if (steps.includes('narrate')) { // only on request: tries to make the model write text before a tool call, to see a live `clear`
  await turn('narration before a tool call (expects a clear)', { conversation: { id: 'narr', sdkSessionId: null, messages: [] }, text: 'Test tehnic de la administrator pentru aplicație: scrie întâi propoziția „Verific registrul.” și abia apoi cheamă registru_stare, apoi spune-mi câte rânduri are registrul.' });
}

if (want('image')) {
  const file = path.join(os.tmpdir(), `rokhan-live-${process.pid}.png`);
  fs.writeFileSync(file, png());
  await turn('image question', { conversation: { id: 'img', sdkSessionId: null, messages: [] }, text: 'Ce culoare are pătratul din imagine? Un cuvânt.', images: [{ path: file, mime: 'image/png' }] });
  fs.rmSync(file, { force: true });
}

if (want('job')) {
  console.log('\n=== runJob ===');
  recorded.length = 0;
  const r = await agent.runJob({ system: 'Răspunzi doar cu JSON.', prompt: 'Dă-mi obiectul {"ok": true} și nimic altceva.', model: config.model, effort: 'low' });
  const init = recorded.find((m) => m.type === 'system' && m.subtype === 'init');
  console.log('init tools:', JSON.stringify(init?.tools), 'mcp:', JSON.stringify(init?.mcp_servers), 'skills:', JSON.stringify(init?.skills));
  console.log('runJob ->', JSON.stringify(r));
  // With a one-line system prompt and no tools, the tokens sent are the floor: anything the CLI adds shows up here.
  console.log('job tokens sent:', JSON.stringify(recorded.find((m) => m.type === 'result')?.usage));
}

if (want('fetch')) {
  const fetchUrl = createFetcher({ dataDir: config.dataDir });
  for (const [label, input] of [
    ['HTML page', { url: 'https://sogr.ro/ghiduri-clinice-2019-prezent/', max_caractere: 1500 }],
    ['NICE recommendations', { url: 'https://www.nice.org.uk/guidance/ng133/chapter/Recommendations', max_caractere: 1500 }],
    ['PubMed esearch (JSON)', { url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=tranexamic+acid+postpartum+hemorrhage&retmode=json&retmax=3', max_caractere: 600 }],
    ['SOGR PDF, pages 14-15', { url: deps.library.guides().find((g) => g.nr === 7).url, pagini: '14-15', max_caractere: 1500 }],
  ]) {
    console.log(`\n=== deschide_url: ${label} ===\n${input.url}`);
    try {
      const t0 = Date.now();
      const r = await fetchUrl(input);
      console.log(`${Date.now() - t0} ms | kind=${r.kind} pages=${r.pages} chars=${r.chars} nextOffset=${r.nextOffset} cached=${r.cached}\n${r.text.slice(0, 900)}`);
    } catch (e) {
      console.log(`FAILED ${e.code}: ${e.message}`);
    }
  }
}
