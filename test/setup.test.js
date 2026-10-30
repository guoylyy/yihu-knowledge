import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import argon2 from 'argon2';
import { Client, makeLibrary, request, startServer } from './helpers.js';
import { boot } from '../src/boot.js';
import { loadConfig, needsSetup } from '../src/config.js';

const GOOD_PASSWORD = 'wizard-pass-10';
const API_KEY = 'zz-wizard-api-key-should-not-echo';
const YH = { YH_CLIENT_ID: 'knowledge', YH_CLIENT_SECRET: 'kb-secret', YH_WEB_URL: 'https://one.example.com', YH_API_URL: 'http://127.0.0.1:9' };

// HOME/PATH 指向空，保证检测不到本机的 claude
async function startWizard(extraEnv = {}) {
  const lib = makeLibrary();
  const env = { KB_DATA_DIR: lib.dataDir, HOME: '/nonexistent', PATH: '', ...extraEnv };
  const booted = await boot(env);
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const form = (target, fields, headers = {}) => {
    const body = new URLSearchParams(fields).toString();
    return request(port, target, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } });
  };
  const check = (root, headers = {}, extra = {}) => {
    const body = JSON.stringify({ root, ...extra });
    return request(port, '/setup/check', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } });
  };
  return {
    lib, env, port, booted, form, check,
    configFile: path.join(lib.dataDir, 'config.json'),
    get: (target, headers = {}) => request(port, target, { headers }),
    valid: (over = {}) => ({ root: lib.root, siteName: '我的库', ownerName: '小明', authMode: 'password', password: GOOD_PASSWORD, aiProvider: 'off', ...over }),
    async indexed() {
      for (let i = 0; i < 500; i++) {
        const res = await request(port, '/setup/progress');
        if (res.status === 404) return true;
        if (JSON.parse(res.text).phase === 'form') return false;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      throw new Error('索引没有结束');
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      booted.stop();
      fs.rmSync(lib.base, { recursive: true, force: true });
    },
  };
}

async function loginCookie(port, password = GOOD_PASSWORD) {
  const c = new Client(port, '10.3.0.1');
  const res = await c.login(password);
  assert.equal(res.status, 303);
  return c;
}

