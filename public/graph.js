import { createHitGrid, createSimulation, neighborhood, placeRing } from './graph-core.js';

const $ = (s) => document.querySelector(s);
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式下不保存 */ } };
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const BASE = document.documentElement.dataset.base ?? '';

const MAX_DPR = 2; // 手机 3 倍屏也只画 2 倍：像素量差一倍多，肉眼看不出区别
const R_MIN = 3;
const R_MAX = 14;
const TAU = Math.PI * 2;
const HIT_SLOP = { mouse: 4, touch: 16 };
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 320;
const MOVE_TOLERANCE = 8;
const RING_LIMIT = 400; // 点太多时省掉节点外圈，少一半绘制
const RING_SPACING = 14;
const TITLE_CHARS = 14;
const LAYOUT_SLICE_MS = 12;
const SHEET_ESTIMATE = 260; // sheet 打开前量不到高度，用估值判断它会不会盖住手指下的点
const OTHER_SLOT = 8;
// 8 色顺序与色值经色盲校验（对 #fbfaf7 / #171714 两种底色），第 9 个目录起归入中性灰，不再生成新色相
const PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

const stage = $('#graph-stage');
const canvas = $('#graph-canvas');
const ctx = canvas.getContext('2d');
const stateBox = $('#graph-state');
const sheet = $('#graph-sheet');
const legend = $('#graph-legend');
const toolbarBody = $('#graph-bar-body');
const foldBtn = $('#graph-fold');
const allToggle = $('#graph-all');
const backBtn = $('#graph-back');
const statsLine = $('#graph-stats');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let W = 0;
let H = 0;
let dpr = 1;
const cam = { k: 1, tx: 0, ty: 0, minK: 0.05 };
let userMoved = false;
let drawQueued = false;
let colors = null;

let nodes = [];
let edges = []; // [a, b] 节点下标
let adjacency = [];
let radius = new Float64Array(0);
let slotOf = new Uint8Array(0);
let byPath = new Map();
let dirs = []; // { name, label, slot, total }
const hiddenDirs = new Set();

let overview = null; // 全局布局只算一次，从聚焦返回时直接复用
let view = null; // { x, y, members, center, sim }
let shown = [];
let shownFlag = new Uint8Array(0);
let shownEdges = [];
let buckets = [];
let grid = null;
let selected = -1;
let hover = -1;
let showAll = read('kb-graph-all') === '1';
let firstDrawDone = false;

const pathHref = (p) => `${BASE}/v/${p.split('/').map(encodeURIComponent).join('/')}`;
const fmt = (n) => n.toLocaleString('zh-CN');
const isDark = () => {
  const rootEl = document.documentElement;
  return rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  colors = {
    palette: [...PALETTE[isDark() ? 'dark' : 'light'], v('--yh-text-2')],
    bg: v('--yh-bg'), text: v('--yh-text'), muted: v('--yh-text-2'), accent: v('--yh-primary'),
    font: `11px ${getComputedStyle(document.body).fontFamily}`,
  };
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!view || !shown.length) return;
  const { x, y } = view;
  const { k, tx, ty } = cam;
  const active = hover >= 0 ? hover : selected;
  const lit = active >= 0 ? new Set([active, ...adjacency[active]]) : null;
  const isLit = (i) => lit.has(i);

  // 边：一条路径一次 stroke
  const strokeEdges = (pick) => {
    ctx.beginPath();
    for (const e of shownEdges) {
      if (pick && !pick(e)) continue;
      const ax = x[e[0]] * k + tx;
      const ay = y[e[0]] * k + ty;
      const bx = x[e[1]] * k + tx;
      const by = y[e[1]] * k + ty;
      if ((ax < 0 && bx < 0) || (ax > W && bx > W) || (ay < 0 && by < 0) || (ay > H && by > H)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  };
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 0.8;
  if (lit) {
    ctx.globalAlpha = 0.08;
    strokeEdges((e) => e[0] !== active && e[1] !== active);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.4;
    strokeEdges((e) => e[0] === active || e[1] === active);
  } else {
    ctx.globalAlpha = 0.4;
    strokeEdges();
  }

  // 节点：同色一批，避免每个点切换 fillStyle
  const ring = shown.length < RING_LIMIT;
  const fillNodes = (pick, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = 1;
    buckets.forEach((list, slot) => {
      ctx.beginPath();
      for (const i of list) {
        if (pick && !pick(i)) continue;
        const sx = x[i] * k + tx;
        const sy = y[i] * k + ty;
        const r = radius[i];
        if (sx < -r || sx > W + r || sy < -r || sy > H + r) continue;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, TAU);
      }
      ctx.fillStyle = colors.palette[slot];
      ctx.fill();
      if (ring) ctx.stroke();
    });
  };
  if (lit) {
    fillNodes((i) => !lit.has(i), 0.14);
    fillNodes(isLit, 1);
  } else fillNodes(null, 1);

  const circle = (i, color) => {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x[i] * k + tx, y[i] * k + ty, radius[i] + 2.5, 0, TAU);
    ctx.stroke();
  };
  if (view.center >= 0 && shownFlag[view.center]) circle(view.center, colors.accent);
  if (active >= 0 && shownFlag[active]) circle(active, colors.text);

  drawLabels(lit, active);
  ctx.globalAlpha = 1;
}

