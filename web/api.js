// Browser-side helpers shared by every view: the JSON API, localStorage, the toast and session events.
import { h, render } from './vendor/preact-11.2.0.mjs';
import htm from './vendor/htm-3.1.1.mjs';

export const html = htm.bind(h);
export { h, render };

// One event bus for app-wide signals: 'unauthorized', 'toast', 'lightbox', 'net', 'registru'.
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// fetch() throws a TypeError without a network: those errors have no status (see isOffline).
// Every call also reports whether the server answered ('net'), so the offline banner shows on
// Wi-Fi without internet too, where navigator.onLine stays true.
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    emit('net', false);
    throw err;
  }
  emit('net', true);
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/login') emit('unauthorized');
  if (!res.ok) throw Object.assign(new Error(data?.error || `http_${res.status}`), { status: res.status, data });
  return data;
}

export const isOffline = (err) => !err?.status;

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('rokhan:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem('rokhan:' + key);
      else localStorage.setItem('rokhan:' + key, JSON.stringify(value));
    } catch {}
  },
};

// toast({ text, line, action: { label, run }, ms })
export const toast = (t) => emit('toast', t);

// Opens the chat with a prepared draft (from a lesson or a guideline).
export function askRokhan(text) {
  store.set('draft-in', text);
  location.hash = '#/intreaba';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls fn each time the app comes back to the front. Returns the function that stops it.
export function onVisible(fn) {
  const run = () => document.visibilityState === 'visible' && fn();
  document.addEventListener('visibilitychange', run);
  return () => document.removeEventListener('visibilitychange', run);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older iOS or no permission: select-and-copy through a temporary field.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  }
}
