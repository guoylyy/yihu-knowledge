// 图谱的纯算法部分（不碰 DOM，测试直接 import）。布局全程不用随机数：同样的数据，每次打开形状都一样
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const THETA2 = 0.81; // Barnes-Hut 开角的平方：格子宽度/距离 < 0.9 时把整格当一个质点
const MAX_DEPTH = 32;
const CHARGE = -110;
const GRAVITY = 0.05; // 把互不相连的小团拉在一起，否则它们会被斥力推出屏幕
const LINK_DISTANCE = 44;
const COLLIDE = 0.35; // 靠得比节点半径还近时额外推开，防止大节点叠在一起
const VELOCITY_DECAY = 0.6;
const ALPHA_DECAY = 1 - 0.001 ** (1 / 300);
const ALPHA_MIN = 0.001;

export function neighborhood(adjacency, start, hops) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop < hops; hop++) {
    const next = [];
    for (const node of frontier) {
      for (const other of adjacency[node]) {
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return seen;
}

// 四叉树放在定长数组里：每 tick 重建一次，不产生 GC 压力
function createQuadtree(n, x, y, sizes) {
  const cap = Math.max(64, n * 16);
  const mass = new Float64Array(cap);
  const sumX = new Float64Array(cap);
  const sumY = new Float64Array(cap);
  const leaf = new Int32Array(cap); // >=0 叶子里的点；-1 内部节点
  const kids = new Int32Array(cap * 4);
  const stack = new Int32Array(MAX_DEPTH * 4);
  const widths = new Float64Array(MAX_DEPTH * 4);
  let count = 0;
  let rootX = 0;
  let rootY = 0;
  let rootHalf = 1;

  const alloc = (point) => {
    const c = count++;
    mass[c] = 0;
    sumX[c] = 0;
    sumY[c] = 0;
    leaf[c] = point;
    kids.fill(0, c * 4, c * 4 + 4);
    return c;
  };
  const add = (c, i) => {
    mass[c]++;
    sumX[c] += x[i];
    sumY[c] += y[i];
  };

  function insert(i) {
    let c = 0;
    let cx = rootX;
    let cy = rootY;
    let half = rootHalf;
    for (let depth = 0; ; depth++) {
      const occupant = leaf[c];
      add(c, i);
      if (occupant === -2) { // 空叶子
        leaf[c] = i;
        return;
      }
      if (occupant >= 0) {
        if (depth >= MAX_DEPTH || count + 2 >= cap) return; // 几乎重合的点并入同一格，只累计质量
        leaf[c] = -1;
        const q = (x[occupant] >= cx ? 1 : 0) + (y[occupant] >= cy ? 2 : 0);
        const k = alloc(occupant);
        add(k, occupant);
        kids[c * 4 + q] = k;
      }
      const q = (x[i] >= cx ? 1 : 0) + (y[i] >= cy ? 2 : 0);
      if (!kids[c * 4 + q]) {
        if (count + 2 >= cap) return;
        kids[c * 4 + q] = alloc(-2);
      }
      c = kids[c * 4 + q];
      half /= 2;
      cx += q & 1 ? half : -half;
      cy += q & 2 ? half : -half;
    }
  }

  return {
    build() {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
      }
      rootX = (minX + maxX) / 2;
      rootY = (minY + maxY) / 2;
      rootHalf = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
      count = 0;
      alloc(-2);
      for (let i = 0; i < n; i++) insert(i);
    },
    // 对第 i 个点累加斥力，写进 vx/vy
    repel(i, strength, vx, vy) {
      let top = 0;
      stack[0] = 0;
      widths[0] = rootHalf * 2;
      top = 1;
      while (top) {
        top--;
        const c = stack[top];
        const width = widths[top];
        const dx = sumX[c] / mass[c] - x[i];
        const dy = sumY[c] / mass[c] - y[i];
        const d2 = dx * dx + dy * dy;
        const isLeaf = leaf[c] >= 0;
        if (isLeaf || width * width < THETA2 * d2) {
          if (leaf[c] === i || d2 === 0) continue;
          const f = strength * mass[c] / Math.max(d2, 1);
          vx[i] += dx * f;
          vy[i] += dy * f;
          // 近处的点一定会走到叶子，碰撞检测顺路做，不用再两两比较
          const gap = isLeaf ? sizes[i] + sizes[leaf[c]] : 0;
          if (d2 < gap * gap) {
            const d = Math.sqrt(d2);
            const push = ((gap - d) / d) * COLLIDE;
            vx[i] -= dx * push;
            vy[i] -= dy * push;
          }
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const k = kids[c * 4 + q];
          if (!k || top >= stack.length) continue;
          stack[top] = k;
          widths[top] = width / 2;
          top++;
        }
      }
    },
  };
}

// edges 是 [a, b] 下标对；pinned 的点钉在原点（聚焦视图的中心）；sizes 是各点的碰撞半径
export function createSimulation(n, edges, pinned = -1, sizes = new Float64Array(n)) {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const degree = new Int32Array(n);
  for (const [a, b] of edges) {
    degree[a]++;
    degree[b]++;
  }
  for (let i = 0; i < n; i++) {
    const r = 12 * Math.sqrt(i + 0.5);
    x[i] = r * Math.cos(i * GOLDEN_ANGLE);
    y[i] = r * Math.sin(i * GOLDEN_ANGLE);
  }
  if (pinned >= 0) {
    x[pinned] = 0;
    y[pinned] = 0;
  }
  const tree = createQuadtree(n, x, y, sizes);
  let alpha = 1;

  function tick() {
    alpha += (0 - alpha) * ALPHA_DECAY;
    tree.build();
    for (let i = 0; i < n; i++) tree.repel(i, CHARGE * alpha, vx, vy);
    for (const [a, b] of edges) {
      const dx = x[b] + vx[b] - x[a] - vx[a] || 0.01;
      const dy = y[b] + vy[b] - y[a] - vy[a] || 0.01;
      const dist = Math.hypot(dx, dy);
      const pull = ((dist - LINK_DISTANCE) / dist) * alpha / Math.max(Math.min(degree[a], degree[b]), 1);
      const bias = degree[a] / (degree[a] + degree[b]);
      vx[b] -= dx * pull * bias;
      vy[b] -= dy * pull * bias;
      vx[a] += dx * pull * (1 - bias);
      vy[a] += dy * pull * (1 - bias);
    }
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] - x[i] * GRAVITY * alpha) * VELOCITY_DECAY;
      vy[i] = (vy[i] - y[i] * GRAVITY * alpha) * VELOCITY_DECAY;
      x[i] += vx[i];
      y[i] += vy[i];
    }
    if (pinned >= 0) {
      x[pinned] = 0;
      y[pinned] = 0;
      vx[pinned] = 0;
      vy[pinned] = 0;
    }
  }

  return {
    x,
    y,
    // 在预算内尽量多跑几步；返回 true 表示已收敛。n 为 0 或 1 时没有什么可算的
    run(budgetMs) {
      if (n < 2) return true;
      const started = performance.now();
      do {
        if (alpha < ALPHA_MIN) return true;
        tick();
      } while (performance.now() - started < budgetMs);
      return alpha < ALPHA_MIN;
    },
  };
}