// 标签最贵，限量；高亮的邻居优先，其余按连接数从高到低，放不下的跳过
function drawLabels(lit, active) {
  const { x, y } = view;
  const { k, tx, ty } = cam;
  const limit = lit ? 24 : W < 500 ? 10 : 28;
  const placed = [];
  ctx.font = colors.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const tryLabel = (i) => {
    const sx = x[i] * k + tx;
    const sy = y[i] * k + ty + radius[i] + 9;
    if (sx < 0 || sx > W || sy < 0 || sy > H) return;
    const text = nodes[i].label;
    const hw = text.length * 5.6 + 3;
    if (placed.some((p) => Math.abs(p.sx - sx) < p.hw + hw && Math.abs(p.sy - sy) < 14)) return;
    placed.push({ sx, sy, hw });
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.bg;
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = colors.text;
    ctx.fillText(text, sx, sy);
  };
  if (active >= 0 && shownFlag[active]) tryLabel(active);
  if (view.center >= 0 && shownFlag[view.center]) tryLabel(view.center);
  const pool = lit ? shown.filter((i) => lit.has(i)) : shown;
  for (const i of pool) {
    if (placed.length >= limit) break;
    if (!nodes[i].degree && !lit) break; // shown 按连接数倒序，后面都是孤立点
    tryLabel(i);
  }
}

function fit() {
  if (!view || !shown.length || !W) return;
  const { x, y } = view;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of shown) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const pad = 24;
  const top = $('#graph-bar').getBoundingClientRect().bottom - stage.getBoundingClientRect().top + 8;
  const usableH = Math.max(H - top - pad, 80);
  const k = Math.min((W - pad * 2) / Math.max(maxX - minX, 1), usableH / Math.max(maxY - minY, 1), 3);
  cam.k = k;
  cam.minK = k * 0.4;
  cam.tx = W / 2 - ((minX + maxX) / 2) * k;
  cam.ty = top + usableH / 2 - ((minY + maxY) / 2) * k;
}

function refreshShown() {
  const members = view.members.filter((i) => i === view.center || !hiddenDirs.has(nodes[i].dir));
  shown = members.sort((a, b) => nodes[b].degree - nodes[a].degree || a - b);
  shownFlag = new Uint8Array(nodes.length);
  for (const i of shown) shownFlag[i] = 1;
  shownEdges = (view.edges ?? edges).filter((e) => shownFlag[e[0]] && shownFlag[e[1]]);
  buckets = Array.from({ length: OTHER_SLOT + 1 }, () => []);
  for (const i of shown) buckets[slotOf[i]].push(i);
  grid = view.sim ? null : createHitGrid(shown, view.x, view.y);
  if (hover >= 0 && !shownFlag[hover]) hover = -1;
  if (selected >= 0 && !shownFlag[selected]) closeSheet();
  requestDraw();
}

