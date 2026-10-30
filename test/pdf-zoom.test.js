import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom, createGestures, doubleTapTarget, isZoomed, pinchZoom, previewOffset, renderScale, snapZoom, wheelFactor } from '../public/pdf-zoom.mjs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function rig({ zoomed = false } = {}) {
  const log = [];
  const gestures = createGestures({
    zoomed: () => zoomed,
    onPinchStart: (x, y) => log.push(['start', x, y]),
    onPinchMove: (scale, x, y) => log.push(['move', scale, x, y]),
    onPinchEnd: () => log.push(['end']),
    onSwipe: (step) => log.push(['swipe', step]),
    onDoubleTap: (x, y) => log.push(['double', x, y]),
  });
  return { gestures, log, kinds: () => log.map((entry) => entry[0]) };
}

const finger = (id, x, y) => ({ id, x, y });

function drag({ gestures }, from, to, { at = 0, ms = 100, id = 1 } = {}) {
  gestures.down([finger(id, ...from)], at);
  gestures.move([finger(id, ...to)]);
  return gestures.up([], finger(id, ...to), at + ms);
}

const tap = ({ gestures }, x, y, at, ms = 40) => {
  gestures.down([finger(1, x, y)], at);
  return gestures.up([], finger(1, x, y), at + ms);
};

test('缩放范围是 1x~5x，1x 附近吸附回适宽', () => {
  assert.equal(clampZoom(0.2), 1);
  assert.equal(clampZoom(9), 5);
  assert.equal(snapZoom(1.05), ZOOM_MIN);
  assert.equal(snapZoom(0.7), ZOOM_MIN);
  assert.equal(snapZoom(1.2), 1.2);
  assert.equal(snapZoom(7), ZOOM_MAX);
});

test('放大判定以 1.01 为界，吸附后不会停在 1 和 1.01 之间', () => {
  assert.equal(isZoomed(1), false);
  assert.equal(isZoomed(1.01), false);
  assert.equal(isZoomed(1.02), true);
  assert.equal(isZoomed(snapZoom(1.005)), false);
});

test('一步步缩小能回到正好 1x，缩小按钮才会禁用', () => {
  let z = ZOOM_MAX;
  for (let i = 0; i < 20 && z > 1; i++) z = snapZoom(z / ZOOM_STEP);
  assert.equal(z, 1);
});

test('双击：适宽放大到 2x，放大状态回适宽', () => {
  assert.equal(doubleTapTarget(1), 2);
  assert.equal(doubleTapTarget(1.5), 1);
  assert.equal(doubleTapTarget(5), 1);
});

test('捏合按两指距离比例缩放并夹在范围内', () => {
  assert.equal(pinchZoom(1, 2), 2);
  assert.equal(pinchZoom(2, 1.5), 3);
  assert.equal(pinchZoom(3, 10), 5);
  assert.equal(pinchZoom(2, 0.1), 1);
});

test('适页比适宽小时，捏合从当前大小起算，不会一碰就跳到 1x', () => {
  assert.equal(pinchZoom(0.5, 1), 0.5);
  assert.equal(pinchZoom(0.5, 0.5), 0.5);
  assert.equal(pinchZoom(0.5, 4), 2);
});

test('预览锚点：放大时两指中点下的内容不动', () => {
  const view = { viewWidth: 400, viewHeight: 600, contentWidth: 400, contentHeight: 5000 };
  const { k, left, top } = previewOffset({ ...view, start: 1, zoom: 2, originX: 150, originY: 1300, x: 150, y: 300 });
  assert.equal(k, 2);
  assert.equal(150 * k - left, 150);
  assert.equal(1300 * k - top, 300);
});

test('预览锚点：两指一起移动时内容跟着走', () => {
  const view = { viewWidth: 400, viewHeight: 600, contentWidth: 400, contentHeight: 5000 };
  const { k, left, top } = previewOffset({ ...view, start: 1, zoom: 2, originX: 200, originY: 1300, x: 180, y: 340 });
  assert.equal(200 * k - left, 180);
  assert.equal(1300 * k - top, 340);
});

test('预览贴边后停住，不露出空白', () => {
  const view = { viewWidth: 400, viewHeight: 600, contentWidth: 400, contentHeight: 800 };
  const low = previewOffset({ ...view, start: 1, zoom: 2, originX: 10, originY: 10, x: 300, y: 500 });
  assert.deepEqual([low.left, low.top], [0, 0]);
  const high = previewOffset({ ...view, start: 1, zoom: 2, originX: 390, originY: 790, x: 10, y: 10 });
  assert.deepEqual([high.left, high.top], [400, 1000]);
});

