// Loads the system prompt once. Edit prompt/system.md, not this file.
import fs from 'node:fs';

let cached;
export function systemPrompt() {
  cached ??= fs.readFileSync(new URL('./prompt/system.md', import.meta.url), 'utf8').trim();
  return cached;
}
