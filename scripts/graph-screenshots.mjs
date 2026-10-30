// 关系图的截图与性能打点。
// 默认：生成虚构的 1547 篇演示库，截图进 docs/screenshots（截图绝不使用真实知识库）。
// 传 GRAPH_ORIGIN + KB_PASSWORD 时改连已启动的服务，截图写到 GRAPH_OUT（默认 /tmp/kb-graph/shots），不进仓库。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../src/app.js';
import { effectiveDenyGlobs } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { runIndex } from '../src/indexer.js';

const DIRS = ['05.工作', '00.收件箱', '03.公司', '07.人员', '01.财务', '02.计划', '06.团队', '08.社会', '04.生活', '09.归档'];
const SIZES = [470, 290, 255, 165, 137, 121, 50, 30, 20, 9];

function makeLibrary(root) {
  let serial = 0;
  const all = [];
  DIRS.forEach((dir, d) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (let i = 0; i < SIZES[d]; i++) all.push({ dir, name: `${dir.slice(3)}笔记${++serial}` });
  });
  // 少数枢纽笔记 + 一串小团，边数和真实库同一量级
  const links = new Map();
  const link = (a, b) => { if (a !== b) links.set(a, [...(links.get(a) ?? []), b]); };
  const hubs = [10, 480, 760, 1030, 1200, 1340];
  let seed = 7;
  const next = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (const hub of hubs) for (let i = 0; i < 16; i++) link(hub, hub + 1 + i);
  for (let i = 0; i < 24; i++) link(hubs[next(hubs.length)], hubs[next(hubs.length)] + 1 + next(16));
  for (let i = 0; i < 30; i++) { const a = 200 + i * 20; link(a, a + 1); link(a + 1, a + 2); }
  all.forEach((n, i) => {
    const body = (links.get(i) ?? []).map((t) => `[[${all[t].name}]]`).join('、');
    fs.writeFileSync(path.join(root, n.dir, `${n.name}.md`), `# ${n.name}\n\n${body || '这是一篇虚构的示例笔记。'}\n`);
  });
  fs.writeFileSync(path.join(root, DIRS[0], `${all[11].name}.md`), `# ${all[11].name}\n\n[[${all[10].name}]]\n\n测试环境 password: demo-only-1234\n`);
}

