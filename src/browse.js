import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { modeOf } from './about.js';
import { isIgnoredEntry } from './indexer.js';
import { PathRejected } from './paths.js';
import { dataDirProblemOf } from './setup.js';

export const MAX_DIRS = 200;
export const MAX_MD = 5000;
const MAX_PATH = 4096;
const MAX_QUERY = 100;
const MAX_HINTS = 8;
// 单个目录最多看这么多项：一堆非 md 文件永远数不到 5000，要有别的办法停下来
const MAX_ENTRIES = 100000;
// 整个请求的统计预算，到点把数到多少就报多少。列目录本身不受影响
const COUNT_BUDGET_MS = 700;
const CONCURRENCY = 8;

const MOUNTINFO = '/proc/self/mountinfo';
// 这些文件系统类型是容器自己的，不是用户挂进来的
const SYSTEM_FS = new Set(['overlay', 'proc', 'sysfs', 'tmpfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2', 'devtmpfs', 'shm']);
const SYSTEM_PREFIX = ['/proc', '/sys', '/dev'];

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const fold = (s) => s.normalize('NFC').toLowerCase();
const isHidden = (name) => name.startsWith('.');

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// mountinfo 里空格等写成 \040 这样的八进制转义
const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const mountPoint = unescapeMount(line.slice(0, sep).split(' ')[4] ?? '');
    const [fsType] = line.slice(sep + 3).split(' ');
    if (!mountPoint.startsWith('/') || mountPoint === '/' || SYSTEM_FS.has(fsType)) continue;
    if (SYSTEM_PREFIX.some((p) => mountPoint === p || mountPoint.startsWith(`${p}/`))) continue;
    out.push(mountPoint);
  }
  return out;
}

// 非 Docker 时机器上的挂载（/boot、/home）和知识库无关，读不到时也一样退回 KB_ROOTS。/etc/hosts 这类是挂进来的文件，不算
export function probeMounts({ inDocker, file = MOUNTINFO }) {
  if (!inDocker) return [];
  try {
    return parseMountinfo(fs.readFileSync(file, 'utf8')).filter((p) => fs.statSync(p).isDirectory());
  } catch {
    return [];
  }
}

// 不写探测文件：用户的库不能因为打开一个页面就多出东西。只读挂载返回 EROFS
async function isWritable(dir) {
  try {
    await fsp.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// 口径和 indexer 一致：不跟随符号链接、deny 目录不进入、后缀不分大小写，所以这个数就是选中后能索引到的篇数。
// 边数边写进 row：预算到点时已经数到的不丢。row.rel 是相对浏览根的路径，deny 规则要带着它算
async function countMd(row, deny, stopped) {
  const stack = [[row.real, row.rel]];
  let entries = 0;
  const stop = () => { row.more = true; };
  while (stack.length) {
    if (stopped()) return stop();
    const [abs, rel] = stack.pop();
    let list;
    try {
      list = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      if (abs === row.real) row.unreadable = true;
      continue;
    }
    for (const entry of list) {
      if (isIgnoredEntry(entry)) continue;
      if (++entries > MAX_ENTRIES) return stop();
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!deny.isDenied(childRel, { isDir: true })) stack.push([path.join(abs, entry.name), childRel]);
      } else if (entry.isFile() && /.\.md$/i.test(entry.name) && !deny.isDenied(childRel)) {
        if (row.mdCount === MAX_MD) return stop();
        row.mdCount++;
      }
    }
  }
  row.done = true;
}

async function pool(items, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
}

// 空的根不算：Debian 系镜像自带空的 /mnt、/media，算上的话「什么都没挂」永远不成立
async function usableRoots(roots, mounts) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    try {
      const real = await fsp.realpath(root);
      if (seen.has(real) || !(await fsp.stat(real)).isDirectory()) continue;
      const list = await fsp.readdir(real, { withFileTypes: true });
      if (!list.some((e) => !isHidden(e.name)) && !mounts.includes(root)) continue;
      seen.add(real);
      out.push(root);
    } catch { /* 根不存在或读不了就不显示 */ }
  }
  return out;
}

