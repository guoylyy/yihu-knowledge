import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { Client, makeLibrary, startServer, testConfig } from './helpers.js';
import { createApp } from '../src/app.js';
import { authWarnings, loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const PREFIX = { 'X-Forwarded-Prefix': '/apps/knowledge' };
const USERS = {
  alice: { id: 96, username: 'alice', name: '爱丽丝' },
  bob: { id: 97, username: 'bob', name: '鲍勃' },
  ding: { id: 98, username: null, name: '钉钉用户' },
};

// 模拟平台的 /api/sso/token：code 就是 USERS 的键，behavior 决定怎么回
const platform = { server: null, url: '', behavior: 'ok', requests: [] };

before(async () => {
  platform.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      platform.requests.push({ url: req.url, auth: req.headers.authorization, body });
      const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      if (platform.behavior === 'bad-credentials') return json(401, { code: 1002, message: 'client_secret 错误' });
      if (platform.behavior === 'used-code') return json(400, { code: 1001, message: 'code 已使用' });
      if (platform.behavior === 'html') return res.writeHead(502).end('<html>bad gateway</html>');
      if (platform.behavior === 'no-user') return json(200, { code: 0, data: {} });
      json(200, { code: 0, data: { access_token: 't', user: USERS[body.code] } });
    });
  });
  await new Promise((resolve) => { platform.server.listen(0, '127.0.0.1', resolve); });
  platform.url = `http://127.0.0.1:${platform.server.address().port}`;
});
after(() => {
  platform.server.closeAllConnections();
  platform.server.close();
});
beforeEach(() => {
  platform.behavior = 'ok';
  platform.requests = [];
});

const ssoConfig = () => ({
  clientId: 'knowledge', clientSecret: 'kb-secret', webUrl: 'https://one.example.com', apiUrl: platform.url,
  appUrl: 'https://one.example.com/apps/knowledge', basePath: '/apps/knowledge', problem: null,
});
const start = (authMode, allowedUsers = [], extra = {}) => startServer({ authMode, allowedUsers, sso: ssoConfig(), ...extra });

