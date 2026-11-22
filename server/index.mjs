import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createApp } from './http/router.mjs';
import { getAuth } from './http/auth.mjs';
import { getConversations } from './store/conversations.mjs';
import { getAgent, getDeps } from './store/deps.mjs';

// Data files hold her notes and photos: readable by the service user only.
process.umask(0o077);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_SUBDIRS = ['library', 'lessons', 'memory', 'conversations', 'uploads', 'agent-cwd'];

// Starts the HTTP server for a config (port 0 picks a free one). Resolves { server, url, close }.
export async function startServer(config) {
  if (!config.password) throw new Error('ROKHAN_PASSWORD is required');
  for (const d of DATA_SUBDIRS) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
  getAuth(config); // checks secret.key and loads the sessions; throws on a damaged key
  if (!config.publicOrigin && !isLoopback(config.host)) {
    console.warn(`[rokhan] warning: listening on ${config.host} without ROKHAN_PUBLIC_ORIGIN: no Origin check and no Secure cookie. Set it when the app is reachable from other machines.`);
  }
  const recovered = getConversations(config).recoverInterrupted();
  if (recovered) console.log(`[rokhan] closed ${recovered} interrupted turn(s)`);

  const app = createApp(config);
  const routesDir = path.join(HERE, 'routes');
  for (const f of fs.readdirSync(routesDir).filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(path.join(routesDir, f)).href);
    mod.default(app);
  }

  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const { port } = server.address();
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;

  let jobs;
  const scheduler = path.join(HERE, 'jobs', 'scheduler.mjs');
  if (!config.fakeLlm && fs.existsSync(scheduler)) {
    const { startJobs } = await import(pathToFileURL(scheduler).href);
    jobs = await startJobs({ config, deps: await getDeps(config), agent: await getAgent(config) });
  }

  async function close() {
    if (typeof jobs?.stop === 'function') jobs.stop();
    server.closeAllConnections?.(); // SSE streams would otherwise keep close() waiting
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return { server, url, port, close };
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!config.password) {
    console.error('ROKHAN_PASSWORD is not set. Put it in .env (see .env.example) or the environment.');
    process.exit(1);
  }
  const { url, close } = await startServer(config).catch((err) => {
    console.error(`[rokhan] cannot start: ${err.message}`);
    process.exit(1);
  });
  console.log(`[rokhan] listening on ${url} (data: ${config.dataDir}, model: ${config.fakeLlm ? 'fake' : config.model})`);
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[rokhan] ${sig}, shutting down`);
    close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
