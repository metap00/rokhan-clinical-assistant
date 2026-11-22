import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getRegistru } from './registru.mjs';
import { getMemorie } from './memorie.mjs';
import { getConversations } from './conversations.mjs';

// The services handed to the agent and the jobs. library and lessons belong to
// another worker: imported only when their files exist, otherwise left undefined.
async function optional(rel, fn, config) {
  const url = new URL(rel, import.meta.url);
  if (!fs.existsSync(fileURLToPath(url))) return undefined;
  return (await import(url.href))[fn](config);
}

const deps = new WeakMap();
const agents = new WeakMap();

export function getDeps(config) {
  if (!deps.has(config)) {
    deps.set(config, (async () => ({
      registru: getRegistru(config),
      memorie: getMemorie(config),
      conversations: getConversations(config),
      library: await optional('../library/index.mjs', 'getLibrary', config),
      lessons: await optional('../lessons/index.mjs', 'getLessons', config),
    }))());
  }
  return deps.get(config);
}

// Built once per config: fake for tests and UI work, the real Agent SDK module otherwise.
export function getAgent(config) {
  if (!agents.has(config)) {
    agents.set(config, (async () => {
      const mod = await import(config.fakeLlm ? '../llm/fake.mjs' : '../llm/agent.mjs');
      return mod.createAgent({ config, deps: await getDeps(config) });
    })());
  }
  return agents.get(config);
}
