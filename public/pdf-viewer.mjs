// PDF 阅读器。只渲染视口内的页和前后各一页，其余是按比例占位的空 div，几百页的文件也只有几张 canvas
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, createGestures, doubleTapTarget, isZoomed, pinchZoom, previewOffset, renderScale, snapZoom, wheelFactor } from './pdf-zoom.mjs';

const root = document.getElementById('pdfv');
const $ = (s) => root.querySelector(s);
const scroller = $('.pdfv-scroll');
const holder = $('.pdfv-pages');
const message = $('.pdfv-msg');
const bar = $('.pdfv-bar');
const input = $('.pdfv-input');

const TOUCH = navigator.maxTouchPoints > 0;
const MAX_PIXELS = TOUCH ? 8e6 : 16e6; // iOS 单张 canvas 超过约 16MP 直接画白，几张加起来也有内存上限
const CHUNK = 256 * 1024;
const KEEP = 2; // 超出视口这么多页就回收 canvas
const PROBE = 5; // 提前量取真实尺寸，占位在看到之前就是对的
const SETTLE_MS = 150; // 缩放停下这么久才重绘，连续捏合或滚轮时只动 transform
const ZOOM_KEYS = { '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', 0: 'reset' };

let doc = null;
let pages = [];
let current = 1;
let pinned = null; // 翻页按钮定位到的页；横版 PPT 在竖屏上一屏有好几页，不能再按滚动位置推算页码
let mode = 'width';
let zoom = 1;
let wanted = [];
let rendering = null;
let probing = false;
let frame = 0;
let renderTimer = 0;
let hashTimer = 0;
let preview = null; // 捏合或 Ctrl+滚轮进行中的预览，松手才改真实布局
let previewFrame = 0;
let settleAt = 0;
let wheelTimer = 0;

function say(text) {
  message.textContent = text;
  message.hidden = false;
}

// 没有 PDF.js 的环境：能内嵌就用浏览器自己的阅读器，不能就只留下载
function fallback() {
  bar.hidden = true;
  if (navigator.pdfViewerEnabled) {
    message.hidden = true;
    const frameEl = Object.assign(document.createElement('iframe'), { src: root.dataset.src, title: root.dataset.name, className: 'pdfv-frame' });
    root.replaceChildren(frameEl);
  } else say('这个浏览器打不开在线阅读器，请点上方「下载」查看。');
}

const padding = () => parseFloat(getComputedStyle(holder).paddingLeft) * 2;
const fitWidth = (p) => (scroller.clientWidth - padding()) / p.width;

function scaleOf(p) {
  if (mode === 'page') return Math.min(fitWidth(p), (scroller.clientHeight - padding()) / p.height);
  return fitWidth(p) * zoom;
}

// 适应页面下的字比适应宽度小，要从当前显示大小接着放大才不会突然跳一下
const shownZoom = (p) => scaleOf(p) / fitWidth(p);

function place(p) {
  const scale = scaleOf(p);
  p.el.style.width = `${Math.floor(p.width * scale)}px`;
  p.el.style.height = `${Math.floor(p.height * scale)}px`;
}

function pageAt(y) {
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const el = pages[mid].el;
    if (el.offsetTop + el.offsetHeight <= y) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

function setCurrent(n) {
  if (n === current && input.value) return;
  current = n;
  if (document.activeElement !== input) input.value = n;
  $('[data-act="prev"]').disabled = n <= 1;
  $('[data-act="next"]').disabled = n >= pages.length;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, '', n > 1 ? `#page=${n}` : location.pathname + location.search), 300);
}

function go(n) {
  const target = Math.min(Math.max(1, n), pages.length);
  scroller.scrollTop = pages[target - 1].el.offsetTop - parseFloat(getComputedStyle(holder).paddingTop);
  pinned = { page: target, top: scroller.scrollTop };
  setCurrent(target);
  schedule();
}

function release(p) {
  p.task?.cancel();
  if (p.canvas) {
    p.canvas.width = 0; // iOS 上光移出 DOM 不释放位图
    p.canvas.remove();
    p.canvas = null;
  }
  p.drawn = 0;
  if (p.page && !p.task) p.page.cleanup();
}

const targetScale = (p) => renderScale(scaleOf(p), window.devicePixelRatio, p.width, p.height, MAX_PIXELS);
const stale = (p) => Math.abs(p.drawn - targetScale(p)) > 0.01;

