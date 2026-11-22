// Markdown (marked + DOMPurify), mermaid diagrams (loaded on demand) and svg fences shown through <img>.
import { html, emit } from '../api.js';
import { useEffect, useState } from '../vendor/preact-hooks-11.2.0.mjs';
import { marked } from '../vendor/marked-18.2.1.mjs';
import DOMPurify from '../vendor/dompurify-3.4.18.mjs';
import { splitBlocks } from '../lib/blocks.js';

// Model answers, memory pages and guideline text are untrusted. Raw HTML inside Markdown is shown
// as text (never parsed), and DOMPurify still cleans what marked produces.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
marked.setOptions({ gfm: true, breaks: false });
marked.use({ renderer: { html: (token) => esc(token.text ?? token.raw ?? '') } });
const PURIFY = {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'meta', 'base', 'link', 'style', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'source'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction'],
};
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Tables get a wrapper that scrolls sideways. The replace runs on sanitised output, where a literal
// "<table>" can only be a real tag (text is escaped).
export function mdToHtml(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? '')), PURIFY)
    .replace(/<table>/g, '<div class="tw"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

export const inlineMd = (text) => DOMPurify.sanitize(marked.parseInline(String(text ?? '')), PURIFY);

// Guideline page markers "[p. 14]" become badges after rendering (digits only, so this adds no markup
// from the text itself).
export const pageBadges = (h) => h.replace(/\[p\. ?(\d+)(?:[–-](\d+))?\]/g, (_, a, b) => `<span class="pg">p. ${a}${b ? '-' + b : ''}</span>`);

// Server HTML that may only carry <mark> highlights (search fragments, lesson cards).
export const marksOnly = (s) => DOMPurify.sanitize(String(s ?? ''), { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] });

export function Md({ text, class: cls = 'md' }) {
  return html`<div class=${cls} dangerouslySetInnerHTML=${{ __html: mdToHtml(text) }} />`;
}

export function Answer({ text }) {
  return html`<div class="answer">
    ${splitBlocks(text).map((s) =>
      s.type === 'md' ? html`<${Md} text=${s.text} />`
      : s.type === 'sources' ? html`<p class="sources" dangerouslySetInnerHTML=${{ __html: inlineMd(s.text) }} />`
      : s.open ? html`<p class="diagram-wait">Desenez…</p>`
      : s.type === 'svg' ? html`<${Diagram} src=${svgDataUrl(s.code)} />`
      : html`<${Mermaid} code=${s.code} />`)}
  </div>`;
}

// Never injected into the DOM: an <img> cannot run script.
function svgDataUrl(code) {
  const svg = code.trim().replace(/^<svg(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function Diagram({ src }) {
  return html`<button class="diagram" type="button" aria-label="Deschide desenul pe tot ecranul" onClick=${() => emit('lightbox', src)}>
    <img src=${src} alt="Desen" />
  </button>`;
}

let mermaidP = null;
function loadMermaid() {
  mermaidP ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid-12.3.0.min.js';
    s.onload = () => {
      // Drawings take the colours of the look that is active when the first one is drawn.
      const css = getComputedStyle(document.documentElement);
      const t = (name) => css.getPropertyValue(name).trim();
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          darkMode: document.documentElement.dataset.theme === 'dark',
          background: t('--surface'), primaryColor: t('--surface-2'), primaryTextColor: t('--ink'), primaryBorderColor: t('--accent-ink'),
          lineColor: t('--muted'), secondaryColor: t('--surface-2'), tertiaryColor: t('--surface'), edgeLabelBackground: t('--surface'),
        },
        htmlLabels: false, // plain SVG text, so the drawing also renders inside an <img>
        flowchart: { htmlLabels: false },
        fontFamily: 'system-ui, sans-serif',
      });
      resolve(window.mermaid);
    };
    s.onerror = () => {
      mermaidP = null;
      reject(new Error('mermaid'));
    };
    document.head.append(s);
  });
  return mermaidP;
}

let seq = 0;
const rendered = new Map(); // code -> data URL, so the stored answer does not redraw what the stream drew
function Mermaid({ code }) {
  const [state, setState] = useState(() => (rendered.has(code) ? { src: rendered.get(code) } : {}));
  useEffect(() => {
    if (rendered.has(code)) return setState({ src: rendered.get(code) });
    let live = true;
    loadMermaid()
      .then((m) => m.render(`mmd-${++seq}`, code))
      .then(({ svg }) => {
        const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        rendered.set(code, src);
        if (live) setState({ src });
      })
      .catch(() => live && setState({ failed: true }));
    return () => (live = false);
  }, [code]);
  if (state.src) return html`<${Diagram} src=${state.src} />`;
  if (state.failed) return html`<div class="diagram-fail"><p>Desenul nu a putut fi afișat.</p><pre>${code}</pre></div>`;
  return html`<p class="diagram-wait">Desenez…</p>`;
}
