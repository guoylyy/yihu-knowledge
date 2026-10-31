import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client, makeLibrary, request, startServer } from './helpers.js';
import { boot } from '../src/boot.js';
import http from 'node:http';
import { createBrowser, MAX_DIRS, MAX_MD, parseMountinfo, probeMounts } from '../src/browse.js';
import { DEFAULT_KB_ROOTS, effectiveDenyGlobs, loadConfig, loadSetupEnv } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { PathRejected } from '../src/paths.js';
import { inspectLibrary } from '../src/setup.js';

const deny = createDeny(effectiveDenyGlobs());

function tree() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-browse-'));
  const root = path.join(base, 'library');
  const write = (rel, content = '# x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  write('notes/a.md');
  write('notes/deep/b.MD');
  write('notes/deep/c.txt');
  write('notes/.obsidian/ignored.md');
  write('notes/工资密码表.md');
  write('notes/密码本/d.md');
  write('.hidden/e.md');
  write('empty/readme.txt');
  write('一个很长的目录名/f.md');
  fs.writeFileSync(path.join(base, 'outside.md'), 'OUTSIDE-CONTENT');
  fs.mkdirSync(path.join(base, 'outside-dir/inner'), { recursive: true });
  fs.writeFileSync(path.join(base, 'outside-dir/inner/secret.md'), 'OUTSIDE-CONTENT');
  fs.symlinkSync(path.join(base, 'outside-dir'), path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'notes'), path.join(root, 'inner-link'));
  return { base, root, dataDir: path.join(base, 'data'), browser: createBrowser({ roots: [root], deny, dataDir: path.join(base, 'data') }) };
}

const rejected = (promise) => assert.rejects(promise, PathRejected);

test('越界：相对路径、..、绝对路径越界、前缀相同的兄弟目录、控制字符全部拒绝', async () => {
  const t = tree();
  fs.mkdirSync(`${t.root}-evil`);
  for (const bad of ['../../etc', '/etc', '/', `${t.root}/../outside-dir`, `${t.root}/notes/../../outside-dir`, `${t.root}-evil`, `${t.root}/notes\0`, `${t.root}\\notes`, `${t.root}/notes/${'x'.repeat(5000)}`, ['a', 'b'], 'notes']) {
    await rejected(t.browser.list({ path: bad }));
  }
});

test('符号链接逃逸：目录、目录里的子路径、根内互指都拒绝，也不出现在列表里', async () => {
  const t = tree();
  await rejected(t.browser.list({ path: `${t.root}/escape` }));
  await rejected(t.browser.list({ path: `${t.root}/escape/inner` }));
  await rejected(t.browser.list({ path: `${t.root}/inner-link` }));
  const names = (await t.browser.list({ path: t.root })).dirs.map((d) => d.name);
  assert.ok(!names.includes('escape'));
  assert.ok(!names.includes('inner-link'));
});

test('拒绝不泄露路径是否存在：不存在、是文件、符号链接后面的路径是同一种错误', async () => {
  const t = tree();
  const errors = [];
  for (const target of [`${t.root}/no-such`, `${t.root}/notes/a.md`, `${t.root}/escape/inner`, `${t.root}/escape/no-such`, '/etc', '/no-such-anywhere']) {
    errors.push(await t.browser.list({ path: target }).catch((err) => `${err.constructor.name}:${err.message}:${err.status}`));
  }
  assert.equal(new Set(errors).size, 1);
  assert.equal(errors[0], 'PathRejected:path rejected:403');
});

test('根本身是符号链接时照常可用，比较的是真实路径', async () => {
  const t = tree();
  const alias = path.join(t.base, 'alias');
  fs.symlinkSync(t.root, alias);
  const browser = createBrowser({ roots: [alias], deny, dataDir: t.dataDir });
  const data = await browser.list({ path: `${alias}/notes` });
  assert.equal(data.path, `${alias}/notes`);
  assert.equal(data.crumbs[0].path, alias);
});

test('隐藏目录、deny 目录既不显示，也不能直接进', async () => {
  const t = tree();
  const data = await t.browser.list({ path: `${t.root}/notes` });
  assert.deepEqual(data.dirs.map((d) => d.name), ['deep']);
  await rejected(t.browser.list({ path: `${t.root}/.hidden` }));
  await rejected(t.browser.list({ path: `${t.root}/notes/.obsidian` }));
  await rejected(t.browser.list({ path: `${t.root}/notes/密码本` }));
});