// 真实尺寸只有在取到这一页时才知道。上方的页变高会把正在读的内容顶走，所以同步补偿滚动位置
function measure(p, page) {
  p.page = page;
  if (p.sized) return;
  p.sized = true;
  const { width, height } = page.getViewport({ scale: 1 });
  if (Math.abs(width - p.width) < 0.5 && Math.abs(height - p.height) < 0.5) return;
  const before = p.el.offsetHeight;
  const above = p.el.offsetTop + before <= scroller.scrollTop;
  Object.assign(p, { width, height });
  place(p);
  if (above) scroller.scrollTop += p.el.offsetHeight - before;
}

async function probe(center) {
  if (probing) return;
  probing = true;
  try {
    for (let n = Math.max(1, center - PROBE); n <= Math.min(pages.length, center + PROBE); n++) {
      const p = pages[n - 1];
      if (!p.sized) measure(p, await doc.getPage(n));
    }
  } catch { /* 取不到就留着估算的占位，渲染时会再报错 */ } finally {
    probing = false;
  }
}

async function render(p) {
  measure(p, p.page ?? await doc.getPage(p.n));
  const scale = targetScale(p);
  const viewport = p.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  p.task = p.page.render({ canvas, viewport });
  try {
    await p.task.promise;
    if (p.canvas) p.canvas.width = 0;
    // 重绘期间旧 canvas 留着被拉伸，缩放时不闪白
    p.el.replaceChildren(canvas);
    p.canvas = canvas;
    p.drawn = scale;
    delete p.el.dataset.error;
  } catch (err) {
    canvas.width = 0;
    if (err?.name !== 'RenderingCancelledException') p.el.dataset.error = '这一页显示失败';
    p.drawn = err?.name === 'RenderingCancelledException' ? p.drawn : scale;
  } finally {
    p.task = null;
  }
}

async function drain() {
  if (rendering || preview) return;
  const wait = settleAt - performance.now();
  if (wait > 0) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(drain, wait);
    return;
  }
  const next = wanted.find((n) => stale(pages[n - 1]));
  if (!next) return;
  rendering = pages[next - 1];
  try {
    await render(rendering);
  } catch {
    rendering.el.dataset.error = '这一页显示失败';
    rendering.drawn = targetScale(rendering);
  }
  rendering = null;
  drain();
}

function update() {
  frame = 0;
  if (!pages.length || preview) return; // 预览时滚动位置归零了，不能拿来算页码和回收
  const top = scroller.scrollTop;
  const height = scroller.clientHeight;
  const first = pageAt(top);
  const last = pageAt(top + height);
  if (pinned && Math.abs(pinned.top - top) > 2) pinned = null;
  const now = pinned?.page ?? pageAt(top + height * 0.4);
  setCurrent(now);
  const from = Math.max(1, first - 1);
  const to = Math.min(pages.length, last + 1);
  wanted = Array.from({ length: to - from + 1 }, (_, i) => from + i).sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
  for (const p of pages) if ((p.canvas || p.task) && (p.n < first - KEEP || p.n > last + KEEP)) release(p);
  clearTimeout(renderTimer);
  renderTimer = setTimeout(drain, 60); // 快速拖动时滑过的页不值得画
  probe(now);
}

function schedule() {
  frame ||= requestAnimationFrame(update);
}

// 重绘期间旧 canvas 留着被拉伸，不闪白；等手势停下再画，cancel 掉的是按旧比例在画的那张
function settle() {
  settleAt = performance.now() + SETTLE_MS;
  rendering?.task?.cancel();
  schedule();
}

function relayout() {
  if (!pages.length || preview) return;
  const anchor = pages[current - 1].el;
  const within = (scroller.scrollTop - anchor.offsetTop) / (anchor.offsetHeight || 1);
  pages.forEach(place);
  scroller.scrollTop = anchor.offsetTop + within * anchor.offsetHeight;
  if (pinned) pinned.top = scroller.scrollTop;
  settle();
}

function syncBar() {
  const custom = mode === 'custom';
  scroller.classList.toggle('pdfv-zoomed', custom);
  $('[data-act="zoom-out"]').disabled = !custom;
  $('[data-act="zoom-in"]').disabled = zoom >= ZOOM_MAX;
  const fit = $('[data-act="fit"]');
  fit.textContent = custom ? '复位' : mode === 'width' ? '适宽' : '适页';
  fit.setAttribute('aria-label', custom ? '复位到适宽' : '切换适应方式');
}

