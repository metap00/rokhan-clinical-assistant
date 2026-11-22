// Shared by the content tests (library, lessons, routes). Tests never touch the real data directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, 'fixtures', 'content', 'datadir');
export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const tmpDir = (name = 'rokhan-content-') => fs.mkdtempSync(path.join(os.tmpdir(), name));

/** config pointing at the read-only library fixtures. */
export const libraryConfig = () => ({ dataDir: FIXTURES, tz: 'Europe/Bucharest' });

/**
 * A throw-away data dir with lessons: units 01-1 and 07-1 (invented guidelines, with their sample lessons) plus renamed copies
 * 07-2, 07-3, 08-1, 08-2 of unit 07-1. Lessons are written for 01-1, 07-1 and 07-2 only. Returns { config, dir, lessonsDir }.
 */
export function makeLessonsData({ state } = {}) {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, 'lessons');
  for (const s of ['units', 'lessons']) fs.mkdirSync(path.join(dir, s), { recursive: true });
  const unit = (id) => readJson(path.join(FIXTURES, 'lessons', 'units', `${id}.json`));
  const lesson = (id) => readJson(path.join(FIXTURES, 'lessons', 'lessons', `${id}.json`));
  const put = (sub, id, obj) => fs.writeFileSync(path.join(dir, sub, `${id}.json`), JSON.stringify(obj));
  put('units', '01-1', unit('01-1'));
  put('units', '07-1', unit('07-1'));
  put('lessons', '01-1', lesson('01-1'));
  put('lessons', '07-1', lesson('07-1'));
  const copies = { '07-2': ['07', 2], '07-3': ['07', 3], '08-1': ['08', 1], '08-2': ['08', 2] };
  for (const [id, [nr, k]] of Object.entries(copies)) {
    const u = unit('07-1');
    Object.assign(u, { id, k, n: nr === '07' ? 3 : 2 });
    u.ghid = { ...u.ghid, nr, titlu: nr === '07' ? u.ghid.titlu : 'Tulburarea inventată de test' };
    put('units', id, u);
  }
  put('lessons', '07-2', { ...lesson('07-1'), unit: '07-2' });
  fs.writeFileSync(path.join(dir, 'curriculum.json'), JSON.stringify([
    { nr: '01', titlu: 'Travaliul fictiv de test', unitati: 1 },
    { nr: '07', titlu: 'Sindromul fictiv de test', unitati: 3 },
    { nr: '08', titlu: 'Tulburarea inventată de test', unitati: 2 },
  ]));
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  return { config: { dataDir, tz: 'Europe/Bucharest' }, dir, lessonsDir: path.join(dir, 'lessons') };
}

/** The `app` object route modules register on: handlers are kept by "METHOD path". */
export function fakeApp() {
  const routes = new Map();
  const add = (m) => (p, h) => routes.set(`${m} ${p}`, h);
  const app = { routes, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), public: { get: add('GET'), post: add('POST') } };
  /** Calls a registered handler like the router would; returns { status, body } (a handler that writes to res itself is captured too). */
  app.call = async (method, p, { params = {}, query = {}, body = null, config } = {}) => {
    const h = routes.get(`${method} ${p}`);
    if (!h) throw new Error(`no route ${method} ${p}`);
    const out = { status: 200, body: undefined };
    const res = { writeHead: (s) => { out.status = s; }, end: (b) => { out.body = JSON.parse(b); } };
    try {
      const r = await h({ params, query, body, req: {}, res, config });
      if (r !== undefined) out.body = r;
    } catch (e) { return { status: e.status || 500, body: { error: e.message } }; }
    return out;
  };
  return app;
}