test('预览：内容比视口矮时不产生负滚动', () => {
  const { top } = previewOffset({ viewWidth: 400, viewHeight: 900, contentWidth: 400, contentHeight: 300, start: 1, zoom: 2, originX: 200, originY: 150, x: 200, y: 150 });
  assert.equal(top, 0);
});

test('清晰度：渲染比例 = CSS 缩放 × min(dpr, 3)，受像素上限约束', () => {
  assert.equal(renderScale(0.6, 2, 595, 842, 8e6), 1.2);
  assert.equal(renderScale(0.6, 4, 595, 842, 8e6), 1.7999999999999998);
  assert.equal(renderScale(1, undefined, 595, 842, 8e6), 1);
  const capped = renderScale(3, 3, 595, 842, 8e6);
  assert.ok(Math.abs(595 * capped * 842 * capped - 8e6) < 1);
  assert.ok(renderScale(3, 3, 595, 842, 16e6) > capped);
});

test('Ctrl+滚轮：向上放大、向下缩小，鼠标一格不会放大近 3 倍', () => {
  assert.ok(wheelFactor(-4) > 1);
  assert.ok(wheelFactor(4) < 1);
  assert.ok(wheelFactor(-120) < 1.3);
  assert.equal(wheelFactor(-3, 1), wheelFactor(-48));
  assert.equal(wheelFactor(0), 1);
});

test('手势：未放大时左滑下一页、右滑上一页', () => {
  const left = rig();
  drag(left, [300, 200], [100, 210]);
  assert.deepEqual(left.log, [['swipe', 1]]);
  const right = rig();
  drag(right, [100, 200], [300, 210]);
  assert.deepEqual(right.log, [['swipe', -1]]);
});

test('手势：放大后单指滑动是平移，不翻页', () => {
  const g = rig({ zoomed: true });
  g.gestures.down([finger(1, 300, 200)], 0);
  g.gestures.move([finger(1, 100, 205)]);
  assert.equal(g.gestures.state, 'pan');
  g.gestures.up([], finger(1, 100, 205), 100);
  assert.deepEqual(g.log, []);
  assert.equal(g.gestures.state, 'idle');
});

test('手势：放大状态在手指落下时定，中途变化不改变这次手势的归属', () => {
  let zoomed = true;
  const gestures = createGestures({ zoomed: () => zoomed, onSwipe: () => assert.fail('不该翻页'), onPinchStart() {}, onPinchMove() {}, onPinchEnd() {}, onDoubleTap() {} });
  gestures.down([finger(1, 300, 200)], 0);
  zoomed = false;
  gestures.move([finger(1, 100, 200)]);
  gestures.up([], finger(1, 100, 200), 100);
});

test('手势：竖着滑、太慢、太短都不翻页', () => {
  for (const [from, to, ms] of [[[300, 100], [260, 400], 100], [[300, 200], [100, 200], 900], [[300, 200], [270, 200], 100]]) {
    const g = rig();
    drag(g, from, to, { ms });
    assert.deepEqual(g.log, []);
  }
});

test('手势：两指按距离比例报告缩放，中点跟着手指', () => {
  const g = rig();
  g.gestures.down([finger(1, 100, 300)], 0);
  g.gestures.down([finger(1, 100, 300), finger(2, 200, 300)], 10);
  assert.equal(g.gestures.state, 'pinch');
  const claimed = g.gestures.move([finger(1, 50, 300), finger(2, 250, 300)]);
  assert.equal(claimed, true, '捏合的移动要拦住浏览器默认行为');
  assert.deepEqual(g.log, [['start', 150, 300], ['move', 2, 150, 300]]);
});

test('手势：单指滑动中加第二指转入捏合，松手不翻页', () => {
  const g = rig();
  g.gestures.down([finger(1, 300, 200)], 0);
  g.gestures.move([finger(1, 200, 200)]);
  g.gestures.down([finger(1, 200, 200), finger(2, 100, 200)], 50);
  g.gestures.up([finger(2, 100, 200)], finger(1, 200, 200), 90);
  g.gestures.up([], finger(2, 40, 200), 100);
  assert.deepEqual(g.kinds(), ['start', 'end']);
});