test('md 计数：递归、不分大小写、不跟随链接、不算 deny 命中的，和索引口径一致', async () => {
  const t = tree();
  const data = await t.browser.list({ path: t.root });
  const count = Object.fromEntries(data.dirs.map((d) => [d.name, d.mdCount]));
  assert.deepEqual(count, { empty: 0, notes: 2, 一个很长的目录名: 1 });
  // 根下的总数包含隐藏目录里的：索引器也会收它，这个数要和选中后看到的一致
  assert.equal(data.currentMdCount, 4);
  const report = await inspectLibrary(t.root, { deny, dataDir: t.dataDir });
  assert.equal(data.currentMdCount, report.byExt.md);
});

test('md 计数上限：超过 5000 只报 5000 并标记 more', async () => {
  const t = tree();
  const big = path.join(t.root, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < MAX_MD + 3; i++) fs.writeFileSync(path.join(big, `${i}.md`), '');
  const row = (await t.browser.list({ path: t.root })).dirs.find((d) => d.name === 'big');
  assert.equal(row.mdCount, MAX_MD);
  assert.equal(row.more, true);
  const exact = path.join(t.root, 'exact');
  fs.mkdirSync(exact);
  for (let i = 0; i < MAX_MD; i++) fs.writeFileSync(path.join(exact, `${i}.md`), '');
  const full = (await t.browser.list({ path: t.root })).dirs.find((d) => d.name === 'exact');
  assert.equal(full.mdCount, MAX_MD);
  assert.equal(full.more, false);
});

test('读写判断：可写和只读目录分得开，判断时不往目录里写东西', async (t2) => {
  if (process.getuid?.() === 0) return t2.skip('root 不受权限位限制');
  const t = tree();
  const locked = path.join(t.root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'a.md'), '# a');
  fs.chmodSync(locked, 0o555);
  const before = fs.readdirSync(locked);
  const data = await t.browser.list({ path: t.root });
  const flags = Object.fromEntries(data.dirs.map((d) => [d.name, d.writable]));
  assert.equal(flags.notes, true);
  assert.equal(flags.locked, false);
  assert.equal((await t.browser.list({ path: locked })).writable, false);
  assert.deepEqual(fs.readdirSync(locked), before);
  fs.chmodSync(locked, 0o755);
});

test('没有读取权限的子目录标出来，不当成 0 篇的空目录', async (t2) => {
  if (process.getuid?.() === 0) return t2.skip('root 不受权限位限制');
  const t = tree();
  const locked = path.join(t.root, 'noread');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  const row = (await t.browser.list({ path: t.root })).dirs.find((d) => d.name === 'noread');
  assert.equal(row.unreadable, true);
  await rejected(t.browser.list({ path: locked }));
  fs.chmodSync(locked, 0o755);
});

test('根不存在或是文件：不显示；都不可用时给出挂载命令，镜像名跟随 lite/full', async () => {
  const t = tree();
  const file = path.join(t.base, 'outside.md');
  const none = createBrowser({ roots: [path.join(t.base, 'nope'), file], deny, dataDir: t.dataDir, inDocker: true });
  const lite = await none.list({});
  assert.deepEqual(lite.dirs, []);
  assert.match(lite.command, /-v "\/你的\/笔记目录:\/data\/library:ro" -v kb-data:\/data yihu-knowledge:lite$/);
  const full = await createBrowser({ roots: [], deny, dataDir: t.dataDir, soffice: '/usr/bin/soffice' }).list({});
  assert.match(full.command, /yihu-knowledge:full$/);
  await rejected(none.list({ path: path.join(t.base, 'nope') }));
});

