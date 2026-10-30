import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Client, makeLibrary, request, startServer } from './helpers.js';
import { boot } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { createPlatformUsers, PlatformUsersError } from '../src/platform-users.js';
import { allowlistMembers, isAllowed } from '../src/sso.js';

const USERS = [
  { id: 1, username: 'mock-admin', name: '演示甲', avatar: null, title: '平台管理员', jobNumber: 'A001', mobile: null, active: true, depts: [{ id: 9, name: '其它部门', isPrimary: false }, { id: 3, name: '研发部', isPrimary: true }] },
  { id: 2, username: 'mock-bob', name: '演示乙', avatar: 'https://cdn.example.com/b.png', title: null, jobNumber: null, mobile: '13800000002', active: true, depts: [] },
  { id: 3, username: null, name: '演示丙', avatar: 'http://intranet.example.com/c.png', title: '顾问', jobNumber: null, mobile: null, active: true },
  { id: 4, username: 'mock-gone', name: '演示丁', avatar: null, title: null, jobNumber: null, mobile: null, active: false },
];

// 同时模拟 /api/sso/token 和 /api/open/users；默认像真实平台一样忽略分页，一次全给
const platform = { server: null, url: '', mode: 'ok', hits: 0, pages: 0 };

before(async () => {
  platform.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const url = new URL(req.url, platform.url);
      if (url.pathname === '/api/sso/token') {
        const { code } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return json(200, { code: 0, data: { user: USERS.find((u) => u.username === code || String(u.id) === code) } });
      }
      platform.hits++;
      if (platform.mode === 'expired') return json(401, { code: 1002, message: 'client_secret 错误' });
      if (platform.mode === 'bad-client') return json(400, { code: 1001, message: 'client_id 无效' });
      if (platform.mode === 'down') return res.writeHead(502).end('<html>bad gateway</html>');
      if (platform.mode === 'weird') return json(200, { code: 0, data: { rows: [] } });
      if (platform.mode === 'slow') return undefined;
      if (platform.mode === 'paged') {
        const page = Number(url.searchParams.get('page'));
        platform.pages = page;
        return json(200, { code: 0, data: { total: 3, list: page === 1 ? USERS.slice(0, 2) : USERS.slice(2, 3) } });
      }
      if (platform.mode === 'endless') {
        const page = Number(url.searchParams.get('page'));
        platform.pages = page;
        return json(200, { code: 0, data: { total: 99999, list: [{ id: page, username: `u${page}`, name: `用户${page}` }] } });
      }
      json(200, { code: 0, data: { total: USERS.length, list: USERS } });
    });
  });
  await new Promise((resolve) => { platform.server.listen(0, '127.0.0.1', resolve); });
  platform.url = `http://127.0.0.1:${platform.server.address().port}`;
});
after(() => {
  platform.server.closeAllConnections();
  platform.server.close();
});
beforeEach(() => Object.assign(platform, { mode: 'ok', hits: 0, pages: 0 }));

const creds = () => ({ clientId: 'knowledge', clientSecret: 'kb-secret', apiUrl: platform.url });
const ssoConfig = () => ({ ...creds(), webUrl: 'https://one.example.com', appUrl: 'https://one.example.com/apps/knowledge', basePath: '', problem: null });
const TOKEN = 'abcdef123456';
const start = (authMode, allowedUsers = [], extra = {}) => startServer({ authMode, allowedUsers, sso: ssoConfig(), setupToken: TOKEN, sources: {}, ...extra });
const configOf = (kb) => JSON.parse(fs.readFileSync(path.join(kb.config.dataDir, 'config.json'), 'utf8'));

async function ssoLogin(client, username) {
  const begin = await client.get('/sso/login');
  const state = new URL(begin.headers.location).searchParams.get('state');
  return client.get(`/sso/callback?code=${username}&state=${state}`);
}

const csrfOf = (page) => page.text.match(/name="_csrf" value="([^"]+)"/)[1];

async function postAccess(client, action, fields, page) {
  const body = new URLSearchParams({ _csrf: csrfOf(page ?? await client.get('/access')) });
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  const text = body.toString();
  return client.send(`/access/${action}`, { method: 'POST', body: text, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(text) } });
}

