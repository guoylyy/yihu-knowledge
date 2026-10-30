import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import argon2 from 'argon2';
import { Client, enc, makeLibrary, PASSWORD, request } from './helpers.js';
import { saveAllowlist } from '../src/allowlist.js';
import { boot } from '../src/boot.js';

const NEW_PASSWORD = 'brand-new-pass-10';
const API_KEY = 'zz-settings-api-key-should-not-echo';
const YH = { YH_CLIENT_ID: 'knowledge', YH_CLIENT_SECRET: 'kb-secret', YH_WEB_URL: 'https://one.example.com', YH_API_URL: 'http://127.0.0.1:9', YH_APP_URL: 'https://one.example.com/apps/knowledge' };
const PASSWORD_HASH = await argon2.hash(PASSWORD);

function makeDir(base, name, files) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// 新库和测试库有同名文件 README.md，内容不同：用来验证旧分享不会串到新库
const NEXT_LIBRARY = Object.fromEntries([
  ['README.md', '# 新库总览\n\nNEWLIBMARK 新库独有的内容\n'],
  ...Array.from({ length: 8 }, (_, i) => [`新笔记/第${i}篇.md`, `# 第${i}篇\n\n[[README]] 正文\n`]),
]);

// 走 boot 和真实的 config.json：/admin/settings 的来源标记、热生效都要这样才测得到
async function start({ file = {}, env = {} } = {}) {
  const lib = makeLibrary();
  fs.mkdirSync(lib.dataDir, { recursive: true });
  const configFile = path.join(lib.dataDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    root: lib.root, siteName: '旧站点', ownerName: '旧主人', authMode: 'password', passwordHash: PASSWORD_HASH, baseUrl: 'http://old.example.com',
    allowedUsers: [], ai: { provider: 'off', baseUrl: '', apiKey: '', model: '' }, ...file,
  }));
  const fullEnv = { KB_DATA_DIR: lib.dataDir, HOME: '/nonexistent', PATH: '', ...env };
  let booted = await boot(fullEnv);
  let server;
  let port;
  const listen = async () => {
    server = http.createServer(booted.handler);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    ({ port } = server.address());
  };
  await listen();
  await booted.state.kb.indexer.run({ full: true });
  const c = new Client(port);
  if (file.authMode !== 'sso') assert.equal((await c.login()).status, 303);
  return {
    lib, c, configFile,
    get kb() { return booted.state.kb; },
    get port() { return port; },
    saved: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
    count: () => booted.state.kb.db.prepare('SELECT COUNT(*) FROM files WHERE is_denied = 0').pluck().get(),
    audit: () => booted.state.kb.db.prepare("SELECT * FROM audit_log WHERE action = 'settings_change' ORDER BY id").all(),
    async post(section, fields) {
      return c.post(`/admin/settings/${section}`, { _csrf: await c.csrf(), ...fields });
    },
    async check(root) {
      const body = JSON.stringify({ root });
      const res = await c.send('/admin/settings/library/check', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-CSRF-Token': await c.csrf() } });
      return { status: res.status, body: JSON.parse(res.text) };
    },
    async finished() {
      for (let i = 0; i < 1000; i++) {
        const job = JSON.parse((await c.get('/admin/settings/library/progress')).text);
        if (!job.running) return job;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      throw new Error('换库没有结束');
    },
    async restart() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      booted.stop();
      booted = await boot(fullEnv);
      await listen();
      c.port = port;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      await booted.state.kb.indexer.idle();
      booted.stop();
      fs.rmSync(lib.base, { recursive: true, force: true });
    },
  };
}

test('表单：配置文件控制的字段可编辑，标出来源，key 不回显', async () => {
  const s = await start({ file: { ai: { provider: 'openai', baseUrl: 'https://llm.example.com/v1', apiKey: API_KEY, model: 'demo-1' } } });
  try {
    const page = (await s.c.get('/admin/settings')).text;
    for (const text of ['id="settings-library"', 'id="settings-site"', 'id="settings-auth"', 'id="settings-ai"', '当前来源：配置文件']) assert.ok(page.includes(text), text);
    assert.doesNotMatch(page, /环境变量优先/);
    assert.match(page, new RegExp(`name="root" id="library-root" value="${s.lib.root}"`));
    assert.doesNotMatch(page, /name="siteName"[^>]* disabled/);
    assert.match(page, /placeholder="\*{6}"/);
    assert.match(page, /留空表示不修改/);
    assert.ok(!page.includes(API_KEY));
    assert.ok(!page.includes('$argon2'));
    assert.match(page, /name="currentPassword"/);
  } finally {
    await s.stop();
  }
});