test('手势：捏合后留在屏幕上的手指不触发翻页，也不算点击', () => {
  const g = rig();
  g.gestures.down([finger(1, 300, 200), finger(2, 200, 200)], 0);
  g.gestures.up([finger(2, 200, 200)], finger(1, 300, 200), 100);
  assert.equal(g.gestures.state, 'lifted');
  g.gestures.move([finger(2, 20, 200)]);
  g.gestures.up([], finger(2, 20, 200), 150);
  assert.deepEqual(g.kinds(), ['start', 'end']);
  assert.equal(g.gestures.state, 'idle');
});

test('手势：捏合抬一指又放回去，是新的一次捏合', () => {
  const g = rig();
  g.gestures.down([finger(1, 300, 200), finger(2, 200, 200)], 0);
  g.gestures.up([finger(2, 200, 200)], finger(1, 300, 200), 100);
  g.gestures.down([finger(2, 200, 200), finger(3, 100, 200)], 150);
  assert.deepEqual(g.kinds(), ['start', 'end', 'start']);
});

test('手势：第三根手指落下或抬起不打断捏合', () => {
  const g = rig();
  const two = [finger(1, 300, 200), finger(2, 200, 200)];
  g.gestures.down(two, 0);
  g.gestures.down([...two, finger(3, 50, 50)], 10);
  g.gestures.up(two, finger(3, 50, 50), 20);
  assert.equal(g.gestures.state, 'pinch');
  assert.deepEqual(g.kinds(), ['start']);
});

test('手势：系统打断时收尾，预览不会卡在 transform 上', () => {
  const g = rig();
  g.gestures.down([finger(1, 300, 200), finger(2, 200, 200)], 0);
  g.gestures.cancel([]);
  assert.deepEqual(g.kinds(), ['start', 'end']);
  assert.equal(g.gestures.state, 'idle');
});

test('手势：双击判定间隔 <300ms、位移 <10px，触发时要求拦截', () => {
  const g = rig();
  assert.equal(tap(g, 100, 200, 0), false);
  assert.equal(tap(g, 104, 203, 200), true);
  assert.deepEqual(g.log, [['double', 104, 203]]);
});

test('手势：间隔太长或离得太远不算双击', () => {
  const slow = rig();
  tap(slow, 100, 200, 0);
  tap(slow, 100, 200, 400);
  assert.deepEqual(slow.log, []);
  const far = rig();
  tap(far, 100, 200, 0);
  tap(far, 130, 200, 150);
  assert.deepEqual(far.log, []);
});

test('手势：三连击只触发一次双击，第四下才是下一次', () => {
  const g = rig();
  for (const at of [0, 120, 240, 360]) tap(g, 100, 200, at);
  assert.deepEqual(g.kinds(), ['double', 'double']);
});

test('手势：长按不算点击', () => {
  const g = rig();
  tap(g, 100, 200, 0, 500);
  tap(g, 100, 200, 600);
  assert.deepEqual(g.log, []);
});

test('手势：捏合之后紧接一次点击不和捏合前的点击凑成双击', () => {
  const g = rig();
  tap(g, 100, 200, 0);
  g.gestures.down([finger(1, 100, 200), finger(2, 200, 200)], 50);
  g.gestures.up([], finger(1, 100, 200), 80);
  tap(g, 100, 200, 120);
  assert.deepEqual(g.kinds(), ['start', 'end']);
});

test('页面没有用 user-scalable 禁缩放，无障碍缩放还在', () => {
  assert.doesNotMatch(read('views/partials/head.ejs'), /user-scalable|maximum-scale/);
});

test('阅读区交给手势：未放大只放行竖向，放大后放行两轴，都不放行浏览器捏合', () => {
  const css = read('public/app.css');
  assert.match(css, /\.pdfv-scroll \{[^}]*touch-action: pan-y;/);
  assert.match(css, /\.pdfv-scroll\.pdfv-zoomed \{[^}]*touch-action: pan-x pan-y;/);
  assert.doesNotMatch(css.match(/\.pdfv-scroll[^\n]*/g).join('\n'), /pinch-zoom|touch-action: auto/);
});

test('canvas 不接触摸：重绘换 canvas 时手势不会断', () => {
  assert.match(read('public/app.css'), /\.pdfv-page canvas \{[^}]*pointer-events: none/);
});

test('滚轮只在 Ctrl/⌘ 时拦截，普通滚轮原样放行', () => {
  const js = read('public/pdf-viewer.mjs');
  const handler = js.slice(js.indexOf("addEventListener('wheel'"));
  assert.ok(handler.indexOf('if (!e.ctrlKey && !e.metaKey) return;') < handler.indexOf('e.preventDefault()'));
});