function renderLegend() {
  const inView = new Map();
  for (const i of view.members) inView.set(nodes[i].dir, (inView.get(nodes[i].dir) ?? 0) + 1);
  legend.replaceChildren(...dirs.filter((d) => inView.has(d.name)).map((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-dir';
    btn.setAttribute('aria-pressed', String(!hiddenDirs.has(d.name)));
    const swatch = document.createElement('span');
    swatch.className = 'graph-swatch';
    swatch.style.background = colors.palette[d.slot];
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = fmt(inView.get(d.name));
    btn.append(swatch, d.label, ' ', count);
    btn.addEventListener('click', () => {
      if (hiddenDirs.has(d.name)) hiddenDirs.delete(d.name);
      else hiddenDirs.add(d.name);
      btn.setAttribute('aria-pressed', String(!hiddenDirs.has(d.name)));
      refreshShown();
    });
    return btn;
  }));
}

function renderStats() {
  if (view === overview) {
    const linked = nodes.filter((n) => n.degree > 0).length;
    statsLine.textContent = `${fmt(linked)} 篇有连接 · ${fmt(edges.length)} 条边 · ${fmt(nodes.length - linked)} 孤立`;
    return;
  }
  const hint = view.members.length === 1 ? ' · 这篇还没有双链' : '';
  statsLine.textContent = `2 跳内 ${fmt(view.members.length)} 篇 · ${fmt(view.edges.length)} 条边${hint}`;
}

function setState(content) {
  stateBox.hidden = !content;
  if (content) stateBox.replaceChildren(...content);
}

function emptyState() {
  const title = document.createElement('strong');
  title.textContent = '还没有双链';
  const tip = document.createElement('p');
  tip.append('在笔记里用 ');
  const code = document.createElement('code');
  code.textContent = '[[另一篇笔记的标题]]';
  tip.append(code, ' 引用它，这里就会连起一条线。');
  return [title, tip];
}

// 全量模式下把孤立点铺到连接团外圈；连接团不动，开关前后位置不跳
function placeIsolated() {
  const rest = nodes.map((_, i) => i).filter((i) => !nodes[i].degree);
  rest.sort((a, b) => dirs.findIndex((d) => d.name === nodes[a].dir) - dirs.findIndex((d) => d.name === nodes[b].dir) || a - b);
  const { x, y } = overview;
  let inner = 0;
  for (const i of overview.linked) inner = Math.max(inner, Math.hypot(x[i], y[i]));
  const ring = placeRing(rest.length, inner + 60, RING_SPACING, H / Math.max(W, 1));
  rest.forEach((node, n) => {
    x[node] = ring[n].x;
    y[node] = ring[n].y;
  });
  overview.isolatedPlaced = true;
}

function syncOverviewMembers() {
  overview.members = showAll ? nodes.map((_, i) => i) : overview.linked;
  allToggle.checked = showAll;
  setState(edges.length || showAll ? null : emptyState());
}

function settle() {
  if (view === overview && showAll && !overview.isolatedPlaced) placeIsolated();
  view.sim = null;
  refreshShown();
  if (!userMoved) fit();
  requestDraw();
  if (firstDrawDone) return;
  firstDrawDone = true;
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('kb-graph-first-draw')));
}

// 分片跑布局：小图第一片就收敛，用户看不到动画；大图也不会卡住主线程
function pump(target) {
  cancelAnimationFrame(target.frame);
  if (target !== view || !target.sim) return;
  const { sim, local } = target;
  const done = sim.run(firstDrawDone ? LAYOUT_SLICE_MS : LAYOUT_SLICE_MS * 3);
  for (let n = 0; n < local.length; n++) {
    target.x[local[n]] = sim.x[n];
    target.y[local[n]] = sim.y[n];
  }
  if (done) {
    if (!firstDrawDone) performance.mark('kb-graph-layout');
    settle();
    return;
  }
  if (!userMoved) fit();
  requestDraw();
  target.frame = requestAnimationFrame(() => pump(target));
}