// 孤立点没有边，力导向只会把它们摊成均匀圆盘。这里直接算出圆盘：
// 向日葵点阵铺成环带，再按极角排序分给调用方——同目录排在一起就成了扇区。aspect 是高/宽，让手机竖屏铺满
export function placeRing(count, innerRadius, spacing, aspect = 1) {
  const a = Math.min(Math.max(aspect, 0.6), 1.8);
  const stretchX = Math.sqrt(1 / a);
  const stretchY = Math.sqrt(a);
  const base = innerRadius / Math.min(stretchX, stretchY); // 压扁后的短轴也不能压到内圈
  const points = [];
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(base ** 2 + (i + 0.5) * spacing ** 2);
    const angle = (i * GOLDEN_ANGLE) % (Math.PI * 2);
    points.push({ angle, x: r * Math.cos(angle) * stretchX, y: r * Math.sin(angle) * stretchY });
  }
  return points.sort((p, q) => p.angle - q.angle);
}

// 均匀网格做命中测试：格子数不超过点数，缩到最小时也只扫一遍
export function createHitGrid(members, x, y) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of members) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const side = Math.max(Math.ceil(Math.sqrt(members.length)), 1);
  const cellW = Math.max((maxX - minX) / side, 1e-6);
  const cellH = Math.max((maxY - minY) / side, 1e-6);
  const cells = Array.from({ length: side * side }, () => []);
  const clamp = (v) => Math.min(Math.max(v, 0), side - 1);
  const colOf = (v) => clamp(Math.floor((v - minX) / cellW));
  const rowOf = (v) => clamp(Math.floor((v - minY) / cellH));
  for (const i of members) cells[rowOf(y[i]) * side + colOf(x[i])].push(i);

  return {
    // 世界坐标 (wx, wy) 附近最近的点。半径是屏幕像素，所以要带上缩放 k；slop 是手指的额外容差
    nearest(wx, wy, k, radiusOf, maxRadius, slop) {
      const reach = (maxRadius + slop) / k;
      let best = -1;
      let bestScore = Infinity;
      for (let row = rowOf(wy - reach); row <= rowOf(wy + reach); row++) {
        for (let col = colOf(wx - reach); col <= colOf(wx + reach); col++) {
          for (const i of cells[row * side + col]) {
            const d = Math.hypot(x[i] - wx, y[i] - wy) * k;
            const score = d - radiusOf(i);
            if (score <= slop && score < bestScore) {
              best = i;
              bestScore = score;
            }
          }
        }
      }
      return best;
    },
  };
}
