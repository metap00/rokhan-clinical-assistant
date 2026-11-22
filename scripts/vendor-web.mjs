// Vendors the frontend libraries into web/vendor/ and the fonts into web/fonts/, with exact versions
// (no CDN, no bundler).
// Usage: node scripts/vendor-web.mjs [libs|fonts]   (needs npm and tar on PATH; fetches from the npm registry)
// File names carry the version because the server serves /vendor/ as immutable for a year.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'vendor');
const FONTS_OUT = path.join(ROOT, 'web', 'fonts');
const ONLY = process.argv[2]; // 'libs', 'fonts' or nothing for both

// [package, version, [[file in the package, name in web/vendor], ...]]
const PACKAGES = [
  ['preact', '11.2.0', [['dist/preact.mjs', 'preact-11.2.0.mjs'], ['hooks/dist/hooks.mjs', 'preact-hooks-11.2.0.mjs']]],
  ['htm', '3.1.1', [['dist/htm.mjs', 'htm-3.1.1.mjs']]],
  ['marked', '18.2.1', [['lib/marked.esm.js', 'marked-18.2.1.mjs']]],
  ['dompurify', '3.4.18', [['dist/purify.es.mjs', 'dompurify-3.4.18.mjs']]],
  ['mermaid', '12.3.0', [['dist/mermaid.min.js', 'mermaid-12.3.0.min.js']]],
];

// Fonts come from the Fontsource packages (the upstream open-licensed files, already cut into the
// Latin and Latin Extended subsets; Romanian needs both: â î are in Latin, ă ș ț in Latin Extended).
// [package, version, [file stems under files/, without the .woff2]]. All four are SIL OFL 1.1.
const FONTS = [
  ['@fontsource-variable/atkinson-hyperlegible-next', '5.3.0', ['atkinson-hyperlegible-next-latin-wght-normal', 'atkinson-hyperlegible-next-latin-ext-wght-normal', 'atkinson-hyperlegible-next-latin-wght-italic', 'atkinson-hyperlegible-next-latin-ext-wght-italic']],
  ['@fontsource/courier-prime', '5.3.0', ['courier-prime-latin-400-normal', 'courier-prime-latin-ext-400-normal', 'courier-prime-latin-700-normal', 'courier-prime-latin-ext-700-normal']],
  ['@fontsource-variable/source-sans-3', '5.3.1', ['source-sans-3-latin-wght-normal', 'source-sans-3-latin-ext-wght-normal', 'source-sans-3-latin-wght-italic', 'source-sans-3-latin-ext-wght-italic']],
  ['@fontsource/protest-strike', '5.3.0', ['protest-strike-latin-400-normal', 'protest-strike-latin-ext-400-normal']],
];

// The browser has no import map (an inline one would break the CSP), so bare specifiers are rewritten.
const REWRITE = { 'preact-hooks-11.2.0.mjs': (s) => s.replace(/from\s*"preact"/g, 'from"./preact-11.2.0.mjs"') };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokhan-vendor-'));

// Downloads one exact version into its own folder and returns the unpacked package directory.
function fetchPackage(name, version) {
  const dir = path.join(tmp, name.replace(/[@/]/g, '_'));
  fs.mkdirSync(dir);
  const tgz = execSync(`npm pack ${name}@${version} --silent`, { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  execSync(`tar -xzf ${tgz}`, { cwd: dir });
  const pkg = path.join(dir, 'package');
  const got = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  if (got !== version) throw new Error(`${name}: wanted ${version}, got ${got}`);
  return pkg;
}

try {
  if (ONLY !== 'libs') {
    fs.rmSync(FONTS_OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(FONTS_OUT, 'licenses'), { recursive: true });
    for (const [name, version, stems] of FONTS) {
      const pkg = fetchPackage(name, version);
      for (const stem of stems) {
        const to = path.join(FONTS_OUT, `${stem}.woff2`);
        fs.copyFileSync(path.join(pkg, 'files', `${stem}.woff2`), to);
        console.log(`${name}@${version}  web/fonts/${stem}.woff2  ${(fs.statSync(to).size / 1024).toFixed(0)} KB`);
      }
      fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(FONTS_OUT, 'licenses', `${name.split('/')[1]}-OFL.txt`));
    }
  }
  if (ONLY !== 'fonts') fs.rmSync(OUT, { recursive: true, force: true });
  if (ONLY !== 'fonts') fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  for (const [name, version, files] of ONLY === 'fonts' ? [] : PACKAGES) {
    const pkg = fetchPackage(name, version);
    for (const [from, to] of files) {
      let text = fs.readFileSync(path.join(pkg, from), 'utf8');
      if (REWRITE[to]) text = REWRITE[to](text);
      text = text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
      fs.writeFileSync(path.join(OUT, to), text);
      console.log(`${name}@${version}  ${from} -> web/vendor/${to}  ${(text.length / 1024).toFixed(0)} KB`);
    }
    for (const lic of fs.readdirSync(pkg).filter((f) => /^LICENSE/i.test(f))) {
      fs.copyFileSync(path.join(pkg, lic), path.join(OUT, 'licenses', `${name}-${lic.replace(/\.(md|txt)$/i, '')}.txt`));
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
