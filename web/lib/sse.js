// Incremental text/event-stream parser. feed(chunk) returns the complete frames seen so far:
// [{ event, data }], data parsed as JSON when it is JSON. Comment lines (": hb") are skipped.
export function createSseParser() {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    const out = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      let parsed = data.join('\n');
      try {
        parsed = JSON.parse(parsed);
      } catch {}
      out.push({ event, data: parsed });
    }
    return out;
  };
}
