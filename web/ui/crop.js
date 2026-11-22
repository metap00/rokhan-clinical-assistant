// Full-screen crop step before a photo is attached. Drag the rectangle or its corners (touch or mouse).
import { html } from '../api.js';
import { useEffect, useRef, useState } from '../vendor/preact-hooks-11.2.0.mjs';
import { applyDrag, cropPlan, FULL } from '../lib/crop.js';

function toDataUrl(img, r) {
  const p = cropPlan(r, img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs would turn black in JPEG
  ctx.fillRect(0, 0, p.w, p.h);
  ctx.drawImage(img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.w, p.h);
  return c.toDataURL('image/jpeg', 0.85);
}

export function CropView({ file, onDone, onCancel }) {
  const [src, setSrc] = useState(null);
  const [rect, setRect] = useState(FULL);
  const [failed, setFailed] = useState(false);
  const img = useRef(null);
  const drag = useRef(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setSrc(u);
    setFailed(false);
    setRect(FULL);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onCancel]);

  const down = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const box = img.current.getBoundingClientRect();
    drag.current = { mode, x0: e.clientX, y0: e.clientY, r0: rect, bw: box.width, bh: box.height };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (d) setRect(applyDrag(d.r0, d.mode, (e.clientX - d.x0) / d.bw, (e.clientY - d.y0) / d.bh));
  };
  const up = () => (drag.current = null);
  const handlers = (mode) => ({ onPointerDown: down(mode), onPointerMove: move, onPointerUp: up, onPointerCancel: up });
  const finish = (r) => onDone(toDataUrl(img.current, r));
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  const box = { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };

  return html`<div class="crop" role="dialog" aria-modal="true" aria-label="Decupează poza">
    <p class="crop-note">Decupează doar ce trebuie citit. Fără nume, CNP sau alte date ale pacientei.</p>
    <div class="crop-stage">
      ${failed ? html`<p class="crop-fail">Poza nu se poate deschide. Încearcă alt fișier.</p>` : src && html`
        <div class="crop-frame">
          <img ref=${img} src=${src} alt="Poza aleasă" draggable="false" onError=${() => setFailed(true)} />
          <div class="crop-dim"><div class="crop-shade" style=${box} /></div>
          <div class="crop-rect" style=${box} ...${handlers('move')}>
            ${['nw', 'ne', 'sw', 'se'].map((c) => html`<span key=${c} class=${'crop-h ' + c} ...${handlers(c)} />`)}
          </div>
        </div>`}
    </div>
    <div class="crop-actions">
      <button class="btn primary" type="button" disabled=${failed || !src} onClick=${() => finish(rect)}>Folosește decuparea</button>
      <button class="btn" type="button" disabled=${failed || !src} onClick=${() => finish(FULL)}>Toată poza</button>
      <button class="btn ghost" type="button" onClick=${onCancel}>Renunță</button>
    </div>
  </div>`;
}