test('listPlatformUsers：按 total 翻页聚合，取主部门，http 头像不要', async () => {
  platform.mode = 'paged';
  const { users, total, available } = await createPlatformUsers(creds()).listPlatformUsers();
  assert.equal(available, true);
  assert.equal(total, 3);
  assert.equal(platform.pages, 2);
  assert.deepEqual(users.map((u) => u.id), [1, 2, 3]);
  assert.equal(users[0].dept, '研发部');
  assert.equal(users[1].avatar, 'https://cdn.example.com/b.png');
  assert.equal(users[2].avatar, null);
});

test('listPlatformUsers：平台忽略分页时不重复也不空转；keyword 在本地过滤', async () => {
  const client = createPlatformUsers(creds());
  assert.equal((await client.listPlatformUsers()).users.length, 4);
  assert.equal(platform.hits, 1);
  assert.deepEqual((await client.listPlatformUsers({ keyword: 'A001' })).users.map((u) => u.id), [1]);
  assert.deepEqual((await client.listPlatformUsers({ keyword: 'MOCK-B' })).users.map((u) => u.id), [2]);
  assert.deepEqual((await client.listPlatformUsers({ page: 2, perPage: 1 })).users.map((u) => u.id), [2]);
});

test('listPlatformUsers：最多 20 页，超出时标记 truncated', async () => {
  platform.mode = 'endless';
  const { users, truncated } = await createPlatformUsers(creds()).listPlatformUsers();
  assert.equal(platform.pages, 20);
  assert.equal(users.length, 20);
  assert.equal(truncated, true);
});

test('listPlatformUsers：401 与 client_id 无效都映射成凭证无效', async () => {
  for (const mode of ['expired', 'bad-client']) {
    platform.mode = mode;
    await assert.rejects(createPlatformUsers(creds()).listPlatformUsers(), (err) => err instanceof PlatformUsersError && err.message === '读不到平台用户列表：凭证无效');
  }
});

test('listPlatformUsers：超时、连不上、5xx、结构异常都是人话', async () => {
  platform.mode = 'slow';
  await assert.rejects(createPlatformUsers(creds(), { timeoutMs: 50 }).listPlatformUsers(), { message: '平台暂时连不上' });
  await assert.rejects(createPlatformUsers({ ...creds(), apiUrl: 'http://127.0.0.1:9' }).listPlatformUsers(), { message: '平台暂时连不上' });
  platform.mode = 'down';
  await assert.rejects(createPlatformUsers(creds()).listPlatformUsers(), { message: '平台暂时连不上' });
  platform.mode = 'weird';
  await assert.rejects(createPlatformUsers(creds()).listPlatformUsers(), { message: '读不到平台用户列表：平台返回了异常结果' });
});

test('listPlatformUsers：60 秒缓存，第二次不打网络，过期才重新拉', async () => {
  const client = createPlatformUsers(creds());
  await client.listPlatformUsers();
  await client.listPlatformUsers();
  assert.equal(platform.hits, 1);
  const shortLived = createPlatformUsers(creds(), { cacheMs: 0 });
  await shortLived.listPlatformUsers();
  await shortLived.listPlatformUsers();
  assert.equal(platform.hits, 3);
});

test('listPlatformUsers：缺凭证时 available: false 并说明原因，不发请求', async () => {
  const client = createPlatformUsers({ clientId: 'x', clientSecret: '', apiUrl: platform.url });
  assert.equal(client.available, false);
  const result = await client.listPlatformUsers();
  assert.equal(result.available, false);
  assert.match(result.reason, /YH_CLIENT_SECRET/);
  assert.equal(platform.hits, 0);
});

test('directory：拉不到时不抛错，还留着上一次的名单给姓名用', async () => {
  const client = createPlatformUsers(creds(), { cacheMs: 0 });
  await client.directory();
  platform.mode = 'down';
  const dir = await client.directory();
  assert.equal(dir.available, false);
  assert.equal(dir.reason, '平台暂时连不上');
  assert.equal(dir.users.length, 4);
});

