import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { runIndex } from './indexer.js';

const { dataDir, root, denyGlobs, full } = workerData;
const db = openDb(dataDir);
try {
  const onProgress = (progress) => parentPort.postMessage({ progress });
  parentPort.postMessage({ result: runIndex({ db, root, deny: createDeny(denyGlobs), full, onProgress }) });
} finally {
  db.close();
}
