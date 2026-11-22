// The service worker's precache list must name every app file (or offline starts break) and
// nothing that does not exist (or the install fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
// Not precached on purpose: mermaid (5 MB, cached on first use), large icons, licences, the worker itself.
// The fonts of all three looks are precached (about 380 KB), so changing the look works offline.
const SKIP = /^\/(sw\.js|vendor\/mermaid-.*|vendor\/licenses\/.*|fonts\/licenses\/.*|icons\/icon(-maskable)?-512\.png)$/;

function files(dir, base = '') {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(dir, `${base}/${d.name}`) : [`${base}/${d.name}`]);
}

test('sw.js SHELL lists exactly the app files', () => {
  const src = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\]);/.exec(src)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  const onDisk = files(WEB).filter((f) => !SKIP.test(f));
  assert.deepEqual(shell.filter((f) => f !== '/').sort(), onDisk.sort());
});

test('manifest names existing icons, standalone display', () => {
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.short_name, 'Rokhan');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(WEB, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(['192x192', '512x512'].every((s) => m.icons.some((i) => i.sizes === s)));
});