function startLayout(target, local, localEdges, pinned) {
  target.sim = createSimulation(local.length, localEdges, pinned, Float64Array.from(local, (i) => radius[i] * 1.5 + 2));
  target.local = local;
  pump(target);
}

function showOverview() {
  userMoved = false;
  if (!overview) {
    const linked = nodes.map((_, i) => i).filter((i) => nodes[i].degree > 0);
    const position = new Map(linked.map((i, n) => [i, n]));
    overview = {
      x: new Float64Array(nodes.length), y: new Float64Array(nodes.length),
      linked, members: linked, center: -1, sim: null, isolatedPlaced: false,
    };
    view = overview;
    syncOverviewMembers();
    refreshShown();
    renderLegend();
    renderStats();
    startLayout(overview, linked, edges.map(([a, b]) => [position.get(a), position.get(b)]), -1);
    return;
  }
  view = overview;
  syncOverviewMembers();
  if (!view.sim && showAll && !overview.isolatedPlaced) placeIsolated();
  refreshShown();
  renderLegend();
  renderStats();
  if (view.sim) pump(view);
  else fit();
}

function showFocus(center) {
  userMoved = false;
  const reach = neighborhood(adjacency, center, 2);
  const local = [...reach];
  const position = new Map(local.map((i, n) => [i, n]));
  const inside = edges.filter((e) => reach.has(e[0]) && reach.has(e[1]));
  view = {
    x: new Float64Array(nodes.length), y: new Float64Array(nodes.length),
    members: local, edges: inside, center, sim: null,
  };
  setState(null);
  refreshShown();
  renderLegend();
  renderStats();
  startLayout(view, local, inside.map(([a, b]) => [position.get(a), position.get(b)]), position.get(center));
}

function route() {
  closeSheet();
  hover = -1;
  const center = byPath.get(new URLSearchParams(location.search).get('focus') ?? '') ?? -1;
  const focused = center >= 0;
  backBtn.hidden = !focused;
  $('#graph-all-label').hidden = focused;
  if (focused) showFocus(center);
  else showOverview();
}

function navigate(url) {
  $('#graph-missing')?.remove();
  history.pushState(null, '', url);
  route();
}

function focusOn(i) {
  navigate(`${BASE}/graph?focus=${encodeURIComponent(nodes[i].path)}`);
}

function closeSheet() {
  selected = -1;
  sheet.hidden = true;
  requestDraw();
}