test('isAllowed：用户名或 id 任一匹配放行；都不在拒绝；数字用户名不能冒充 id', () => {
  const lists = { allowedUsers: ['alice'], allowedUserIds: [7] };
  assert.equal(isAllowed({ username: 'alice', id: 1 }, lists), true);
  assert.equal(isAllowed({ username: 'renamed', id: 7 }, lists), true);
  assert.equal(isAllowed({ username: 'renamed', id: '7' }, lists), true);
  assert.equal(isAllowed({ username: 'bob', id: 8 }, lists), false);
  assert.equal(isAllowed({ username: '7', id: 8 }, lists), false);
  assert.equal(isAllowed({ username: null, id: null }, { allowedUsers: [], allowedUserIds: [] }), false);
});

test('配置：KB_ALLOWED_USERS 非空时 config.json 里的 id 不再放行；只有逗号算没设', () => {
  const lib = makeLibrary();
  try {
    fs.mkdirSync(lib.dataDir, { recursive: true });
    fs.writeFileSync(path.join(lib.dataDir, 'config.json'), JSON.stringify({ root: lib.root, allowedUsers: ['alice'], allowedUserIds: [7], allowedProfiles: { 7: { username: 'alice', name: '甲' } } }));
    const base = { KB_DATA_DIR: lib.dataDir, AUTH_MODE: 'sso' };
    const fromFile = loadConfig(base);
    assert.deepEqual(fromFile.allowedUserIds, [7]);
    assert.equal(fromFile.sources.allowedUsers, 'file');
    assert.equal(allowlistMembers(fromFile).length, 1);
    const fromEnv = loadConfig({ ...base, KB_ALLOWED_USERS: 'bob' });
    assert.deepEqual(fromEnv.allowedUsers, ['bob']);
    assert.deepEqual(fromEnv.allowedUserIds, []);
    assert.equal(fromEnv.sources.allowedUsers, 'env');
    assert.equal(isAllowed({ username: 'x', id: 7 }, fromEnv), false);
    assert.equal(loadConfig({ ...base, KB_ALLOWED_USERS: ' , ' }).sources.allowedUsers, 'file');
  } finally {
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});

test('/access：未登录 302，POST 401', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const c = new Client(kb.port, '10.4.0.1');
    const res = await c.get('/access');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login/);
    assert.equal((await c.post('/access/add', { member: '2' })).status, 401);
  } finally {
    await kb.stop();
  }
});

test('/access：列出白名单和候选人；保存写 config.json，不用重启，保存前被拒保存后能进', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.2');
    await ssoLogin(admin, 'mock-admin');
    const page = await admin.get('/access');
    assert.equal(page.status, 200);
    assert.match(page.text, /演示甲/);
    assert.match(page.text, /value="2"/);
    assert.doesNotMatch(page.text, /演示丁/, '停用的人不出现在候选里');

    const bob = new Client(kb.port, '10.4.0.3');
    assert.equal((await ssoLogin(bob, 'mock-bob')).status, 403);

    const saved = await postAccess(admin, 'add', { member: ['2', '3'] }, page);
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.location, '/access?saved=1');
    const file = configOf(kb);
    assert.deepEqual(file.allowedUsers, ['mock-admin', 'mock-bob']);
    assert.deepEqual(file.allowedUserIds, [2, 3]);

    assert.equal((await ssoLogin(bob, 'mock-bob')).status, 302);
    assert.equal((await bob.get('/')).status, 200);
    assert.equal(fs.statSync(path.join(kb.config.dataDir, 'config.json')).mode % 512, 0o600);
  } finally {
    await kb.stop();
  }
});

test('/access：保存只动白名单，config.json 里的口令 hash 和 AI key 原样保留', async () => {
  const kb = await start('both', ['mock-admin']);
  try {
    fs.writeFileSync(path.join(kb.config.dataDir, 'config.json'), JSON.stringify({ root: '/x', passwordHash: '$argon2id$keep', ai: { apiKey: 'keep-me' }, allowedUsers: ['mock-admin'] }));
    const c = new Client(kb.port, '10.4.0.4');
    await c.login();
    await postAccess(c, 'add', { member: '2' });
    const file = configOf(kb);
    assert.equal(file.passwordHash, '$argon2id$keep');
    assert.equal(file.ai.apiKey, 'keep-me');
    assert.deepEqual(file.allowedUserIds, [2]);
  } finally {
    await kb.stop();
  }
});

