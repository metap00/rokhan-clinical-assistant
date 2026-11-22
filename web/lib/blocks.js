// Splits an answer into segments the UI renders differently:
//   { type: 'md', text }                 ordinary Markdown
//   { type: 'mermaid' | 'svg', code, open }   a fenced diagram; open = the closing fence has not arrived yet
//   { type: 'sources', text }            the trailing "Surse:" line
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/;
const DIAGRAMS = new Set(['mermaid', 'svg']);
const SOURCES = /^\s*(\*\*|__)?surse\s*:/i;

export function splitBlocks(text) {
  const out = [];
  let md = [];
  let fence = null; // { marker, lang, lines } while inside any fence
  const flushMd = () => {
    if (md.length) out.push({ type: 'md', text: md.join('\n') });
    md = [];
  };
  for (const line of String(text ?? '').split('\n')) {
    if (fence) {
      const close = line.trim();
      if (close.startsWith(fence.marker) && /^(`+|~+)$/.test(close) && close[0] === fence.marker[0]) {
        if (DIAGRAMS.has(fence.lang)) out.push({ type: fence.lang, code: fence.lines.join('\n'), open: false });
        else md.push(line);
        fence = null;
      } else if (DIAGRAMS.has(fence.lang)) fence.lines.push(line);
      else md.push(line);
      continue;
    }
    const m = FENCE.exec(line);
    if (m) {
      fence = { marker: m[1], lang: m[2].toLowerCase(), lines: [] };
      if (DIAGRAMS.has(fence.lang)) flushMd();
      else md.push(line);
      continue;
    }
    md.push(line);
  }
  if (fence && DIAGRAMS.has(fence.lang)) out.push({ type: fence.lang, code: fence.lines.join('\n'), open: true });
  flushMd();

  // A last non-empty line starting with "Surse:" becomes its own segment.
  const last = out.at(-1);
  if (last?.type === 'md') {
    const lines = last.text.replace(/\s+$/, '').split('\n');
    if (SOURCES.test(lines.at(-1))) {
      const src = lines.pop();
      last.text = lines.join('\n');
      if (!last.text.trim()) out.pop();
      out.push({ type: 'sources', text: src.trim() });
    }
  }
  return out.filter((s) => s.type !== 'md' || s.text.trim());
}

// Guideline text comes from PDF extraction: deep indents (which Markdown would turn into code blocks)
// and runs of spaces from column layout. Flatten both ("[p. N]" badges are added after rendering).
export function cleanGuideText(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/[ \t ]{2,}/g, ' '))
    .join('\n');
}
