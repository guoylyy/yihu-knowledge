// 阅读器手势端到端验收。文件路径从环境变量传，真实库的路径和截图都不进仓库
//   ZOOM_ORIGIN=http://localhost:3051 ZOOM_PASSWORD=... ZOOM_PDF=库内路径 ZOOM_PPT=库内路径 ZOOM_OUT=/tmp/shots node scripts/zoom-check.mjs
// Chromium 走 CDP 的真实触摸管线；WebKit 没有多点触摸注入，捏合用合成 TouchEvent，只验证事件处理，不经过系统手势识别
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';

const { ZOOM_ORIGIN: origin, ZOOM_PASSWORD: password, ZOOM_PDF: pdf, ZOOM_PPT: ppt, ZOOM_OUT: out = '/tmp/zoom-check' } = process.env;
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const url = (file) => `${origin}/v/${file.split('/').map(encodeURIComponent).join('/')}`;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 当前页的尺寸、滚动和页码。cssWidth/pixelWidth 取视口里第一张已渲染的 canvas
const read = (page) => page.evaluate(() => {
  const scroller = document.querySelector('.pdfv-scroll');
  const n = Number(document.querySelector('.pdfv-input').value);
  const canvas = document.querySelector(`.pdfv-page[data-n="${n}"] canvas`);
  const bar = document.querySelector('.pdfv-bar').getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return {
    page: n, cssWidth: canvas?.getBoundingClientRect().width, pixelWidth: canvas?.width,
    left: scroller.scrollLeft, top: scroller.scrollTop, maxLeft: scroller.scrollWidth - scroller.clientWidth,
    zoomed: scroller.classList.contains('pdfv-zoomed'), pinching: scroller.classList.contains('pdfv-pinching'),
    transform: document.querySelector('.pdfv-pages').style.transform, pageScale: visualViewport.scale,
    overflow: document.documentElement.scrollWidth - innerWidth, barClear: view.bottom <= bar.top + 0.5 || bar.bottom <= view.top + 0.5,
    fit: document.querySelector('[data-act="fit"]').textContent, out: document.querySelector('[data-act="zoom-out"]').disabled,
    smallest: Math.min(...[...document.querySelectorAll('.pdfv-bar button')].map((b) => Math.min(b.offsetWidth, b.offsetHeight))),
  };
});

// 松手后 canvas 换成新比例为止
async function rendered(page, before, label) {
  await page.waitForFunction((was) => {
    const n = document.querySelector('.pdfv-input').value;
    const canvas = document.querySelector(`.pdfv-page[data-n="${n}"] canvas`);
    return canvas && canvas.width !== was;
  }, before, { timeout: 15000 }).catch(() => console.log(`      （等 ${label} 重绘超时）`));
  await pause(300);
}