test('空的根不算可用：镜像自带的空 /mnt、/media 不能挡住挂载提示；只有隐藏文件也算空', async () => {
  const t = tree();
  const mnt = path.join(t.base, 'mnt');
  const media = path.join(t.base, 'media');
  fs.mkdirSync(mnt);
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, '.DS_Store'), '');
  const browser = createBrowser({ roots: [mnt, media], deny, dataDir: t.dataDir, inDocker: true });
  const data = await browser.list({});
  assert.deepEqual(data.dirs, []);
  assert.ok(data.command);
  // 挂了一个空目录是另一回事：用户确实挂了，只是还没有文件
  const mounted = await createBrowser({ roots: [mnt], mounts: [mnt], deny, dataDir: t.dataDir, inDocker: true }).list({});
  assert.deepEqual(mounted.dirs.map((d) => d.path), [mnt]);
  assert.equal(mounted.command, null);
});

test('顶层列表：同一个真实目录不重复；路径作为名字', async () => {
  const t = tree();
  const alias = path.join(t.base, 'alias');
  fs.symlinkSync(t.root, alias);
  const data = await createBrowser({ roots: [t.root, alias], deny, dataDir: t.dataDir }).list({ path: '' });
  assert.deepEqual(data.dirs.map((d) => d.path), [t.root]);
  assert.deepEqual(data.crumbs, []);
  assert.equal(data.path, '');
});

test('面包屑：从最长匹配的根开始，逐级可点', async () => {
  const t = tree();
  const nested = createBrowser({ roots: [t.root, `${t.root}/notes`], deny, dataDir: t.dataDir });
  assert.deepEqual((await nested.list({ path: `${t.root}/notes/deep/` })).crumbs, [
    { name: `${t.root}/notes`, path: `${t.root}/notes` },
    { name: 'deep', path: `${t.root}/notes/deep` },
  ]);
  assert.deepEqual((await t.browser.list({ path: `${t.root}/一个很长的目录名` })).crumbs.map((c) => c.name), [t.root, '一个很长的目录名']);
});

test('大目录：只列 200 个，搜索在截断之前做，第 201 个之后的也搜得到；自然排序', async () => {
  const t = tree();
  const big = path.join(t.root, 'big');
  for (let i = 0; i < 500; i++) fs.mkdirSync(path.join(big, `目录${i}`), { recursive: true });
  const data = await t.browser.list({ path: big });
  assert.equal(data.dirs.length, MAX_DIRS);
  assert.equal(data.total, 500);
  assert.equal(data.truncated, true);
  assert.deepEqual(data.dirs.slice(0, 3).map((d) => d.name), ['目录0', '目录1', '目录2']);
  const hit = await t.browser.list({ path: big, q: '目录49' });
  assert.deepEqual(hit.dirs.map((d) => d.name), ['目录49', ...Array.from({ length: 10 }, (_, i) => `目录49${i}`)]);
  assert.equal(hit.truncated, false);
  assert.equal(hit.matched, 11);
  assert.equal(hit.total, 500);
  assert.deepEqual((await t.browser.list({ path: big, q: '没有这个' })).dirs, []);
});

test('响应里只有名字、路径、计数和读写标记，没有文件内容和文件名', async () => {
  const t = tree();
  const text = JSON.stringify(await t.browser.list({ path: t.root }));
  for (const word of ['OUTSIDE-CONTENT', '# x', 'a.md', 'readme.txt', t.dataDir]) assert.ok(!text.includes(word), word);
});

test('mountinfo：解析转义，过滤容器自己的挂载', () => {
  const info = [
    '837 722 0:146 / / rw,relatime - overlay overlay rw,lowerdir=/x',
    '839 837 0:215 / /proc rw - proc proc rw',
    '840 837 0:216 / /dev rw,nosuid - tmpfs tmpfs rw',
    '846 837 254:1 /docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw',
    '847 837 254:1 /docker/volumes/kb/_data /data rw,relatime master:1 - ext4 /dev/vda1 rw',
    '848 847 0:46 /notes /data/library ro,nosuid - virtiofs virtiofs2 rw',
    '849 837 0:47 /x /my\\040notes ro - fakeowner fakeowner rw',
    '850 837 0:48 / /run/secrets ro - tmpfs tmpfs ro',
    'broken line',
  ].join('\n');
  assert.deepEqual(parseMountinfo(info), ['/etc/hosts', '/data', '/data/library', '/my notes']);
});

