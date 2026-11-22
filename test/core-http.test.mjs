import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { boot, tmpDir, makeConfig } from './core-helpers.mjs';
import { createApp } from '../server/http/router.mjs';
import { getAuth } from '../server/http/auth.mjs';

// Raw request: fetch() normalizes paths, so traversal tests need node:http.
function raw(url, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

describe('router', () => {
  let srv;
  before(async () => {
    const config = makeConfig();
    const app = createApp(config);
    app.public.get('/api/t/:a/x/:b', async (c) => ({ params: c.params, query: c.query }));
    app.public.post('/api/echo', async (c) => ({ body: c.body }));
    app.public.post('/api/big', async (c) => ({ n: c.body.s.length }), { bodyLimit: 3 * 1024 * 1024 });
    app.public.get('/api/boom', async () => {
      throw new Error('secret detail');
    });
    app.public.get('/api/teapot', async () => {
      throw Object.assign(new Error('ceainic'), { status: 418 });
    });
    app.get('/api/private', async () => ({ ok: true }));
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    srv = { server, url: `http://127.0.0.1:${server.address().port}` };
  });
  after(() => srv.server.close());

  test('path params (decoded) and query object', async () => {
    const r = await fetch(`${srv.url}/api/t/unu/x/do%20i?q=caut&ghid=14`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { params: { a: 'unu', b: 'do i' }, query: { q: 'caut', ghid: '14' } });
  });

  test('unknown api route is 404 JSON, wrong method too', async () => {
    let r = await fetch(`${srv.url}/api/nu-exista`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'negasit' });
    r = await fetch(`${srv.url}/api/echo`);
    assert.equal(r.status, 404);
  });

  test('JSON body, empty body is null, bad JSON is 400', async () => {
    let r = await fetch(`${srv.url}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.deepEqual(await r.json(), { body: { a: 1 } });
    r = await fetch(`${srv.url}/api/echo`, { method: 'POST' });
    assert.deepEqual(await r.json(), { body: null });
    r = await fetch(`${srv.url}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400);
  });

  test('body limit: 1 MB by default, per-route override', async () => {
    const big = JSON.stringify({ s: 'x'.repeat(1.2 * 1024 * 1024) });
    let r = await fetch(`${srv.url}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'prea_mare' });
    r = await fetch(`${srv.url}/api/big`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(r.status, 200);
  });

  test('errors: status + message, anything else 500 intern without details', async () => {
    let r = await fetch(`${srv.url}/api/teapot`);
    assert.equal(r.status, 418);
    assert.deepEqual(await r.json(), { error: 'ceainic' });
    const orig = console.error;
    console.error = () => {};
    try {
      r = await fetch(`${srv.url}/api/boom`);
    } finally {
      console.error = orig;
    }
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'intern' });
  });

  test('routes need a session unless public', async () => {
    const r = await fetch(`${srv.url}/api/private`);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'neautentificat' });
  });

  test('security headers on every response', async () => {
    for (const p of ['/api/t/a/x/b', '/api/nu-exista', '/']) {
      const r = await fetch(srv.url + p);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'; base-uri 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    }
  });
});

describe('static files', () => {
  let s;
  before(async () => {
    const root = tmpDir('rokhan-root-');
    fs.mkdirSync(path.join(root, 'web', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(root, 'web', 'sw.js'), '// sw');
    fs.writeFileSync(path.join(root, 'web', 'app.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'web', 'vendor', 'preact.mjs'), 'export default 1');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'nu');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"9.9.9"}');
    s = await boot({ root });
  });
  after(() => s.close());

  test('index, MIME types and cache headers', async () => {
    let r = await raw(s.url, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    r = await raw(s.url, '/sw.js');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.match(r.headers['content-type'], /javascript/);
    r = await raw(s.url, '/vendor/preact.mjs');
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    r = await raw(s.url, '/app.css');
    assert.match(r.headers['content-type'], /text\/css/);
  });

  test('app paths fall back to index.html, missing assets are 404', async () => {
    let r = await raw(s.url, '/registru');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>app/);
    r = await raw(s.url, '/lipsa.js');
    assert.equal(r.status, 404);
  });

  test('path traversal stays inside web/', async () => {
    for (const p of ['/..%2fsecret.txt', '/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/vendor/..%5c..%5csecret.txt', '/..%2f..']) {
      const r = await raw(s.url, p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body, /nu$/);
    }
  });

  test('placeholder page when web/ does not exist', async () => {
    const root = tmpDir('rokhan-noweb-');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.0.1"}');
    const t = await boot({ root });
    try {
      const r = await raw(t.url, '/orice');
      assert.equal(r.status, 200);
      assert.match(r.body, /Rokhan/);
    } finally {
      await t.close();
    }
  });
});

describe('auth', () => {
  test('login sets a signed HttpOnly cookie; session and logout', async () => {
    const s = await boot();
    try {
      let r = await s.api('GET', '/api/session');
      assert.deepEqual(r.json, { authenticated: false });
      r = await s.api('POST', '/api/login', { password: 'gresit' });
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'parola' });
      r = await s.login();
      assert.equal(r.status, 200);
      const sc = r.headers.get('set-cookie');
      assert.match(sc, /^rokhan_session=[0-9a-f]{32}\.\d+\.[0-9a-f]{64}; Max-Age=15552000; HttpOnly; SameSite=Lax; Path=\/$/);
      r = await s.api('GET', '/api/session');
      assert.deepEqual(r.json, { authenticated: true });
      r = await s.api('GET', '/api/stare');
      assert.equal(r.status, 200);
      assert.equal(r.json.fakeLlm, true);
      r = await s.api('POST', '/api/logout');
      assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
      assert.ok(fs.existsSync(path.join(s.config.dataDir, 'secret.key')));
    } finally {
      await s.close();
    }
  });

  test('tampered and expired cookies are refused', async () => {
    const s = await boot();
    try {
      await s.login();
      const good = s.cookie;
      const [id, exp, mac] = good.split('=')[1].split('.');
      const flip = mac.slice(0, -1) + (mac.at(-1) === '0' ? '1' : '0');
      const otherId = 'f'.repeat(32);
      for (const bad of [`rokhan_session=${id}.${exp}.${flip}`, `rokhan_session=${id}.${Number(exp) + 1}.${mac}`, 'rokhan_session=x', 'rokhan_session=']) {
        s.cookie = bad;
        assert.equal((await s.api('GET', '/api/stare')).status, 401, bad);
      }
      const auth = getAuth(s.config);
      const past = Date.now() - 1000;
      s.cookie = `rokhan_session=${id}.${past}.${auth.sign(`${id}.${past}`)}`;
      assert.equal((await s.api('GET', '/api/stare')).status, 401); // expired
      s.cookie = `rokhan_session=${otherId}.${exp}.${auth.sign(`${otherId}.${exp}`)}`;
      assert.equal((await s.api('GET', '/api/stare')).status, 401); // signed but no such session
      s.cookie = good;
      assert.equal((await s.api('GET', '/api/stare')).status, 200);
    } finally {
      await s.close();
    }
  });

  test('rate limit: 5 failures per 15 minutes, then 429 even with the right password', async () => {
    const s = await boot();
    try {
      for (let i = 0; i < 5; i++) assert.equal((await s.api('POST', '/api/login', { password: 'x' })).status, 401);
      const r = await s.api('POST', '/api/login', { password: s.config.password });
      assert.equal(r.status, 429);
      assert.equal(r.json.error, 'prea_multe');
      assert.ok(r.json.retryAfterSec > 0 && r.json.retryAfterSec <= 900);
    } finally {
      await s.close();
    }
  });

  test('with a public origin: Secure cookie, Origin check, X-Forwarded-For per client', async () => {
    const origin = 'https://rokhan.example.ts.net:8444';
    const s = await boot({ publicOrigin: origin });
    try {
      let r = await s.api('POST', '/api/login', { password: s.config.password });
      assert.equal(r.status, 403);
      assert.deepEqual(r.json, { error: 'origine' });
      r = await s.api('POST', '/api/login', { password: s.config.password }, { origin: 'https://rau.example' });
      assert.equal(r.status, 403);
      r = await s.login();
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie'), /; Secure$/);
      assert.equal((await s.api('GET', '/api/registru')).status, 200); // GET needs no Origin
      assert.equal((await s.api('POST', '/api/registru/rows', { nume: 'Test' })).status, 403);

      const h = (ip) => ({ origin, 'x-forwarded-for': `10.0.0.1, ${ip}` });
      for (let i = 0; i < 5; i++) await s.api('POST', '/api/login', { password: 'x' }, h('1.1.1.1'));
      assert.equal((await s.api('POST', '/api/login', { password: 'x' }, h('1.1.1.1'))).status, 429);
      assert.equal((await s.api('POST', '/api/login', { password: 'x' }, h('2.2.2.2'))).status, 401);
    } finally {
      await s.close();
    }
  });

  test('X-Forwarded-For is ignored without a public origin', async () => {
    const s = await boot();
    try {
      for (let i = 0; i < 5; i++) await s.api('POST', '/api/login', { password: 'x' }, { 'x-forwarded-for': `9.9.9.${i}` });
      assert.equal((await s.api('POST', '/api/login', { password: 'x' }, { 'x-forwarded-for': '8.8.8.8' })).status, 429);
    } finally {
      await s.close();
    }
  });
});
