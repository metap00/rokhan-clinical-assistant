// Fixtures of the vendored pipeline tests (invented units; the 4-9 min length cap is lifted for them, as the original test world did).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SOGR_LENGTH_LIMITS = '0,99';
const here = path.dirname(fileURLToPath(import.meta.url));
export const readFixtureJson = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'content', 'sogr', name), 'utf8'));
