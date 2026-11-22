import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic, httpError } from './files.mjs';

const TITLES = {
  profil: 'Profil',
  'jurnal-de-studiu': 'Jurnal de studiu',
  'plan-de-studiu': 'Plan de studiu',
  surse: 'Surse',
  'intrebari-deschise': 'Întrebări deschise',
  corectii: 'Corecții',
};
const ORDER = Object.keys(TITLES);
const MAX_BYTES = 200 * 1024;
const HISTORY_KEEP = 20;

export function titleOf(pagina) {
  if (TITLES[pagina]) return TITLES[pagina];
  if (pagina.startsWith('subiect-')) return 'Subiect: ' + pagina.slice(8).replace(/-/g, ' ');
  return pagina.replace(/-/g, ' ');
}

function checkName(pagina) {
  if (typeof pagina !== 'string' || !/^[a-z0-9-]+$/.test(pagina) || pagina.length > 80) throw httpError(400, 'pagina_invalida');
}

const instances = new Map();

export function getMemorie(config) {
  if (!instances.has(config.dataDir)) instances.set(config.dataDir, createMemorie(config));
  return instances.get(config.dataDir);
}

function createMemorie(config) {
  const dir = path.join(config.dataDir, 'memory');
  const fileOf = (pagina) => path.join(dir, pagina + '.md');
  const historyDir = path.join(dir, '.history');

  // Copies the current page to .history/<pagina>-<timestamp>.md and keeps the newest HISTORY_KEEP.
  function keepOld(pagina) {
    if (!fs.existsSync(fileOf(pagina))) return;
    fs.mkdirSync(historyDir, { recursive: true });
    // Names sort by time: on a clash, step the stamp forward by a millisecond.
    let t = Date.now();
    const nameAt = (ms) => `${pagina}-${new Date(ms).toISOString().replace(/[:.]/g, '-')}.md`;
    while (fs.existsSync(path.join(historyDir, nameAt(t)))) t++;
    const name = nameAt(t);
    fs.copyFileSync(fileOf(pagina), path.join(historyDir, name));
    const mine = new RegExp(`^${pagina}-\\d{4}-\\d{2}-\\d{2}T`);
    const old = fs.readdirSync(historyDir).filter((f) => mine.test(f)).sort();
    for (const f of old.slice(0, -HISTORY_KEEP)) fs.rmSync(path.join(historyDir, f));
  }

  function read(pagina) {
    checkName(pagina);
    try {
      const markdown = fs.readFileSync(fileOf(pagina), 'utf8');
      return { pagina, titlu: titleOf(pagina), markdown, updatedAt: fs.statSync(fileOf(pagina)).mtimeMs };
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, 'negasit');
      throw err;
    }
  }

  return {
    list() {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.md$/.test(f)).map((f) => f.slice(0, -3));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const rank = (p) => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length);
      return names
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .map((pagina) => {
          const st = fs.statSync(fileOf(pagina));
          return { pagina, titlu: titleOf(pagina), updatedAt: st.mtimeMs, bytes: st.size };
        });
    },
    read,
    write(pagina, markdown) {
      checkName(pagina);
      if (typeof markdown !== 'string') throw httpError(400, 'markdown_lipsa');
      if (Buffer.byteLength(markdown) > MAX_BYTES) throw httpError(400, 'prea_mare');
      keepOld(pagina);
      writeTextAtomic(fileOf(pagina), markdown);
      return read(pagina);
    },
  };
}
