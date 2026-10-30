import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONVERT_EXTS = new Set(['pptx', 'ppt', 'doc', 'docx', 'odp']);
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const CONCURRENCY = 2; // soffice 按 UserInstallation 互斥，每个槽位一份配置目录
const FAIL_TTL_MS = 60 * 60 * 1000; // 坏文件不用每次打开都白等一轮，但超时可能只是当时机器忙，过一阵可以再试
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const MAC_APP = '/Applications/LibreOffice.app/Contents/MacOS/soffice';

const canRun = (bin) => {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// KB_SOFFICE 配了就只认它：写错路径时回退到别的版本，比明确告诉人「没装」更难查
export function findSoffice(env = process.env) {
  if (env.KB_SOFFICE) return canRun(env.KB_SOFFICE) ? env.KB_SOFFICE : null;
  const names = ['soffice', 'libreoffice'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const found = dirs.flatMap((dir) => names.map((name) => path.join(dir, name))).find(canRun);
  return found ?? (canRun(MAC_APP) ? MAC_APP : null);
}

export const previewKey = (rel, stat) => createHash('sha1').update(`${rel}\0${Math.floor(stat.mtimeMs)}\0${stat.size}`).digest('hex');

export function createConverter({ dataDir, soffice = null, timeoutMs = DEFAULT_TIMEOUT_MS, cacheBytes = DEFAULT_CACHE_BYTES, now = Date.now }) {
  const dir = path.join(dataDir, 'previews');
  const jobs = new Map();
  const waiting = [];
  const idleSlots = Array.from({ length: CONCURRENCY }, (_, i) => i);
  const running = new Set();
  let closed = false;

  if (soffice) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 上次进程退出时没收尾的工作目录
    for (const name of fs.readdirSync(dir)) if (name.startsWith('.job-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }

  const pdfPath = (key) => path.join(dir, `${key}.pdf`);
  const failPath = (key) => path.join(dir, `${key}.fail`);
  const profileOf = (slot) => path.join(dir, `.profile-${slot}`);

  function readFailure(key) {
    try {
      const fail = JSON.parse(fs.readFileSync(failPath(key), 'utf8'));
      return now() - fail.at < FAIL_TTL_MS ? fail : null;
    } catch {
      return null;
    }
  }

  // 按「最近被打开」淘汰：atime 在 noatime 挂载上不可靠，所以打开时自己 touch mtime
  function evict(keep) {
    const pdfs = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.startsWith('.')) continue;
      const stat = fs.statSync(full);
      if (name.endsWith('.fail')) { if (now() - stat.mtimeMs > FAIL_TTL_MS) fs.rmSync(full, { force: true }); }
      else if (name.endsWith('.pdf')) pdfs.push({ full, size: stat.size, used: stat.mtimeMs });
    }
    let total = pdfs.reduce((sum, p) => sum + p.size, 0);
    for (const pdf of pdfs.sort((a, b) => a.used - b.used)) {
      if (total <= cacheBytes) break;
      if (pdf.full === keep) continue;
      fs.rmSync(pdf.full, { force: true });
      total -= pdf.size;
    }
  }

  function killGroup(child) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* 已经退出 */ }
  }

  // soffice 是 shell 包装脚本套 oosplash 再套 soffice.bin，只杀 child 会留下真正干活的进程，所以要单开进程组。
  // 环境变量只给白名单：进程要打开库里的任意文档，KB_PASSWORD、AI_API_KEY 这些没有理由让它看到
  function runSoffice(input, outDir, slot) {
    const profile = profileOf(slot);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const child = spawn(soffice, [
      '--headless', '--norestore', '--nologo', '--nodefault', '--nofirststartwizard',
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to', 'pdf', '--outdir', outDir, input,
    ], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: profile, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: outDir } });
    running.add(child);
    return new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
        // 只清锁不删目录：首次建配置目录要几十秒，慢机器上删了就是每次都冷启动、每次都超时
        fs.rmSync(path.join(profile, '.lock'), { force: true });
      }, timeoutMs);
      const settle = (reason) => {
        clearTimeout(timer);
        running.delete(child);
        resolve(reason);
      };
      child.once('error', () => settle('spawn'));
      child.once('close', (code) => settle(timedOut ? 'timeout' : code === 0 ? null : 'crash'));
    });
  }

  // soffice 打不开文件时退出码也是 0，只能看产物
  function isPdf(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      return head.toString('latin1') === '%PDF-';
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // 拷一份再转：soffice 会在文档旁边写 .~lock，库目录不能被写；文件名固定也避开了 C 语系下的中文路径问题
  async function convert(job, slot) {
    let work = null;
    try {
      work = fs.mkdtempSync(path.join(dir, '.job-'));
      const input = path.join(work, `input.${job.ext}`);
      await fs.promises.copyFile(job.full, input);
      const reason = await runSoffice(input, work, slot);
      if (closed) return;
      const output = path.join(work, 'input.pdf');
      if (reason || !isPdf(output)) {
        fs.writeFileSync(failPath(job.key), JSON.stringify({ reason: reason ?? 'no-output', at: now() }));
        return;
      }
      fs.renameSync(output, pdfPath(job.key));
      evict(pdfPath(job.key));
    } catch {
      if (!closed) fs.writeFileSync(failPath(job.key), JSON.stringify({ reason: 'io', at: now() }));
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  }

  function pump() {
    while (!closed && idleSlots.length && waiting.length) {
      const job = waiting.shift();
      const slot = idleSlots.shift();
      job.startedAt = now();
      convert(job, slot).catch(() => console.error('文档转换失败')).finally(() => {
        idleSlots.push(slot);
        jobs.delete(job.key);
        pump();
      });
    }
  }

  const pendingState = (job) => (job.startedAt === null
    ? { state: 'queued', ahead: waiting.indexOf(job) + CONCURRENCY - idleSlots.length, elapsedMs: 0 }
    : { state: 'running', ahead: 0, elapsedMs: now() - job.startedAt });

  // 幂等：页面和轮询都走这里，服务重启丢了队列也能自己接上
  function request(rel, full, ext) {
    const stat = fs.statSync(full);
    const key = previewKey(rel, stat);
    const pdf = pdfPath(key);
    if (fs.existsSync(pdf)) {
      if (now() - fs.statSync(pdf).mtimeMs > TOUCH_EVERY_MS) fs.utimesSync(pdf, new Date(now()), new Date(now()));
      return { state: 'ready', key, pdf };
    }
    const failed = readFailure(key);
    if (failed) return { state: 'failed', key, reason: failed.reason };
    let job = jobs.get(key);
    if (!job) {
      job = { key, full, ext, startedAt: null };
      jobs.set(key, job);
      waiting.push(job);
      pump();
    }
    return { key, ...pendingState(job) };
  }

  function close() {
    closed = true;
    waiting.length = 0;
    for (const child of running) killGroup(child);
  }

  return { enabled: Boolean(soffice), request, close };
}