test('探测挂载：非 Docker、读不到都退回空列表；挂进来的文件不算目录', () => {
  const t = tree();
  const file = path.join(t.base, 'mountinfo');
  const line = (p) => `1 1 0:1 / ${p} rw - ext4 /dev/x rw`;
  fs.writeFileSync(file, [line(t.root), line(path.join(t.base, 'outside.md'))].join('\n'));
  assert.deepEqual(probeMounts({ inDocker: false, file }), []);
  assert.deepEqual(probeMounts({ inDocker: true, file: '/no/such/mountinfo' }), []);
  assert.deepEqual(probeMounts({ inDocker: true, file }), [t.root]);
});

test('挂载提示：数据目录不当候选；KB_ROOTS 外的挂载单独说明，不放宽浏览范围', async () => {
  const t = tree();
  const data = path.join(t.base, 'data');
  const other = path.join(t.base, 'outside-dir');
  fs.mkdirSync(data);
  const browser = createBrowser({ roots: [t.root], mounts: [data, t.root, other], deny, dataDir: data, inDocker: true });
  const { hints, command } = await browser.list({});
  assert.deepEqual(hints.selectable.map((d) => [d.path, d.mdCount]), [[t.root, 4]]);
  assert.deepEqual(hints.elsewhere, [other]);
  assert.equal(command, null);
  await rejected(browser.list({ path: other }));
});

test('挂载点在根里面时提示挂载点本身，不提示外面那层根；隐藏和 deny 的挂载点不提示', async () => {
  const t = tree();
  const browser = createBrowser({ roots: [t.root], mounts: [`${t.root}/notes`, `${t.root}/.hidden`, `${t.root}/notes/密码本`], deny, dataDir: t.dataDir, inDocker: true });
  assert.deepEqual((await browser.list({})).hints.selectable.map((d) => d.path), [`${t.root}/notes`]);
});

test('KB_ROOTS：默认值、环境变量、config.json，相对路径丢掉，环境变量优先', () => {
  const t = tree();
  fs.mkdirSync(t.dataDir);
  assert.deepEqual(loadSetupEnv({ KB_DATA_DIR: t.dataDir }).kbRoots, DEFAULT_KB_ROOTS);
  assert.deepEqual(loadSetupEnv({ KB_DATA_DIR: t.dataDir, KB_ROOTS: ' /a , relative, /b/ ' }).kbRoots, ['/a', '/b']);
  assert.deepEqual(loadSetupEnv({ KB_DATA_DIR: t.dataDir, KB_ROOTS: 'relative' }).kbRoots, DEFAULT_KB_ROOTS);
  fs.writeFileSync(path.join(t.dataDir, 'config.json'), JSON.stringify({ root: t.root, KB_ROOTS: '/from/file,/second' }));
  assert.deepEqual(loadConfig({ KB_DATA_DIR: t.dataDir }).kbRoots, ['/from/file', '/second']);
  assert.deepEqual(loadConfig({ KB_DATA_DIR: t.dataDir, KB_ROOTS: '/from/env' }).kbRoots, ['/from/env']);
});

test('数据目录下的 library 是约定挂载点，预检放行；其它子目录照旧拒绝', async () => {
  const t = tree();
  const library = path.join(t.dataDir, 'library');
  const other = path.join(t.dataDir, 'previews');
  for (const dir of [library, other]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '# a');
  }
  assert.equal((await inspectLibrary(library, { deny, dataDir: t.dataDir })).ok, true);
  assert.match((await inspectLibrary(other, { deny, dataDir: t.dataDir })).error, /这个目录在数据目录里面/);
});

async function wizard(extra) {
  const lib = makeLibrary();
  const booted = await boot({ KB_DATA_DIR: lib.dataDir, KB_ROOTS: lib.root, HOME: '/nonexistent', PATH: '', ...extra });
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    lib, booted, port,
    get: (target, headers = {}) => request(port, target, { headers }),
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      booted.stop();
      fs.rmSync(lib.base, { recursive: true, force: true });
    },
  };
}

const q = (p) => `path=${encodeURIComponent(p)}`;
const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };

