import { Worker } from 'node:worker_threads';

export function runWorker(workerData, onProgress) {
  const worker = new Worker(new URL('./index-worker.js', import.meta.url), { workerData });
  return new Promise((resolve, reject) => {
    worker.on('message', (m) => (m.progress ? onProgress?.(m.progress) : resolve(m.result)));
    worker.once('error', reject);
  });
}

export const pdfOptions = (config) => ({
  ...(config.pdfMaxPages ? { maxPages: config.pdfMaxPages } : {}),
  ...(config.previewMaxBytes ? { maxFileBytes: config.previewMaxBytes } : {}),
});

// 索引放到 worker 跑，全量扫描时阅读请求不被阻塞；同一时刻只跑一个
export function createIndexRunner(config, { onProgress } = {}) {
  let running = null;
  let queuedFull = false;

  function hold(job) {
    running = job.finally(() => {
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
    return hold(runWorker({ dataDir: config.dataDir, root: config.root, denyGlobs: config.denyGlobs, full, pdf: pdfOptions(config) }, onProgress));
  }

  // 换库收尾时占住索引位，防止旧目录的扫描和它交错。这期间 run() 的调用方拿到的是 task 的结果，所以 task 要返回索引结果
  async function exclusive(task) {
    while (running) await running.catch(() => {});
    return hold(Promise.resolve().then(task));
  }

  return { run, exclusive, get running() { return Boolean(running); }, idle: () => running ?? Promise.resolve() };
}