// 手指下的内容用「第几页的哪个比例」记，不用滚动坐标：页间距和内边距不随缩放变，坐标换算会越翻越偏
function anchorAt(x, y) {
  const p = pages[pageAt(scroller.scrollTop + y) - 1];
  const fx = (scroller.scrollLeft + x - p.el.offsetLeft) / p.el.offsetWidth;
  const fy = (scroller.scrollTop + y - p.el.offsetTop) / p.el.offsetHeight;
  return { p, x, y, fx, fy };
}

function applyZoom(next, { p, x, y, fx, fy }) {
  // 适页下两指只是碰了一下，别把模式换掉
  if (mode !== 'page' || Math.abs(next / shownZoom(p) - 1) > 0.02) {
    zoom = snapZoom(next);
    mode = zoom === ZOOM_MIN ? 'width' : 'custom';
    pages.forEach(place);
  }
  syncBar();
  scroller.scrollLeft = p.el.offsetLeft + fx * p.el.offsetWidth - x;
  scroller.scrollTop = p.el.offsetTop + fy * p.el.offsetHeight - y;
  settle();
}

function setZoom(next) {
  const anchor = anchorAt(scroller.clientWidth / 2, pinned ? 0 : scroller.clientHeight / 2);
  applyZoom(next(shownZoom(anchor.p)), anchor);
  if (pinned) pinned.top = scroller.scrollTop;
}

const viewPoint = (clientX, clientY) => {
  const box = scroller.getBoundingClientRect();
  return { x: clientX - box.left, y: clientY - box.top, box };
};

function toggleZoomAt(clientX, clientY) {
  const { x, y } = viewPoint(clientX, clientY);
  applyZoom(doubleTapTarget(zoom), anchorAt(x, y));
}

function paintPreview() {
  previewFrame = 0;
  if (!preview) return;
  const { k, left, top } = previewOffset(preview);
  holder.style.transform = `translate(${-left}px, ${-top}px) scale(${k})`;
}

function beginPreview(clientX, clientY) {
  if (preview) endPreview();
  const { x, y, box } = viewPoint(clientX, clientY);
  const anchor = anchorAt(x, y);
  const start = shownZoom(anchor.p);
  preview = {
    anchor, box, start, zoom: start, x, y,
    originX: scroller.scrollLeft + x, originY: scroller.scrollTop + y,
    viewWidth: scroller.clientWidth, viewHeight: scroller.clientHeight,
    contentWidth: holder.offsetWidth, contentHeight: holder.offsetHeight,
  };
  // overflow:hidden 掐断正在进行的原生滚动。滚动归零后整段位移都在 transform 里，缩小时滚动范围变小也不会被浏览器夹回去
  scroller.classList.add('pdfv-pinching');
  scroller.scrollLeft = 0;
  scroller.scrollTop = 0;
  paintPreview();
}

function movePreview(scale, clientX, clientY) {
  Object.assign(preview, { zoom: pinchZoom(preview.start, scale), x: clientX - preview.box.left, y: clientY - preview.box.top });
  previewFrame ||= requestAnimationFrame(paintPreview);
}

function endPreview() {
  if (!preview) return;
  const { anchor, zoom: next, x, y } = preview;
  clearTimeout(wheelTimer);
  preview = null;
  holder.style.transform = '';
  scroller.classList.remove('pdfv-pinching');
  applyZoom(next, { ...anchor, x, y });
}

function toggleFit() {
  mode = mode === 'width' ? 'page' : 'width';
  zoom = ZOOM_MIN;
  syncBar();
  relayout();
}

const ACTIONS = {
  prev: () => go(current - 1),
  next: () => go(current + 1),
  'zoom-in': () => setZoom((z) => z * ZOOM_STEP),
  'zoom-out': () => setZoom((z) => z / ZOOM_STEP),
  reset: () => setZoom(() => ZOOM_MIN),
  fit: () => (mode === 'custom' ? ACTIONS.reset() : toggleFit()),
};

