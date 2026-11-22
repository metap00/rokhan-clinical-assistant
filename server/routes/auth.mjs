import { getAuth } from '../http/auth.mjs';

export default function register(app) {
  const auth = getAuth(app.config);

  app.public.post('/api/login', async (c) => {
    const ip = auth.clientIp(c.req);
    const wait = auth.blockedFor(ip);
    if (wait) {
      c.res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(wait) });
      c.res.end(JSON.stringify({ error: 'prea_multe', retryAfterSec: wait }));
      return;
    }
    if (!auth.checkPassword(c.body?.password)) {
      auth.recordFailure(ip);
      throw Object.assign(new Error('parola'), { status: 401 });
    }
    auth.clearFailures(ip);
    c.res.setHeader('Set-Cookie', auth.makeCookie());
    return { ok: true };
  });

  app.post('/api/logout', async (c) => {
    auth.endSession(c.req);
    c.res.setHeader('Set-Cookie', auth.clearCookie());
    return { ok: true };
  });

  app.public.get('/api/session', async (c) => ({ authenticated: !!auth.verify(c.req) }));
}
