import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { Client, enc, reindex, startServer } from './helpers.js';
import { createHitGrid, createSimulation, neighborhood, placeRing } from '../public/graph-core.js';

let kb;
let client;
before(async () => {
  kb = await startServer();
  client = new Client(kb.port);
  assert.equal((await client.login()).status, 303);
});
after(() => kb.stop());

const fetchGraph = async () => JSON.parse((await client.get('/graph/data')).text);
const nodeAt = (data, path) => data.nodes.find((n) => n.path === path);
const bumpIndex = () => kb.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'index_generation'").run();

test('图谱：未登录拉不到数据也看不到页面', async () => {
  const anon = new Client(kb.port, '10.2.0.1');
  for (const p of ['/graph/data', '/graph', '/graph?focus=README.md']) {
    const res = await anon.get(p);
    assert.equal(res.status, 302, p);
    assert.match(res.headers.location, /^\/login\?next=/, p);
    assert.ok(!res.text.includes('总览页'), p);
  }
});

test('图谱：登录后结构正确，stats 与数据库直查一致', async () => {
  const data = await fetchGraph();
  const { n } = kb.db.prepare('SELECT COUNT(*) AS n FROM files WHERE is_denied = 0').get();
  const drawn = kb.db.prepare(`SELECT DISTINCT src_id AS s, target_id AS t FROM links l
    JOIN files a ON a.id = l.src_id AND a.is_denied = 0 JOIN files b ON b.id = l.target_id AND b.is_denied = 0
    WHERE l.kind IN ('wiki', 'embed') AND l.src_id != l.target_id`).all();
  const linked = new Set(drawn.flatMap((e) => [e.s, e.t])).size;
  assert.deepEqual(data.stats, { nodes: n, linked, edges: drawn.length, isolated: n - linked });
  assert.equal(data.nodes.length, n);
  assert.equal(data.edges.length, drawn.length);
  assert.ok(drawn.length > 0);
  assert.equal(data.nodes.filter((x) => x.degree > 0).length, linked);
  for (const key of ['id', 'path', 'title', 'dir', 'degree', 'sensitive']) assert.ok(key in data.nodes[0], key);

  const readme = nodeAt(data, 'README.md');
  assert.equal(readme.title, '总览页');
  assert.equal(readme.dir, '');
  assert.equal(nodeAt(data, 'share/子目录/深层.txt').dir, 'share');
});

test('图谱：deny 的文件和指向它的边都不返回，索引尚未更新时规则也生效', async () => {
  const first = await fetchGraph();
  const texts = JSON.stringify(first);
  assert.ok(!texts.includes('工资密码表'));
  assert.ok(!texts.includes('绝密'));
  assert.ok(!texts.includes('MY_TOKEN_NOTES'));

  const victim = nodeAt(first, 'notes/笔记乙.md');
  assert.ok(victim.degree > 0);
  kb.db.prepare('UPDATE files SET is_denied = 1 WHERE id = ?').run(victim.id);
  bumpIndex();
  const second = await fetchGraph();
  assert.equal(nodeAt(second, 'notes/笔记乙.md'), undefined);
  assert.ok(!second.edges.some((e) => e.source === victim.id || e.target === victim.id));
  kb.db.prepare('UPDATE files SET is_denied = 0 WHERE id = ?').run(victim.id);
  bumpIndex();

  // 新增 deny 规则后、下一轮索引之前：库里还是 is_denied=0，读路径同样要拦住
  const { isDenied } = kb.deny;
  kb.deny.isDenied = (p, opts) => p === 'notes/笔记乙.md' || isDenied(p, opts);
  try {
    const third = await fetchGraph();
    assert.equal(nodeAt(third, 'notes/笔记乙.md'), undefined);
    assert.ok(!third.edges.some((e) => e.source === victim.id || e.target === victim.id));
    assert.match((await client.get(`/graph?focus=${encodeURIComponent('notes/笔记乙.md')}`)).text, /没找到这篇笔记/);
  } finally {
    kb.deny.isDenied = isDenied;
  }
});

test('图谱：无悬挂边、无自环、无重复', async () => {
  const data = await fetchGraph();
  const ids = new Set(data.nodes.map((n) => n.id));
  const seen = new Set();
  for (const e of data.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target));
    assert.notEqual(e.source, e.target);
    const key = `${e.source}>${e.target}`;
    assert.ok(!seen.has(key));
    seen.add(key);
  }
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  for (const n of data.nodes) assert.equal(n.degree, degree.get(n.id) ?? 0, n.path);
});

test('图谱：同一对笔记写两次、自己链自己，都不多算边', async () => {
  fs.writeFileSync(`${kb.lib.root}/share/重复.md`, '# 重复\n\n[[公开二]] 再写一次 [[公开二]]，自己 [[重复]]。\n');
  reindex(kb);
  const data = await fetchGraph();
  const dup = nodeAt(data, 'share/重复.md');
  assert.equal(dup.degree, 1);
  assert.equal(data.edges.filter((e) => e.source === dup.id).length, 1);
  fs.rmSync(`${kb.lib.root}/share/重复.md`);
  reindex(kb);
});

test('图谱：敏感笔记只带标题和标记，不带摘要和正文', async () => {
  const data = await fetchGraph();
  const secret = nodeAt(data, 'notes/泄密笔记.md');
  assert.equal(secret.sensitive, 1);
  assert.equal(secret.title, '运维备忘');
  assert.ok(!('excerpt' in secret));
  assert.equal(nodeAt(data, 'README.md').sensitive, 0);
  assert.ok(!JSON.stringify(data).includes('hunter2'));
});