function bindControls() {
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) ACTIONS[act]();
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => {
    const n = parseInt(input.value, 10);
    if (Number.isInteger(n)) go(n);
    input.value = current;
    input.blur();
  });
  scroller.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(relayout).observe(scroller);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select') || e.altKey) return;
    if (e.metaKey || e.ctrlKey) {
      if (!ZOOM_KEYS[e.key]) return;
      e.preventDefault();
      ACTIONS[ZOOM_KEYS[e.key]]();
    } else if (e.key === 'ArrowLeft') go(current - 1);
    else if (e.key === 'ArrowRight') go(current + 1);
  });
  window.addEventListener('hashchange', () => {
    const n = Number(location.hash.match(/^#page=(\d+)$/)?.[1]);
    if (n) go(n);
  });

  bindGestures();
}

// 放大后的平移就是 scroller 的原生滚动（两轴都走它，自带惯性和边界），手势只负责捏合、双击和未放大时的翻页
function bindGestures() {
  const gestures = createGestures({
    zoomed: () => isZoomed(zoom) || (window.visualViewport?.scale ?? 1) > 1.05,
    onPinchStart: beginPreview,
    onPinchMove: movePreview,
    onPinchEnd: endPreview,
    onSwipe: (step) => go(current + step),
    onDoubleTap: toggleZoomAt,
  });
  const points = (list) => Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
  let touchedAt = -Infinity;
  scroller.addEventListener('touchstart', (e) => gestures.down(points(e.touches), e.timeStamp), { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (gestures.move(points(e.touches)) && e.cancelable) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('touchend', (e) => {
    touchedAt = e.timeStamp;
    if (gestures.up(points(e.touches), points(e.changedTouches)[0], e.timeStamp) && e.cancelable) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('touchcancel', (e) => gestures.cancel(points(e.touches)));
  // iOS Safari 的页面级捏合不完全听 touch-action；桌面 Safari 的触控板捏合不走这里，留给浏览器
  if (TOUCH) for (const type of ['gesturestart', 'gesturechange']) scroller.addEventListener(type, (e) => e.preventDefault());
  scroller.addEventListener('dblclick', (e) => {
    if (e.timeStamp - touchedAt > 800) toggleZoomAt(e.clientX, e.clientY); // 触屏的双击已经处理过，这是鼠标
  });
  // 没按 Ctrl/⌘ 时必须原样放行，普通滚轮还要滚页面
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!preview) beginPreview(e.clientX, e.clientY);
    movePreview((preview.zoom / preview.start) * wheelFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endPreview, SETTLE_MS);
  }, { passive: false });
}

function buildPages(numPages, width, height) {
  const fragment = document.createDocumentFragment();
  pages = Array.from({ length: numPages }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'pdfv-page';
    el.dataset.n = i + 1;
    fragment.append(el);
    return { n: i + 1, el, width, height, sized: false, page: null, canvas: null, task: null, drawn: 0 };
  });
  holder.append(fragment);
  pages.forEach(place);
}

function layoutHeight() {
  root.style.setProperty('--pdfv-top', `${Math.ceil(root.getBoundingClientRect().top + window.scrollY)}px`);
}

async function open() {
  layoutHeight();
  window.addEventListener('resize', layoutHeight);
  const assets = new URL(root.dataset.assets, location.href);
  let pdfjs;
  try {
    pdfjs = await import(new URL('pdf.min.mjs', assets).href);
  } catch {
    fallback();
    return;
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assets).href;
  const task = pdfjs.getDocument({
    url: new URL(root.dataset.src, location.href).href,
    cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    // 只按需要的页发 Range，大文件不在后台把整个文件拖下来
    rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true,
    verbosity: 0,
  });
  let locked = false;
  task.onPassword = () => {
    locked = true;
    say('这份 PDF 设了打开密码，在线阅读器打不开，请下载后查看。');
    task.destroy();
  };
  try {
    doc = await task.promise;
    const first = await doc.getPage(1);
    const { width, height } = first.getViewport({ scale: 1 });
    buildPages(doc.numPages, width, height);
    measure(pages[0], first);
  } catch (err) {
    if (locked) return;
    if (err?.name === 'InvalidPDFException') say('这个文件已损坏或不是有效的 PDF，请下载查看。');
    else say('加载失败，请检查网络后刷新，或点上方「下载」。');
    return;
  }
  message.hidden = true;
  bar.hidden = false;
  $('.pdfv-total').textContent = doc.numPages;
  root.dataset.ready = doc.numPages;
  input.value = '';
  bindControls();
  syncBar();
  const n = Number(location.hash.match(/^#page=(\d+)$/)?.[1]);
  setCurrent(1);
  if (n > 1) go(n);
  else schedule();
}

if (root) open();
