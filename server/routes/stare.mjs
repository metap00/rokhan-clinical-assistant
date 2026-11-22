import fs from 'node:fs';
import path from 'node:path';

export default function register(app) {
  const { config } = app;
  const versiune = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
  app.get('/api/stare', async () => ({ versiune, fakeLlm: !!config.fakeLlm, model: config.model }));
}
