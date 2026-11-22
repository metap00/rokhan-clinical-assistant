// deschide_url: fetches a public web page or PDF and returns readable text for the model.
// Guards: http/https only, every hop resolved and checked against private address ranges, the connection
// pinned to the checked address, 30 s, 25 MB, and the conversion to text in a worker thread with its own 10 s. The host check is ported from the earlier bot's document reader.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { REFUSAL } from './provenance.mjs';

const MB = 1024 * 1024;
export const LIMITS = {
  bytes: 25 * MB,
  timeoutMs: 30_000,
  redirects: 5,
  defaultChars: 12_000,
  maxChars: 40_000,
  cacheMs: 24 * 3600 * 1000,
  extractMs: 10_000, // HTML and PDF conversion, in a worker that is terminated at this limit
  htmlChars: 5 * MB, // ponytail: regex converter, only the first 5 MB of markup is converted; a real parser if pages get bigger
};
const USER_AGENT = 'Mozilla/5.0 (compatible; RokhanReader/1.0)';

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => new FetchError(code, message);

// ---------- host check ----------

function v4Bytes(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function v6Bytes(s) {
  s = s.split('%')[0].toLowerCase();
  let tail = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = v4Bytes(dotted[1]);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, dotted.index) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (dotted) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

/**
 * The addresses of this machine's own interfaces, in the form isBlockedAddress compares. A service that listens on
 * every interface and is closed only by a firewall is reachable from the box itself through its public address.
 */
export function ownAddresses(interfaces = os.networkInterfaces()) {
  const own = new Set();
  for (const list of Object.values(interfaces ?? {})) {
    for (const a of list ?? []) {
      const bytes = net.isIPv4(a.address) ? v4Bytes(a.address) : v6Bytes(String(a.address));
      if (bytes) own.add(bytes.join('.'));
    }
  }
  return own;
}

function blockedV4(bytes, own) {
  const [a, b] = bytes;
  return (
    own.has(bytes.join('.')) ||
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10 (Tailscale lives here)
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * True when the literal IP address must not be contacted: loopback, private, link-local, CGNAT, mapped and
 * translated forms, and the machine's own addresses (`own`, read from the interfaces on every call).
 */
export function isBlockedAddress(ip, own = ownAddresses()) {
  if (net.isIPv4(ip)) return blockedV4(v4Bytes(ip), own);
  if (!net.isIPv6(ip)) return true;
  const g = v6Bytes(ip);
  if (!g) return true;
  const allZero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 15) && (g[15] === 0 || g[15] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (g[0] === 0xfe && (g[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (g[0] === 0xff) return true; // multicast
  if (g[0] === 0xfe && (g[1] & 0xc0) === 0xc0) return true; // fec0::/10
  if (g[0] === 0x20 && g[1] === 0x02) return true; // 2002::/16 6to4
  if (g[0] === 0x20 && g[1] === 0x01 && g[2] === 0 && g[3] === 0) return true; // 2001::/32 Teredo
  if (g[0] === 0 && g[1] === 0x64 && g[2] === 0xff && g[3] === 0x9b && g[4] === 0 && g[5] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (allZero(0, 8) && g[8] === 0xff && g[9] === 0xff && g[10] === 0 && g[11] === 0) return true; // ::ffff:0:a.b.c.d IPv4-translated
  if (allZero(0, 10) && g[10] === 0xff && g[11] === 0xff) return blockedV4(g.slice(12), own); // ::ffff:a.b.c.d
  if (allZero(0, 12)) return blockedV4(g.slice(12), own); // ::a.b.c.d
  if (g[0] === 0 && g[1] === 0x64 && g[2] === 0xff && g[3] === 0x9b && allZero(4, 12)) return blockedV4(g.slice(12), own); // NAT64
  return own.has(g.join('.'));
}

const defaultResolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

const hostOf = (url) => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);

/** The checks that need no network: a well-formed http(s) URL without credentials. Returns the URL or throws FetchError. */
export function parseUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw fail('url', 'URL invalid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('url', 'Doar adrese http:// și https://.');
  if (url.username || url.password) throw fail('url', 'Adresele cu utilizator și parolă nu sunt permise.');
  if (!hostOf(url)) throw fail('url', 'URL fără gazdă.');
  return url;
}

/**
 * Validates a URL and resolves its host. Returns { url, host, addresses } or throws FetchError.
 * `allow(url)` is the provenance rule: it is asked before the name is resolved, so a refused address leaks nothing.
 */
export async function checkUrl(raw, resolver = defaultResolver, allow = null, own = ownAddresses()) {
  const url = parseUrl(raw);
  if (allow && !allow(url)) throw fail('provenienta', REFUSAL);
  const host = hostOf(url);
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = await resolver(host); } catch { throw fail('descarcare', 'Gazda nu a putut fi rezolvată.'); }
  }
  if (!addresses?.length) throw fail('descarcare', 'Gazda nu a putut fi rezolvată.');
  if (addresses.some((a) => isBlockedAddress(a, own))) throw fail('blocat', 'Gazda duce la o adresă privată sau locală.');
  return { url, host, addresses };
}

// ---------- download ----------

/** One GET to `url`, connected to `address` (the one that was checked). Resolves { status, headers, body }. */
function requestOnce(url, address, deadline) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(fail('timeout', 'Descărcarea a durat prea mult.'));
    const family = net.isIPv6(address) ? 6 : 4;
    const host = hostOf(url);
    const mod = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { req.destroy(); reject(err); } else resolve(value);
    };
    const req = mod.request(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/pdf,application/json,text/plain,*/*;q=0.8', 'Accept-Language': 'ro,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
      servername: net.isIP(host) ? undefined : host,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return done(null, { status, headers: res.headers, body: Buffer.alloc(0) }); }
      if (Number(res.headers['content-length'] || 0) > LIMITS.bytes) return done(fail('prea_mare', 'Documentul are peste 25 MB.'));
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let n = 0;
      stream.on('data', (c) => {
        n += c.length;
        if (n > LIMITS.bytes) return done(fail('prea_mare', 'Documentul are peste 25 MB.'));
        chunks.push(c);
      });
      stream.on('end', () => done(null, { status, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on('error', () => done(fail('descarcare', 'Descărcarea a eșuat.')));
      res.on('error', () => done(fail('descarcare', 'Descărcarea a eșuat.')));
      res.on('aborted', () => done(fail('descarcare', 'Descărcarea s-a întrerupt.')));
    });
    const timer = setTimeout(() => done(fail('timeout', 'Descărcarea a durat prea mult.')), left);
    req.on('error', (e) => done(e instanceof FetchError ? e : fail('descarcare', 'Descărcarea a eșuat.')));
    req.end();
  });
}

/**
 * Follows redirects (each hop checked again). Resolves { finalUrl, address, status, headers, body }. A FetchError
 * carries `finalUrl` and `address` too: the hop it stopped at and the IP it was connected to, if any.
 */
export async function download(raw, { resolver, request = requestOnce, allow = null } = {}) {
  const deadline = Date.now() + LIMITS.timeoutMs;
  let current = raw;
  let address = null;
  try {
    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
      address = null;
      const { url, addresses } = await checkUrl(current, resolver, allow);
      current = url.href;
      address = addresses[0];
      const res = await request(url, address, deadline);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        try { current = new URL(res.headers.location, url).toString(); } catch { throw fail('descarcare', 'Redirecționare greșită.'); }
        continue;
      }
      if (res.body.length > LIMITS.bytes) throw fail('prea_mare', 'Documentul are peste 25 MB.');
      return { finalUrl: url.toString(), address, status: res.status, headers: res.headers, body: res.body };
    }
    throw fail('descarcare', 'Prea multe redirecționări.');
  } catch (e) {
    if (e instanceof FetchError) Object.assign(e, { finalUrl: current, address });
    throw e;
  }
}

// ---------- extraction ----------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', le: '≤', ge: '≥', micro: 'µ', mu: 'μ', deg: '°', plusmn: '±',
  times: '×', middot: '·', bull: '•', copy: '©', reg: '®', euro: '€', frac12: '½', alpha: 'α', beta: 'β', rarr: '→',
};
const codePoint = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
  .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);

