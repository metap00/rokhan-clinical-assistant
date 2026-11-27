// Line icons, 24×24, drawn with currentColor. Decorative: the button around them carries the label.
// Stroke weight, caps and joins come from the look (--ico-w, --ico-cap, --ico-join in app.css).
import { html } from '../api.js';

const P = {
  chat: 'M4 5h16v11H9l-5 4z',
  registru: 'M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM6 3v18M9 8h6M9 12h6',
  lecturi: 'M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1zM12 6v14',
  ghiduri: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.5-1 2.5 15.5-3.5 1z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h13M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  back: 'M15 5l-7 7 7 7',
  share: 'M12 4v11M8 8l4-4 4 4M5 13v7h14v-7',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4 4',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  down: 'M6 9l6 6 6-6',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  check: 'M5 13l4 4L19 7',
};

export function Icon({ name }) {
  const dots = name === 'more' || name === 'dots';
  return html`<svg class=${dots ? 'ico dots' : 'ico'} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${P[name]} /></svg>`;
}