function animatePan(dy) {
  if (reducedMotion.matches) {
    cam.ty += dy;
    requestDraw();
    return;
  }
  const from = cam.ty;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min((now - started) / 160, 1);
    cam.ty = from + dy * (1 - (1 - t) ** 3);
    draw();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function openSheet(i) {
  const node = nodes[i];
  selected = i;
  const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '根目录';
  $('#graph-sheet-title').textContent = node.title;
  $('#graph-sheet-dir').textContent = dir;
  $('#graph-sheet-refs').textContent = `${fmt(node.inbound)} 次`;
  $('#graph-sheet-links').textContent = `${fmt(node.degree)} 条`;
  $('#graph-sheet-open').href = pathHref(node.path);
  $('#graph-sheet-sensitive').hidden = !node.sensitive;
  sheet.hidden = false;
  // 选中的点不能被 sheet 盖住
  const sheetTop = sheet.getBoundingClientRect().top - stage.getBoundingClientRect().top;
  const sy = view.y[i] * cam.k + cam.ty;
  if (sy > sheetTop - 28) animatePan(sheetTop - 28 - sy);
  requestDraw();
}

// —— 手势 ——
const pointers = new Map();
let gesture = null;
let longPress = 0;
let lastTap = { node: -1, at: 0 };
let sheetTimer = 0;

const local = (e) => {
  const box = canvas.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
};
const hitTest = (p, kind) => {
  if (!grid) return -1;
  const wx = (p.x - cam.tx) / cam.k;
  const wy = (p.y - cam.ty) / cam.k;
  return grid.nearest(wx, wy, cam.k, (i) => radius[i], R_MAX, kind === 'mouse' ? HIT_SLOP.mouse : HIT_SLOP.touch);
};
const clampK = (k) => Math.min(Math.max(k, cam.minK), 8);

function zoomAt(px, py, factor) {
  const k = clampK(cam.k * factor);
  const wx = (px - cam.tx) / cam.k;
  const wy = (py - cam.ty) / cam.k;
  cam.k = k;
  cam.tx = px - wx * k;
  cam.ty = py - wy * k;
  userMoved = true;
  requestDraw();
}

function cancelLongPress() {
  clearTimeout(longPress);
  longPress = 0;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    const node = hitTest(p, e.pointerType);
    gesture = { from: p, moved: false, pinched: false, held: false, type: e.pointerType };
    if (node >= 0) {
      longPress = setTimeout(() => {
        longPress = 0;
        gesture.held = true;
        focusOn(node);
      }, LONG_PRESS_MS);
    }
  } else if (gesture) {
    gesture.pinched = true;
    cancelLongPress();
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = local(e);
  const prev = pointers.get(e.pointerId);
  if (!prev) {
    if (e.pointerType !== 'mouse') return;
    const node = hitTest(p, 'mouse');
    canvas.style.cursor = node >= 0 ? 'pointer' : '';
    if (node !== hover) {
      hover = node;
      requestDraw();
    }
    return;
  }
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    if (!gesture.moved && Math.hypot(p.x - gesture.from.x, p.y - gesture.from.y) <= MOVE_TOLERANCE) return;
    gesture.moved = true;
    cancelLongPress();
    cam.tx += p.x - prev.x;
    cam.ty += p.y - prev.y;
    userMoved = true;
    requestDraw();
    return;
  }
  // 双指：以这根手指移动前后的两指连线为准，同时算出缩放和平移，换手指时不跳
  const other = [...pointers].find(([id]) => id !== e.pointerId)[1];
  const before = Math.hypot(prev.x - other.x, prev.y - other.y);
  const after = Math.hypot(p.x - other.x, p.y - other.y);
  if (before > 0) zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, after / before);
  cam.tx += (p.x - prev.x) / 2;
  cam.ty += (p.y - prev.y) / 2;
  requestDraw();
});

function endPointer(e, tapped) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size || !gesture) return;
  const done = gesture;
  gesture = null;
  cancelLongPress();
  if (!tapped || done.moved || done.pinched || done.held) return;
  const node = hitTest(p, done.type);
  const now = performance.now();
  clearTimeout(sheetTimer);
  if (node >= 0 && node === lastTap.node && now - lastTap.at < DOUBLE_TAP_MS) {
    lastTap = { node: -1, at: 0 };
    focusOn(node);
    return;
  }
  lastTap = { node, at: now };
  if (node < 0) closeSheet();
  // sheet 会盖住屏幕下半部分的点，立刻打开的话第二下就点在 sheet 上了，这里等双击窗口过去
  else if (p.y > H - SHEET_ESTIMATE) sheetTimer = setTimeout(() => openSheet(node), DOUBLE_TAP_MS);
  else openSheet(node);
}

