// PDF 阅读器。只渲染视口内的页和前后各一页，其余是按比例占位的空 div，几百页的文件也只有几张 canvas
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
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const KEEP = 2; // 超出视口这么多页就回收 canvas
const PROBE = 5; // 提前量取真实尺寸，占位在看到之前就是对的
const SWIPE_MIN = 50;
const SWIPE_MS = 800;

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

function scaleOf(p) {
  const pad = padding();
  const width = scroller.clientWidth - pad;
  if (mode === 'page') return Math.min(width / p.width, (scroller.clientHeight - pad) / p.height);
  return (width / p.width) * zoom;
}

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

const targetScale = (p) => {
  const scale = scaleOf(p) * Math.min(window.devicePixelRatio || 1, 3);
  return Math.min(scale, Math.sqrt(MAX_PIXELS / (p.width * p.height)));
};
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
  if (rendering) return;
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
  if (!pages.length) return;
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

function relayout() {
  if (!pages.length) return;
  const anchor = pages[current - 1].el;
  const within = (scroller.scrollTop - anchor.offsetTop) / (anchor.offsetHeight || 1);
  pages.forEach(place);
  scroller.scrollTop = anchor.offsetTop + within * anchor.offsetHeight;
  if (pinned) pinned.top = scroller.scrollTop;
  rendering?.task?.cancel();
  scroller.classList.toggle('pdfv-wide', scroller.scrollWidth > scroller.clientWidth + 1);
  schedule();
}

function setZoom(next) {
  // 适应页面下的字比适应宽度小，从当前显示大小接着放大才不会突然跳一下
  const from = mode === 'page' ? scaleOf(pages[current - 1]) / ((scroller.clientWidth - padding()) / pages[current - 1].width) : zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next(from)));
  mode = 'custom';
  $('[data-act="fit"]').textContent = '适宽';
  relayout();
}

function toggleFit() {
  mode = mode === 'width' ? 'page' : 'width';
  zoom = 1;
  $('[data-act="fit"]').textContent = mode === 'width' ? '适宽' : '适页';
  relayout();
}

const ACTIONS = {
  prev: () => go(current - 1),
  next: () => go(current + 1),
  'zoom-in': () => setZoom((z) => z * ZOOM_STEP),
  'zoom-out': () => setZoom((z) => z / ZOOM_STEP),
  fit: toggleFit,
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
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') go(current - 1);
    else if (e.key === 'ArrowRight') go(current + 1);
  });
  window.addEventListener('hashchange', () => {
    const n = Number(location.hash.match(/^#page=(\d+)$/)?.[1]);
    if (n) go(n);
  });

  // 左右滑动翻页。放大后横向要留给平移，两指是缩放，这两种情况都不算翻页
  let touch = null;
  scroller.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
  }, { passive: true });
  scroller.addEventListener('touchend', (e) => {
    const start = touch;
    touch = null;
    if (!start || scroller.classList.contains('pdfv-wide') || (window.visualViewport?.scale ?? 1) > 1.05) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5 && e.timeStamp - start.at < SWIPE_MS) go(current + (dx < 0 ? 1 : -1));
  }, { passive: true });
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
  const n = Number(location.hash.match(/^#page=(\d+)$/)?.[1]);
  setCurrent(1);
  if (n > 1) go(n);
  else schedule();
}

if (root) open();
