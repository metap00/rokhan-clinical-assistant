// The assistant: one user message in, one streamed answer out, through the Claude Agent SDK.
// The SDK is locked down: our own system prompt, no settings from the host, WebSearch as the only built-in tool,
// everything else through the in-process `rokhan` tools.
import fs from 'node:fs';
import path from 'node:path';
import { query, tool, createSdkMcpServer, deleteSession, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { createTools } from './tools.mjs';
import { createFetcher } from './fetch-url.mjs';
import { systemPrompt } from './prompt.mjs';
import { createProvenance } from './provenance.mjs';

export const MAX_TURNS = 40;
const THINKING = 'Mă gândesc…';
const MESSAGES = {
  limita: 'Am atins limita de utilizare.',
  auth: 'Nu sunt conectat la model. Administratorul aplicației trebuie să refacă autentificarea pe server.',
  oprit: 'Oprit.',
  intern: 'Ceva n-a mers. Mai încearcă o dată.',
};
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error']);

/** The Romanian status line for a tool call. Never a tool name. */
export function statusLabel(toolName) {
  const n = String(toolName).replace(/^mcp__rokhan__/, '');
  if (n === 'biblioteca_cauta') return 'Caut în ghiduri…';
  if (n === 'ghid_cuprins' || n === 'ghid_citeste') return 'Citesc ghidul…';
  if (n === 'WebSearch') return 'Caut pe internet…';
  if (n === 'deschide_url') return 'Deschid sursa…';
  if (n === 'registru_stare') return 'Mă uit în registru…';
  if (n.startsWith('registru_')) return 'Notez în registru…';
  if (n === 'memorie_citeste') return 'Îmi amintesc…';
  if (n.startsWith('memorie_')) return 'Îmi notez…';
  if (n === 'lecturi_stare') return 'Mă uit la lecturi…';
  return 'Lucrez…';
}

const dateParts = (now, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
const hhmm = (ms, tz) => { const p = dateParts(new Date(ms), tz); return `${p.hour}:${p.minute}`; };

/** Last messages of a stored conversation as a plain transcript, for a fresh SDK session. */
export function transcriptOf(messages = [], currentText = '') {
  let list = messages.filter((m) => m?.text?.trim() && (m.role === 'user' || m.role === 'assistant'));
  const last = list.at(-1);
  if (last?.role === 'user' && last.text === currentText) list = list.slice(0, -1); // the turn being asked right now
  return list.slice(-10).map((m) => `${m.role === 'user' ? 'Rezidenta' : 'Rokhan'}: ${m.text.trim().slice(0, 2000)}`).join('\n\n');
}

/** The text block of the user message: clock line, urgent mark, profile and transcript when given, then her text. */
export function buildUserText({ now = new Date(), tz, urgent, profil, transcript, text }) {
  const p = dateParts(now, tz);
  const weekday = new Intl.DateTimeFormat('ro-RO', { timeZone: tz, weekday: 'long' }).format(now);
  const out = [`[Acum: ${weekday}, ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}, ${tz}]`];
  if (urgent) out.push('[URGENT]');
  if (profil?.trim()) out.push(`<profil>\n${profil.trim()}\n</profil>`);
  if (transcript?.trim()) out.push(`<conversatie_anterioara>\n${transcript.trim()}\n</conversatie_anterioara>`);
  out.push(text ?? '');
  return out.join('\n');
}

/**
 * Maps SDK messages to the events the chat shows. Text deltas go out as `delta`; text that turns out to be
 * narration (a tool call follows, or another assistant message starts) is taken back with `clear`; each tool call
 * and each thinking phase sets a `status` label. `text` is what is visible at the end: the final message's text.
 */
export function createStreamMapper(emit) {
  let visible = '';
  let lastLabel = null;
  let lastAssistantId = null;
  const streamed = new Set(); // message ids that arrived as stream events
  const status = (label) => { if (label !== lastLabel) { lastLabel = label; emit('status', { label }); } };
  const clear = () => { if (visible) { visible = ''; emit('clear', {}); } };
  const text = (t) => { if (t) { visible += t; emit('delta', { text: t }); } };
  const toolStart = (name) => { clear(); status(statusLabel(name)); };
  return {
    status,
    push(msg) {
      if (msg.parent_tool_use_id) return;
      if (msg.type === 'stream_event') {
        const e = msg.event ?? {};
        if (e.type === 'message_start') { streamed.add(e.message?.id); clear(); status(THINKING); }
        else if (e.type === 'content_block_start') {
          const b = e.content_block ?? {};
          if (b.type === 'tool_use' || b.type === 'server_tool_use') toolStart(b.name);
          else if (b.type === 'thinking') status(THINKING);
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text(e.delta.text);
      } else if (msg.type === 'assistant' && !msg.error && !streamed.has(msg.message?.id)) {
        // Not streamed: partial messages are off, or the CLI fell back to a non-streaming request.
        if (msg.message?.id !== lastAssistantId) { lastAssistantId = msg.message?.id; clear(); }
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text') text(b.text);
          else if (b.type === 'tool_use' || b.type === 'server_tool_use') toolStart(b.name);
        }
      }
    },
    get text() { return visible.trim(); },
  };
}

/** Decides the error of a finished run, or null when it succeeded. Pure, so the mapping is testable. */
export function classifyError({ aborted, thrown, result, apiError, apiErrorText, rate, tz = 'Europe/Bucharest' }) {
  const make = (code, message = MESSAGES[code], resetAt = null) => ({ code, message, resetAt });
  if (aborted) return make('oprit');
  if (result && !result.is_error && result.subtype === 'success') return null;
  const blob = [result?.is_error ? result.result : '', ...(result?.errors ?? []), apiErrorText, thrown?.message].filter(Boolean).join(' | ');
  if (apiError === 'rate_limit' || rate?.status === 'rejected' || /usage limit|hit your limit|limit reached|rate.?limit/i.test(blob)) {
    const raw = Number(rate?.resetsAt ?? /\|(\d{10,13})\b/.exec(blob)?.[1]);
    if (!Number.isFinite(raw) || raw <= 0) return make('limita');
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return make('limita', `Am atins limita de utilizare. Revin după ${hhmm(ms, tz)}.`, new Date(ms).toISOString());
  }
  if (AUTH_ERRORS.has(apiError) || /not logged in|\/login|invalid api key|api key|authentication|unauthorized|oauth/i.test(blob)) return make('auth');
  return make('intern');
}

// What SDK 0.3.330 lists in init even with settingSources [], skills [] and CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1:
// two skills and three plugins that are compiled into the Claude Code binary (plugins carry path "builtin").
// They are not loaded from the host and no Skill tool exists to reach them, so the check lets exactly these
// through and refuses everything else. A new SDK version that adds another one fails loudly here, on purpose.
const CLI_BUILTIN_SKILLS = new Set(['doctor', 'plugin-authoring']);

/** Problems in the SDK's init message: anything loaded beyond WebSearch, our own tools and the CLI's built-ins. Empty = clean. */
export function checkInit(init, { tools = true } = {}) {
  const problems = [];
  const extraTools = (init.tools ?? []).filter((t) => !(tools && (t === 'WebSearch' || t.startsWith('mcp__rokhan__'))));
  if (extraTools.length) problems.push(`tools: ${extraTools.join(', ')}`);
  if (tools && !(init.tools ?? []).some((t) => t.startsWith('mcp__rokhan__'))) problems.push('the rokhan tools are missing');
  const skills = (init.skills ?? []).filter((s) => !CLI_BUILTIN_SKILLS.has(s));
  if (skills.length) problems.push(`skills: ${skills.join(', ')}`);
  const plugins = (init.plugins ?? []).filter((p) => p.path !== 'builtin');
  if (plugins.length) problems.push(`plugins: ${plugins.map((p) => p.name).join(', ')}`);
  const servers = (init.mcp_servers ?? []).filter((s) => !(tools && s.name === 'rokhan'));
  if (servers.length) problems.push(`mcp servers: ${servers.map((s) => s.name).join(', ')}`);
  // Agents are only reachable through the Agent/Task tool, which the tools check above already forbids.
  return problems;
}

const usageOf = (r) => (r ? {
  input: r.usage?.input_tokens ?? 0,
  output: r.usage?.output_tokens ?? 0,
  cacheRead: r.usage?.cache_read_input_tokens ?? 0,
  cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
  costUsd: r.total_cost_usd ?? 0,
  turns: r.num_turns ?? 0,
  durationMs: r.duration_ms ?? 0,
} : null);

let initLogged = false;

// Tools whose results may hand the model an address to open: the web page itself and the library, which the model
// cannot write. Memory and logbook results are left out on purpose: the model writes those, so it could plant an
// address there and read it back.
const LINK_SOURCES = new Set(['deschide_url', 'ghid_cuprins', 'ghid_citeste', 'biblioteca_cauta']);

const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => { const [x, y] = [realPath(a), realPath(b)]; return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; };

// What the Claude Code child process gets on top of the host's environment.
// CLAUDE_CODE_DISABLE_BUNDLED_SKILLS is not in the spec's list: without it the init message lists the
// skills that ship inside Claude Code (deep-research, code-review, ...), which the init check refuses.
const CHILD_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };

/**
 * The child's environment: the host's, without the app's own settings (ROKHAN_*, the password among them), plus
 * CHILD_ENV. Names are compared without case, because Windows keeps whatever spelling a variable was set with
 * (`Path`, not `PATH`) and a plain copy of process.env keeps it too. Every other variable passes as it is spelled.
 */
export function childEnv(env = process.env) {
  const ours = new Set(Object.keys(CHILD_ENV));
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^ROKHAN_/i.test(k) && !ours.has(k.toUpperCase()))), ...CHILD_ENV };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * createAgent({ config, deps }) -> { runTurn, runJob, forgetSession, purgeSessions }.
 * `queryFn`, `deleteFn`, `listFn`, `mcpFn`, `fetchUrl` and `now` are test seams (a fake SDK query, deleteSession and
 * listSessions, the MCP server left as a plain definition, a fake network, a fixed clock).
 */