const DOC_LINK = /\.(pdf|docx?)(?:$|[?#])|\/download\b/i;

/** HTML (or XML) to readable text: headings as "# ", list items as "- ", table rows as "a | b" lines. */
export function htmlToText(html, baseUrl) {
  let s = String(html).slice(0, LIMITS.htmlChars).replace(/<!--[\s\S]*?-->/g, ' ');
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s)?.[1];
  s = s.replace(/<(script|style|nav|noscript|svg|template|iframe|head|footer|select)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(s);
  if (main && main[1].length > 500) s = main[1];
  // Links keep their address only when they point to a document, so the model can open the PDF behind a list page.
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, inner) => {
    if (!DOC_LINK.test(href)) return inner;
    try { return `${inner} (${new URL(decodeEntities(href), baseUrl).toString()})`; } catch { return inner; }
  });
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<tr\b[^>]*>/gi, '') // the row's line break comes from </tr>, so rows stay on consecutive lines
    .replace(/<\/?(p|div|section|article|ul|ol|table|tr|thead|tbody|blockquote|pre|dl|dt|dd|figure|figcaption|header|main|hr|title|sec|abstract)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n').map((l) => l.replace(/[ \t\r\f\v ]+/g, ' ').trim().replace(/(?:\s*\|)+$/, ''));
  const body = lines.join('\n')
    .replace(/^(#+|-)\n+(?=[^\n#-])/gm, '$1 ') // a marker whose text landed on the next line
    .replace(/^(?:#+|-)\n/gm, '') // empty headings and list items
    .replace(/\n{3,}/g, '\n\n').trim();
  const t = title ? decodeEntities(title.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
  return t && !body.startsWith(`# ${t}`) ? `${t}\n\n${body}` : body;
}

function decodeText(body, contentType) {
  let cs = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!cs) cs = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  try { return new TextDecoder(cs || 'utf-8').decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

async function pdfPages(body) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(new Uint8Array(body));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((p) => p.trim());
  } catch {
    throw fail('format', 'PDF-ul nu a putut fi citit (protejat sau deteriorat).');
  }
}

/** Bytes to { kind, text } or { kind: 'pdf', pages }. */
export async function extract(body, contentType = '', baseUrl) {
  const ct = contentType.toLowerCase();
  if (body.subarray(0, 5).toString('latin1').startsWith('%PDF')) return { kind: 'pdf', pages: await pdfPages(body) };
  if (/^(image|audio|video|font)\//.test(ct) || body.subarray(0, 4096).includes(0)) throw fail('format', 'Format nesuportat: doar pagini web, text, JSON și PDF.');
  const text = decodeText(body, contentType);
  if (ct.includes('json')) return { kind: 'json', text };
  if (/html|xml/.test(ct) || /^\s*<(?:!doctype|html|\?xml)/i.test(text)) return { kind: 'html', text: htmlToText(text, baseUrl) };
  return { kind: 'text', text };
}

/**
 * extract() in a worker thread that is terminated after `ms`. The converter's regular expressions go quadratic on
 * hostile markup and the PDF parser has no limit of its own; on the main thread either would stop every request.
 */
export function extractBounded(body, contentType = '', baseUrl, ms = LIMITS.extractMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.mjs', import.meta.url), { workerData: { body, contentType, baseUrl }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Settle only when the thread is really gone, so a conversion that cannot be stopped would show up as a hang here.
      worker.terminate().then(() => (err ? reject(err) : resolve(value)));
    };
    const timer = setTimeout(() => done(fail('timeout', `Documentul e prea greu de citit: conversia a fost oprită după ${Math.round(ms / 1000) || 1} s.`)), ms);
    worker.once('message', (m) => (m?.error ? done(fail(m.error.code, m.error.message)) : done(null, m.value)));
    worker.once('error', () => done(fail('format', 'Documentul nu a putut fi citit.')));
    worker.once('exit', () => done(fail('format', 'Documentul nu a putut fi citit.')));
  });
}

// ---------- paging ----------

/** "3-5" / "1,4,7-9" -> sorted unique page numbers, or null when malformed. */
export function parsePages(spec) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b - a > 10_000) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** Slice [offset, offset+maxChars) preferring a line boundary; returns { text, end }. */
export function slice(text, offset, maxChars) {
  if (offset >= text.length) return { text: '', end: text.length };
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl >= offset && nl + 1 - offset >= maxChars / 2) end = nl + 1;
    else if (/[\ud800-\udbff]/.test(text[end - 1])) end -= 1; // do not split a surrogate pair
  }
  return { text: text.slice(offset, end), end };
}