test('/access：移除要同时清掉用户名和 id，移除后旧会话当场失效', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.5');
    await ssoLogin(admin, 'mock-admin');
    await postAccess(admin, 'add', { member: '2' });
    const bob = new Client(kb.port, '10.4.0.6');
    await ssoLogin(bob, 'mock-bob');
    assert.equal((await bob.get('/')).status, 200);

    assert.equal((await postAccess(admin, 'remove', { key: 'id:2' })).status, 303);
    assert.deepEqual(configOf(kb).allowedUsers, ['mock-admin']);
    assert.deepEqual(configOf(kb).allowedUserIds, []);
    assert.equal((await bob.get('/')).status, 302);
    assert.equal((await ssoLogin(bob, 'mock-bob')).status, 403);
  } finally {
    await kb.stop();
  }
});

test('/access：平台登录的人不能把自己移出白名单；口令登录的可以清空', async () => {
  const kb = await start('both', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.7');
    await ssoLogin(admin, 'mock-admin');
    const res = await postAccess(admin, 'remove', { key: 'id:1' });
    assert.equal(res.status, 400);
    assert.match(res.text, /不能把自己移出白名单/);
    assert.equal((await admin.get('/')).status, 200);

    const owner = new Client(kb.port, '10.4.0.8');
    await owner.login();
    assert.equal((await postAccess(owner, 'remove', { key: 'id:1' })).status, 303);
    assert.deepEqual(kb.config.allowedUsers, []);
  } finally {
    await kb.stop();
  }
});

test('/access：环境变量控制时只读，POST 不改配置', async () => {
  const kb = await start('sso', ['mock-admin'], { sources: { allowedUsers: 'env' } });
  try {
    const admin = new Client(kb.port, '10.4.0.9');
    await ssoLogin(admin, 'mock-admin');
    const denied = new Client(kb.port, '10.4.0.10');
    await ssoLogin(denied, 'mock-bob');
    const page = await admin.get('/access');
    assert.match(page.text, /当前由环境变量 KB_ALLOWED_USERS 控制，改这里不会生效/);
    assert.match(page.text, /去掉环境变量/);
    assert.doesNotMatch(page.text, /access\/(add|remove|approve)/);
    const res = await postAccess(admin, 'add', { member: '2' }, await admin.get('/admin'));
    assert.equal(res.status, 409);
    assert.deepEqual(kb.config.allowedUsers, ['mock-admin']);
    assert.equal(fs.existsSync(path.join(kb.config.dataDir, 'config.json')), false);
  } finally {
    await kb.stop();
  }
});

test('/access：平台连不上时退回手填，页面不 500，手填能保存', async () => {
  platform.mode = 'down';
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.11');
    await ssoLogin(admin, 'mock-admin');
    const page = await admin.get('/access');
    assert.equal(page.status, 200);
    assert.match(page.text, /平台暂时连不上/);
    assert.match(page.text, /name="manual"/);
    assert.equal((await postAccess(admin, 'add', { manual: 'someone, 42' }, page)).status, 303);
    assert.deepEqual(kb.config.allowedUsers, ['mock-admin', 'someone', '42']);
  } finally {
    await kb.stop();
  }
});

