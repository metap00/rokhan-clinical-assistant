import fs from 'node:fs';
import path from 'node:path';
import { sendFile } from '../http/router.mjs';
import { httpError } from '../store/files.mjs';

export default function register(app) {
  const dir = path.join(app.config.dataDir, 'uploads');

  app.get('/api/uploads/:convId/:fileId', async (c) => {
    const { convId, fileId } = c.params;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(convId) || !/^[a-f0-9]{24}$/.test(fileId)) throw httpError(404, 'negasit');
    for (const ext of ['jpg', 'png', 'webp']) {
      const file = path.join(dir, convId, `${fileId}.${ext}`);
      if (fs.existsSync(file)) return sendFile(c.res, file, 'private, max-age=31536000, immutable');
    }
    throw httpError(404, 'negasit');
  });
}
