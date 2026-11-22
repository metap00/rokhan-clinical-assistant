// The looks in web/app.css: every look is a complete token block, the components use tokens only,
// the fonts exist, and text and controls keep WCAG AA contrast in both themes of all three looks.
// Print the contrast table with:  CONTRAST_TABLE=1 node --test test/web-design.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const css = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');
const plain = css.replace(/\/\*[\s\S]*?\*\//g, ''); // without comments, for reading the rules
const LOOKS = ['instrument', 'fisa', 'darkspear']; // the first is the default

// The declarations of the first rule whose selector list contains `selector` exactly.
function block(selector) {
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) {
      return Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim().replace(/\s+/g, ' ')]));
    }
  }
  throw new Error(`no rule for ${selector}`);
}
const light = (look) => block(`[data-look="${look}"]`);
const dark = (look) => ({ ...light(look), ...block(`[data-look="${look}"][data-theme="dark"]`) });
const value = (tokens, name) => {
  let v = tokens[name];
  for (let i = 0; i < 5 && /^var\((--[\w-]+)\)$/.test(v ?? ''); i++) v = tokens[/^var\((--[\w-]+)\)$/.exec(v)[1]];
  return v;
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [what it is, foreground token, background tokens (the first that is a colour counts), minimum]
// 4.5 for text, 3 for large text (the counter digits) and for the edges and fills that make a control visible.
const CARDS = ['standard', 'recomandare', 'optiune', 'ghid'];
const PAIRS = [
  ['Body text on the page', '--ink', ['--bg'], 4.5],
  ['Body text on a surface (tables, fields, panels)', '--ink', ['--surface'], 4.5],
  ['Text on the subtle fill (tags, code, page badges)', '--ink', ['--surface-2'], 4.5],
  ['Secondary text on the page', '--muted', ['--bg'], 4.5],
  ['Secondary text on a surface', '--muted', ['--surface'], 4.5],
  ['Placeholder in a field', '--muted', ['--field-bg'], 4.5],
  ['Secondary text in a note or the current conversation', '--muted', ['--note-bg', '--bg'], 4.5],
  ['Links and accent text on the page', '--accent-ink', ['--bg'], 4.5],
  ['Links and accent text on a panel', '--accent-ink', ['--panel-bg', '--bg'], 4.5],
  ['Header title', '--on-chrome', ['--chrome'], 4.5],
  ['Tab label', '--tab-ink', ['--tabs-bg'], 4.5],
  ['Current tab label (and its focus ring)', '--tab-on-ink', ['--tab-on-bg', '--tabs-bg'], 4.5],
  ['Primary button', '--on-accent', ['--accent'], 4.5],
  ['Plain button', '--btn-ink', ['--btn-bg'], 4.5],
  ['Text button on the page', '--ghost-ink', ['--bg'], 4.5],
  ['Text button on a panel', '--ghost-ink', ['--panel-bg', '--bg'], 4.5],
  ['Chip (starters, follow-ups)', '--chip-ink', ['--chip-bg'], 4.5],
  ['Segment', '--seg-ink', ['--seg-bg', '--seg-track', '--bg'], 4.5],
  ['Chosen segment', '--seg-on-ink', ['--seg-on-bg'], 4.5],
  ['Send button', '--on-hot', ['--hot'], 4.5],
  ['Stop and delete buttons', '--on-danger', ['--danger-fill'], 4.5],
  ['Error text on the page', '--danger', ['--bg'], 4.5],
  ['Error text on a surface', '--danger', ['--surface'], 4.5],
  ['The CNP warning above the composer', '--danger', ['--surface'], 4.5],
  ['Edge of the CNP warning against the composer', '--danger-fill', ['--composer-bg'], 3],
  ['Text in "Din ghiduri" and in the review card', '--ink', ['--note-bg', '--bg'], 4.5],
  ['Her message', '--bubble-ink', ['--bubble-bg'], 4.5],
  ['Urgent mark', '--stamp-ink', ['--stamp-bg', '--composer-bg'], 4.5],
  ['Urgent mark above her message', '--stamp-ink', ['--stamp-bg', '--bg'], 4.5],
  ['Toast text', '--toast-ink', ['--toast-bg'], 4.5],
  ['Toast action', '--toast-act', ['--toast-bg'], 4.5],
  ['Table header', '--th-ink', ['--th-bg', '--surface'], 4.5],
  ['Counter text', '--counter-ink', ['--counter-bg', '--bg'], 4.5],
  ['Counter secondary text', '--counter-muted', ['--counter-bg', '--bg'], 4.5],
  ['Counter digits (large)', '--num', ['--digit-bg', '--counter-bg', '--bg'], 3],
  ['Counter small numbers', '--num-2', ['--counter-bg', '--bg'], 4.5],
  ['Highlighted words', '--mark-ink', ['--mark'], 4.5],
  ['Text in a highlighted passage', '--ink', ['--hit-bg'], 4.5],
  ...CARDS.flatMap((c) => [
    [`Card "${c}": text`, '--ink', [`--c-${c}-bg`], 4.5],
    [`Card "${c}": explanation`, '--muted', [`--c-${c}-bg`], 4.5],
    [`Card "${c}": kind label`, `--c-${c}-ink`, [`--c-${c}-tag`, `--c-${c}-bg`], 4.5],
    [`Card "${c}": grade and page`, `--c-${c}-meta`, [`--c-${c}-bg`], 4.5],
  ]),
  ['Field edge against the page', '--field-line', ['--bg'], 3],
  ['Field edge against a surface', '--field-line', ['--surface'], 3],
  ['Switch edge, off', '--switch-line', ['--bg'], 3],
  ['Focus ring on the page', '--focus', ['--bg'], 3],
  ['Focus ring on a surface', '--focus', ['--surface'], 3],
  ['Focus ring on the header', '--focus-chrome', ['--chrome'], 3],
  ['Focus ring on the tab bar', '--focus-chrome', ['--tabs-bg'], 3],
  ['Primary fill against the page (button, switch on, chosen look)', '--accent', ['--bg'], 3],
  ['Chosen segment against the others', '--seg-on-bg', ['--seg-bg', '--seg-track', '--bg'], 3],
  ['Send button against the composer', '--hot', ['--composer-bg'], 3],
  ['Progress fill against the page', '--ok', ['--bg'], 3],
  ['Urgent bar against the composer', '--urgent', ['--composer-bg'], 3],
];
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v ?? '');