test('最近被拒绝：显示用户名和姓名，一键加入，已加入的不再给按钮', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.12');
    await ssoLogin(admin, 'mock-admin');
    const bob = new Client(kb.port, '10.4.0.13');
    assert.equal((await ssoLogin(bob, 'mock-bob')).status, 403);
    assert.equal((await ssoLogin(new Client(kb.port, '10.4.0.14'), '3')).status, 403);

    const page = await admin.get('/access');
    assert.match(page.text, /最近被拒绝的登录/);
    assert.match(page.text, /演示乙/);
    assert.match(page.text, /mock-bob/);
    const row = kb.db.prepare("SELECT * FROM login_log WHERE result = 'denied' AND user_id = '2'").get();
    assert.equal(row.username, 'mock-bob');
    assert.equal(row.name, '演示乙');

    assert.equal((await postAccess(admin, 'approve', { log: String(row.id) }, page)).status, 303);
    assert.deepEqual(configOf(kb).allowedUsers, ['mock-admin', 'mock-bob']);
    assert.deepEqual(configOf(kb).allowedUserIds, [2]);
    assert.equal((await ssoLogin(bob, 'mock-bob')).status, 302);
    assert.match((await admin.get('/access')).text, /已在白名单/);

    // 没有 username 的人只记 id，姓名不能被写成用户名
    const ding = kb.db.prepare("SELECT * FROM login_log WHERE result = 'denied' AND user_id = '3'").get();
    await postAccess(admin, 'approve', { log: String(ding.id) });
    assert.deepEqual(kb.config.allowedUsers, ['mock-admin', 'mock-bob']);
    assert.deepEqual(kb.config.allowedUserIds, [2, 3]);
  } finally {
    await kb.stop();
  }
});

test('最近被拒绝：老记录 name 为空时 username 可能是姓名，只加 id', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.15');
    await ssoLogin(admin, 'mock-admin');
    const { lastInsertRowid } = kb.db.prepare("INSERT INTO login_log (ts, via, username, user_id, ip, ua, result) VALUES (1, 'sso', '某姓名', '500', 'x', 'x', 'denied')").run();
    await postAccess(admin, 'approve', { log: String(lastInsertRowid) });
    assert.deepEqual(kb.config.allowedUsers, ['mock-admin']);
    assert.deepEqual(kb.config.allowedUserIds, [500]);
  } finally {
    await kb.stop();
  }
});

test('/admin 有访问权限卡片和入口', async () => {
  const kb = await start('sso', ['mock-admin']);
  try {
    const admin = new Client(kb.port, '10.4.0.16');
    await ssoLogin(admin, 'mock-admin');
    const page = await admin.get('/admin');
    assert.match(page.text, /<h2>访问权限<\/h2>/);
    assert.match(page.text, /href="\/access"/);
  } finally {
    await kb.stop();
  }
});

