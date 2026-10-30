import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { adoptIndex, indexAll } from './indexer.js';

const { dataDir, dbFile, root, denyGlobs, full, adoptFrom, pdf } = workerData;
const db = openDb(dataDir, dbFile);
try {
  const onProgress = (progress) => parentPort.postMessage({ progress });
  const result = adoptFrom ? adoptIndex({ db, file: adoptFrom }) : await indexAll({ db, root, deny: createDeny(denyGlobs), full, onProgress, pdf });
  parentPort.postMessage({ result });
} finally {
  db.close();
}
