import { Worker } from 'node:worker_threads';

// 索引放到 worker 跑，全量扫描时阅读请求不被阻塞；同一时刻只跑一个
export function createIndexRunner(config, { onProgress } = {}) {
  let running = null;
  let queuedFull = false;

  function start(full) {
    const worker = new Worker(new URL('./index-worker.js', import.meta.url), {
      workerData: { dataDir: config.dataDir, root: config.root, denyGlobs: config.denyGlobs, full },
    });
    running = new Promise((resolve, reject) => {
      worker.on('message', (m) => (m.progress ? onProgress?.(m.progress) : resolve(m.result)));
      worker.once('error', reject);
    }).finally(() => {
      running = null;
      if (queuedFull) {
        queuedFull = false;
        run({ full: true }).catch(() => console.error('索引失败'));
      }
    });
    return running;
  }

  function run({ full = false } = {}) {
    if (running) {
      if (full) queuedFull = true;
      return running;
    }
    return start(full);
  }

  return { run, get running() { return Boolean(running); }, idle: () => running ?? Promise.resolve() };
}
