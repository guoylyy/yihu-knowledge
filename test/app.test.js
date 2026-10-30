import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client, enc, PASSWORD, reindex, startServer } from './helpers.js';
import { createIndexRunner } from '../src/index-runner.js';
import { safeNext } from '../src/auth.js';

let kb;
let client;
before(async () => {
  kb = await startServer();
  client = new Client(kb.port);
  const res = await client.login();
  assert.equal(res.status, 303);
});
after(() => kb.stop());

test('访问控制：未登录访问受保护页面一律跳登录', async () => {
  const anon = new Client(kb.port, '10.1.0.1');
  for (const p of ['/', `/v/${enc('README.md')}`, '/raw/x.png', '/dl/x', '/html/x', '/d', '/search?q=a', '/tree', '/admin', '/admin/settings', '/admin/shares']) {
    const res = await anon.get(p);
    assert.equal(res.status, 302, p);
    assert.match(res.headers.location, /^\/login\?next=/, p);
  }
});

test('访问控制：未登录的 POST 返回 401', async () => {
  const anon = new Client(kb.port, '10.1.0.2');
  assert.equal((await anon.post('/admin/reindex')).status, 401);
  assert.equal((await anon.post('/admin/shares', { path: 'README.md' })).status, 401);
});

test('登录：cookie 带 HttpOnly、Secure、SameSite=Lax；数据库不存明文', async () => {
  const c = new Client(kb.port, '10.1.0.3');
  const res = await c.login();
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const hash = kb.db.prepare("SELECT value FROM meta WHERE key = 'auth_hash'").pluck().get();
  assert.match(hash, /^\$argon2/);
  assert.ok(!hash.includes(PASSWORD));
  const sid = cookie.match(/kb_sid=([^;]+)/)[1];
  assert.equal(kb.db.prepare('SELECT COUNT(*) FROM sessions WHERE id_hash = ?').pluck().get(sid), 0);
});

test('登录：错 5 次按 IP 锁定 15 分钟，锁定期内正确口令也不行，换 IP 不受影响', async () => {
  const c = new Client(kb.port, '10.1.0.4');
  for (let i = 0; i < 4; i++) assert.equal((await c.login('wrong-password')).status, 401);
  const fifth = await c.login('wrong-password');
  assert.equal(fifth.status, 429);
  assert.ok(Number(fifth.headers['retry-after']) > 800);
  assert.equal((await c.login()).status, 429);
  assert.equal((await new Client(kb.port, '10.1.0.5').login()).status, 303);
  // 到期后可恢复
  kb.db.prepare("UPDATE throttle SET locked_until = 0, last_fail = 0 WHERE key = 'login:10.1.0.4'").run();
  assert.equal((await c.login()).status, 303);
});

test('登录：成功后失败计数清零', async () => {
  const c = new Client(kb.port, '10.1.0.6');
  for (let i = 0; i < 4; i++) await c.login('wrong-password');
  assert.equal((await c.login()).status, 303);
  assert.equal((await c.login('wrong-password')).status, 401);
});

test('登录：next 不能跳出站外', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', undefined]) assert.equal(safeNext(bad), '/');
  assert.equal(safeNext('/v/a.md?x=1'), '/v/a.md?x=1');
});

test('退出登录后会话失效', async () => {
  const c = new Client(kb.port, '10.1.0.7');
  await c.login();
  const csrf = await c.csrf();
  const sid = c.cookies.get('kb_sid');
  assert.equal((await c.post('/logout', { _csrf: csrf })).status, 303);
  c.cookies.set('kb_sid', sid);
  assert.equal((await c.get('/admin')).status, 302);
});

test('CSRF：管理操作缺 token 或 token 错误返回 403', async () => {
  assert.equal((await client.post('/admin/reindex')).status, 403);
  assert.equal((await client.post('/admin/reindex', { _csrf: 'nope' })).status, 403);
  assert.equal((await client.post('/admin/shares', { path: 'README.md', days: '7' })).status, 403);
  assert.equal((await client.post('/logout')).status, 403);
  assert.equal(kb.db.prepare('SELECT COUNT(*) FROM shares').pluck().get(), 0);
});

