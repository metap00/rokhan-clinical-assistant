// Runs extract() off the server's thread (review finding 3). fetch-url.mjs starts one worker per document and
// terminates it when the conversion takes too long.
import { parentPort, workerData } from 'node:worker_threads';
import { extract } from './fetch-url.mjs';

try {
  const { body, contentType, baseUrl } = workerData;
  parentPort.postMessage({ value: await extract(Buffer.from(body.buffer, body.byteOffset, body.byteLength), contentType, baseUrl) });
} catch (e) {
  parentPort.postMessage({ error: { code: e?.code ?? 'format', message: e?.code ? e.message : 'Documentul nu a putut fi citit.' } });
}