canvas.addEventListener('pointerup', (e) => endPointer(e, true));
canvas.addEventListener('pointercancel', (e) => endPointer(e, false));
canvas.addEventListener('pointerleave', () => {
  if (hover < 0 || pointers.size) return;
  hover = -1;
  requestDraw();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = local(e);
  const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  zoomAt(p.x, p.y, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });
// iOS Safari 的页面级捏合不完全听 touch-action
for (const type of ['gesturestart', 'gesturechange']) stage.addEventListener(type, (e) => e.preventDefault());

// —— 工具条与 sheet ——
const setFolded = (folded) => {
  toolbarBody.hidden = folded;
  foldBtn.setAttribute('aria-expanded', String(!folded));
  foldBtn.textContent = folded ? '筛选' : '收起';
};
foldBtn.addEventListener('click', () => {
  setFolded(!toolbarBody.hidden);
  if (!userMoved) {
    fit();
    requestDraw();
  }
});
setFolded(!matchMedia('(min-width: 768px)').matches);

allToggle.checked = showAll;
allToggle.addEventListener('change', () => {
  showAll = allToggle.checked;
  store('kb-graph-all', showAll ? '1' : '0');
  closeSheet();
  showOverview();
});
backBtn.addEventListener('click', () => navigate(`${BASE}/graph`));
$('#graph-fit').addEventListener('click', () => {
  userMoved = false;
  fit();
  requestDraw();
});
$('#graph-sheet-close').addEventListener('click', closeSheet);
$('#graph-sheet-focus').addEventListener('click', () => focusOn(selected));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
window.addEventListener('popstate', route);

const grip = $('#graph-sheet-grip');
let dragFrom = null;
grip.addEventListener('pointerdown', (e) => {
  dragFrom = e.clientY;
  grip.setPointerCapture(e.pointerId);
});
grip.addEventListener('pointerup', (e) => {
  if (dragFrom !== null && e.clientY - dragFrom > 40) closeSheet();
  dragFrom = null;
});

new ResizeObserver(() => {
  const box = stage.getBoundingClientRect();
  const dw = box.width - W;
  const dh = box.height - H;
  W = box.width;
  H = box.height;
  dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  if (userMoved) {
    cam.tx += dw / 2;
    cam.ty += dh / 2;
  } else fit();
  draw();
}).observe(stage);

const repaintTheme = () => {
  readColors();
  if (view) renderLegend();
  requestDraw();
};
new MutationObserver(repaintTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaintTheme);

// —— 数据 ——
function ingest(data) {
  nodes = data.nodes;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  edges = data.edges.map((e) => [index.get(e.source), index.get(e.target)]);
  adjacency = nodes.map(() => []);
  for (const [a, b] of edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  const maxDegree = nodes.reduce((m, n) => Math.max(m, n.degree), 1);
  radius = Float64Array.from(nodes, (n) => R_MIN + (R_MAX - R_MIN) * (n.degree / maxDegree) ** 0.7);
  byPath = new Map(nodes.map((n, i) => [n.path, i]));
  for (const n of nodes) {
    const chars = [...n.title]; // 按字符截，不把 emoji 切成两半
    n.label = chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('')}…` : n.title;
  }
  // 颜色按目录总文件数排定，不看当前视图：隐藏、聚焦都不会让某个目录换色
  const totals = new Map();
  for (const n of nodes) totals.set(n.dir, (totals.get(n.dir) ?? 0) + 1);
  dirs = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([name, total], rank) => ({ name, total, label: name || '根目录', slot: Math.min(rank, OTHER_SLOT) }));
  const slots = new Map(dirs.map((d) => [d.name, d.slot]));
  slotOf = Uint8Array.from(nodes, (n) => slots.get(n.dir));
}

function showError(message, action) {
  const text = document.createElement('p');
  text.textContent = message;
  setState([text, action]);
}

async function load() {
  const wait = document.createElement('p');
  wait.textContent = '正在载入关系图…';
  setState([wait]);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn primary';
  retry.textContent = '重试';
  retry.addEventListener('click', load);
  let data;
  try {
    const res = await fetch(`${BASE}/graph/data`, { signal: AbortSignal.timeout(15000) });
    if (res.redirected) {
      const login = document.createElement('a');
      login.className = 'btn primary';
      login.href = `${BASE}/login?next=${encodeURIComponent(location.pathname.slice(BASE.length) + location.search)}`;
      login.textContent = '重新登录';
      showError('登录已过期，请重新登录。', login);
      return;
    }
    if (!res.ok) {
      showError(`关系图加载失败（HTTP ${res.status}），请稍后再试。`, retry);
      return;
    }
    data = await res.json();
  } catch (err) {
    showError(err.name === 'TimeoutError' ? '服务器响应超时，请稍后再试。' : '连不上服务器，请检查网络后重试。', retry);
    return;
  }
  performance.mark('kb-graph-data');
  ingest(data);
  setState(null);
  route();
}

readColors();
load();