function rows(tokens) {
  return PAIRS.map(([label, fg, bgs, min]) => {
    const f = value(tokens, fg);
    const b = bgs.map((t) => value(tokens, t)).find(isHex);
    assert.ok(isHex(f) && b, `${label}: ${fg} (${f}) on ${bgs.join('/')} must be plain hex colours`);
    return { label, fg: f, bg: b, min, ratio: contrast(f, b) };
  });
}

for (const look of LOOKS) for (const [theme, tokens] of [['light', light(look)], ['dark', dark(look)]]) {
  test(`contrast: ${look}, ${theme}`, () => {
    const bad = rows(tokens).filter((r) => r.ratio < r.min).map((r) => `${r.label}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)} (needs ${r.min})`);
    assert.deepEqual(bad, []);
  });
}

test('every look defines the same tokens (a look is one complete block)', () => {
  const base = Object.keys(light('fisa')).sort();
  for (const look of LOOKS.slice(1)) assert.deepEqual(Object.keys(light(look)).sort(), base, look);
  for (const look of LOOKS) {
    const extra = Object.keys(block(`[data-look="${look}"][data-theme="dark"]`)).filter((k) => !base.includes(k));
    assert.deepEqual(extra, [], `${look} dark sets tokens the light block does not have`);
  }
});

test('components use tokens only: no colour or font names after the token blocks', () => {
  const at = css.indexOf('COMPONENTS. Tokens only from here on.');
  assert.ok(at > 0);
  const rest = css.slice(at).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/gi) ?? [], []);
  const fonts = [...rest.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/g)].map((m) => m[1]).filter((v) => !/var\(--[\w-]*font|inherit/.test(v));
  assert.deepEqual(fonts, []);
});

test('the font files named in app.css exist, and every font file is used', () => {
  const used = [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(WEB, 'fonts')).filter((f) => f.endsWith('.woff2')).sort();
  assert.deepEqual(used, onDisk);
  for (const lic of ['atkinson-hyperlegible-next', 'courier-prime', 'source-sans-3', 'protest-strike']) assert.ok(fs.existsSync(path.join(WEB, 'fonts', 'licenses', `${lic}-OFL.txt`)), lic);
});

test('theme.js and the look picker name exactly the looks app.css has', () => {
  const names = (file, re) => JSON.parse(re.exec(fs.readFileSync(path.join(WEB, file), 'utf8'))[1].replace(/'/g, '"'));
  assert.deepEqual(names('theme.js', /var LOOKS = (\[[^\]]+\])/), LOOKS);
  const picker = [...fs.readFileSync(path.join(WEB, 'views', 'mai-mult.js'), 'utf8').matchAll(/^\s+\['(\w+)', '[^']+', '[^']+'\],$/gm)].map((m) => m[1]);
  assert.deepEqual(picker, LOOKS);
});

test('the default look is instrument: the fallback, the page before the script, the manifest and the icon agree', () => {
  assert.equal(LOOKS[0], 'instrument');
  // theme.js falls back to the first look, and only when nothing valid is saved
  const theme = fs.readFileSync(path.join(WEB, 'theme.js'), 'utf8');
  assert.match(theme, /root\.dataset\.look = LOOKS\.indexOf\(s\.aspect\) >= 0 \? s\.aspect : LOOKS\[0\];/);
  // without data-look (no script yet) the page takes the default's tokens, and no other look claims :root
  assert.match(plain, /:root:not\(\[data-look\]\), \[data-look="instrument"\] \{/);
  assert.doesNotMatch(plain, /:root, \[data-look=/);
  const t = light('instrument');
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.background_color, t['--bg']);
  assert.equal(m.theme_color, t['--chrome']);
  assert.match(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), new RegExp(`<meta name="theme-color" content="${t['--chrome']}">`));
  for (const icon of ['icon.svg', 'icon-maskable.svg']) assert.ok(fs.readFileSync(path.join(WEB, 'icons', icon), 'utf8').includes(`fill="${t['--accent']}"`), icon);
});

if (process.env.CONTRAST_TABLE) {
  const cols = LOOKS.flatMap((look) => [[`${look} light`, rows(light(look))], [`${look} dark`, rows(dark(look))]]);
  const out = [`| Pair | Min | ${cols.map((c) => c[0]).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`];
  PAIRS.forEach(([label, , , min], i) => out.push(`| ${label} | ${min} | ${cols.map((c) => c[1][i].ratio.toFixed(1)).join(' | ')} |`));
  const all = cols.flatMap((c) => c[1]);
  out.push('', `Lowest text ratio: ${Math.min(...all.filter((r) => r.min === 4.5).map((r) => r.ratio)).toFixed(2)}. Lowest edge or fill ratio: ${Math.min(...all.filter((r) => r.min === 3).map((r) => r.ratio)).toFixed(2)}.`);
  console.log(out.join('\n'));
}