test('安全响应头：CSP 禁内联脚本，no-referrer，页面不缓存', async () => {
  const res = await client.get('/');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('阅读页：标题、面包屑、属性表、双链、缺失链接、反向链接', async () => {
  const res = await client.get(`/v/${enc('README.md')}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /总览页/);
  assert.match(res.text, /<summary>属性<\/summary>/);
  assert.match(res.text, /href="\/v\/notes\/[^"]+"[^>]*>别名甲/);
  assert.match(res.text, /wikilink-missing[^>]*>不存在的笔记/);
  const a = await client.get(`/v/${enc('notes/笔记甲.md')}`);
  assert.match(a.text, /反向链接/);
  assert.match(a.text, /总览页<\/a>/);
  assert.match(a.text, /<img src="\/raw\/notes\/[^"]+" alt="[^"]*" loading="lazy" width="300"/);
  assert.match(a.text, /embed-note/);
  assert.match(a.text, /第二节正文/);
  assert.doesNotMatch(a.text, /第一节正文/);
});

test('阅读页：与页面标题相同的正文 H1 不重复显示', async () => {
  const res = await client.get(`/v/${enc('notes/笔记乙.md')}`);
  assert.equal(res.text.match(/笔记乙<\/h1>/g).length, 1);
});

test('阅读页：上一篇/下一篇在同目录内', async () => {
  const res = await client.get(`/v/${enc('notes/笔记乙.md')}`);
  assert.match(res.text, /上一篇/);
  assert.match(res.text, /下一篇/);
});

test('嵌入：deny 文件不会被 ![[ ]] 内联出来', async () => {
  const res = await client.get(`/v/${enc('notes/引用泄密.md')}`);
  assert.doesNotMatch(res.text, /ZZSECRETZZ/);
  assert.match(res.text, /wikilink-missing[^>]*>工资密码表/);
});

test('md 注入：XSS 样本经完整页面渲染后没有可执行内容', async () => {
  const res = await client.get(`/v/${enc('notes/xss.md')}`);
  const prose = res.text.slice(res.text.indexOf('id="content"'), res.text.indexOf('</main>'));
  assert.doesNotMatch(prose, /<script[\s>]/);
  assert.doesNotMatch(prose, /<a [^>]*href="javascript:/i);
  assert.doesNotMatch(prose, /<img [^>]*onerror/i);
  assert.doesNotMatch(prose, /<iframe/);
});

test('HTML 文件：页面用沙箱 iframe，内容带 CSP sandbox，/raw 强制下载', async () => {
  const page = await client.get(`/v/${enc('notes/附件.html')}`);
  assert.match(page.text, /<iframe[^>]*sandbox="allow-same-origin"/);
  const inner = await client.get(`/html/${enc('notes/附件.html')}`);
  assert.match(inner.headers['content-security-policy'], /^sandbox allow-same-origin/);
  assert.doesNotMatch(inner.headers['content-security-policy'], /allow-scripts/);
  const raw = await client.get(`/raw/${enc('notes/附件.html')}`);
  assert.match(raw.headers['content-disposition'], /attachment/);
});

test('SVG：直接打开也在 CSP sandbox 下，脚本不能跑在本站 origin', async () => {
  const res = await client.get(`/raw/${enc('notes/脚本图.svg')}`);
  assert.match(res.headers['content-security-policy'], /^sandbox;/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('其他格式：csv 成表、json 高亮、gbk 正常、图片有缓存头', async () => {
  const csv = await client.get(`/v/${enc('notes/数据.csv')}`);
  assert.match(csv.text, /<td>张,三<\/td>/);
  const json = await client.get(`/v/${enc('notes/配置.json')}`);
  assert.match(json.text, /hljs-attr/);
  const gbk = await client.get(`/v/${enc('notes/gbk.txt')}`);
  assert.match(gbk.text, /北京/);
  const png = await client.get(`/raw/${enc('notes/图片.png')}`);
  assert.equal(png.status, 200);
  assert.match(png.headers['cache-control'], /private, max-age=3600/);
  assert.ok(png.headers.etag);
});

test('下载：走鉴权，带 attachment 和中文文件名', async () => {
  const res = await client.get(`/dl/${enc('notes/数据.csv')}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment/);
});

test('目录树：只含未 deny 条目，子目录按需加载', async () => {
  const home = await client.get('/');
  assert.doesNotMatch(home.text, /工资密码表|\.obsidian|银行支付/);
  const frag = await client.get(`/tree?dir=${encodeURIComponent('notes')}`);
  assert.match(frag.text, /笔记甲/);
  assert.equal((await client.get(`/tree?dir=${encodeURIComponent('../')}`)).status, 403);
});

test('搜索页：中文命中并高亮，结果页没有 deny 内容', async () => {
  const res = await client.get(`/search?q=${encodeURIComponent('工资')}`);
  assert.match(res.text, /<mark>工资<\/mark>/);
  assert.doesNotMatch(res.text, /ZZSECRETZZ/);
});

test('管理：/admin/settings 显示生效的 deny 规则和敏感文件', async () => {
  const res = await client.get('/admin/settings');
  assert.match(res.text, /\.tmp\.\*\//);
  assert.match(res.text, /\*身份证\*/);
  assert.match(res.text, /泄密笔记/);
});

test('管理：POST /admin/reindex 带 CSRF 可用，worker 能完成索引', async () => {
  const csrf = await client.csrf();
  assert.equal((await client.post('/admin/reindex', { _csrf: csrf })).status, 303);
  const runner = createIndexRunner(kb.config);
  const result = await runner.run();
  assert.equal(result.processed, 0);
  assert.ok(result.total > 10);
});

test('AI：只接受单篇，off 时不外发但记日志；敏感文件被阻止', async () => {
  const csrf = await client.csrf();
  const call = (body) => {
    const json = JSON.stringify(body);
    return client.send('/ai/summarize', { method: 'POST', body: json, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Content-Length': Buffer.byteLength(json) } });
  };
  assert.equal((await call({ path: 'notes/笔记甲.md' })).status, 503);
  assert.equal((await call({ path: 'notes/泄密笔记.md' })).status, 403);
  assert.equal((await call({ path: '工资密码表.md' })).status, 404);
  const log = kb.db.prepare('SELECT path, status FROM ai_log ORDER BY id').all();
  assert.deepEqual(log, [{ path: 'notes/笔记甲.md', status: 'off' }, { path: 'notes/泄密笔记.md', status: 'blocked_sensitive' }]);
});

test('reindex 后读路径立刻看到新内容（目录快照随 generation 刷新）', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  fs.writeFileSync(path.join(kb.lib.root, 'notes/新笔记.md'), '# 新笔记\n');
  reindex(kb);
  assert.equal((await client.get(`/v/${enc('notes/新笔记.md')}`)).status, 200);
});