test('图谱：被引用次数与阅读页的反向链接一致，含 md 链接', async () => {
  fs.writeFileSync(`${kb.lib.root}/share/普通链接.md`, '# 普通链接\n\n[说明](公开说明.md)\n');
  reindex(kb);
  const data = await fetchGraph();
  const target = nodeAt(data, 'share/公开说明.md');
  const page = await client.get(`/v/${enc('share/公开说明.md')}`);
  const section = page.text.match(/<section class="backlinks">([\s\S]*?)<\/section>/)[1];
  assert.equal(target.inbound, section.match(/<li>/g).length);
  assert.ok(section.includes('普通链接'));
  // md 链接不算双链，这一篇没有边，但它确实引用了别人
  assert.equal(nodeAt(data, 'share/普通链接.md').degree, 0);
  fs.rmSync(`${kb.lib.root}/share/普通链接.md`);
  reindex(kb);
});

test('图谱页：focus 不存在、被 deny、参数异常都降级为全图', async () => {
  const cases = ['nope/不存在.md', '工资密码表.md', '../../etc/passwd'];
  for (const focus of cases) {
    const res = await client.get(`/graph?focus=${encodeURIComponent(focus)}`);
    assert.equal(res.status, 200, focus);
    assert.ok(res.text.includes('没找到这篇笔记'), focus);
  }
  const repeated = await client.get('/graph?focus=a&focus=b');
  assert.equal(repeated.status, 200);
  const ok = await client.get(`/graph?focus=${encodeURIComponent('README.md')}`);
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes('没找到这篇笔记'));
});

test('图谱页：不内联数据、不引外链，脚本走同源并受 CSP 约束', async () => {
  const res = await client.get('/graph');
  assert.equal(res.status, 200);
  assert.ok(res.text.length < 12000, `HTML ${res.text.length} 字节`);
  assert.ok(!res.text.includes('"nodes"'));
  assert.ok(!res.text.includes('总览页'));
  assert.ok(!/<(script|link|img|iframe)\b[^>]*(src|href)="(https?:)?\/\//i.test(res.text));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(res.text), '不能有内联脚本');
  assert.ok(!/\sstyle="/i.test(res.text), 'CSP 不允许内联样式');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  for (const asset of ['/assets/graph.js', '/assets/graph-core.js']) {
    const js = await client.get(asset);
    assert.equal(js.status, 200, asset);
    assert.match(js.headers['content-type'], /javascript/);
    assert.ok(!/https?:\/\//.test(js.text), asset);
  }
});

test('阅读页：登录后有「关系图」入口且路径已编码，分享页没有', async () => {
  const page = await client.get(`/v/${enc('notes/笔记甲.md')}`);
  assert.ok(page.text.includes(`href="/graph?focus=${encodeURIComponent('notes/笔记甲.md')}"`));
  const made = await client.createShare({ path: 'share/公开说明.md' });
  const token = (await client.get(made.headers.location)).text.match(/\/s\/([\w-]{16,})/)[1];
  const shared = await new Client(kb.port, '10.2.0.2').get(`/s/${token}`);
  assert.equal(shared.status, 200);
  assert.ok(!shared.text.includes('/graph'));
});

test('布局：确定性、无 NaN、聚焦中心钉在原点，重合的点也不崩', () => {
  const edges = [[0, 1], [1, 2], [2, 0], [3, 4], [5, 0]];
  const run = () => {
    const sim = createSimulation(6, edges, 0);
    while (!sim.run(50));
    return [...sim.x, ...sim.y];
  };
  const a = run();
  assert.deepEqual(a, run());
  assert.ok(a.every(Number.isFinite));
  assert.equal(a[0], 0);
  assert.equal(a[6], 0);
  assert.equal(createSimulation(1, []).run(1), true);
  assert.equal(createSimulation(0, []).run(1), true);
  const big = createSimulation(500, Array.from({ length: 499 }, (_, i) => [i, i + 1]));
  big.x.fill(5);
  big.y.fill(5);
  while (!big.run(50));
  assert.ok([...big.x, ...big.y].every(Number.isFinite));
});

test('布局：两跳邻域、环带、命中测试', () => {
  const adjacency = [[1], [0, 2], [1, 3], [2], []];
  assert.deepEqual([...neighborhood(adjacency, 0, 2)].sort(), [0, 1, 2]);
  assert.deepEqual([...neighborhood(adjacency, 4, 2)], [4]);

  const ring = placeRing(200, 100, 14);
  assert.equal(ring.length, 200);
  assert.ok(ring.every((p) => Math.hypot(p.x, p.y) >= 100));
  assert.ok(ring.every((p, i) => !i || p.angle >= ring[i - 1].angle));
  assert.ok(placeRing(200, 100, 14, 2).every((p) => Math.hypot(p.x, p.y) >= 100), '竖屏压扁后也不能压到内圈');

  const x = Float64Array.from([0, 100, 200]);
  const y = Float64Array.from([0, 0, 0]);
  const grid = createHitGrid([0, 1, 2], x, y);
  const r = () => 5;
  assert.equal(grid.nearest(101, 1, 1, r, 14, 4), 1);
  assert.equal(grid.nearest(50, 50, 1, r, 14, 4), -1);
  // 缩到 0.1 倍时屏幕上只差几个像素，容差以屏幕像素计
  assert.equal(grid.nearest(180, 0, 0.1, r, 14, 16), 2);
  assert.equal(createHitGrid([], x, y).nearest(0, 0, 1, r, 14, 4), -1);
});