const contentAt = (page, x, y) => page.evaluate(({ x, y }) => {
  const scroller = document.querySelector('.pdfv-scroll');
  const box = scroller.getBoundingClientRect();
  const hit = [...document.querySelectorAll('.pdfv-page')].find((el) => { const r = el.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
  const r = hit.getBoundingClientRect();
  return { n: hit.dataset.n, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, inView: x >= box.left && x <= box.right };
}, { x, y });

async function touchDriver(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  return {
    pinch: (x, y, scaleFactor) => cdp.send('Input.synthesizePinchGesture', { x, y, scaleFactor, relativeSpeed: 800, gestureSourceType: 'touch' }),
    async twoFingers(x, y, from, to, { hold } = {}) {
      await send('touchStart', [[x - from, y], [x + from, y]]);
      for (let i = 1; i <= 8; i++) {
        const d = from + ((to - from) * i) / 8;
        await send('touchMove', [[x - d, y], [x + d, y]]);
        await pause(16);
      }
      await pause(50);
      const during = hold ? await hold() : null;
      await send('touchEnd', []);
      return during;
    },
    async swipe(x0, y0, x1, y1) {
      await send('touchStart', [[x0, y0]]);
      for (let i = 1; i <= 8; i++) {
        await send('touchMove', [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]);
        await pause(16);
      }
      await send('touchEnd', []);
      await pause(300);
    },
    async doubleTap(x, y) {
      for (let i = 0; i < 2; i++) {
        await send('touchStart', [[x, y]]);
        await send('touchEnd', []);
        await pause(80);
      }
    },
  };
}

// WebKit：在页面里按真实顺序派发 TouchEvent。到不了系统手势层，所以这里不验证原生滚动和浏览器捏合
const webkitDriver = (page) => {
  const fire = (type, active, changed = active) => page.evaluate(({ type, active, changed }) => {
    const target = document.querySelector('.pdfv-page');
    const touch = ([x, y], identifier) => ({ identifier, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: active.map(touch) });
    Object.defineProperty(event, 'changedTouches', { value: changed.map(touch) });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, active, changed });
  return {
    fire,
    async twoFingers(x, y, from, to, { hold } = {}) {
      await fire('touchstart', [[x - from, y]]);
      await fire('touchstart', [[x - from, y], [x + from, y]]);
      let claimed = true;
      for (let i = 1; i <= 8; i++) {
        const d = from + ((to - from) * i) / 8;
        claimed &&= await fire('touchmove', [[x - d, y], [x + d, y]]);
        await pause(16);
      }
      await pause(50);
      const during = hold ? await hold() : null;
      await fire('touchend', [[x + to, y]], [[x - to, y]]);
      await fire('touchend', [], [[x + to, y]]);
      return { during, claimed };
    },
    async swipe(x0, y0, x1, y1) {
      await fire('touchstart', [[x0, y0]]);
      for (let i = 1; i <= 8; i++) {
        await fire('touchmove', [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]);
        await pause(16);
      }
      await fire('touchend', [], [[x1, y1]]);
      await pause(300);
    },
    async doubleTap(x, y) {
      for (let i = 0; i < 2; i++) {
        await fire('touchstart', [[x, y]]);
        await fire('touchend', [], [[x, y]]);
        await pause(80);
      }
    },
  };
};

async function open(page, file) {
  await page.goto(url(file));
  await page.waitForSelector('#pdfv[data-ready]', { timeout: 180000 });
  await page.waitForSelector('.pdfv-page canvas', { timeout: 30000 });
  await pause(800);
  return page.evaluate(() => Number(document.querySelector('#pdfv').dataset.ready));
}

// 每帧记录 canvas 还在不在，证明重绘期间没闪白
const watchBlank = (page) => page.evaluate(() => {
  window.__blank = 0;
  window.__watch = true;
  const scroller = document.querySelector('.pdfv-scroll');
  const tick = () => {
    if (!window.__watch) return;
    const box = scroller.getBoundingClientRect();
    const hit = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 3).find((el) => el.classList.contains('pdfv-page'));
    if (hit && !hit.querySelector('canvas')) window.__blank++;
    requestAnimationFrame(tick);
  };
  tick();
});
const blankFrames = (page) => page.evaluate(() => { window.__watch = false; return window.__blank; });

async function mobileChromium(browser, file, tag) {
  console.log(`\n== Chromium 375×667 dpr3：${tag} ==`);
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/login`);
  await page.fill('input[type=password]', password);
  await page.press('input[type=password]', 'Enter');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
  const total = await open(page, file);
  const touch = await touchDriver(page);
  const box = await page.evaluate(() => { const r = document.querySelector('.pdfv-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

  const base = await read(page);
  console.log('页数', total, '初始', base);
  check('初始缩小按钮禁用', base.out === true);
  check('工具栏按钮 ≥44px', base.smallest >= 44, base.smallest);
  check('无横向溢出（初始）', base.overflow <= 0, base.overflow);
  await page.screenshot({ path: path.join(out, `${tag}-1-before.png`) });

  // 捏合过程：transform 预览、canvas 不重绘、浏览器不缩放
  const anchorBefore = await contentAt(page, box.x, box.y);
  await watchBlank(page);
  const during = await touch.twoFingers(box.x, box.y, 40, 120, { hold: () => read(page) });
  console.log('捏合中', { transform: during.transform, pixelWidth: during.pixelWidth, pinching: during.pinching, pageScale: during.pageScale });
  check('捏合中用 transform 预览', /scale\(3/.test(during.transform) && during.pinching, during.transform);
  check('捏合中不重绘 canvas', during.pixelWidth === base.pixelWidth, [base.pixelWidth, during.pixelWidth]);
  check('捏合中浏览器页面不缩放', during.pageScale === 1, during.pageScale);
  await rendered(page, base.pixelWidth, '捏合');
  const zoomed = await read(page);
  console.log('捏合后', { cssWidth: zoomed.cssWidth, pixelWidth: zoomed.pixelWidth, fit: zoomed.fit });
  const anchorAfter = await contentAt(page, box.x, box.y);
  console.log('锚点', anchorBefore, '→', anchorAfter);
  check('CSS 宽约 3 倍', Math.abs(zoomed.cssWidth / base.cssWidth - 3) < 0.05, zoomed.cssWidth / base.cssWidth);
  check('松手后重渲染变清晰（像素宽变大）', zoomed.pixelWidth > base.pixelWidth * 1.3, [base.pixelWidth, zoomed.pixelWidth]);
  check('重绘期间无空白帧', await blankFrames(page) === 0);
  check('锚点不跑（同页，偏差 <2%）', anchorBefore.n === anchorAfter.n && Math.abs(anchorBefore.fx - anchorAfter.fx) < 0.02 && Math.abs(anchorBefore.fy - anchorAfter.fy) < 0.02);
  check('放大后按钮显示复位，缩小可用', zoomed.fit === '复位' && !zoomed.out);
  check('工具栏不遮挡内容', zoomed.barClear);
  check('放大后无横向溢出', zoomed.overflow <= 0, zoomed.overflow);
  await page.screenshot({ path: path.join(out, `${tag}-2-pinched.png`) });

  // 放大状态左滑：平移，不翻页
  await touch.swipe(320, box.y, 60, box.y);
  await pause(300);
  const panned = await read(page);
  check('放大后左滑页码不变', panned.page === zoomed.page, [zoomed.page, panned.page]);
  check('放大后左滑是原生平移', panned.left > zoomed.left + 50, [zoomed.left, panned.left]);
  for (let i = 0; i < 6; i++) await touch.swipe(340, box.y, 40, box.y);
  await pause(300);
  const edge = await read(page);
  check('平移到边界停住，不露空白', Math.abs(edge.left - edge.maxLeft) <= 1, [edge.left, edge.maxLeft]);
  check('到边界继续左滑也不翻页', edge.page === zoomed.page);

  // 复位后才能翻页
  await page.tap('[data-act="fit"]');
  await pause(400);
  const reset = await read(page);
  check('复位回适宽', !reset.zoomed && reset.fit === '适宽' && reset.out === true, reset.fit);
  if (total > 1) {
    await touch.swipe(320, box.y, 60, box.y);
    await pause(400);
    const swiped = await read(page);
    check('复位后左滑能翻页', swiped.page === reset.page + 1, [reset.page, swiped.page]);
    await page.evaluate(() => { location.hash = '#page=1'; });
    await pause(500);
  } else console.log('      （单页文件，跳过翻页回归）');

  // 双击
  await page.evaluate(() => document.querySelector('.pdfv-scroll').scrollTo(0, 0));
  await pause(300);
  const tapPoint = { x: 100, y: box.y - 60 };
  const a0 = await contentAt(page, tapPoint.x, tapPoint.y);
  const beforeTap = await read(page);
  await touch.doubleTap(tapPoint.x, tapPoint.y);
  await rendered(page, beforeTap.pixelWidth, '双击');
  const doubled = await read(page);
  const a1 = await contentAt(page, tapPoint.x, tapPoint.y);
  check('双击放大到 2x', Math.abs(doubled.cssWidth / beforeTap.cssWidth - 2) < 0.03, doubled.cssWidth / beforeTap.cssWidth);
  check('双击以点击处为中心', Math.abs(a0.fx - a1.fx) < 0.02 && Math.abs(a0.fy - a1.fy) < 0.02, [a0, a1]);
  check('双击后页面未被浏览器缩放', doubled.pageScale === 1, doubled.pageScale);
  await page.screenshot({ path: path.join(out, `${tag}-3-doubletap-in.png`) });
  await touch.doubleTap(tapPoint.x, tapPoint.y);
  await rendered(page, doubled.pixelWidth, '再次双击');
  const undone = await read(page);
  check('再双击回适宽', !undone.zoomed && Math.abs(undone.cssWidth - beforeTap.cssWidth) < 1, undone.cssWidth);
  await page.screenshot({ path: path.join(out, `${tag}-4-doubletap-out.png`) });

  // synthesizePinchGesture：浏览器自己的合成捏合
  await touch.pinch(box.x, box.y, 2.5);
  await rendered(page, undone.pixelWidth, 'synthesizePinchGesture');
  const synth = await read(page);
  check('synthesizePinchGesture 生效且不触发浏览器缩放', synth.zoomed && synth.pageScale === 1, { css: synth.cssWidth, px: synth.pixelWidth, pageScale: synth.pageScale });
  const ratio = synth.cssWidth / undone.cssWidth;
  console.log('synthesizePinchGesture(2.5) 实际倍数', ratio);

  // 放大状态竖向单指：原生滚动，和横向平移同一条路
  const beforeV = await read(page);
  await touch.swipe(180, box.y + 120, 180, box.y - 120);
  await pause(300);
  const afterV = await read(page);
  check('放大后竖向单指滚动', afterV.top > beforeV.top + 50, [beforeV.top, afterV.top]);

  // 捏回：不必回到正好 1x，1.08 以内吸附。用 CDP 触摸序列控制比例
  await touch.twoFingers(box.x, box.y, 150, Math.round((150 * 1.05) / ratio));
  await rendered(page, synth.pixelWidth, '捏回');
  const back = await read(page);
  check('捏回 1.05x 吸附适宽', !back.zoomed && back.fit === '适宽' && Math.abs(back.cssWidth - undone.cssWidth) < 1, { css: back.cssWidth, px: back.pixelWidth });

  // 防抖：松手到 canvas 被换掉至少 150ms
  await page.evaluate(() => {
    window.__swapped = null;
    new MutationObserver((_, o) => { window.__swapped = performance.now(); o.disconnect(); }).observe(document.querySelector('.pdfv-pages'), { childList: true, subtree: true });
    document.querySelector('.pdfv-scroll').addEventListener('touchend', () => { window.__ended = performance.now(); }, { once: true });
  });
  await touch.twoFingers(box.x, box.y, 50, 100);
  await rendered(page, back.pixelWidth, '防抖');
  const delay = await page.evaluate(() => window.__swapped - window.__ended);
  check('松手后防抖 ≥150ms 才重绘', delay >= 150, `${Math.round(delay)}ms`);

  // 重绘途中再捏：canvas 被换掉时手势不能断
  const racing = await read(page);
  await touch.twoFingers(box.x, box.y, 40, 60);
  await pause(170);
  await touch.twoFingers(box.x, box.y, 40, 60);
  await rendered(page, racing.pixelWidth, '连续捏合');
  const raced = await read(page);
  check('重绘途中再捏合不卡住', !raced.pinching && raced.transform === '' && raced.cssWidth > racing.cssWidth * 1.8, raced.cssWidth / racing.cssWidth);

  // 上限 5x，放大按钮禁用；像素不超 8MP
  for (let i = 0; i < 12; i++) if (await page.isEnabled('[data-act="zoom-in"]')) await page.tap('[data-act="zoom-in"]');
  await pause(900);
  const max = await read(page);
  const mp = await page.evaluate(() => { const c = document.querySelector(`.pdfv-page[data-n="${document.querySelector('.pdfv-input').value}"] canvas`); return c.width * c.height / 1e6; });
  check('最大 5x 且放大按钮禁用', Math.abs(max.cssWidth / undone.cssWidth - 5) < 0.02 && await page.isDisabled('[data-act="zoom-in"]'), max.cssWidth / undone.cssWidth);
  check('5x 时受 8MP 上限约束', mp <= 8.01, { css: max.cssWidth, px: max.pixelWidth, mp: mp.toFixed(2) });
  check('5x 无横向溢出', max.overflow <= 0, max.overflow);
  await page.screenshot({ path: path.join(out, `${tag}-5-max.png`) });

  // 适页模式：切换不受影响，两指碰一下不换模式
  await page.tap('[data-act="fit"]');
  await pause(400);
  await page.tap('[data-act="fit"]');
  await pause(400);
  const fitted = await read(page);
  check('复位后可切适页', fitted.fit === '适页' && fitted.out === true, fitted.fit);
  await touch.twoFingers(box.x, box.y, 60, 60);
  await pause(400);
  check('适页下两指轻碰不换模式', (await read(page)).fit === '适页');
  await page.tap('[data-act="fit"]');
  await pause(400);

  check('无页面错误', errors.length === 0, errors);
  await context.close();
}

async function mobileWebkit(browser, file, tag) {
  console.log(`\n== WebKit 375×667 dpr3（合成 TouchEvent）：${tag} ==`);
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  // 桌面 WebKit 报 0，真 iPhone 是 5：不改的话走的是桌面 16MP 上限，也不绑 gesture 事件
  await context.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/login`);
  await page.fill('input[type=password]', password);
  await page.press('input[type=password]', 'Enter');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
  const total = await open(page, file);
  const touch = webkitDriver(page);
  const box = await page.evaluate(() => { const r = document.querySelector('.pdfv-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  console.log('maxTouchPoints', await page.evaluate(() => navigator.maxTouchPoints), 'dpr', await page.evaluate(() => devicePixelRatio));

  const base = await read(page);
  console.log('页数', total, '初始', { css: base.cssWidth, px: base.pixelWidth });
  check('WebKit 按钮 ≥44px', base.smallest >= 44, base.smallest);
  const blocked = await page.evaluate(() => {
    const scroller = document.querySelector('.pdfv-scroll');
    const fired = ['gesturestart', 'gesturechange'].map((type) => { const e = new Event(type, { bubbles: true, cancelable: true }); scroller.dispatchEvent(e); return e.defaultPrevented; });
    return { fired, touchAction: getComputedStyle(scroller).touchAction };
  });
  check('WebKit 拦截 iOS 的 gesture 事件', blocked.fired.every(Boolean), blocked);
  check('WebKit touch-action 不含捏合', !/pinch|auto/.test(blocked.touchAction), blocked.touchAction);
  const a0 = await contentAt(page, box.x, box.y);
  await page.screenshot({ path: path.join(out, `${tag}-webkit-1-before.png`) });
  const { during, claimed } = await touch.twoFingers(box.x, box.y, 40, 120, { hold: () => read(page) });
  check('捏合中 transform 预览且未重绘', /scale\(3/.test(during.transform) && during.pixelWidth === base.pixelWidth, during.transform);
  check('捏合 touchmove 被拦截', claimed);
  await rendered(page, base.pixelWidth, '捏合');
  const zoomed = await read(page);
  const a1 = await contentAt(page, box.x, box.y);
  console.log('捏合后', { css: zoomed.cssWidth, px: zoomed.pixelWidth });
  check('CSS 宽约 3 倍', Math.abs(zoomed.cssWidth / base.cssWidth - 3) < 0.05);
  check('重渲染变清晰', zoomed.pixelWidth > base.pixelWidth * 1.3, [base.pixelWidth, zoomed.pixelWidth]);
  check('锚点不跑', Math.abs(a0.fx - a1.fx) < 0.02 && Math.abs(a0.fy - a1.fy) < 0.02, [a0, a1]);
  await page.screenshot({ path: path.join(out, `${tag}-webkit-2-pinched.png`) });

  await touch.swipe(320, box.y, 60, box.y);
  check('放大后左滑页码不变', (await read(page)).page === zoomed.page);
  await touch.twoFingers(box.x, box.y, 150, 52);
  await rendered(page, zoomed.pixelWidth, '捏回');
  const back = await read(page);
  check('捏回吸附适宽', !back.zoomed && back.fit === '适宽', { css: back.cssWidth, px: back.pixelWidth });
  await touch.twoFingers(box.x, box.y, 40, 120);
  await rendered(page, back.pixelWidth, '再次捏合');
  await page.tap('[data-act="fit"]');
  await pause(400);
  const reset = await read(page);
  check('复位', !reset.zoomed && reset.fit === '适宽');
  if (total > 1) {
    await touch.swipe(320, box.y, 60, box.y);
    await pause(300);
    check('复位后左滑能翻页', (await read(page)).page === reset.page + 1);
    await page.evaluate(() => { location.hash = '#page=1'; });
    await pause(500);
  }
  await touch.doubleTap(100, box.y - 60);
  await rendered(page, reset.pixelWidth, '双击');
  const doubled = await read(page);
  check('双击放大到 2x', Math.abs(doubled.cssWidth / reset.cssWidth - 2) < 0.03, doubled.cssWidth / reset.cssWidth);
  await page.screenshot({ path: path.join(out, `${tag}-webkit-3-doubletap-in.png`) });
  await touch.doubleTap(100, box.y - 60);
  await rendered(page, doubled.pixelWidth, '再次双击');
  check('再双击回适宽', !(await read(page)).zoomed);
  check('无页面错误', errors.length === 0, errors);
  await context.close();
}

async function desktop(browser, file, tag) {
  console.log(`\n== 桌面 1440×900：${tag} ==`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/login`);
  await page.fill('input[type=password]', password);
  await page.press('input[type=password]', 'Enter');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
  await open(page, file);
  const box = await page.evaluate(() => { const r = document.querySelector('.pdfv-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.evaluate(() => {
    window.__wheel = [];
    window.addEventListener('wheel', (e) => queueMicrotask(() => window.__wheel.push([e.ctrlKey, e.defaultPrevented])));
  });

  const base = await read(page);
  await page.mouse.wheel(0, 300);
  await pause(400);
  const scrolled = await read(page);
  check('普通滚轮仍能滚动页面', scrolled.top > base.top + 100 && !scrolled.zoomed, [base.top, scrolled.top]);
  check('普通滚轮未被 preventDefault', (await page.evaluate(() => window.__wheel)).every(([, prevented]) => !prevented));

  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await pause(30); }
  await page.keyboard.up('Control');
  await rendered(page, scrolled.pixelWidth, 'Ctrl+滚轮');
  const wheeled = await read(page);
  check('Ctrl+滚轮放大', wheeled.zoomed && wheeled.cssWidth > scrolled.cssWidth * 1.3, wheeled.cssWidth / scrolled.cssWidth);
  check('Ctrl+滚轮后页面未缩放且无溢出', wheeled.pageScale === 1 && wheeled.overflow <= 0, wheeled.overflow);
  await page.screenshot({ path: path.join(out, `${tag}-desktop-ctrl-wheel.png`) });
  const before = wheeled.top;
  await page.mouse.wheel(0, 200);
  await pause(300);
  check('放大后普通滚轮照常滚动', (await read(page)).top > before + 50);

  await page.keyboard.press('Control+0');
  await pause(500);
  const reset = await read(page);
  check('Ctrl+0 复位', !reset.zoomed && reset.fit === '适宽');
  await page.keyboard.press('Control+=');
  await pause(500);
  const plus = await read(page);
  check('Ctrl+= 放大', plus.zoomed && Math.abs(plus.cssWidth / reset.cssWidth - 1.25) < 0.02, plus.cssWidth / reset.cssWidth);
  await page.keyboard.press('Control+-');
  await pause(500);
  check('Ctrl+- 缩小回 1x', !(await read(page)).zoomed);
  await page.mouse.dblclick(box.x, box.y);
  await pause(500);
  check('鼠标双击放大', (await read(page)).zoomed);
  await page.mouse.dblclick(box.x, box.y);
  await pause(500);
  check('鼠标再双击复位', !(await read(page)).zoomed);
  await context.close();
}

const chrome = await chromium.launch();
for (const [file, tag] of [[pdf, 'pdf'], [ppt, 'ppt']]) await mobileChromium(chrome, file, tag);
await desktop(chrome, pdf, 'pdf');
await chrome.close();

const safari = await webkit.launch();
for (const [file, tag] of [[pdf, 'pdf'], [ppt, 'ppt']]) await mobileWebkit(safari, file, tag);
await desktop(safari, pdf, 'pdf-webkit');
await safari.close();

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
