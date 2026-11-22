import fs from 'node:fs';
import path from 'node:path';
import { getAuth } from './auth.mjs';

const MB = 1024 * 1024;

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PLACEHOLDER = '<!doctype html><meta charset="utf-8"><title>Rokhan</title><p>Rokhan: interfața nu este instalată încă.</p>';

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendFile(res, file, cacheControl) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const { size } = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': cacheControl });
  fs.createReadStream(file).pipe(res);
}

// Server-sent events on a raw response. send() is a no-op once the client is gone.
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const beat = setInterval(() => write(': hb\n\n'), 15000);
  beat.unref();
  let closed = false;
  res.on('close', () => {
    closed = true;
    clearInterval(beat);
  });
  function write(s) {
    if (!closed && !res.writableEnded) res.write(s);
  }
  return {
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    },
    close() {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    },
    get closed() {
      return closed || res.writableEnded;
    },
  };
}

function compile(pattern) {
  const names = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${src}$`), names };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(Object.assign(new Error('prea_mare'), { status: 413, drop: true }));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('prea_mare'), { status: 413, drop: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('json_invalid'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// app.get/post/put/patch/delete(path, handler, { bodyLimit }), app.public.* for routes without a session.
export function createApp(config) {
  const auth = getAuth(config);
  const routes = [];
  const add = (isPublic) => (method) => (pattern, handler, opts = {}) => {
    routes.push({ method, ...compile(pattern), handler, isPublic, bodyLimit: opts.bodyLimit ?? MB });
  };
  const methods = (isPublic) =>
    Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m, add(isPublic)(m.toUpperCase())]));
  const app = { ...methods(false), public: methods(true), config, handle };

  const webRoot = path.join(config.root, 'web');

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return sendJson(res, 400, { error: 'url_invalid' });
    }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { error: 'negasit' });
      return serveStatic(res, url.pathname);
    } catch (err) {
      if (!err.status) console.error(`[rokhan] ${req.method} ${url.pathname}:`, err);
      if (res.headersSent) return res.destroy();
      if (err.drop) res.setHeader('Connection', 'close');
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'intern' });
    }
  }

  async function handleApi(req, res, url) {
    let route, m;
    for (const r of routes) {
      if (r.method === req.method && (m = r.re.exec(url.pathname))) {
        route = r;
        break;
      }
    }
    if (!route) throw Object.assign(new Error('negasit'), { status: 404 });
    if (config.publicOrigin && !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.publicOrigin) {
      throw Object.assign(new Error('origine'), { status: 403 });
    }
    if (!route.isPublic && !auth.verify(req)) throw Object.assign(new Error('neautentificat'), { status: 401 });
    const params = {};
    route.names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(m[i + 1]);
      } catch {
        throw Object.assign(new Error('url_invalid'), { status: 400 });
      }
    });
    // A body must be declared JSON: an HTML form cannot send that without a preflight, which we never answer.
    const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (hasBody && type !== 'application/json') throw Object.assign(new Error('tip_continut'), { status: 415 });
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req, route.bodyLimit) : null;
    const c = { params, query: Object.fromEntries(url.searchParams), body, req, res, config };
    const out = await route.handler(c);
    if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
  }

  function serveStatic(res, pathname) {
    if (!fs.existsSync(webRoot)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(PLACEHOLDER);
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 404, { error: 'negasit' });
    }
    const file = path.resolve(webRoot, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
    if (rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg.startsWith('.')) || (file !== webRoot && !file.startsWith(webRoot + path.sep))) {
      return sendJson(res, 404, { error: 'negasit' });
    }
    let target = file;
    if (!isFile(target)) {
      // SPA fallback for app paths; a missing asset (has an extension) is a real 404.
      if (path.extname(rel)) return sendJson(res, 404, { error: 'negasit' });
      target = path.join(webRoot, 'index.html');
      if (!isFile(target)) return sendJson(res, 404, { error: 'negasit' });
    }
    // Follow links only when they stay inside web/.
    const real = fs.realpathSync(target);
    if (!real.startsWith(fs.realpathSync(webRoot) + path.sep)) return sendJson(res, 404, { error: 'negasit' });
    const name = path.basename(target);
    const cache = rel.startsWith('/vendor/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    sendFile(res, real, name.endsWith('.html') || name === 'sw.js' ? 'no-cache' : cache);
  }

  return app;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