test('向导接口：外部来源没有设置码是 401，页面也不带目录信息；有设置码才列', async () => {
  const w = await wizard();
  try {
    assert.equal((await w.get(`/setup/browse?${q(w.lib.root)}`, REMOTE)).status, 401);
    assert.equal((await w.get('/setup/browse', REMOTE)).status, 401);
    assert.equal((await w.get('/setup/browse?token=wrong', REMOTE)).status, 401);
    assert.equal((await w.get('/setup/browse', { ...REMOTE, 'X-Setup-Token': 'wrong' })).status, 401);
    const page = (await w.get('/setup', REMOTE)).text;
    assert.ok(page.includes('id="dir-browser"'));
    assert.ok(!page.includes(w.lib.root));
    const ok = await w.get(`/setup/browse?${q(w.lib.root)}`, { ...REMOTE, 'X-Setup-Token': w.booted.setupToken });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(ok.text)).slice(0, 4), ['path', 'crumbs', 'dirs', 'currentMdCount']);
    assert.equal((await w.get(`/setup/browse?token=${w.booted.setupToken}&${q(w.lib.root)}`, REMOTE)).status, 200);
  } finally {
    await w.stop();
  }
});

test('向导接口：本机免设置码，但别的网站发起的请求要拒绝', async () => {
  const w = await wizard();
  try {
    assert.equal((await w.get('/setup/browse', { 'Sec-Fetch-Site': 'same-origin', Host: 'localhost' })).status, 200);
    assert.equal((await w.get('/setup/browse', { 'Sec-Fetch-Site': 'cross-site', Host: 'localhost' })).status, 401);
    assert.equal((await w.get('/setup/browse', { Host: 'evil.example' })).status, 401);
  } finally {
    await w.stop();
  }
});

test('向导接口：越界和不存在都是同一个 403 响应，编码绕过也一样', async () => {
  const w = await wizard();
  try {
    const headers = { Host: 'localhost' };
    const bodies = new Set();
    for (const target of ['path=..%2F..%2Fetc', 'path=/etc', `${q(`${w.lib.root}/link-dir`)}`, `${q(`${w.lib.root}/link-dir/outside.md`)}`, `${q(`${w.lib.root}/no-such`)}`, `path=${encodeURIComponent(w.lib.root)}%2F..%2F..`, 'path=%2e%2e', `${q(w.lib.root)}&path=/etc`, `path=${encodeURIComponent(w.lib.root)}%00`]) {
      const res = await w.get(`/setup/browse?${target}`, headers);
      assert.equal(res.status, 403, target);
      bodies.add(res.text);
    }
    assert.deepEqual([...bodies], ['{"error":"forbidden"}']);
  } finally {
    await w.stop();
  }
});

test('配置完成后 /setup/browse 不再存在；登录后的接口未登录时跳登录，登录后可用', async () => {
  const s = await startServer({ kbRoots: [] });
  try {
    s.config.kbRoots = [s.lib.root];
    assert.equal((await request(s.port, '/setup/browse')).status, 404);
    const guest = await request(s.port, `/admin/browse?${q(s.lib.root)}`);
    assert.equal(guest.status, 302);
    assert.match(guest.headers.location, /^\/login/);
    const c = new Client(s.port, '10.5.0.1');
    await c.login();
    const res = await c.get(`/admin/browse?${q(s.lib.root)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /json/);
    assert.ok(JSON.parse(res.text).dirs.some((d) => d.name === 'notes'));
    assert.equal((await c.get('/admin/browse?path=/etc')).status, 403);
    assert.equal((await c.get(`/admin/browse?${q(`${s.lib.root}/link-dir`)}`)).status, 403);
    const page = (await c.get('/admin/settings')).text;
    assert.ok(page.includes('data-url="/admin/browse"'));
    assert.ok(page.includes('<details class="dir-advanced"'));
  } finally {
    await s.stop();
  }
});

test('清单声明挂载，但不把 KB_ROOT 写死（让向导能选目录）', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../yh-app.json', import.meta.url), 'utf8'));
  const [mount] = manifest.deploy.mounts;
  assert.equal(mount.container, '/data/library');
  assert.equal(mount.mode, 'ro');
  assert.equal(mount.required, false);
  // 环境变量优先于界面：一旦在清单里钉死 KB_ROOT，平台部署后设置页的目录就是只读的，
  // 用户没法在界面上选库。所以清单不设 KB_ROOT，默认浏览根里要有挂载点，向导第一步直接能点选。
  assert.equal(manifest.env.KB_ROOT, undefined);
  assert.ok(DEFAULT_KB_ROOTS.includes(mount.container));
});