test('表单：环境变量控制的字段只读并说明原因，后端同样拒绝', async () => {
  const s = await start({ env: { KB_ROOT: '', KB_OWNER_NAME: '环境主人', KB_BASE_URL: 'https://env.example.com', AUTH_MODE: 'password', AI_PROVIDER: 'off', AI_API_KEY: 'zz-env-key-secret', KB_PASSWORD: PASSWORD } });
  try {
    const page = (await s.c.get('/admin/settings')).text;
    assert.match(page, /name="ownerName"[^>]* disabled/);
    assert.match(page, /name="baseUrl"[^>]* disabled/);
    assert.match(page, /name="authMode"[^>]* disabled/);
    assert.match(page, /name="aiProvider"[^>]* disabled/);
    assert.match(page, /name="aiApiKey"[^>]* disabled/);
    for (const name of ['KB_OWNER_NAME', 'KB_BASE_URL', 'AUTH_MODE', 'AI_PROVIDER', 'AI_API_KEY', 'KB_PASSWORD']) assert.ok(page.includes(`<code>${name}</code>`), name);
    assert.match(page, /环境变量优先，这里改了也不生效/);
    assert.doesNotMatch(page, /name="currentPassword"/);
    assert.doesNotMatch(page, /name="siteName"[^>]* disabled/);
    assert.ok(!page.includes('zz-env-key-secret'));

    const res = await s.post('site', { siteName: '站', ownerName: '想改的人', baseUrl: 'https://env.example.com' });
    assert.equal(res.status, 409);
    assert.match(res.text, /主人名由环境变量控制/);
    assert.equal((await s.post('auth', { authMode: 'both' })).status, 409);
    assert.equal((await s.post('password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 409);
    assert.equal(s.saved().ownerName, '旧主人');

    // 只改站点名：环境变量的值不能顺带写进 config.json
    assert.equal((await s.post('site', { siteName: '新站点' })).status, 303);
    assert.equal(s.saved().siteName, '新站点');
    assert.equal(s.saved().baseUrl, 'http://old.example.com');
    assert.ok(!fs.readFileSync(s.configFile, 'utf8').includes(PASSWORD));
  } finally {
    await s.stop();
  }
});

test('目录由 KB_ROOT 控制：只读，检测和提交都改不了', async () => {
  const lib = makeLibrary();
  const other = makeDir(lib.base, 'other', NEXT_LIBRARY);
  const s = await start({ env: { KB_ROOT: lib.root, KB_PASSWORD: PASSWORD } });
  try {
    const page = (await s.c.get('/admin/settings')).text;
    assert.match(page, /id="library-root"[^>]* disabled/);
    assert.match(page, /<code>KB_ROOT<\/code>/);
    assert.doesNotMatch(page, /id="library-save"/);
    const res = await s.post('library', { root: other, confirm: '1' });
    assert.equal(res.status, 409);
    assert.match(res.text, /知识库目录由环境变量控制/);
  } finally {
    await s.stop();
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});

test('换目录预检：每种错误都有人话，什么都不改', async () => {
  const s = await start();
  const { base, root, dataDir } = s.lib;
  const empty = makeDir(base, 'empty', {});
  const insideData = makeDir(dataDir, 'notes', { 'a.md': '# a' });
  const holdsData = makeDir(base, 'holder', { 'a.md': '# a' });
  try {
    const cases = [
      [path.join(base, 'nope'), '目录不存在'],
      [path.join(root, 'README.md'), '这不是一个目录'],
      [empty, '目录是空的'],
      [dataDir, '这就是数据目录本身'],
      [insideData, '这个目录在数据目录里面'],
      [base, '数据目录在这个目录里面'],
      [root, '这就是现在的知识库目录'],
      ['relative/path', '请填写绝对路径'],
    ];
    for (const [target, error] of cases) {
      const { status, body } = await s.check(target);
      assert.equal(status, 400, target);
      assert.ok(body.error.startsWith(error), `${target}: ${body.error}`);
      const res = await s.post('library', { root: target, confirm: '1' });
      assert.equal(res.status, 400, target);
      assert.ok(res.text.includes(error), target);
    }
    assert.equal(s.saved().root, root);
    assert.equal(fs.existsSync(path.join(dataDir, 'reindex.tmp.sqlite')), false);

    // 数据目录是软链接时也认得出来
    const alias = path.join(base, 'data-alias');
    fs.symlinkSync(dataDir, alias);
    assert.ok((await s.check(alias)).body.error.startsWith('这就是数据目录本身'));
    assert.equal((await s.check(holdsData)).status, 200);
  } finally {
    await s.stop();
  }
});

test('换目录成功：索引换成新库，配置落盘，会话和分享记录都在，旧分享 404', async () => {
  const s = await start();
  const next = makeDir(s.lib.base, 'next', NEXT_LIBRARY);
  try {
    const before = s.count();
    await s.c.createShare({ path: 'README.md' }); // 同名文件，内容不同
    await s.c.createShare({ path: 'notes/笔记甲.md' });
    const [same, gone] = s.kb.db.prepare('SELECT token FROM shares ORDER BY id').pluck().all();
    assert.equal((await new Client(s.port).get(`/s/${same}`)).status, 200);
    const old = new Client(s.port, '10.9.0.2');
    await old.login();

    const { body: report } = await s.check(next);
    assert.equal(report.current, before);
    assert.equal(report.files, 9);
    assert.equal(report.shares, 2);
    assert.equal(report.anomaly, null);

    const unconfirmed = await s.post('library', { root: next });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.text, /要先确认后果/);
    assert.equal(s.saved().root, s.lib.root);

    assert.equal((await s.post('library', { root: next, confirm: '1' })).status, 303);
    const job = await s.finished();
    assert.equal(job.phase, 'done');
    assert.deepEqual([job.before, job.after, job.retired], [before, 9, 2]);

    assert.equal(s.saved().root, next);
    assert.equal(s.kb.config.root, next);
    assert.equal(s.count(), 9);
    assert.equal(s.kb.db.prepare('SELECT COUNT(*) FROM file_text').pluck().get(), 9);
    assert.equal(fs.statSync(s.configFile).mode & 0o777, 0o600);
    for (const f of ['reindex.tmp.sqlite', 'reindex.tmp.sqlite-wal', 'reindex.tmp.sqlite-shm', 'config.pending.json']) assert.equal(fs.existsSync(path.join(s.lib.dataDir, f)), false, f);

    // 读的是新目录，搜索、目录、链接解析都切过去了，不用重启
    const note = await s.c.get(`/v/${enc('README.md')}`);
    assert.equal(note.status, 200);
    assert.match(note.text, /NEWLIBMARK/);
    assert.equal((await s.c.get(`/v/${enc('notes/笔记甲.md')}`)).status, 404);
    assert.match((await s.c.get('/search?q=NEWLIBMARK')).text, /README/);
    assert.doesNotMatch((await s.c.get(`/search?q=${encodeURIComponent('工资核算')}`)).text, /笔记乙/);
    assert.ok(s.kb.db.prepare("SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL").pluck().get() >= 8);

    // 路径不存在的自然 404；路径碰巧相同的也 404，不能把新库的内容给旧链接的持有人
    for (const token of [same, gone]) {
      const visitor = await new Client(s.port).get(`/s/${token}`);
      assert.equal(visitor.status, 404);
      assert.ok(!visitor.text.includes('NEWLIBMARK'));
    }
    assert.match((await s.c.get('/admin/shares')).text, /换库后失效/);

    // 登录状态不受影响，别的会话也在
    assert.equal((await old.get('/')).status, 200);
    assert.match((await s.c.get('/admin/settings')).text, /已换到/);
    const fresh = await s.c.createShare({ path: 'README.md' });
    assert.equal(fresh.status, 303);
    const token = s.kb.db.prepare('SELECT token FROM shares ORDER BY id DESC').pluck().get();
    assert.match((await new Client(s.port).get(`/s/${token}`)).text, /NEWLIBMARK/);

    await s.restart();
    assert.equal(s.kb.config.root, next);
    assert.equal((await s.c.get(`/v/${enc('README.md')}`)).status, 200);
  } finally {
    await s.stop();
  }
});

test('换目录失败：目录不可读时旧配置和旧索引不变，页面显示错误，旧库照常读', async () => {
  const s = await start();
  const locked = makeDir(s.lib.base, 'locked', NEXT_LIBRARY);
  fs.chmodSync(locked, 0o000);
  try {
    const before = s.count();
    const res = await s.post('library', { root: locked, confirm: '1' });
    assert.equal(res.status, 400);
    assert.match(res.text, /没有读取权限/);
    assert.equal(s.saved().root, s.lib.root);
    assert.equal(s.count(), before);
    assert.equal((await s.c.get(`/v/${enc('README.md')}`)).status, 200);
  } finally {
    fs.chmodSync(locked, 0o700);
    await s.stop();
  }
});

test('换目录失败：临时库写不进去 → 不碰正式库，错误回到表单，改好能重来', async () => {
  const s = await start();
  const next = makeDir(s.lib.base, 'next', NEXT_LIBRARY);
  const tmp = path.join(s.lib.dataDir, 'reindex.tmp.sqlite');
  const logged = console.error;
  console.error = () => {};
  fs.mkdirSync(tmp);
  try {
    const before = s.count();
    await s.c.createShare({ path: 'README.md' });
    const token = s.kb.db.prepare('SELECT token FROM shares').pluck().get();
    assert.equal((await s.post('library', { root: next, confirm: '1' })).status, 303);
    const job = await s.finished();
    assert.equal(job.phase, 'failed');
    assert.match(job.error, /配置和索引都没有动/);
    assert.equal(s.saved().root, s.lib.root);
    assert.equal(s.count(), before);
    assert.equal((await s.c.get(`/v/${enc('README.md')}`)).status, 200);
    assert.equal((await new Client(s.port).get(`/s/${token}`)).status, 200);
    assert.ok((await s.c.get('/admin/settings')).text.includes('配置和索引都没有动'));
    assert.equal(s.audit().length, 0);

    fs.rmdirSync(tmp);
    assert.equal((await s.post('library', { root: next, confirm: '1' })).status, 303);
    assert.equal((await s.finished()).phase, 'done');
    assert.equal(s.saved().root, next);
  } finally {
    console.error = logged;
    await s.stop();
  }
});

test('文件数异常：新库没有 md → 不替换，勾选确认后才换', async () => {
  const s = await start();
  const pdfs = makeDir(s.lib.base, 'pdfs', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.pdf`, 'x'])));
  try {
    const before = s.count();
    const { body } = await s.check(pdfs);
    assert.match(body.anomaly, /一篇 Markdown 笔记都没有/);
    const refused = await s.post('library', { root: pdfs, confirm: '1' });
    assert.equal(refused.status, 409);
    assert.match(refused.text, /确认这就是我要的库/);
    assert.equal(s.saved().root, s.lib.root);
    assert.equal(s.count(), before);

    assert.equal((await s.post('library', { root: pdfs, confirm: '1', acceptAnomaly: '1' })).status, 303);
    assert.equal((await s.finished()).phase, 'done');
    assert.equal(s.saved().root, pdfs);
    assert.equal(s.count(), 20);
  } finally {
    await s.stop();
  }
});

test('文件数异常：比旧库少 90% 以上也要确认，刚好边界不算', async () => {
  const s = await start();
  const small = makeDir(s.lib.base, 'small', { 'a.md': '# a' });
  try {
    assert.match((await s.check(small)).body.anomaly, /少了 90% 以上/);
    assert.equal((await s.post('library', { root: small, confirm: '1' })).status, 409);
    const db = s.kb.db;
    const keep = db.prepare('SELECT id FROM files WHERE is_denied = 0 ORDER BY id LIMIT 10').pluck().all();
    db.prepare(`DELETE FROM files WHERE id NOT IN (${keep.join(',')})`).run();
    assert.equal(s.count(), 10);
    assert.equal((await s.check(small)).body.anomaly, null);
  } finally {
    await s.stop();
  }
});

test('换库期间：其它页面照常可读，不能再提交一次，别的分区保存不会丢', async () => {
  const s = await start();
  const files = { ...NEXT_LIBRARY };
  for (let i = 0; i < 400; i++) files[`批量/${i}.md`] = `# ${i}\n\n${'正文 '.repeat(200)}\n`;
  const next = makeDir(s.lib.base, 'next', files);
  try {
    assert.equal((await s.post('library', { root: next, confirm: '1' })).status, 303);
    const during = await s.post('library', { root: next, confirm: '1' });
    assert.equal(during.status, 409);
    assert.match(during.text, /已经有一次换库在进行中/);
    assert.match(during.text, /id="library-progress"/);
    assert.equal((await s.post('site', { siteName: '换库时改的', ownerName: '旧主人', baseUrl: 'http://old.example.com' })).status, 303);
    for (let job = JSON.parse((await s.c.get('/admin/settings/library/progress')).text); job.running; job = JSON.parse((await s.c.get('/admin/settings/library/progress')).text)) {
      assert.equal((await s.c.get(`/v/${enc('README.md')}`)).status, 200);
      assert.equal((await s.c.get('/')).status, 200);
    }
    assert.equal((await s.finished()).phase, 'done');
    assert.equal(s.saved().root, next);
    assert.equal(s.saved().siteName, '换库时改的');
    assert.equal(s.count(), 409);
  } finally {
    await s.stop();
  }
});

test('站点：非法地址被拒，合法立即生效，分享页文案和分享链接都跟着变', async () => {
  const s = await start();
  try {
    await s.c.createShare({ path: 'README.md' });
    const { id, token } = s.kb.db.prepare('SELECT id, token FROM shares').get();
    const site = (over) => s.post('site', { siteName: '新站点', ownerName: '新主人', baseUrl: 'https://kb.example.org/', ...over });
    for (const baseUrl of ['kb.example.org', 'ftp://kb.example.org', 'javascript:alert(1)', 'https://', '', 'https://kb.example.org/?a=1']) {
      const res = await site({ baseUrl });
      assert.equal(res.status, 400, baseUrl);
      assert.match(res.text, /对外地址/);
    }
    assert.equal((await site({ siteName: 'x'.repeat(41) })).status, 400);
    assert.equal((await site({ ownerName: '' })).status, 400);
    assert.equal(s.saved().baseUrl, 'http://old.example.com');

    assert.equal((await site()).status, 303);
    assert.equal(s.saved().baseUrl, 'https://kb.example.org');
    const visitor = (await new Client(s.port).get(`/s/${token}`)).text;
    assert.match(visitor, /来自 <strong>新主人<\/strong> 的分享/);
    assert.match(visitor, /新站点/);
    assert.match((await s.c.get(`/admin/shares/${id}`)).text, new RegExp(`value="https://kb\\.example\\.org/s/${token}"`));
    assert.match((await new Client(s.port).get('/login')).text, /新站点/);
    assert.equal(s.kb.config.cookieSecure, true);
    assert.equal(s.saved().root, s.lib.root);
  } finally {
    await s.stop();
  }
});

test('口令：当前口令错拒绝，成功后其它会话失效、当前保留，重启后依旧', async () => {
  const s = await start();
  const other = new Client(s.port, '10.9.0.3');
  await other.login();
  const change = (over) => s.post('password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, ...over });
  try {
    const wrong = await change({ currentPassword: 'not-the-password' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /当前口令不正确/);
    assert.equal((await change({ newPassword: 'short', confirmPassword: 'short' })).status, 400);
    assert.equal((await change({ confirmPassword: 'different-pass-10' })).status, 400);
    assert.equal(s.saved().passwordHash, PASSWORD_HASH);
    assert.equal((await other.get('/')).status, 200);

    assert.equal((await change()).status, 303);
    assert.ok(await argon2.verify(s.saved().passwordHash, NEW_PASSWORD));
    assert.equal((await s.c.get('/')).status, 200);
    assert.equal((await other.get('/')).status, 302);
    assert.equal((await new Client(s.port, '10.9.0.4').login(PASSWORD)).status, 401);
    assert.equal((await new Client(s.port, '10.9.0.5').login(NEW_PASSWORD)).status, 303);

    await s.restart();
    assert.equal((await s.c.get('/')).status, 200);
  } finally {
    await s.stop();
  }
});

test('口令：核对当前口令和登录共用次数上限', async () => {
  const s = await start();
  try {
    const attempt = () => s.post('password', { currentPassword: 'guess-guess-guess', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    for (let i = 0; i < 4; i++) assert.equal((await attempt()).status, 400);
    const locked = await attempt();
    assert.equal(locked.status, 429);
    assert.match(locked.text, /尝试次数过多/);
  } finally {
    await s.stop();
  }
});

test('登录方式：sso 模式没有口令区；白名单为空不让切；切换立即生效', async () => {
  const s = await start({ env: YH });
  try {
    const empty = await s.post('auth', { authMode: 'sso' });
    assert.equal(empty.status, 400);
    assert.match(empty.text, /白名单是空的/);
    assert.equal(s.saved().authMode, 'password');

    assert.doesNotMatch((await new Client(s.port).get('/login')).text, /用平台账号登录/);
    assert.equal((await s.post('auth', { authMode: 'both' })).status, 303);
    assert.match((await new Client(s.port).get('/login')).text, /用平台账号登录/);
    assert.equal((await s.c.get('/')).status, 200);
    assert.equal((await new Client(s.port).get('/sso/login')).status, 302);

    saveAllowlist(s.kb.config, { allowedUsers: ['alice'] });
    assert.equal((await s.post('auth', { authMode: 'sso' })).status, 303);
    assert.equal(s.saved().authMode, 'sso');
    // 口令会话当场失效，登录页也不再收口令
    assert.equal((await s.c.get('/')).status, 302);
    const denied = await new Client(s.port).post('/login', { password: PASSWORD });
    assert.equal(denied.status, 403);
  } finally {
    await s.stop();
  }
  const sso = await start({ file: { authMode: 'sso', allowedUsers: ['alice'], passwordHash: undefined }, env: YH });
  try {
    sso.kb.auth.createSession({ via: 'sso', username: 'alice', userId: '1' });
    const created = sso.kb.auth.createSession({ via: 'sso', username: 'alice', userId: '1' });
    sso.c.cookies.set('kb_sid', created.id);
    const page = (await sso.c.get('/admin/settings')).text;
    assert.doesNotMatch(page, /name="currentPassword"/);
    assert.match(page, /name="newPassword"/);
    assert.equal((await sso.post('password', { currentPassword: 'x', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 409);
    // 从 sso 切回来时还没有口令：必须当场设一个，否则切完谁都进不来
    assert.match((await sso.post('auth', { authMode: 'both', newPassword: 'short' })).text, /口令至少 10 位/);
    assert.equal(sso.saved().authMode, 'sso');
    assert.equal((await sso.post('auth', { authMode: 'both', newPassword: NEW_PASSWORD })).status, 303);
    assert.ok(await argon2.verify(sso.saved().passwordHash, NEW_PASSWORD));
    assert.equal((await new Client(sso.port, '10.9.0.6').login(NEW_PASSWORD)).status, 303);
  } finally {
    await sso.stop();
  }
});

test('没有平台凭证时不能切平台登录', async () => {
  const s = await start();
  try {
    assert.match((await s.c.get('/admin/settings')).text, /name="authMode" value="sso"[^>]* disabled/);
    const res = await s.post('auth', { authMode: 'both' });
    assert.equal(res.status, 400);
    assert.match(res.text, /未检测到平台应用凭证/);
  } finally {
    await s.stop();
  }
});

test('AI：key 留空或 ****** 表示不修改，改通道立即生效，切走再切回来 key 还在', async () => {
  const s = await start();
  const openai = { aiProvider: 'openai', aiBaseUrl: 'https://llm.example.com/v1', aiModel: 'demo-1' };
  try {
    const noKey = await s.post('ai', openai);
    assert.equal(noKey.status, 400);
    assert.match(noKey.text, /请填写 API Key/);
    assert.equal((await s.post('ai', { ...openai, aiBaseUrl: 'ftp://x', aiApiKey: API_KEY })).status, 400);
    assert.equal((await s.post('ai', { aiProvider: 'magic' })).status, 400);
    assert.equal((await s.post('ai', { aiProvider: 'platform' })).status, 400);
    assert.equal(s.saved().ai.provider, 'off');

    assert.equal((await s.post('ai', { ...openai, aiApiKey: API_KEY })).status, 303);
    assert.deepEqual(s.saved().ai, { provider: 'openai', baseUrl: openai.aiBaseUrl, apiKey: API_KEY, model: 'demo-1' });
    assert.match((await s.c.get('/admin/settings')).text, /openai（demo-1）/);

    for (const aiApiKey of ['', '******']) {
      assert.equal((await s.post('ai', { ...openai, aiModel: `demo-${aiApiKey.length}`, aiApiKey })).status, 303);
      assert.equal(s.saved().ai.apiKey, API_KEY);
    }
    assert.equal((await s.post('ai', { aiProvider: 'off' })).status, 303);
    assert.match((await s.c.get('/admin/settings')).text, /AI 通道<\/th><td>off/);
    assert.equal(s.saved().ai.apiKey, API_KEY);
    assert.equal(s.saved().ai.baseUrl, openai.aiBaseUrl);
    assert.equal((await s.post('ai', { ...openai, aiModel: 'demo-2' })).status, 303);
    assert.equal(s.kb.config.aiApiKey, API_KEY);
    assert.ok(!(await s.c.get('/admin/settings')).text.includes(API_KEY));
  } finally {
    await s.stop();
  }
});

test('审计：记下谁改了什么，口令和 key 只说已修改', async () => {
  const s = await start();
  const next = makeDir(s.lib.base, 'next', NEXT_LIBRARY);
  try {
    await s.post('site', { siteName: '新站点', ownerName: '旧主人', baseUrl: 'http://old.example.com' });
    await s.post('ai', { aiProvider: 'openai', aiBaseUrl: 'https://llm.example.com/v1', aiModel: 'demo-1', aiApiKey: API_KEY });
    await s.post('password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    await s.post('library', { root: next, confirm: '1' });
    await s.finished();
    // 没有变化的保存不留记录
    await s.post('site', { siteName: '新站点', ownerName: '旧主人', baseUrl: 'http://old.example.com' });

    const rows = s.audit();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.actor === '口令登录' && row.ts > 0 && row.ip));
    assert.deepEqual(JSON.parse(rows[0].detail), [{ field: 'siteName', from: '旧站点', to: '新站点' }]);
    const ai = JSON.parse(rows[1].detail);
    assert.deepEqual(ai.find((c) => c.field === 'aiProvider'), { field: 'aiProvider', from: 'off', to: 'openai' });
    assert.deepEqual(ai.find((c) => c.field === 'aiApiKey'), { field: 'aiApiKey', note: '已修改' });
    assert.deepEqual(JSON.parse(rows[2].detail), [{ field: 'password', note: '已修改' }]);
    assert.deepEqual(JSON.parse(rows[3].detail)[0].to, next);

    const all = JSON.stringify(rows);
    for (const secret of [API_KEY, NEW_PASSWORD, PASSWORD, '$argon2']) assert.ok(!all.includes(secret), secret);
    const page = (await s.c.get('/admin/settings')).text;
    assert.match(page, /设置改动记录/);
    assert.match(page, /旧站点 → 新站点/);
    assert.ok(!page.includes(API_KEY));
  } finally {
    await s.stop();
  }
});

test('config.json 写不进去：页面报错，配置和运行状态都不变', async () => {
  const s = await start();
  const logged = console.error;
  console.error = () => {};
  fs.chmodSync(s.lib.dataDir, 0o500);
  try {
    const res = await s.post('site', { siteName: '写不进去', ownerName: '旧主人', baseUrl: 'http://old.example.com' });
    assert.equal(res.status, 503);
    assert.match(res.text, /没有保存/);
    assert.equal(s.kb.config.siteName, '旧站点');
  } finally {
    fs.chmodSync(s.lib.dataDir, 0o700);
    console.error = logged;
    await s.stop();
  }
});

test('设置接口：未登录和缺 CSRF 都进不来', async () => {
  const s = await start();
  try {
    const anon = new Client(s.port, '10.9.0.7');
    assert.equal((await anon.get('/admin/settings/library/progress')).status, 302);
    for (const part of ['site', 'auth', 'ai', 'password', 'library', 'library/check']) {
      assert.equal((await anon.post(`/admin/settings/${part}`, {})).status, 401, part);
      assert.equal((await s.c.post(`/admin/settings/${part}`, {})).status, 403, part);
    }
    assert.equal((await request(s.port, '/admin/settings')).status, 302);
  } finally {
    await s.stop();
  }
});

test('向导同样拒绝数据目录里的库', async () => {
  const lib = makeLibrary();
  const env = { KB_DATA_DIR: lib.dataDir, HOME: '/nonexistent', PATH: '' };
  const inside = makeDir(lib.dataDir, 'notes', { 'a.md': '# a' });
  const booted = await boot(env);
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const body = JSON.stringify({ root: inside });
    const res = await request(server.address().port, '/setup/check', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.text).error, /这个目录在数据目录里面/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    booted.stop();
    fs.rmSync(lib.base, { recursive: true, force: true });
  }
});
