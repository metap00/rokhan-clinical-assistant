// "Văzute 3 din 268" over its bar.
import { html } from '../api.js';

export function Progress({ label, n, total }) {
  const text = `${label} ${n} din ${total}`;
  return html`<div class="progress-line">
    <p>${text}</p>
    <div class="bar-track" role="progressbar" aria-label=${text} aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${n}><span style=${{ width: (total ? (100 * n) / total : 0) + '%' }} /></div>
  </div>`;
}