test('未配置：页面都 302 到 /setup，/setup 200，健康检查照常', async () => {
  const w = await startWizard();
  try {
    assert.equal(needsSetup(w.env), true);
    for (const target of ['/', '/v/x', '/search', '/search?q=a', '/login', '/admin', '/s/abc']) {
      const res = await w.get(target);
      assert.equal(res.status, 302, target);
      assert.equal(res.headers.location, '/setup');
    }
    assert.equal((await w.get('/', { 'X-Forwarded-Prefix': '/apps/knowledge' })).headers.location, '/apps/knowledge/setup');
    assert.equal(JSON.parse((await w.get('/health')).text).status, 'ok');
    assert.equal((await w.get('/health?plain=1')).text, 'ok');
    const page = await w.get('/setup');
    assert.equal(page.status, 200);
    for (const text of ['1. 知识库目录', '2. 站点信息', '3. 谁能进', '4. AI']) assert.ok(page.text.includes(text), text);
    assert.doesNotMatch(page.text, /https?:\/\/(?!localhost|api\.example)[a-z]+\.[a-z]+\/[^"]*\.(js|css)/);
    assert.equal((await w.get('/assets/setup.js')).status, 200);
  } finally {
    await w.stop();
  }
});

test('POST /setup/check：统计数字和索引口径一致', async () => {
  const w = await startWizard();
  try {
    const res = await w.check(w.lib.root);
    assert.equal(res.status, 200);
    const report = JSON.parse(res.text);
    assert.equal(report.ok, true);
    assert.equal(report.obsidian, true);
    assert.equal(report.byExt.md, 9);
    assert.equal(report.estimatedSeconds, 1);
    assert.equal(Object.values(report.byExt).reduce((a, b) => a + b, 0), report.files);
    assert.ok(report.deniedExamples.length > 0 && report.deniedExamples.length <= report.denied);
    assert.ok(report.deniedExamples.some((p) => p === '.obsidian/' || p === '工资密码表.md'));
    assert.doesNotMatch(JSON.stringify(report), /ZZSECRETZZ/);

    assert.equal((await w.form('/setup', w.valid())).status, 200);
    assert.equal(await w.indexed(), true);
    const db = w.booted.state.kb.db;
    assert.equal(db.prepare('SELECT COUNT(*) FROM files WHERE is_denied = 0').pluck().get(), report.files);
  } finally {
    await w.stop();
  }
});

test('POST /setup/check：失败都给人话，不是堆栈', async () => {
  const w = await startWizard();
  const empty = path.join(w.lib.base, 'empty');
  const locked = path.join(w.lib.base, 'locked');
  const subLocked = path.join(w.lib.base, 'sub');
  fs.mkdirSync(empty);
  fs.mkdirSync(locked, { mode: 0o000 });
  fs.mkdirSync(path.join(subLocked, '私有'), { recursive: true });
  fs.writeFileSync(path.join(subLocked, 'a.md'), 'x');
  fs.chmodSync(path.join(subLocked, '私有'), 0o000);
  try {
    const cases = [
      [path.join(w.lib.base, 'nope'), '目录不存在'],
      [path.join(w.lib.root, 'README.md'), '这不是一个目录'],
      [locked, '没有读取权限'],
      [subLocked, '没有读取权限：私有'],
      [empty, '目录是空的'],
      ['relative/path', '请填写绝对路径，例如 /home/me/notes'],
      ['', '请填写知识库目录'],
      [w.lib.base, '数据目录在这个目录里面'],
    ];
    for (const [root, error] of cases) {
      if (root === w.lib.base) fs.mkdirSync(w.lib.dataDir, { recursive: true });
      const res = await w.check(root);
      assert.equal(res.status, 400, root);
      const body = JSON.parse(res.text);
      assert.equal(body.ok, false);
      assert.ok(body.error.startsWith(error), `${root}: ${body.error}`);
    }
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.chmodSync(path.join(subLocked, '私有'), 0o700);
    await w.stop();
  }
});

test('POST /setup：写 config.json 权限 600，口令只存 hash，索引完切到正式应用', async () => {
  const w = await startWizard();
  try {
    const res = await w.form('/setup', w.valid());
    assert.equal(res.status, 200);
    assert.match(res.text, /正在建立索引/);
    assert.equal(await w.indexed(), true);

    assert.equal(fs.statSync(w.configFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${w.configFile}.tmp`), false);
    const raw = fs.readFileSync(w.configFile, 'utf8');
    assert.ok(!raw.includes(GOOD_PASSWORD));
    const saved = JSON.parse(raw);
    assert.equal(saved.root, w.lib.root);
    assert.equal(saved.siteName, '我的库');
    assert.equal(saved.ownerName, '小明');
    assert.equal(saved.authMode, 'password');
    assert.equal(saved.ai.provider, 'off');
    assert.ok(await argon2.verify(saved.passwordHash, GOOD_PASSWORD));
    assert.equal(needsSetup(w.env), false);

    assert.equal((await w.get('/')).headers.location, '/login?next=%2F');
    const login = await w.get('/login');
    assert.match(login.text, /我的库/);
    const c = await loginCookie(w.port);
    assert.equal((await c.get('/')).status, 200);
    assert.equal((await c.get('/v/README.md')).status, 200);
    assert.equal(w.booted.state.kb.config.ownerName, '小明');
  } finally {
    await w.stop();
  }
});

test('配置完成后 /setup 及其接口一律 404，不论是否登录', async () => {
  const w = await startWizard();
  try {
    await w.form('/setup', w.valid());
    await w.indexed();
    const c = await loginCookie(w.port);
    for (const send of [(t) => w.get(t), (t) => c.get(t)]) {
      for (const target of ['/setup', '/setup/', '/setup/progress', '/setup/whatever']) assert.equal((await send(target)).status, 404, target);
    }
    assert.equal((await w.form('/setup', w.valid())).status, 404);
    assert.equal((await w.check(w.lib.root)).status, 404);
    assert.equal((await c.post('/setup', w.valid())).status, 404);
    assert.equal(fs.statSync(w.configFile).mode & 0o777, 0o600);
  } finally {
    await w.stop();
  }
  // 环境变量部署从来没有向导，同样 404 而不是跳登录
  const kb = await startServer();
  try {
    assert.equal((await new Client(kb.port).get('/setup')).status, 404);
    assert.equal((await new Client(kb.port).post('/setup', {})).status, 404);
  } finally {
    await kb.stop();
  }
});

test('POST /setup：非法路径和弱口令都不落盘，口令不回显', async () => {
  const w = await startWizard();
  try {
    const bad = await w.form('/setup', w.valid({ root: path.join(w.lib.base, 'nope') }));
    assert.equal(bad.status, 400);
    assert.match(bad.text, /知识库目录：目录不存在/);
    assert.equal(fs.existsSync(w.configFile), false);
    assert.doesNotMatch(bad.text, new RegExp(GOOD_PASSWORD));

    const short = await w.form('/setup', w.valid({ password: '123456789' }));
    assert.equal(short.status, 400);
    assert.match(short.text, /口令至少 10 位/);
    assert.doesNotMatch(short.text, /123456789/);
    assert.match(short.text, new RegExp(`value="${w.lib.root}"`));
    assert.equal(fs.existsSync(w.configFile), false);

    for (const over of [{ authMode: 'open' }, { aiProvider: 'magic' }, { aiProvider: 'openai', aiBaseUrl: 'ftp://x', aiApiKey: 'k', aiModel: 'm' }, { aiProvider: 'openai', aiBaseUrl: 'https://a.example/v1' }, { aiProvider: 'claude-cli' }, { siteName: 'x'.repeat(41) }]) {
      assert.equal((await w.form('/setup', w.valid(over))).status, 400, JSON.stringify(over));
    }
    assert.equal(fs.existsSync(w.configFile), false);

    assert.equal((await w.form('/setup', w.valid({ password: '1234567890' }))).status, 200);
    assert.equal(await w.indexed(), true);
  } finally {
    await w.stop();
  }
});

test('AI key：回显页不出现明文，留空表示不修改；/admin 也只说已设置', async () => {
  const w = await startWizard();
  try {
    const ai = { aiProvider: 'openai', aiBaseUrl: 'https://llm.example.com/v1', aiApiKey: API_KEY, aiModel: 'demo-1' };
    const first = await w.form('/setup', w.valid({ ...ai, password: 'short' }));
    assert.equal(first.status, 400);
    assert.ok(!first.text.includes(API_KEY));
    assert.match(first.text, /placeholder="\*{6}"/);
    assert.match(first.text, /留空表示不修改/);
    assert.ok(!(await w.get('/setup')).text.includes(API_KEY));

    assert.equal((await w.form('/setup', w.valid({ ...ai, aiApiKey: '' }))).status, 200);
    assert.equal(await w.indexed(), true);
    assert.equal(JSON.parse(fs.readFileSync(w.configFile, 'utf8')).ai.apiKey, API_KEY);
    assert.equal(w.booted.state.kb.config.aiApiKey, API_KEY);

    const c = await loginCookie(w.port);
    const admin = await c.get('/admin');
    assert.ok(!admin.text.includes(API_KEY));
    assert.match(admin.text, /AI Key<\/td><td>已设置<\/td><td class="nowrap">配置文件/);
    assert.ok(!(await c.get('/admin/settings')).text.includes(API_KEY));
  } finally {
    await w.stop();
  }
});

test('环境变量覆盖：config.json 写 A、环境变量设 B → 生效 B，/admin 来源=环境变量', async () => {
  const w = await startWizard();
  try {
    await w.form('/setup', w.valid({ aiProvider: 'openai', aiBaseUrl: 'https://a.example.com/v1', aiApiKey: 'file-key', aiModel: 'file-model' }));
    await w.indexed();
    await w.booted.state.kb.indexer.idle();
    const other = path.join(w.lib.base, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, '来自环境变量的库.md'), '# B\n');

    const file = loadConfig(w.env);
    assert.equal(file.root, w.lib.root);
    assert.equal(file.sources.root, 'file');

    const env = { ...w.env, KB_ROOT: other, AUTH_MODE: 'both', KB_PASSWORD: 'env-password-1', KB_ALLOWED_USERS: 'bob', AI_PROVIDER: 'off', AI_BASE_URL: 'https://b.example.com/v1', AI_API_KEY: 'env-key', AI_MODEL: 'env-model', KB_OWNER_NAME: '环境主人', ...YH, YH_APP_URL: 'https://b.example.com' };
    const merged = loadConfig(env);
    assert.equal(merged.root, other);
    assert.equal(merged.authMode, 'both');
    assert.equal(merged.password, 'env-password-1');
    assert.deepEqual(merged.allowedUsers, ['bob']);
    assert.equal(merged.aiProvider, 'off');
    assert.equal(merged.aiBaseUrl, 'https://b.example.com/v1');
    assert.equal(merged.aiApiKey, 'env-key');
    assert.equal(merged.aiModel, 'env-model');
    assert.equal(merged.ownerName, '环境主人');
    assert.equal(merged.siteName, '我的库');
    for (const key of ['root', 'authMode', 'password', 'allowedUsers', 'aiProvider', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'ownerName']) assert.equal(merged.sources[key], 'env', key);
    assert.equal(merged.sources.siteName, 'file');

    // 空字符串算没设：docker compose 把没填的变量传成空串，不能把配置文件盖掉
    const blank = loadConfig({ ...w.env, KB_ROOT: '', AI_API_KEY: '', AUTH_MODE: '', KB_ALLOWED_USERS: '' });
    assert.equal(blank.root, w.lib.root);
    assert.equal(blank.aiApiKey, 'file-key');
    assert.equal(blank.sources.aiApiKey, 'file');
    assert.equal(blank.authMode, 'password');

    // 真起一个实例：/admin 上看得到来源，登录用的是环境变量里的口令
    w.booted.stop();
    const again = await boot({ ...w.env, KB_ROOT: other, KB_PASSWORD: 'env-password-1', AI_API_KEY: 'zz-env-key-secret' });
    const server = http.createServer(again.handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const c = await loginCookie(server.address().port, 'env-password-1');
      const admin = await c.get('/admin');
      assert.match(admin.text, new RegExp(`知识库目录</td><td>${other}</td><td class="nowrap">环境变量`));
      assert.match(admin.text, /登录口令<\/td><td>已设置<\/td><td class="nowrap">环境变量/);
      assert.match(admin.text, /AI Key<\/td><td>已设置<\/td><td class="nowrap">环境变量/);
      assert.match(admin.text, /站点名<\/td><td>我的库<\/td><td class="nowrap">配置文件/);
      assert.ok(!admin.text.includes('zz-env-key-secret'));
      assert.ok(!admin.text.includes('file-key'));
      assert.ok(!admin.text.includes('$argon2'));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      await again.state.kb.indexer.idle();
      w.booted.stop = () => again.stop();
    }
  } finally {
    await w.stop();
  }
});

test('平台选项：没有 YH_* 时禁用且后端也拒绝；有 YH_* 时默认选平台模型', async () => {
  const w = await startWizard();
  try {
    const page = await w.get('/setup');
    assert.match(page.text, /value="sso"[^>]* disabled/);
    assert.match(page.text, /value="both"[^>]* disabled/);
    assert.match(page.text, /value="platform"[^>]* disabled/);
    assert.match(page.text, /未检测到平台应用凭证/);
    for (const over of [{ authMode: 'sso' }, { authMode: 'both' }, { aiProvider: 'platform' }]) {
      const res = await w.form('/setup', w.valid(over));
      assert.equal(res.status, 400);
      assert.match(res.text, /未检测到平台应用凭证/);
    }
  } finally {
    await w.stop();
  }

  const yh = await startWizard({ ...YH, YH_APP_URL: 'https://one.example.com/apps/knowledge' });
  try {
    const page = await yh.get('/setup');
    assert.doesNotMatch(page.text, /value="sso"[^>]* disabled/);
    assert.match(page.text, /value="platform" checked/);
    assert.match(page.text, /将使用平台模型，无需 key/);
    assert.equal((await yh.form('/setup', yh.valid({ authMode: 'sso', password: '', allowedUsers: 'alice, 96,', aiProvider: 'platform' }))).status, 200);
    assert.equal(await yh.indexed(), true);
    const saved = JSON.parse(fs.readFileSync(yh.configFile, 'utf8'));
    assert.equal(saved.passwordHash, undefined);
    assert.deepEqual(saved.allowedUsers, ['alice', '96']);
    assert.equal(saved.ai.provider, 'platform');
    const { config } = yh.booted.state.kb;
    assert.equal(config.authMode, 'sso');
    assert.deepEqual(config.allowedUsers, ['alice', '96']);
    assert.equal(config.sso.problem, null);
    assert.match((await yh.get('/login')).text, /用平台账号登录/);
  } finally {
    await yh.stop();
  }
});

test('本机检测到 claude 时才能选命令行通道', async () => {
  const lib = makeLibrary();
  const bin = path.join(lib.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const w = await startWizard({ PATH: bin });
  try {
    assert.doesNotMatch((await w.get('/setup')).text, /value="claude-cli"[^>]* disabled/);
    assert.equal((await w.form('/setup', w.valid({ aiProvider: 'claude-cli' }))).status, 200);
    assert.equal(await w.indexed(), true);
    assert.equal(w.booted.state.kb.config.aiProvider, 'claude-cli');
  } finally {
    await w.stop();
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});

test('外来访问：没有设置码不能探测目录或抢先配置；本机和设置码放行', async () => {
  const w = await startWizard();
  try {
    const remote = { 'X-Forwarded-For': '203.0.113.9' };
    const denied = await w.check(w.lib.root, remote);
    assert.equal(denied.status, 403);
    assert.deepEqual(Object.keys(JSON.parse(denied.text)), ['ok', 'error']);
    assert.equal((await w.form('/setup', w.valid(), remote)).status, 403);
    assert.equal(fs.existsSync(w.configFile), false);
    assert.equal((await w.check(w.lib.root, remote, { token: 'x'.repeat(12) })).status, 403);
    assert.match((await w.get('/setup', remote)).text, /name="token"/);
    assert.doesNotMatch((await w.get('/setup')).text, /name="token"/);
    assert.match((await w.get(`/setup?token=${w.booted.setupToken}`, remote)).text, new RegExp(`value="${w.booted.setupToken}"`));

    // 别的网站从用户浏览器打 localhost
    assert.equal((await w.check(w.lib.root, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await w.form('/setup', w.valid(), { Origin: 'null' })).status, 403);
    assert.equal((await w.form('/setup', w.valid(), { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    // DNS 重绑定：socket 是 127.0.0.1，但 Host 是攻击者的域名
    assert.equal((await w.check(w.lib.root, { Host: 'rebind.evil.example' })).status, 403);
    assert.equal((await w.check(w.lib.root, { Origin: `http://127.0.0.1:${w.port}` })).status, 200);
    // 全站 no-referrer 下，浏览器同源提交表单带的就是 Origin: null，不能挡
    const browser = await w.form('/setup', w.valid({ password: 'short' }), { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(browser.status, 400);
    assert.match(browser.text, /口令至少 10 位/);

    assert.equal((await w.check(w.lib.root, remote, { token: w.booted.setupToken })).status, 200);
    const ok = await w.form('/setup', w.valid({ token: w.booted.setupToken }), { ...remote, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'kb.example.com', 'X-Forwarded-Prefix': '/apps/knowledge' });
    assert.equal(ok.status, 200);
    assert.equal(await w.indexed(), true);
    assert.equal(JSON.parse(fs.readFileSync(w.configFile, 'utf8')).baseUrl, 'https://kb.example.com/apps/knowledge');
    assert.equal(w.booted.state.kb.config.cookieSecure, true);
  } finally {
    await w.stop();
  }
});

test('http 上配置的实例：对外地址取访问地址，登录 cookie 不带 Secure', async () => {
  const w = await startWizard();
  try {
    await w.form('/setup', w.valid());
    await w.indexed();
    const { config } = w.booted.state.kb;
    assert.equal(config.baseUrl, `http://127.0.0.1:${w.port}`);
    assert.equal(config.cookieSecure, false);
    const body = new URLSearchParams({ password: GOOD_PASSWORD }).toString();
    const res = await request(w.port, '/login', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } });
    assert.doesNotMatch(res.headers['set-cookie'].join(), /Secure/);
  } finally {
    await w.stop();
  }
});

test('首次索引失败：撤掉 config.json，回到表单给错误，改好能重来', async () => {
  const w = await startWizard();
  fs.mkdirSync(path.join(w.lib.dataDir, 'kb.sqlite'), { recursive: true });
  const logged = console.error;
  console.error = () => {};
  try {
    assert.equal((await w.form('/setup', w.valid())).status, 200);
    assert.equal(await w.indexed(), false);
    assert.equal(fs.existsSync(w.configFile), false);
    assert.equal(needsSetup(w.env), true);
    const page = await w.get('/setup');
    assert.equal(page.status, 200);
    assert.match(page.text, /首次索引失败，配置没有保存/);
    assert.match(page.text, new RegExp(`value="${w.lib.root}"`));

    fs.rmdirSync(path.join(w.lib.dataDir, 'kb.sqlite'));
    assert.equal((await w.form('/setup', w.valid())).status, 200);
    assert.equal(await w.indexed(), true);
    assert.equal(fs.existsSync(w.configFile), true);
  } finally {
    console.error = logged;
    await w.stop();
  }
});

test('连点提交只生效一次', async () => {
  const w = await startWizard();
  try {
    const [a, b] = await Promise.all([w.form('/setup', w.valid()), w.form('/setup', w.valid({ siteName: '第二次' }))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 303]);
    await w.indexed();
    assert.equal(JSON.parse(fs.readFileSync(w.configFile, 'utf8')).siteName, '我的库');
  } finally {
    await w.stop();
  }
});

test('config.json 损坏：启动报错，不退回向导', async () => {
  const lib = makeLibrary();
  try {
    fs.mkdirSync(lib.dataDir, { recursive: true });
    fs.writeFileSync(path.join(lib.dataDir, 'config.json'), '{ 手滑');
    await assert.rejects(boot({ KB_DATA_DIR: lib.dataDir }), /配置文件不是合法的 JSON/);
  } finally {
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});

test('重新配置：删 config.json 重启后回到向导，换口令后旧会话失效', async () => {
  const w = await startWizard();
  try {
    await w.form('/setup', w.valid());
    await w.indexed();
    const old = await loginCookie(w.port);
    assert.equal((await old.get('/')).status, 200);
    w.booted.stop();
    fs.rmSync(w.configFile);

    const again = await boot(w.env);
    const server = http.createServer(again.handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    w.booted.stop = () => again.stop();
    try {
      assert.equal((await request(port, '/setup')).status, 200);
      const body = new URLSearchParams(w.valid({ password: 'another-pass-10' })).toString();
      await request(port, '/setup', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } });
      for (let i = 0; i < 500 && (await request(port, '/setup/progress')).status !== 404; i++) await new Promise((resolve) => { setTimeout(resolve, 10); });
      const stale = new Client(port, '10.3.0.2');
      stale.cookies = old.cookies;
      assert.equal((await stale.get('/')).status, 302);
      assert.equal((await new Client(port, '10.3.0.3').login('another-pass-10')).status, 303);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    }
  } finally {
    await w.stop();
  }
});

test('Docker：提示填容器内路径', async () => {
  const w = await startWizard({ KB_IN_DOCKER: '1' });
  try {
    const page = await w.get('/setup');
    assert.match(page.text, /placeholder="\/library"/);
    assert.match(page.text, /docker run -v \/你的\/知识库:\/library:ro/);
  } finally {
    await w.stop();
  }
  const plain = await startWizard();
  try {
    assert.doesNotMatch((await plain.get('/setup')).text, /docker run/);
  } finally {
    await plain.stop();
  }
});

test('环境变量里配好了就不进向导；数据目录写不进去时页面直接说', async () => {
  const lib = makeLibrary();
  try {
    assert.equal(needsSetup({ KB_ROOT: lib.root, KB_DATA_DIR: lib.dataDir }), false);
    const notDir = path.join(lib.base, 'plain-file');
    fs.writeFileSync(notDir, 'x');
    const w = await startWizard({ KB_DATA_DIR: path.join(notDir, 'data') });
    try {
      assert.match((await w.get('/setup')).text, /写不进去/);
      assert.equal((await w.form('/setup', w.valid())).status, 400);
    } finally {
      await w.stop();
    }
  } finally {
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});