// ---------- entry point ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * createFetcher({ dataDir }) -> fetchUrl({ url, pagini, offset, max_caractere })
 * Resolves { url, kind, pages, chars, text, nextOffset, cached }. Throws FetchError (code: url | provenienta | blocat |
 * descarcare | prea_mare | timeout | format | argument). `allow(URL)` decides which addresses may be contacted at all. `resolver`, `request`, `now` and `extractMs` are test seams.
 */
export function createFetcher({ dataDir, resolver, request, now = Date.now, extractMs = LIMITS.extractMs }) {
  const cacheDir = path.join(dataDir, 'cache');
  const logFile = path.join(dataDir, 'logs', 'fetch.log');

  // One line per fetch: time, address asked for, status or error code, bytes, address the fetch ended at, IP connected to.
  // Addresses are JSON strings, so nothing in them can start a new line or a new field (review finding 11).
  const log = (url, status, bytes, finalUrl = null, address = null) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()}\t${JSON.stringify(url)}\t${status}\t${bytes}\t${finalUrl ? JSON.stringify(String(finalUrl)) : '-'}\t${address ?? '-'}\n`);
    } catch { /* logging is best effort */ }
  };
  const cacheGet = (file) => {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      return now() - entry.at < LIMITS.cacheMs ? entry : null;
    } catch { return null; }
  };
  const cachePut = (file, entry) => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch { /* cache is best effort */ }
  };

  return async function fetchUrl({ url, pagini, offset = 0, max_caractere = LIMITS.defaultChars, allow = null } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw fail('argument', 'Lipsește adresa.');
    if (!Number.isInteger(offset) || offset < 0) throw fail('argument', 'offset trebuie să fie un întreg pozitiv.');
    if (!Number.isInteger(max_caractere) || max_caractere < 1) throw fail('argument', 'max_caractere trebuie să fie un întreg pozitiv.');
    const maxChars = Math.min(max_caractere, LIMITS.maxChars);
    let sel = null;
    if (pagini !== undefined && pagini !== null && pagini !== '') {
      sel = parsePages(pagini);
      if (!sel) throw fail('argument', 'pagini arată ca 3-5 sau 1,4,7-9.');
    }

    try {
      url = parseUrl(url).href; // from here on the address is the parsed one: that is what is fetched, cached and logged
    } catch (e) {
      log(url.slice(0, 2000), e.code, 0);
      throw e;
    }
    if (allow && !allow(new URL(url))) { // also for a page that is in the cache
      log(url, 'provenienta', 0);
      throw fail('provenienta', REFUSAL);
    }

    const file = path.join(cacheDir, `url-${sha256(url)}.json`);
    let entry = cacheGet(file);
    const cached = entry !== null;
    if (cached) log(url, 'cache', entry.bytes, entry.finalUrl);
    else {
      let res;
      try {
        res = await download(url, { resolver, request, allow });
      } catch (e) {
        log(url, e.code || 'eroare', 0, e.finalUrl, e.address);
        throw e;
      }
      log(url, res.status, res.body.length, res.finalUrl, res.address);
      if (res.status < 200 || res.status >= 300) throw fail('descarcare', `Serverul a răspuns HTTP ${res.status}.`);
      const ex = await extractBounded(res.body, String(res.headers['content-type'] || ''), res.finalUrl, extractMs);
      entry = { at: now(), url, finalUrl: res.finalUrl, bytes: res.body.length, ...ex };
      cachePut(file, entry);
    }

    let text;
    if (entry.kind === 'pdf') {
      let nums = entry.pages.map((_, i) => i + 1);
      if (sel) {
        nums = sel.filter((n) => n <= entry.pages.length);
        if (!nums.length) throw fail('argument', `Documentul are ${entry.pages.length} pagini.`);
      }
      text = nums.map((n) => `[p. ${n}]\n${entry.pages[n - 1]}\n`).join('\n');
    } else text = entry.text;

    const part = slice(text, offset, maxChars);
    return {
      url: entry.finalUrl,
      kind: entry.kind,
      pages: entry.kind === 'pdf' ? entry.pages.length : null,
      chars: text.length,
      text: part.text,
      nextOffset: part.end < text.length ? part.end : null,
      cached,
    };
  };
}