async function ssoLogin(client, code, { next, headers } = {}) {
  const begin = await client.get(`/sso/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, { headers });
  assert.equal(begin.status, 302);
  const url = new URL(begin.headers.location);
  const res = await client.get(`/sso/callback?code=${code}&state=${url.searchParams.get('state')}`, { headers });
  return { url, res };
}

test('password：/login 没有平台入口；环境里有 YH_* 也不启用 SSO', async () => {
  const env = { KB_ROOT: '/tmp', KB_DATA_DIR: '/nonexistent/kb-data', YH_CLIENT_ID: 'id', YH_CLIENT_SECRET: 's', YH_WEB_URL: 'https://one.example.com', YH_API_URL: 'http://x', YH_APP_URL: 'https://one.example.com/apps/k' };
  const config = loadConfig(env);
  assert.equal(config.authMode, 'password');
  assert.equal(config.sso, null);
  assert.equal(config.baseUrl, 'http://localhost:3030');

  const kb = await startServer({ sso: config.sso });
  try {
    const page = await new Client(kb.port).get('/login');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /平台/);
    assert.match(page.text, /type="password"/);
    const jump = await new Client(kb.port).get('/sso/login');
    assert.equal(jump.status, 302);
    assert.match(jump.headers.location, /^\/login/);
    assert.equal((await new Client(kb.port).get('/sso/callback?code=alice&state=x')).headers.location.startsWith('/login'), true);
    assert.equal((await new Client(kb.port, '10.2.0.1').login()).status, 303);
  } finally {
    await kb.stop();
  }
});

test('配置：AUTH_MODE 非法启动失败；白名单去空格；sso 下 KB_BASE_URL 缺省取 YH_APP_URL', () => {
  assert.throws(() => loadConfig({ KB_ROOT: '/tmp', AUTH_MODE: 'open' }), /AUTH_MODE 只能是/);
  const config = loadConfig({ KB_ROOT: '/tmp', AUTH_MODE: 'SSO', KB_ALLOWED_USERS: ' alice, 96 ,,', YH_APP_URL: 'https://one.example.com/apps/k/' });
  assert.equal(config.authMode, 'sso');
  assert.deepEqual(config.allowedUsers, ['alice', '96']);
  assert.equal(config.baseUrl, 'https://one.example.com/apps/k');
  assert.deepEqual(loadConfig({ KB_ROOT: '/tmp', AUTH_MODE: 'both', KB_ALLOWED_USERS: ',' }).allowedUsers, []);
});

test('启动：sso 不需要 KB_PASSWORD；password / both 缺口令启动失败', async () => {
  const kb = await start('sso', [], { password: '' });
  await kb.stop();
  for (const authMode of ['password', 'both']) {
    const lib = makeLibrary();
    try {
      await assert.rejects(createApp(testConfig(lib, { authMode, password: '', sso: ssoConfig() })), /缺少 KB_PASSWORD/);
    } finally {
      fs.rmSync(lib.base, { recursive: true, force: true });
    }
  }
});

test('sso：/login 只有平台入口，口令接口关闭', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.1.1');
    const page = await c.get('/login?next=/search');
    assert.match(page.text, /用平台账号登录/);
    assert.match(page.text, /href="\/sso\/login\?next=%2Fsearch"/);
    assert.doesNotMatch(page.text, /type="password"/);
    const res = await c.login();
    assert.equal(res.status, 403);
    assert.equal(c.cookies.get('kb_sid'), undefined);
  } finally {
    await kb.stop();
  }
});

test('sso：白名单内的用户名走完回调拿到会话，可读可写，访问记录能看到', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.1.2');
    const { url, res } = await ssoLogin(c, 'alice', { next: '/search?q=工资' });
    assert.equal(url.origin + url.pathname, 'https://one.example.com/sso/authorize');
    assert.equal(url.searchParams.get('client_id'), 'knowledge');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://one.example.com/apps/knowledge/sso/callback');
    assert.equal(res.status, 302);
    assert.equal(decodeURIComponent(res.headers.location), '/search?q=工资');

    const [call] = platform.requests;
    assert.equal(call.url, '/api/sso/token');
    assert.equal(call.auth, `Basic ${Buffer.from('knowledge:kb-secret').toString('base64')}`);
    assert.deepEqual(call.body, { code: 'alice', redirect_uri: 'https://one.example.com/apps/knowledge/sso/callback' });

    const row = kb.db.prepare('SELECT login_via, username, user_id, expires_at - created_at AS ttl FROM sessions').get();
    assert.deepEqual({ ...row }, { login_via: 'sso', username: 'alice', user_id: '96', ttl: 8 * 3600e3 });
    assert.equal((await c.get('/v/notes/%E7%AC%94%E8%AE%B0%E4%B9%99.md')).status, 200);
    assert.equal((await c.createShare({ path: 'share/公开说明.md' })).status, 303);
    const admin = await c.get('/admin');
    assert.match(admin.text, /访问记录/);
    assert.match(admin.text, /平台登录（alice）/);
    assert.match(admin.text, /alice（id 96）/);
    assert.match(admin.text, /退出平台登录/);
  } finally {
    await kb.stop();
  }
});

test('sso：白名单按平台用户 id 匹配（钉钉用户没有 username）', async () => {
  const kb = await start('sso', ['98']);
  try {
    const c = new Client(kb.port, '10.2.1.3');
    assert.equal((await ssoLogin(c, 'ding')).res.status, 302);
    assert.match((await c.get('/admin')).text, /钉钉用户（id 98）/);
  } finally {
    await kb.stop();
  }
});

test('sso：不在白名单 → 403，文案含用户名，不建会话，留拒绝记录', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.1.4');
    const { res } = await ssoLogin(c, 'bob');
    assert.equal(res.status, 403);
    assert.match(res.text, /你的平台账号（bob）没有访问这个知识库的权限，请联系管理员把你加进白名单/);
    assert.match(res.text, /退出平台登录/);
    assert.equal(c.cookies.get('kb_sid'), undefined);
    assert.equal(kb.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 0);
    assert.equal((await c.get('/')).status, 302);
    assert.deepEqual({ ...kb.db.prepare('SELECT via, username, user_id, result FROM login_log').get() }, { via: 'sso', username: 'bob', user_id: '97', result: 'denied' });
  } finally {
    await kb.stop();
  }
});

test('sso：白名单为空一律拒绝（fail closed），页面写清未配置', async () => {
  const kb = await start('sso', []);
  try {
    const c = new Client(kb.port, '10.2.1.5');
    const { res } = await ssoLogin(c, 'alice');
    assert.equal(res.status, 403);
    assert.match(res.text, /管理员还没有配置允许访问的人/);
    assert.equal(c.cookies.get('kb_sid'), undefined);
  } finally {
    await kb.stop();
  }
  // 没有 username 的账号不能靠空值或 undefined 蹭进白名单
  const loose = await start('sso', ['undefined', 'null', '']);
  try {
    assert.equal((await ssoLogin(new Client(loose.port, '10.2.1.6'), 'ding')).res.status, 403);
  } finally {
    await loose.stop();
  }
});

test('sso：state 不对不去换 token；next 不能跳出站外', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.1.7');
    await c.get('/sso/login');
    for (const target of ['/sso/callback?code=alice&state=forged', '/sso/callback?code=alice']) {
      const res = await c.get(target);
      assert.equal(res.status, 303);
      assert.equal(res.headers.location, '/login?sso_error=state');
    }
    const stranger = await new Client(kb.port, '10.2.1.8').get('/sso/callback?code=alice&state=x');
    assert.equal(stranger.headers.location, '/login?sso_error=state');
    assert.equal(platform.requests.length, 0);
    assert.match((await c.get('/login?sso_error=state')).text, /登录校验没有通过/);

    const { res } = await ssoLogin(new Client(kb.port, '10.2.1.9'), 'alice', { next: '//evil.example' });
    assert.equal(res.headers.location, '/');
  } finally {
    await kb.stop();
  }
});

test('sso：回调失败都回登录页给可读错误，不白屏', async () => {
  const kb = await start('sso', ['alice']);
  const down = await start('sso', ['alice'], { sso: { ...ssoConfig(), apiUrl: 'http://127.0.0.1:9' } });
  try {
    const cases = [
      ['bad-credentials', 'credentials', /YH_CLIENT_ID/], ['used-code', 'code', /授权码无效/], ['html', 'platform', /平台返回了异常结果/], ['no-user', 'platform', /平台返回了异常结果/],
    ];
    for (const [behavior, code, text] of cases) {
      platform.behavior = behavior;
      const c = new Client(kb.port, '10.2.2.1');
      const { res } = await ssoLogin(c, 'alice');
      assert.equal(res.status, 303, behavior);
      assert.equal(res.headers.location, `/login?sso_error=${code}`);
      const page = await c.get(res.headers.location);
      assert.equal(page.status, 200);
      assert.match(page.text, text);
    }
    const c = new Client(down.port, '10.2.2.2');
    const { res } = await ssoLogin(c, 'alice');
    assert.equal(res.headers.location, '/login?sso_error=unreachable');
    assert.match((await c.get(res.headers.location)).text, /连不上平台/);

    const refused = await new Client(kb.port, '10.2.2.3').get('/sso/callback?error=access_denied');
    assert.equal(refused.headers.location, '/login?sso_error=refused');
    const page = await new Client(kb.port, '10.2.2.3').get('/login?sso_error=<script>');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /<script>|class="alert"/);
  } finally {
    await kb.stop();
    await down.stop();
  }
});

test('both：两个入口；口令登录不受白名单限制，也写访问记录', async () => {
  const kb = await start('both', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.3.1');
    const page = await c.get('/login');
    assert.match(page.text, /用平台账号登录/);
    assert.match(page.text, /type="password"/);
    assert.equal((await c.login()).status, 303);
    assert.equal((await c.get('/')).status, 200);
    const admin = await c.get('/admin');
    assert.match(admin.text, /当前会话：口令登录/);
    assert.match(admin.text, /站点主人/);
    assert.doesNotMatch(admin.text, /退出平台登录/);

    const sso = new Client(kb.port, '10.2.3.2');
    assert.equal((await ssoLogin(sso, 'alice')).res.status, 302);
    assert.equal((await sso.get('/')).status, 200);
    assert.equal((await ssoLogin(new Client(kb.port, '10.2.3.3'), 'bob')).res.status, 403);
    assert.deepEqual(kb.db.prepare('SELECT via || \':\' || result FROM login_log ORDER BY id').pluck().all(), ['password:ok', 'sso:ok', 'sso:denied']);
  } finally {
    await kb.stop();
  }
});

test('会话：移出白名单、换 AUTH_MODE 后旧会话立刻失效', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.4.1');
    await ssoLogin(c, 'alice');
    assert.equal((await c.get('/')).status, 200);
    kb.config.allowedUsers.length = 0;
    assert.equal((await c.get('/')).status, 302);
    assert.equal(kb.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 0);

    kb.config.allowedUsers.push('alice');
    const stale = new Client(kb.port, '10.2.4.2');
    stale.cookies.set('kb_sid', kb.auth.createSession({ via: 'password' }).id);
    assert.equal((await stale.get('/')).status, 302);
  } finally {
    await kb.stop();
  }
});

test('未配置平台凭证：有启动警告，登录页禁用入口并说明原因', async () => {
  const config = loadConfig({ KB_ROOT: '/tmp', AUTH_MODE: 'both', KB_PASSWORD: 'x'.repeat(8) });
  assert.match(config.sso.problem, /YH_CLIENT_ID \/ YH_CLIENT_SECRET/);
  assert.ok(authWarnings(config).some((w) => /平台登录入口已禁用/.test(w)));
  assert.ok(authWarnings(config).some((w) => /白名单为空/.test(w)));
  assert.deepEqual(authWarnings(loadConfig({ KB_ROOT: '/tmp' })), []);

  const kb = await startServer({ authMode: 'both', sso: config.sso });
  try {
    const page = await new Client(kb.port).get('/login');
    assert.match(page.text, /<button class="btn primary" type="button" disabled>用平台账号登录/);
    assert.match(page.text, /平台登录暂不可用：未配置 YH_CLIENT_ID/);
    assert.doesNotMatch(page.text, /href="\/sso\/login/);
    assert.match(page.text, /type="password"/);
    assert.equal((await new Client(kb.port).get('/sso/login')).headers.location.startsWith('/login'), true);
    assert.equal((await new Client(kb.port, '10.2.5.1').login()).status, 303);
  } finally {
    await kb.stop();
  }
});

test('退出：普通退出回登录页；退出平台登录 303 到平台，CSP 放行平台域名', async () => {
  const kb = await start('sso', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.6.1');
    const send = (target, opts = {}) => c.get(target, { ...opts, headers: { ...PREFIX, ...opts.headers } });
    await ssoLogin(c, 'alice', { headers: PREFIX });
    const admin = await send('/admin');
    assert.match(admin.headers['content-security-policy'], /form-action 'self' https:\/\/one\.example\.com/);
    const csrf = admin.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const body = new URLSearchParams({ _csrf: csrf, platform: '1' }).toString();
    const res = await c.send('/logout', {
      method: 'POST', body, headers: { ...PREFIX, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, 'https://one.example.com/logout?redirect=%2Fapps%2Fknowledge%2F');
    assert.match(res.headers['set-cookie'].join(), /kb_sid=;.*Path=\/apps\/knowledge/);
    assert.equal(kb.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 0);

    const plain = new Client(kb.port, '10.2.6.2');
    await ssoLogin(plain, 'alice');
    const back = await plain.post('/logout', { _csrf: await plain.csrf() });
    assert.equal(back.headers.location, '/login');
  } finally {
    await kb.stop();
  }
  const local = await startServer();
  try {
    assert.match((await new Client(local.port).get('/login')).headers['content-security-policy'], /form-action 'self';/);
  } finally {
    await local.stop();
  }
});

test('挂在 /apps/<code>/ 下：链接、跳转、cookie 路径、图片都带前缀', async () => {
  const kb = await start('both', ['alice']);
  try {
    const c = new Client(kb.port, '10.2.7.1');
    const get = (target) => c.get(target, { headers: PREFIX });

    const anon = await get('/admin');
    assert.equal(anon.headers.location, '/apps/knowledge/login?next=%2Fadmin');
    const login = await get('/login');
    assert.match(login.text, /<html lang="zh-CN" data-base="\/apps\/knowledge">/);
    assert.match(login.text, /href="\/apps\/knowledge\/assets\/app\.css"/);
    assert.match(login.text, /action="\/apps\/knowledge\/login"/);
    assert.match(login.text, /href="\/apps\/knowledge\/sso\/login\?next=%2F"/);

    const begin = await get('/sso/login');
    assert.match(begin.headers['set-cookie'].join(), /kb_sso_state=.*Path=\/apps\/knowledge\/sso/);
    const state = new URL(begin.headers.location).searchParams.get('state');
    const done = await get(`/sso/callback?code=alice&state=${state}`);
    assert.equal(done.headers.location, '/apps/knowledge/');
    assert.match(done.headers['set-cookie'].join(), /kb_sid=.*Path=\/apps\/knowledge;/);

    const read = await get('/v/notes/%E7%AC%94%E8%AE%B0%E7%94%B2.md');
    assert.equal(read.status, 200);
    assert.match(read.text, /src="\/apps\/knowledge\/raw\/notes\//);
    assert.match(read.text, /href="\/apps\/knowledge\/v\/README\.md"/);
    assert.doesNotMatch(read.text.replace(/(href|src|action)="\/apps\/knowledge/g, ''), /(?:href|src|action)="\/(?!\/)/);

    const home = await get('/');
    assert.doesNotMatch(home.text.replace(/(href|src|action)="\/apps\/knowledge/g, ''), /(?:href|src|action)="\/(?!\/)/);

    const body = new URLSearchParams({ _csrf: (await get('/admin')).text.match(/name="_csrf" value="([^"]+)"/)[1], path: 'share/公开说明.md', days: '7', password: 'share-pass-1' }).toString();
    const created = await c.send('/admin/shares', { method: 'POST', body, headers: { ...PREFIX, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } });
    assert.match(created.headers.location, /^\/apps\/knowledge\/admin\/shares\/\d+$/);
    const { token } = kb.db.prepare('SELECT token FROM shares').get();
    const guest = new Client(kb.port, '10.2.7.2');
    const gate = await guest.get(`/s/${token}`, { headers: PREFIX });
    assert.match(gate.text, new RegExp(`action="/apps/knowledge/s/${token}/unlock"`));
    const unlockBody = new URLSearchParams({ password: 'share-pass-1' }).toString();
    const unlocked = await guest.send(`/s/${token}/unlock`, { method: 'POST', body: unlockBody, headers: { ...PREFIX, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(unlockBody) } });
    assert.equal(unlocked.headers.location, `/apps/knowledge/s/${token}`);
    assert.match(unlocked.headers['set-cookie'].join(), new RegExp(`Path=/apps/knowledge/s/${token}`));
    const shared = await guest.get(`/s/${token}`, { headers: PREFIX });
    assert.match(shared.text, new RegExp(`src="/apps/knowledge/s/${token}/raw/`));

    // 非平台形态的前缀不采信，直连时没有前缀
    assert.match((await new Client(kb.port).get('/login', { headers: { 'X-Forwarded-Prefix': '//evil.example' } })).text, /data-base=""/);
    assert.match((await new Client(kb.port).get('/login')).text, /href="\/assets\/app\.css"/);
  } finally {
    await kb.stop();
  }
});

test('/health 和 /healthz 都免登录', async () => {
  const kb = await start('sso', []);
  try {
    assert.equal((await new Client(kb.port).get('/health')).text, 'ok');
    assert.equal((await new Client(kb.port).get('/healthz')).text, 'ok');
  } finally {
    await kb.stop();
  }
});

test('会话表：旧库升级后老会话算口令登录，升级不丢会话', () => {
  const lib = makeLibrary();
  try {
    fs.mkdirSync(lib.dataDir, { recursive: true });
    const old = new Database(`${lib.dataDir}/kb.sqlite`);
    old.exec('CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    old.prepare("INSERT INTO sessions VALUES ('h', 'c', 1, 2)").run();
    old.close();
    const db = openDb(lib.dataDir);
    assert.deepEqual({ ...db.prepare('SELECT id_hash, login_via, username FROM sessions').get() }, { id_hash: 'h', login_via: 'password', username: null });
    db.close();
  } finally {
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});