export function createBrowser({ roots, mounts = [], deny, dataDir, inDocker = false, soffice = null }) {
  const configured = roots.map((r) => path.resolve(r));

  // 顺序不能换：
  // 1. 字面检查：必须是绝对路径，有 `..`、控制字符、反斜杠就拒绝，不做“修正”
  // 2. path.resolve 后按路径段比较前缀，确定落在哪个根里，这一步不碰文件系统，根外的路径是否存在无从探测
  // 3. 隐藏目录、deny 规则：名字就能判断的先判断
  // 4. realpath 必须等于「根的真实路径 + 相对路径」，所以根内任何一段是符号链接都拒绝，指向哪里都一样
  // 任何一步失败都是同一个 PathRejected：不存在、是文件、没权限、符号链接都不可区分
  async function locate(input) {
    if (typeof input !== 'string' || input.length > MAX_PATH || !path.isAbsolute(input)) throw new PathRejected();
    if (/[\x00-\x1f\x7f\\]/.test(input) || input.split('/').includes('..')) throw new PathRejected();
    const resolved = path.resolve(input);
    const root = configured.filter((r) => isInside(r, resolved)).sort((a, b) => b.length - a.length)[0];
    if (!root) throw new PathRejected();
    const rel = path.relative(root, resolved);
    const segments = rel ? rel.split(path.sep) : [];
    if (segments.some(isHidden) || (rel && deny.isDenied(segments.join('/'), { isDir: true }))) throw new PathRejected();
    let real;
    try {
      const realRoot = await fsp.realpath(root);
      real = await fsp.realpath(resolved);
      if (real !== path.join(realRoot, rel) || !(await fsp.stat(real)).isDirectory()) throw new PathRejected();
    } catch {
      throw new PathRejected();
    }
    return { root, rel: segments.join('/'), real, resolved, segments };
  }

  function crumbsOf({ root, segments }) {
    const crumbs = [{ name: root, path: root }];
    let current = root;
    for (const name of segments) {
      current = path.join(current, name);
      crumbs.push({ name, path: current });
    }
    return crumbs;
  }

  async function subdirs({ real, rel }) {
    let list;
    try {
      list = await fsp.readdir(real, { withFileTypes: true });
    } catch {
      throw new PathRejected();
    }
    return list.filter((e) => {
      if (!e.isDirectory() || isIgnoredEntry(e) || isHidden(e.name)) return false;
      return !deny.isDenied(rel ? `${rel}/${e.name}` : e.name, { isDir: true });
    }).map((e) => e.name);
  }

  // 预算到点就不再等：readdir 卡在网络盘上时，已经数到的数字照样能返回
  async function fillCounts(rows) {
    let expired = false;
    let timer;
    const counting = pool(rows, (item) => countMd(item, deny, () => expired));
    await Promise.race([counting, new Promise((resolve) => { timer = setTimeout(resolve, COUNT_BUDGET_MS); })]);
    clearTimeout(timer);
    expired = true;
    for (const item of rows) item.more ||= !item.done;
  }

  const row = async (name, target, real, rel) => ({
    name, path: target, real, rel, mdCount: 0, more: false, unreadable: false, writable: await isWritable(real),
  });
  const publicRow = ({ name, path: target, mdCount, more, unreadable, writable }) => ({ name, path: target, mdCount, more, unreadable, writable });

  // 能不能当知识库由预检裁决，这里只把必然被拒的（数据目录本身、包着它的目录）从提示里拿掉
  function hintable(dir) {
    try {
      return !dataDirProblemOf(fs.realpathSync(dir), dataDir);
    } catch {
      return false;
    }
  }

  async function reachable(dirs) {
    const checks = await Promise.all(dirs.map((dir) => locate(dir).then(() => dir, () => null)));
    return checks.filter(Boolean);
  }

  async function hints(usable) {
    const browsable = (dir) => configured.some((r) => isInside(r, dir));
    const inRoots = await reachable(mounts.filter(browsable));
    // /mnt 只因为里面挂了 /mnt/nas 才非空时，提示 /mnt/nas 就够了
    const plain = usable.filter((r) => !mounts.some((m) => m !== r && isInside(r, m)));
    const candidates = [...new Set([...inRoots, ...plain])].filter(hintable).sort(collator.compare).slice(0, MAX_HINTS);
    const rows = await Promise.all(candidates.map((dir) => row(dir, dir, fs.realpathSync(dir), '')));
    await fillCounts(rows);
    // 挂了但不在 KB_ROOTS 里：浏览范围不能悄悄放宽，只说清楚为什么点不进去
    return { selectable: rows.map(publicRow), elsewhere: mounts.filter((m) => !browsable(m)).filter(hintable).sort(collator.compare) };
  }

  const command = () => `docker run -d --name kb -p 3030:3030 \\\n  -v "/你的/笔记目录:/data/library:ro" -v kb-data:/data yihu-knowledge:${modeOf(soffice)}`;

  async function top({ q }) {
    const usable = await usableRoots(configured, mounts);
    const matched = usable.filter((dir) => fold(dir).includes(q));
    const rows = await Promise.all(matched.slice(0, MAX_DIRS).map(async (dir) => row(dir, dir, await fsp.realpath(dir), '')));
    const [info] = await Promise.all([hints(usable), fillCounts(rows)]);
    return {
      path: '', crumbs: [], dirs: rows.map(publicRow), currentMdCount: 0, currentMore: false, writable: false, total: usable.length, matched: matched.length, truncated: false,
      hints: info, inDocker, command: info.selectable.length || info.elsewhere.length ? null : command(),
    };
  }

  async function list({ path: input, q: rawQuery }) {
    const q = fold(String(rawQuery ?? '').slice(0, MAX_QUERY).trim());
    if (input === undefined || input === '') return top({ q });
    const place = await locate(input);
    const names = await subdirs(place);
    // 先过滤再截断：第 201 个之后的目录也要搜得到
    const matched = q ? names.filter((name) => fold(name).includes(q)) : names;
    const shown = matched.sort(collator.compare).slice(0, MAX_DIRS);
    const rows = await Promise.all(shown.map((name) => row(name, path.join(place.resolved, name), path.join(place.real, name), place.rel ? `${place.rel}/${name}` : name)));
    const current = { real: place.real, rel: place.rel, mdCount: 0, more: false };
    await fillCounts([current, ...rows]);
    return {
      path: place.resolved, crumbs: crumbsOf(place), dirs: rows.map(publicRow), currentMdCount: current.mdCount, currentMore: current.more,
      writable: await isWritable(place.real), total: names.length, matched: matched.length, truncated: matched.length > MAX_DIRS,
    };
  }

  return { list, locate };
}

export function browseHandler(browserOf) {
  return async (req, res) => {
    try {
      res.json(await browserOf().list({ path: req.query.path, q: req.query.q }));
    } catch (err) {
      if (!(err instanceof PathRejected)) console.error(`目录浏览失败: ${err.name} ${err.code ?? ''}`);
      res.status(403).json({ error: 'forbidden' });
    }
  };
}
