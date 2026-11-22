// Crop rectangle maths. Rectangles are fractions of the image: { x, y, w, h } in 0..1.
export const MIN = 0.05;
export const FULL = { x: 0, y: 0, w: 1, h: 1 }; // default rectangle: the whole picture
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// mode: 'move' or a corner 'nw' | 'ne' | 'sw' | 'se'; dx, dy are fractions of the image size.
export function applyDrag(r, mode, dx, dy) {
  if (mode === 'move') {
    return { x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h), w: r.w, h: r.h };
  }
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - MIN);
  if (mode.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, 1);
  if (mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - MIN);
  if (mode.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, 1);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Pixel source rectangle and output size (long side at most `max`).
export function cropPlan(r, naturalW, naturalH, max = 1600) {
  const sx = Math.round(r.x * naturalW), sy = Math.round(r.y * naturalH);
  const sw = Math.max(1, Math.round(r.w * naturalW)), sh = Math.max(1, Math.round(r.h * naturalH));
  const k = Math.min(1, max / Math.max(sw, sh));
  return { sx, sy, sw, sh, w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
}
