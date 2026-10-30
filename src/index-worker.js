import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { adoptIndex, runIndex } from './indexer.js';

const { dataDir, dbFile, root, denyGlobs, full, adoptFrom } = workerData;
const db = openDb(dataDir, dbFile);
try {
  const onProgress = (progress) => parentPort.postMessage({ progress });
  const result = adoptFrom ? adoptIndex({ db, file: adoptFrom }) : runIndex({ db, root, deny: createDeny(denyGlobs), full, onProgress });
  parentPort.postMessage({ result });
} finally {
  db.close();
}