export function createAgent({ config, deps, queryFn = query, deleteFn = deleteSession, listFn = listSessions, mcpFn = createSdkMcpServer, fetchUrl = createFetcher({ dataDir: config.dataDir }), now = () => new Date() }) {
  // The SDK names a session's folder after the working directory. The child process is given the canonical path
  // (no 8.3 short names, no symlinks), because listSessions and deleteSession resolve the path before they look.
  const workDir = () => {
    const dir = path.join(config.dataDir, 'agent-cwd');
    fs.mkdirSync(dir, { recursive: true });
    return realPath(dir);
  };
  const logFile = path.join(config.dataDir, 'logs', 'agent.log');
  const provenance = createProvenance(); // the addresses seen per conversation, for deschide_url
  const toolDefs = createTools({ config, deps, fetchUrl });

  const log = (line) => {
    console.error(`[rokhan agent] ${line}`);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch { /* best effort */ }
  };

  // A fresh MCP server per run: one instance serves one connection. `ctx` belongs to the turn: { seen, writes }.
  const mcpServer = (ctx) => mcpFn({
    name: 'rokhan',
    alwaysLoad: true,
    tools: toolDefs.map((t) => tool(t.name, t.description, t.shape, async (args) => {
      try {
        await new Promise(setImmediate); // lets the stream loop record a search result that arrived just before this call
        const text = await t.run(args, ctx);
        if (LINK_SOURCES.has(t.name)) ctx.seen.add(text);
        if (t.write) ctx.writes.add(t.write(args)); // only a call that succeeded: the trace says what really changed
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Eroare: ${e?.message ?? e}` }], isError: true };
      }
    })),
  });

  const baseOptions = () => {
    return {
      settingSources: [],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      skills: [],
      cwd: workDir(),
      includeHookEvents: true, // without it only SessionStart and Setup hooks are reported, and the hook guard below is blind to tool hooks
      env: childEnv(),
    };
  };

  /** One SDK query from start to end. Never throws. */
  async function run({ prompt, options, withTools, signal, emit, seen }) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const mapper = createStreamMapper(emit);
    const s = { sessionId: null, result: null, rate: null, apiError: null, apiErrorText: '', sawOutput: false, initProblems: null, thrown: null };
    const stderr = [];
    const toolNames = new Map(); // tool_use id -> name, to know which results are web search results
    mapper.status(THINKING); // something to show before the first byte arrives
    try {
      for await (const msg of queryFn({ prompt, options: { ...options, abortController: ac, stderr: (d) => { stderr.push(String(d)); if (stderr.length > 20) stderr.shift(); } } })) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          s.sessionId = msg.session_id;
          const problems = checkInit(msg, { tools: withTools });
          if (!initLogged || problems.length) {
            initLogged = true;
            log(`init: model=${msg.model} tools=[${(msg.tools ?? []).join(', ')}] skills=[${(msg.skills ?? []).join(', ')}] agents=[${(msg.agents ?? []).join(', ')}] plugins=[${(msg.plugins ?? []).map((p) => p.name).join(', ')}] mcp=[${(msg.mcp_servers ?? []).map((m) => `${m.name}:${m.status}`).join(', ')}]`);
          }
          if (problems.length) {
            s.initProblems = problems;
            log(`REFUSING TO RUN: the SDK loaded things it must not: ${problems.join('; ')}`);
            ac.abort();
            break;
          }
        } else if (msg.type === 'system' && /^hook_/.test(msg.subtype ?? '')) {
          s.initProblems = [`hook ran: ${msg.hook_name ?? msg.subtype}`];
          log(`REFUSING TO RUN: a host hook fired (${msg.hook_name ?? msg.subtype})`);
          ac.abort();
          break;
        } else if (msg.type === 'rate_limit_event') s.rate = msg.rate_limit_info;
        else if (msg.type === 'assistant' && msg.error) {
          s.apiError = msg.error;
          s.apiErrorText = (msg.message?.content ?? []).map((b) => b.text ?? '').join(' ');
        } else if (msg.type === 'assistant' || msg.type === 'stream_event') {
          s.sawOutput = true;
          for (const b of msg.message?.content ?? []) if (b?.type === 'tool_use' && b.id) toolNames.set(b.id, b.name);
        } else if (msg.type === 'user' && seen && !msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) if (b?.type === 'tool_result' && toolNames.get(b.tool_use_id) === 'WebSearch') seen.add(b.content);
        } else if (msg.type === 'result') {
          s.result = msg;
          s.sessionId = msg.session_id ?? s.sessionId;
        }
        mapper.push(msg);
      }
    } catch (e) {
      s.thrown = e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    let error = s.initProblems ? { code: 'intern', message: MESSAGES.intern, resetAt: null } : classifyError({ aborted: signal?.aborted, thrown: s.thrown, result: s.result, apiError: s.apiError, apiErrorText: s.apiErrorText, rate: s.rate, tz: config.tz });
    if (error?.code === 'intern' && !s.initProblems) {
      log(`run failed: subtype=${s.result?.subtype} apiError=${s.apiError} result=${String(s.result?.result ?? '').slice(0, 300)} errors=${JSON.stringify(s.result?.errors ?? [])} thrown=${s.thrown?.message ?? ''} stderr=${stderr.join('').slice(-600)}`);
    }
    const final = String(s.result?.result ?? '').trim();
    if (!error && mapper.text && final && mapper.text !== final) log(`streamed text (${mapper.text.length} chars) differs from the SDK's final result (${final.length} chars); keeping what was streamed`);
    return { text: mapper.text || (error ? '' : final), sdkSessionId: s.sessionId, usage: usageOf(s.result), error, sawOutput: s.sawOutput };
  }

  async function runTurn({ conversation, text, images = [], urgent = false, signal, emit = () => {} }) {
    const safeEmit = (event, data) => { try { emit(event, data); } catch { /* a broken listener must not stop the turn */ } };
    const previous = conversation?.sdkSessionId ?? null;
    const writes = new Set(); // the write tools that ran, over both attempts
    try {
      // Addresses she wrote, now or earlier in this conversation, may be opened. The model's own messages do not count.
      const seen = provenance.of(conversation?.id);
      for (const m of conversation?.messages ?? []) if (m?.role === 'user') seen.add(m.text);
      seen.add(text);
      const ctx = { seen, writes };
      const imageBlocks = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: fs.readFileSync(img.path).toString('base64') } }));
      const attempt = async (resume) => {
        let profil = '';
        let transcript = '';
        if (!resume) { // a fresh session knows nothing: give it her profile and the recent conversation
          try { const page = await deps.memorie.read('profil'); profil = (typeof page === 'string' ? page : page?.markdown) ?? ''; } catch { /* no profile yet */ }
          transcript = transcriptOf(conversation?.messages, text);
        }
        const content = [{ type: 'text', text: buildUserText({ now: now(), tz: config.tz, urgent, profil, transcript, text }) }, ...imageBlocks];
        const prompt = (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; })();
        const options = {
          ...baseOptions(),
          model: config.model,
          effort: config.effort,
          systemPrompt: systemPrompt(),
          tools: ['WebSearch'],
          allowedTools: ['WebSearch', 'mcp__rokhan__*'],
          mcpServers: { rokhan: mcpServer(ctx) },
          maxTurns: MAX_TURNS,
          includePartialMessages: true,
          ...(resume ? { resume } : {}),
        };
        return run({ prompt, options, withTools: true, signal, emit: safeEmit, seen });
      };

      let r = await attempt(previous);
      if (previous && r.error?.code === 'intern' && !r.sawOutput) {
        log(`session ${previous} could not be resumed, starting a fresh one`);
        r = await attempt(null);
      }
      return { text: r.text, sdkSessionId: r.sdkSessionId ?? previous, usage: r.usage, error: r.error, writes: [...writes] };
    } catch (e) {
      log(`runTurn crashed: ${e?.stack ?? e}`);
      return { text: '', sdkSessionId: previous, usage: null, error: { code: 'intern', message: MESSAGES.intern, resetAt: null }, writes: [...writes] };
    }
  }

  async function runJob({ system, prompt, model, effort }) {
    try {
      const options = {
        ...baseOptions(),
        model: model ?? config.model,
        effort: effort ?? config.effort,
        systemPrompt: system,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        maxTurns: 3, // no tools; the spare turns cover a continuation after an output-length stop
        persistSession: false,
      };
      const r = await run({ prompt: String(prompt), options, withTools: false, emit: () => {} });
      return { text: r.text, error: r.error };
    } catch (e) {
      log(`runJob crashed: ${e?.stack ?? e}`);
      return { text: '', error: { code: 'intern', message: MESSAGES.intern, resetAt: null } };
    }
  }

  /**
   * Deletes the SDK's transcript of one session (when its conversation is deleted). It goes through the SDK's own
   * deleteSession, limited to this app's project directory, and only for a well-formed session id, so it can
   * never touch another file. Resolves true when a transcript was removed. Never throws.
   */
  async function forgetSession(sdkSessionId) {
    if (typeof sdkSessionId !== 'string' || !SESSION_ID.test(sdkSessionId)) return false;
    try {
      await deleteFn(sdkSessionId, { dir: workDir() });
      return true;
    } catch (e) {
      if (!/not found/i.test(e?.message ?? '')) log(`forgetSession ${sdkSessionId}: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * Deletes the SDK transcripts of this app that were last used more than `olderThanMs` ago (the purge job).
   * The ids come from the SDK's listing of the app's own working directory, without the repository's other
   * worktrees, and each is deleted through the SDK with the same directory: nothing outside that project folder
   * is ever named. Resolves the number deleted. Never throws.
   */
  async function purgeSessions(olderThanMs) {
    if (typeof olderThanMs !== 'number' || !(olderThanMs > 0)) return 0;
    const cutoff = now().getTime() - olderThanMs;
    let sessions;
    let cwd;
    try { cwd = workDir(); sessions = await listFn({ dir: cwd, includeWorktrees: false }); } catch (e) { log(`purgeSessions: ${e?.message ?? e}`); return 0; }
    let removed = 0;
    for (const s of sessions ?? []) {
      if (!SESSION_ID.test(String(s?.sessionId)) || !(s.lastModified < cutoff)) continue;
      if (s.cwd && !samePath(s.cwd, cwd)) continue;
      try { await deleteFn(s.sessionId, { dir: cwd }); removed++; } catch (e) { log(`purgeSessions ${s.sessionId}: ${e?.message ?? e}`); }
    }
    return removed;
  }

  return { runTurn, runJob, forgetSession, purgeSessions };
}