test('设置码：403 页有引导；正确 200 且只能访问 /access；错误 404', async () => {
  const kb = await start('sso', []);
  try {
    const denied = await ssoLogin(new Client(kb.port, '10.4.1.1'), 'mock-bob');
    assert.equal(denied.status, 403);
    assert.match(denied.text, /管理员可用启动日志里的设置码打开 <code>\/access\?token=&lt;设置码&gt;<\/code> 添加成员/);

    assert.equal((await new Client(kb.port, '10.4.1.2').get('/access?token=000000000000')).status, 404);
    assert.equal((await new Client(kb.port, '10.4.1.2').get('/access?token=')).status, 404);

    const c = new Client(kb.port, '10.4.1.3');
    const page = await c.get(`/access?token=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /临时管理会话/);
    assert.match(page.text, /演示甲/);
    assert.equal((await c.get('/access')).status, 200);

    for (const target of ['/', '/v/README.md', '/raw/README.md', '/search?q=a', '/admin', '/graph/data']) {
      const res = await c.get(target);
      assert.equal(res.status, 302, target);
      assert.match(res.headers.location, /^\/login/, target);
    }
    assert.equal((await c.post('/admin/reindex', { _csrf: csrfOf(page) })).status, 401);
    const row = kb.db.prepare("SELECT * FROM sessions WHERE login_via = 'setup'").get();
    assert.ok(row.expires_at - row.created_at <= 30 * 60 * 1000);
    assert.equal(kb.db.prepare("SELECT COUNT(*) FROM login_log WHERE via = 'setup'").pluck().get(), 1);
  } finally {
    await kb.stop();
  }
});

test('设置码：both 模式下临时会话同样读不了笔记', async () => {
  const kb = await start('both', []);
  try {
    const c = new Client(kb.port, '10.4.1.4');
    assert.equal((await c.get(`/access?token=${TOKEN}`)).status, 200);
    assert.equal((await c.get('/v/README.md')).status, 302);
    assert.equal((await c.get('/admin')).status, 302);
  } finally {
    await kb.stop();
  }
});

test('设置码：白名单有人、环境变量控制、口令模式下都不生效', async () => {
  for (const [mode, list, extra] of [['sso', ['mock-admin'], {}], ['sso', ['mock-admin'], { sources: { allowedUsers: 'env' } }], ['password', [], { sso: null }]]) {
    const kb = await start(mode, list, extra);
    try {
      assert.equal((await new Client(kb.port, '10.4.1.5').get(`/access?token=${TOKEN}`)).status, 404);
    } finally {
      await kb.stop();
    }
  }
});

test('设置码：连错 5 次后，正确的码也是 404', async () => {
  const kb = await start('sso', []);
  try {
    const c = new Client(kb.port, '10.4.1.6');
    for (let i = 0; i < 5; i++) assert.equal((await c.get('/access?token=wrong')).status, 404);
    assert.equal((await c.get(`/access?token=${TOKEN}`)).status, 404);
    assert.equal((await new Client(kb.port, '10.4.1.7').get(`/access?token=${TOKEN}`)).status, 200);
  } finally {
    await kb.stop();
  }
});

test('设置码：被拒绝的人把自己加进去，临时会话转正，同一浏览器直接能读', async () => {
  const kb = await start('sso', []);
  try {
    const c = new Client(kb.port, '10.4.1.8');
    assert.equal((await ssoLogin(c, 'mock-bob')).status, 403);
    assert.equal((await c.get('/v/README.md')).status, 302);
    const page = await c.get(`/access?token=${TOKEN}`);
    const saved = await postAccess(c, 'add', { member: '2' }, page);
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.location, '/access?saved=1');
    assert.equal((await c.get('/')).status, 200);
    assert.equal(kb.db.prepare("SELECT COUNT(*) FROM sessions WHERE login_via = 'setup'").pluck().get(), 0);
    assert.equal(kb.db.prepare("SELECT login_via FROM sessions WHERE user_id = '2'").pluck().get(), 'sso');
    assert.equal((await c.get(`/access?token=${TOKEN}`)).status, 404);
  } finally {
    await kb.stop();
  }
});

test('设置码：加的不是自己，保存后临时会话直接失效；另一个标签页的临时会话也失效', async () => {
  const kb = await start('sso', []);
  try {
    const c = new Client(kb.port, '10.4.1.9');
    const other = new Client(kb.port, '10.4.1.10');
    await other.get(`/access?token=${TOKEN}`);
    const page = await c.get(`/access?token=${TOKEN}`);
    const saved = await postAccess(c, 'add', { member: '1' }, page);
    assert.equal(saved.status, 200);
    assert.match(saved.text, /临时管理会话已结束/);
    assert.equal((await c.get('/access')).status, 302);
    assert.equal((await other.get('/access')).status, 302);
    assert.equal(kb.db.prepare("SELECT COUNT(*) FROM sessions WHERE login_via = 'setup'").pluck().get(), 0);
  } finally {
    await kb.stop();
  }
});

test('设置码：临时会话也要过 CSRF', async () => {
  const kb = await start('sso', []);
  try {
    const c = new Client(kb.port, '10.4.1.11');
    await c.get(`/access?token=${TOKEN}`);
    assert.equal((await c.post('/access/add', { member: '1', _csrf: 'x' })).status, 403);
    assert.deepEqual(kb.config.allowedUsers, []);
  } finally {
    await kb.stop();
  }
});

// 向导：用 boot 走真实入口
async function wizard(extraEnv = {}, prepare = () => {}) {
  const lib = makeLibrary();
  prepare(lib);
  const env = {
    KB_DATA_DIR: lib.dataDir, HOME: '/nonexistent', PATH: '', YH_CLIENT_ID: 'knowledge', YH_CLIENT_SECRET: 'kb-secret',
    YH_WEB_URL: 'https://one.example.com', YH_API_URL: platform.url, ...extraEnv,
  };
  const booted = await boot(env);
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    lib, port, booted,
    get: (target, headers = {}) => request(port, target, { headers }),
    post(fields) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
      const text = body.toString();
      return request(port, '/setup', { method: 'POST', body: text, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(text) } });
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      booted.stop();
      fs.rmSync(lib.base, { recursive: true, force: true });
    },
  };
}

test('向导：拉到列表时出现姓名和勾选框，保存写 allowedUsers + allowedUserIds', async () => {
  const w = await wizard();
  try {
    const page = await w.get('/setup');
    assert.match(page.text, /演示甲/);
    assert.match(page.text, /研发部 · 平台管理员/);
    assert.match(page.text, /name="member" value="2"/);
    assert.match(page.text, /data-picker-search/);
    assert.doesNotMatch(page.text, /演示丁/);
    assert.doesNotMatch(page.text, /name="allowedUsers"/);

    const res = await w.post({ root: w.lib.root, authMode: 'sso', aiProvider: 'off', picker: '1', member: ['1', '3'] });
    assert.equal(res.status, 200);
    const file = JSON.parse(fs.readFileSync(path.join(w.lib.dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(file.allowedUsers, ['mock-admin']);
    assert.deepEqual(file.allowedUserIds, [1, 3]);
    assert.equal(file.allowedProfiles[3].name, '演示丙');
  } finally {
    await w.stop();
  }
});

test('向导：拉不到列表时出现手填框并说明原因', async () => {
  platform.mode = 'expired';
  const w = await wizard();
  try {
    const page = await w.get('/setup');
    assert.equal(page.status, 200);
    assert.match(page.text, /name="allowedUsers"/);
    assert.match(page.text, /读不到平台用户列表：凭证无效/);
  } finally {
    await w.stop();
  }
});

test('向导：外部访问没带设置码时看不到通讯录，也不打平台；带上才有', async () => {
  const w = await wizard();
  const remote = { 'X-Forwarded-For': '203.0.113.9' };
  try {
    const locked = await w.get('/setup', remote);
    assert.doesNotMatch(locked.text, /演示甲/);
    assert.match(locked.text, /name="allowedUsers"/);
    assert.match(locked.text, /先验证设置码/);
    assert.equal(platform.hits, 0);
    assert.match((await w.get(`/setup?token=${w.booted.setupToken}`, remote)).text, /演示甲/);
  } finally {
    await w.stop();
  }
});

test('向导：提交失败后勾选还在；删掉配置重来时回填上次的名单', async () => {
  const w = await wizard({}, (lib) => {
    fs.mkdirSync(lib.dataDir, { recursive: true });
    fs.writeFileSync(path.join(lib.dataDir, 'allowlist.last.json'), JSON.stringify({ allowedUsers: ['mock-admin'], allowedUserIds: [1], allowedProfiles: {} }));
  });
  try {
    assert.match((await w.get('/setup')).text, /name="member" value="1" checked/);
    const failed = await w.post({ root: '/no/such/dir', authMode: 'sso', aiProvider: 'off', picker: '1', member: ['2'] });
    assert.equal(failed.status, 400);
    assert.match(failed.text, /name="member" value="2" checked/);
    assert.doesNotMatch(failed.text, /name="member" value="1" checked/);
  } finally {
    await w.stop();
  }
});

test('启动：配置完成后也有设置码，白名单为空才进日志，/access 能用它', async () => {
  const lib = makeLibrary();
  const logged = [];
  const { log } = console;
  console.log = (line) => logged.push(String(line));
  try {
    const env = { KB_ROOT: lib.root, KB_DATA_DIR: lib.dataDir, HOME: '/nonexistent', PATH: '', AUTH_MODE: 'sso', YH_CLIENT_ID: 'knowledge', YH_CLIENT_SECRET: 'kb-secret', YH_WEB_URL: 'https://one.example.com', YH_API_URL: platform.url, YH_APP_URL: 'https://kb.example.com' };
    const booted = await boot(env);
    assert.ok(logged.some((l) => l.includes(`/access?token=${booted.setupToken}`)));
    const server = http.createServer(booted.handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    assert.equal((await request(server.address().port, `/access?token=${booted.setupToken}`)).status, 200);
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    booted.stop();

    logged.length = 0;
    const second = await boot({ ...env, KB_ALLOWED_USERS: 'mock-admin' });
    assert.ok(!logged.some((l) => l.includes(second.setupToken)));
    second.stop();
  } finally {
    console.log = log;
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});
