// 阅读器缩放的纯算法和手势状态机（不碰 DOM，测试直接 import）。zoom 的单位是「适宽」的倍数
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 1.25;
export const ZOOM_DOUBLE_TAP = 2;
const ZOOM_SNAP = 1.08; // 捏回这个倍数以内就当作想回适宽
const ZOOMED = 1.01;
const TAP_SLOP = 10;
const TAP_GAP_MS = 300;
const TAP_HOLD_MS = 300; // 按住不算点击，否则长按后再点一下会被当成双击
const SWIPE_MIN = 50;
const SWIPE_MS = 800;
const SWIPE_RATIO = 1.5;
const WHEEL_SPEED = 0.01;
const WHEEL_MAX = 25; // 滚轮一格的 delta 是 100 上下，触控板捏合只有几，不限幅的话滚一格就放大近 3 倍

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const clampZoom = (z) => clamp(z, ZOOM_MIN, ZOOM_MAX);
export const snapZoom = (z) => (clampZoom(z) <= ZOOM_SNAP ? ZOOM_MIN : clampZoom(z));
export const isZoomed = (z) => z > ZOOMED;
export const doubleTapTarget = (z) => (isZoomed(z) ? ZOOM_MIN : ZOOM_DOUBLE_TAP);

// 适页比适宽小时从当前大小起捏，下限不能把画面突然撑到 1x
export const pinchZoom = (start, scale) => clamp(start * scale, Math.min(start, ZOOM_MIN), ZOOM_MAX);

export const wheelFactor = (deltaY, deltaMode = 0) => {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.exp(-clamp(pixels, -WHEEL_MAX, WHEEL_MAX) * WHEEL_SPEED);
};

// viewport.scale = CSS 缩放 × min(dpr, 3)，再受单张 canvas 像素上限约束
export const renderScale = (cssScale, dpr, width, height, maxPixels) => Math.min(cssScale * Math.min(dpr || 1, 3), Math.sqrt(maxPixels / (width * height)));

// 捏合预览的位移：origin 是起手时手指下的内容坐标，让它跟着两指中点 (x, y)。贴边后停住，不把空白露出来
export function previewOffset({ start, zoom, originX, originY, x, y, viewWidth, viewHeight, contentWidth, contentHeight }) {
  const k = zoom / start;
  return {
    k,
    left: clamp(originX * k - x, 0, Math.max(0, contentWidth * k - viewWidth)),
    top: clamp(originY * k - y, 0, Math.max(0, contentHeight * k - viewHeight)),
  };
}

// 状态：
//   idle   没有手指
//   tap    一指未离开 10px，可能是点击
//   swipe  一指滑动且未放大，松手时判定翻页；竖向由浏览器滚动
//   pan    一指滑动且已放大，由浏览器原生滚动平移，松手什么也不做
//   pinch  两指，缩放，翻页和点击都失效
//   lifted 捏合刚结束还有手指留在屏幕上，全部抬起前不接受单指手势，否则抬手慢一点就会误翻页
// zoomed 只在手指落下时取一次：一次手势的归属不能中途改变
export function createGestures({ zoomed, onPinchStart, onPinchMove, onPinchEnd, onSwipe, onDoubleTap }) {
  let state = 'idle';
  let start = null;
  let pair = null;
  let spread = 0;
  let lastTap = null;

  const center = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const tracked = (touches) => pair.map((id) => touches.find((t) => t.id === id));
  const endPinch = (remaining) => {
    onPinchEnd();
    pair = null;
    state = remaining > 0 ? 'lifted' : 'idle';
  };

  return {
    get state() { return state; },
    down(touches, at) {
      if (touches.length >= 2) {
        if (state === 'pinch') return;
        const [a, b] = touches;
        pair = [a.id, b.id];
        spread = gap(a, b) || 1;
        lastTap = null;
        state = 'pinch';
        const mid = center(a, b);
        onPinchStart(mid.x, mid.y);
      } else if (state === 'idle') {
        const [t] = touches;
        start = { x: t.x, y: t.y, at, zoomed: zoomed() };
        state = 'tap';
      }
    },
    // 返回 true 表示这次移动归手势所有，调用方要拦住浏览器的默认行为
    move(touches) {
      if (state === 'pinch') {
        const [a, b] = tracked(touches);
        if (!a || !b) return true;
        const mid = center(a, b);
        onPinchMove(gap(a, b) / spread, mid.x, mid.y);
        return true;
      }
      if (state === 'tap' && touches[0] && gap(touches[0], start) >= TAP_SLOP) state = start.zoomed ? 'pan' : 'swipe';
      return false;
    },
    up(touches, changed, at) {
      if (state === 'pinch') {
        if (tracked(touches).some((t) => !t)) endPinch(touches.length);
        return true;
      }
      if (touches.length > 0) return false;
      const was = state;
      state = 'idle';
      if (was === 'swipe') {
        const dx = changed.x - start.x;
        const dy = changed.y - start.y;
        if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO && at - start.at < SWIPE_MS) onSwipe(dx < 0 ? 1 : -1);
      } else if (was === 'tap' && at - start.at < TAP_HOLD_MS) {
        if (lastTap && at - lastTap.at < TAP_GAP_MS && gap(changed, lastTap) < TAP_SLOP) {
          lastTap = null;
          onDoubleTap(changed.x, changed.y);
          return true;
        }
        lastTap = { x: changed.x, y: changed.y, at };
      }
      return false;
    },
    cancel(touches) {
      if (state === 'pinch') endPinch(touches.length);
      else state = touches.length > 0 ? 'lifted' : 'idle';
    },
  };
}