let origin = process.env.GRAPH_ORIGIN;
let password = process.env.KB_PASSWORD;
let out = process.env.GRAPH_OUT ?? '/tmp/kb-graph/shots';
let teardown = async () => {};
if (!origin) {
  const base = path.resolve('data/demo-graph');
  out = path.resolve('docs/screenshots');
  fs.rmSync(base, { recursive: true, force: true });
  makeLibrary(path.join(base, 'library'));
  password = 'demo-password';
  const config = {
    root: path.join(base, 'library'), dataDir: path.join(base, 'data'), password, baseUrl: 'http://localhost', port: 0,
    denyGlobs: effectiveDenyGlobs(), ownerName: '示例团队', trustProxy: 0, cookieSecure: false, aiProvider: 'off',
    timeZone: 'Asia/Shanghai', zipMaxBytes: 1e9, scanIntervalMs: 0,
  };
  const kb = await createApp(config);
  runIndex({ db: kb.db, root: config.root, deny: createDeny(config.denyGlobs) });
  const server = await new Promise((resolve) => { const s = kb.app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  teardown = async () => {
    server.closeAllConnections();
    server.close();
    kb.close();
    fs.rmSync(base, { recursive: true, force: true });
  };
}
fs.mkdirSync(out, { recursive: true });

const problems = [];
const report = { perf: [] };
const browser = await chromium.launch({ channel: 'chrome' });

async function newPage(width, opts = {}) {
  const mobile = width === 375;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: mobile ? 3 : 1, hasTouch: mobile, isMobile: mobile, colorScheme: 'light', ...opts,
  });
  const page = await context.newPage();
  // 统计真实发生的重绘及其 JS 耗时：rAF 稳定在 60 不代表画了东西，必须和这个一起看
  await page.addInitScript(() => {
    window.__draws = [];
    let drew = false;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function patched(...args) {
      drew = true;
      return clear.apply(this, args);
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      drew = false;
      const at = performance.now();
      cb(t);
      // 绘制命令默认延后光栅；开 __flush 时用读回逼它当场画完，量到的才是含光栅的总耗时
      if (drew && window.__flush) document.querySelector('#graph-canvas').getContext('2d').getImageData(0, 0, 1, 1);
      if (drew) window.__draws.push(performance.now() - at);
    });
  });
  page.on('console', (m) => {
    // getImageData 是这个脚本自己找节点用的，页面不调用它
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('willReadFrequently')) problems.push(`${width} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  await page.goto(`${origin}/login`);
  await page.fill('input[name=password]', password);
  await Promise.all([page.waitForURL(`${origin}/`), page.click('button[type=submit]')]);
  return { context, page };
}

const ready = (page) => page.waitForFunction(() => performance.getEntriesByName('kb-graph-first-draw').length > 0);
const settle = (page) => page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); }));

async function checkWidth(page, width, name) {
  const m = await page.evaluate(() => ({ body: document.body.scrollWidth, doc: document.documentElement.scrollWidth, inner: innerWidth }));
  if (m.body !== m.inner || m.doc !== m.inner) problems.push(`${width} ${name}: 横向溢出 ${JSON.stringify(m)}`);
  return m;
}

const hasTouch = (page) => page.viewportSize().width === 375;
const expectState = async (page, pattern, label) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#graph-stats').textContent), pattern.source, { timeout: 4000 })
    .catch(() => problems.push(`${label}: 状态行不符合 ${pattern}`));
};

// 找一个屏幕上的节点：从页面暴露不了内部状态，就用 canvas 像素找连接数最大的那个
async function tapBiggestNode(page) {
  const box = await page.locator('#graph-canvas').boundingBox();
  const point = await page.evaluate(() => {
    const c = document.querySelector('#graph-canvas');
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const scale = c.width / c.getBoundingClientRect().width;
    const barBottom = document.querySelector('#graph-bar').getBoundingClientRect().bottom - c.getBoundingClientRect().top;
    let best = null;
    const step = Math.round(4 * scale);
    for (let y = step; y < height - step; y += step) {
      if (y / scale < barBottom + 8) continue;
      for (let x = step; x < width - step; x += step) {
        let solid = 0;
        for (const [dx, dy] of [[0, 0], [step, 0], [-step, 0], [0, step], [0, -step]]) {
          const o = ((y + dy) * width + x + dx) * 4;
          if (data[o + 3] > 200 && Math.max(data[o], data[o + 1], data[o + 2]) - Math.min(data[o], data[o + 1], data[o + 2]) > 60) solid++;
        }
        if (solid === 5 && (!best || solid > best.solid)) best = { x: x / scale, y: y / scale, solid };
      }
    }
    return best;
  });
  if (!point) throw new Error('没在画布上找到节点');
  const at = { x: box.x + point.x, y: box.y + point.y };
  if (hasTouch(page)) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  return at;
}

for (const width of [375, 1440]) {
  const { context, page } = await newPage(width);
  const shot = async (name) => {
    await settle(page);
    const size = await checkWidth(page, width, name);
    if (width === 375) report[`scroll-${name}`] = size;
    await page.screenshot({ path: path.join(out, `graph-${name}-${width}.png`) });
  };
  await page.goto(`${origin}/graph`);
  await ready(page);
  await shot('default');
  if (await page.locator('#graph-back').isVisible()) problems.push(`${width} 全图上不该有返回按钮`);

  if (width === 375) await page.click('#graph-fold');
  await page.check('#graph-all');
  if (width === 375) await page.click('#graph-fold');
  await shot('all');
  if (width === 375) await page.click('#graph-fold');
  const before = await page.evaluate(() => window.__draws.length);
  const firstDir = page.locator('.graph-dir').first();
  await firstDir.click();
  if ((await firstDir.getAttribute('aria-pressed')) !== 'false') problems.push(`${width} 图例隐藏无效`);
  await firstDir.click();
  await settle(page);
  if ((await page.evaluate(() => window.__draws.length)) === before) problems.push(`${width} 图例点击没有重绘`);
  await page.uncheck('#graph-all');
  if (width === 375) await page.click('#graph-fold');
  await settle(page);

  await tapBiggestNode(page);
  await page.waitForSelector('#graph-sheet:not([hidden])', { timeout: 3000 });
  await page.waitForTimeout(250);
  await shot('sheet');
  const href = await page.getAttribute('#graph-sheet-open', 'href');
  if (!/^\/v\//.test(href)) problems.push(`${width} 打开笔记链接不对: ${href}`);

  await page.click('#graph-sheet-focus');
  await page.waitForFunction(() => new URLSearchParams(location.search).has('focus'));
  await page.waitForFunction(() => /2 跳内/.test(document.querySelector('#graph-stats').textContent));
  await page.waitForTimeout(300);
  await shot('focus');
  if (await page.locator('#graph-sheet').isVisible()) problems.push(`${width} 聚焦后 sheet 没关`);

  await page.click('#graph-back');
  await page.waitForFunction(() => !location.search);
  await expectState(page, /篇有连接/, `${width} 返回全图`);
  await page.goBack();
  await expectState(page, /2 跳内/, `${width} 浏览器后退`);

  // 阅读页 → 图谱
  await page.goto(origin + href);
  await page.click('a[href^="/graph?focus="]');
  await expectState(page, /2 跳内/, `${width} 阅读页入口`);

  // 聚焦到不存在的路径
  await page.goto(`${origin}/graph?focus=nope.md`);
  await expectState(page, /篇有连接/, `${width} 降级全图`);
  if (!(await page.locator('#graph-missing').isVisible())) problems.push(`${width} 没有降级提示`);

  // 双击与长按
  await page.goto(`${origin}/graph`);
  await ready(page);
  await settle(page);
  const target = await tapBiggestNode(page);
  await page.waitForSelector('#graph-sheet:not([hidden])');
  await page.click('#graph-sheet-close');
  await page.waitForTimeout(400);
  if (hasTouch(page)) {
    await page.touchscreen.tap(target.x, target.y);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(target.x, target.y);
  } else await page.mouse.dblclick(target.x, target.y);
  await expectState(page, /2 跳内/, `${width} 双击聚焦`);
  await page.goBack();
  await expectState(page, /篇有连接/, `${width} 双击后退`);
  await page.waitForTimeout(100);
  if (hasTouch(page)) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expectState(page, /2 跳内/, '375 长按聚焦');
  } else {
    // 滚轮缩放
    await page.mouse.move(700, 500);
    const drawn = await page.evaluate(() => window.__draws.length);
    await page.mouse.wheel(0, -300);
    await settle(page);
    if ((await page.evaluate(() => window.__draws.length)) === drawn) problems.push('1440 滚轮没有重绘');
  }

  // 深色：画布的颜色要跟着切换，不刷新
  await page.goto(`${origin}/graph`);
  await ready(page);
  await page.click('#theme-toggle');
  await shot('dark');
  await context.close();
}

// 敏感笔记的 sheet、空态、错误态、失效登录：用真实页面 + 拦截接口
{
  const { context, page } = await newPage(375);
  await page.route('**/graph/data', async (r) => {
    const res = await r.fetch();
    const json = await res.json();
    json.nodes.forEach((n) => { n.sensitive = 1; });
    await r.fulfill({ response: res, json });
  });
  await page.goto(`${origin}/graph`);
  await ready(page);
  await settle(page);
  await tapBiggestNode(page);
  await page.waitForSelector('#graph-sheet:not([hidden])');
  await page.waitForTimeout(250);
  if (!(await page.locator('#graph-sheet-sensitive', { hasText: '含敏感内容，AI 与分享已禁用' }).isVisible())) problems.push('敏感标注缺失');
  await page.screenshot({ path: path.join(out, 'graph-sensitive-375.png') });
  await context.close();

  const empty = await newPage(375);
  await empty.page.route('**/graph/data', (r) => r.fulfill({ json: { nodes: [], edges: [], stats: { nodes: 0, linked: 0, edges: 0, isolated: 0 } } }));
  await empty.page.goto(`${origin}/graph`);
  await empty.page.waitForSelector('#graph-state:not([hidden]) strong');
  if (!(await empty.page.textContent('#graph-state')).includes('还没有双链')) problems.push('空态文案缺失');
  await empty.page.screenshot({ path: path.join(out, 'graph-empty-375.png') });
  await empty.context.close();

  const failing = await newPage(375);
  let calls = 0;
  await failing.page.route('**/graph/data', (r) => (++calls === 1 || calls === 3 ? r.fulfill({ status: 503, body: 'x' }) : r.continue()));
  await failing.page.goto(`${origin}/graph`);
  await failing.page.waitForSelector('#graph-state button');
  if (!(await failing.page.textContent('#graph-state')).includes('HTTP 503')) problems.push('错误态文案缺失');
  await failing.page.screenshot({ path: path.join(out, 'graph-error-375.png') });
  await failing.page.click('#graph-state button');
  await ready(failing.page);
  if (await failing.page.locator('#graph-state').isVisible()) problems.push('重试后错误态没消失');
  // 这一条是故意触发的 503
  for (let i = problems.length - 1; i >= 0; i--) if (problems[i].includes('503')) problems.splice(i, 1);
  await failing.context.close();

  // 打开页面后登录失效：fetch 被 302 到登录页，不能当成 JSON 解析崩掉
  const expired = await newPage(375);
  let first = true;
  await expired.page.route('**/graph/data', (r) => {
    if (first) { first = false; return r.fulfill({ status: 503, body: 'x' }); }
    return r.continue();
  });
  await expired.page.goto(`${origin}/graph`);
  await expired.page.waitForSelector('#graph-state button');
  await expired.context.clearCookies();
  await expired.page.click('#graph-state button');
  await expired.page.waitForSelector('#graph-state a[href^="/login"]', { timeout: 3000 }).catch(() => problems.push('登录过期没有提示'));
  for (let i = problems.length - 1; i >= 0; i--) if (problems[i].includes('503')) problems.splice(i, 1);
  await expired.context.close();
}

// 性能：全量 1547 节点，375 + 3 倍屏，CPU 降速模拟手机
for (const rate of [1, 4, 6]) {
  const { context, page } = await newPage(375);
  await page.goto(`${origin}/graph`);
  await page.evaluate(() => localStorage.setItem('kb-graph-all', '1'));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto(`${origin}/graph`);
  await ready(page);
  const marks = await page.evaluate(() => Object.fromEntries(['kb-graph-data', 'kb-graph-layout', 'kb-graph-first-draw']
    .map((n) => [n.replace('kb-graph-', ''), Math.round(performance.getEntriesByName(n)[0]?.startTime ?? -1)])));
  const nodeCount = await page.evaluate(() => fetch('/graph/data').then((r) => r.json()).then((d) => d.nodes.length));
  const pixels = () => page.evaluate(() => {
    const c = document.querySelector('#graph-canvas');
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.reduce((sum, v, i) => (sum + v * (i % 97)) % 1000003, 0);
  });
  const hashBefore = await pixels();

  const box = await page.locator('#graph-canvas').boundingBox();
  await page.evaluate(() => {
    window.__draws.length = 0;
    window.__frames = [];
    let last = performance.now();
    const loop = (now) => {
      window.__frames.push(now - last);
      last = now;
      window.__raf = requestAnimationFrame(loop);
    };
    window.__raf = requestAnimationFrame(loop);
  });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
  for (let i = 0; i < 120; i++) {
    await touch('touchMove', [{ x: cx + 70 * Math.sin(i / 9), y: cy + 90 * Math.cos(i / 7), id: 1 }]);
    await page.waitForTimeout(8);
  }
  await touch('touchEnd', []);
  await touch('touchStart', [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }]);
  for (let i = 0; i < 90; i++) {
    const d = 40 + 90 * Math.abs(Math.sin(i / 14));
    await touch('touchMove', [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }]);
    await page.waitForTimeout(8);
  }
  await touch('touchEnd', []);
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames.slice(2); });
  const draws = await page.evaluate(() => [...window.__draws].sort((a, b) => a - b));
  if (draws.length < 60) problems.push(`${rate}x 手势只触发了 ${draws.length} 次重绘，帧率数字不可信`);
  if ((await pixels()) === hashBefore) problems.push(`${rate}x 手势后画面没有变化`);
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(sorted.length * p)];
  report.perf.push({
    cpu: `${rate}x 降速`, nodes: nodeCount, ...marks,
    frames: frames.length,
    fpsMedian: Math.round(1000 / pct(0.5)), fpsP5: Math.round(1000 / pct(0.95)), worstMs: Math.round(sorted.at(-1)),
    framesOver50ms: frames.filter((f) => f > 50).length,
    draws: draws.length, drawMedianMs: +draws[draws.length >> 1].toFixed(2), drawMaxMs: +draws.at(-1).toFixed(2),
  });
  await context.close();
}

// 含光栅的绘制耗时：读回会让 Chrome 退到软件光栅，比真机 GPU 悲观，当上界看
{
  const { context, page } = await newPage(375);
  await page.goto(`${origin}/graph`);
  await page.evaluate(() => localStorage.setItem('kb-graph-all', '1'));
  await page.goto(`${origin}/graph`);
  await ready(page);
  await page.evaluate(() => { window.__flush = true; window.__draws.length = 0; });
  const cdp = await context.newCDPSession(page);
  const cx = 187;
  const cy = 400;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
  for (let i = 0; i < 120; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 60 * Math.sin(i / 9), y: cy + 80 * Math.cos(i / 7), id: 1 }] });
    await page.waitForTimeout(8);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const draws = await page.evaluate(() => [...window.__draws].sort((a, b) => a - b));
  report.rasterBound = { draws: draws.length, medianMs: +draws[draws.length >> 1].toFixed(1), p95Ms: +draws[Math.floor(draws.length * 0.95)].toFixed(1), maxMs: +draws.at(-1).toFixed(1) };
  await context.close();
}

await browser.close();
await teardown();
console.log(JSON.stringify(report, null, 1));
console.log(problems.length ? `问题：\n${[...new Set(problems)].join('\n')}` : '无横向溢出，无 console / CSP 报错');
