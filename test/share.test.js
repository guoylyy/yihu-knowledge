import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client, enc, startServer } from './helpers.js';

let kb;
let admin;
before(async () => {
  kb = await startServer();
  admin = new Client(kb.port);
  await admin.login();
});
after(() => kb.stop());

async function share(fields) {
  const res = await admin.createShare(fields);
  assert.equal(res.status, 303, res.text.slice(0, 200));
  const id = Number(res.headers.location.split('/').pop());
  const row = kb.db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
  return { ...row, url: `/s/${row.token}` };
}
const visits = (id) => kb.db.prepare('SELECT * FROM visits WHERE share_id = ? ORDER BY id').all(id);

test('分享：token 是 32 字节随机值，默认 7 天，链接基于 KB_BASE_URL', async () => {
  const s = await share({ path: 'share/公开说明.md' });
  assert.equal(Buffer.from(s.token, 'base64url').length, 32);
  assert.ok(Math.abs(s.expires_at - s.created_at - 7 * 864e5) < 1000);
  const detail = await admin.get(`/admin/shares/${s.id}`);
  assert.match(detail.text, new RegExp(`https://kb\\.example\\.com/s/${s.token}`));
  assert.match(detail.text, /<svg/);
});

test('分享流程：匿名访问 → 写访问记录 → 后台可见 → 过期后拒绝', async () => {
  const s = await share({ path: 'share/公开说明.md' });
  const anon = new Client(kb.port, '203.0.113.9');
  const page = await anon.get(s.url, { headers: { Referer: 'https://chat.example/x' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /来自 <strong>测试主人<\/strong> 的分享/);
  assert.doesNotMatch(page.text, /\/admin|name="q"|ai-summary/);
  const [v] = visits(s.id);
  assert.equal(v.ip, '203.0.113.9');
  assert.equal(v.ua, 'kb-test-agent');
  assert.equal(v.referer, 'https://chat.example/x');
  assert.equal(v.kind, 'view');
  assert.equal(v.path, 'share/公开说明.md');
  const detail = await admin.get(`/admin/shares/${s.id}`);
  assert.match(detail.text, /203\.0\.113\.9/);
  assert.match(detail.text, /kb-test-agent/);
  assert.match(detail.text, /class="bar"/);

  kb.db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, s.id);
  const expired = await anon.get(s.url);
  assert.equal(expired.status, 410);
  assert.match(expired.text, /已过期/);
  assert.doesNotMatch(expired.text, /公开说明|可以分享/);
  assert.equal((await anon.get(`${s.url}/download`)).status, 410);
  assert.equal((await anon.get(`${s.url}/raw/${enc('notes/图片.png')}`)).status, 410);
});

test('token 无效：格式错误和不存在都是 404，无路径信息', async () => {
  const anon = new Client(kb.port, '203.0.113.10');
  for (const t of ['abc', 'A'.repeat(43), '../../v/README.md']) {
    const res = await anon.get(`/s/${t}`);
    assert.ok([404].includes(res.status), t);
    assert.doesNotMatch(res.text, /README|总览/);
  }
  assert.match((await anon.get(`/s/${'A'.repeat(43)}`)).text, /链接无效/);
});

test('取消分享后立即失效', async () => {
  const s = await share({ path: 'share/公开二.md' });
  const csrf = await admin.csrf();
  await admin.post(`/admin/shares/${s.id}/revoke`, { _csrf: csrf });
  const res = await new Client(kb.port, '203.0.113.11').get(s.url);
  assert.equal(res.status, 410);
  assert.match(res.text, /已取消/);
});

test('访问密码：未解锁不露内容，错误有提示，正确后可读，下载同样受保护', async () => {
  const s = await share({ path: 'share/公开说明.md', password: 'open-sesame' });
  const anon = new Client(kb.port, '203.0.113.12');
  const gate = await anon.get(s.url);
  assert.equal(gate.status, 401);
  assert.match(gate.text, /需要访问密码/);
  assert.doesNotMatch(gate.text, /公开说明/);
  assert.equal((await anon.get(`${s.url}/download`)).status, 401);
  assert.equal(visits(s.id).length, 0);
  const wrong = await anon.post(`${s.url}/unlock`, { password: 'nope' });
  assert.equal(wrong.status, 403);
  assert.match(wrong.text, /访问密码不正确/);
  assert.equal((await anon.post(`${s.url}/unlock`, { password: 'open-sesame' })).status, 303);
  const ok = await anon.get(s.url);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /可以分享的内容/);
  assert.equal((await anon.get(`${s.url}/download`)).status, 200);
  assert.ok(!s.password_hash.includes('open-sesame'));
});

test('访问密码：错 5 次按分享 + IP 锁定', async () => {
  const s = await share({ path: 'share/公开二.md', password: 'open-sesame' });
  const anon = new Client(kb.port, '203.0.113.13');
  for (let i = 0; i < 4; i++) assert.equal((await anon.post(`${s.url}/unlock`, { password: 'x' })).status, 403);
  assert.equal((await anon.post(`${s.url}/unlock`, { password: 'x' })).status, 403);
  assert.equal((await anon.post(`${s.url}/unlock`, { password: 'open-sesame' })).status, 429);
});

test('范围：单文件分享看不到别的文件，链接变灰，嵌入图片可见', async () => {
  const s = await share({ path: 'share/公开说明.md' });
  const anon = new Client(kb.port, '203.0.113.14');
  const page = await anon.get(s.url);
  assert.match(page.text, /wikilink-missing[^>]*>公开二/);
  assert.doesNotMatch(page.text, /href="\/v\//);
  assert.equal((await anon.get(`${s.url}/v/${enc('README.md')}`)).status, 404);
  assert.equal((await anon.get(`${s.url}/v/${enc('share/公开二.md')}`)).status, 404);
  assert.equal((await anon.get(`${s.url}/raw/${enc('notes/图片.png')}`)).status, 200);
  assert.equal((await anon.get(`${s.url}/download?path=${encodeURIComponent('README.md')}`)).status, 404);
});

test('范围：分享内路径穿越被拒绝，不泄露目标是否存在', async () => {
  const s = await share({ path: 'share' });
  const anon = new Client(kb.port, '203.0.113.15');
  for (const a of ['../README.md', '%2e%2e%2fREADME.md', '..%2f..%2f..%2fetc%2fpasswd', 'share/../README.md', '/etc/passwd']) {
    const res = await anon.get(`${s.url}/v/${a}`);
    assert.ok([403, 404].includes(res.status), `${a} -> ${res.status}`);
    assert.doesNotMatch(res.text, /总览页/);
  }
  assert.equal((await anon.get(`${s.url}/d/notes`)).status, 404);
  assert.equal((await anon.get(`${s.url}/tree?dir=notes`)).status, 404);
  assert.equal((await anon.get(`${s.url}/download?path=${encodeURIComponent('../README.md')}`)).status, 403);
});

test('目录分享：敏感文件被排除，子目录可浏览，只有范围内反向链接', async () => {
  const s = await share({ path: 'share' });
  const anon = new Client(kb.port, '203.0.113.16');
  const page = await anon.get(s.url);
  assert.match(page.text, /公开说明/);
  assert.doesNotMatch(page.text, /运维/);
  assert.equal((await anon.get(`${s.url}/v/${enc('share/运维.md')}`)).status, 404);
  assert.equal((await anon.get(`${s.url}/download?path=${encodeURIComponent('share/运维.md')}`)).status, 404);
  assert.equal((await anon.get(`${s.url}/d/${enc('share/子目录')}`)).status, 200);
  const doc = await anon.get(`${s.url}/v/${enc('share/公开二.md')}`);
  assert.match(doc.text, /反向链接/);
  assert.match(doc.text, new RegExp(`/s/${s.token}/v/`));
  assert.doesNotMatch(doc.text, /href="\/v\//);
  const inner = await anon.get(`${s.url}/v/${enc('share/公开说明.md')}`);
  assert.match(inner.text, /wikilink-missing[^>]*>README/);
});

test('目录打包：zip 含范围内文件，不含敏感文件，记 download', async () => {
  const s = await share({ path: 'share' });
  const anon = new Client(kb.port, '203.0.113.17');
  const res = await anon.get(`${s.url}/download`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /\.zip/);
  const { unzipSync } = await import('fflate');
  const names = Object.keys(unzipSync(new Uint8Array(res.buffer)));
  assert.deepEqual(names.sort(), ['公开二.md', '公开说明.md', '子目录/深层.txt'].sort());
  assert.equal(visits(s.id).at(-1).kind, 'download');
});

test('创建校验：整库、deny、不存在、敏感文件都被拒绝', async () => {
  for (const path of ['', '/', '工资密码表.md', '.git/config', '不存在.md', 'notes/泄密笔记.md', '../outside.md']) {
    const res = await admin.createShare({ path });
    assert.equal(res.status, 400, path);
  }
  assert.equal((await admin.createShare({ path: 'README.md', days: '9999' })).status, 400);
});

test('强制分享：敏感单文件需显式勾选，且记录在案', async () => {
  const s = await share({ path: 'notes/泄密笔记.md', allow_sensitive: '1' });
  assert.equal(s.allow_sensitive, 1);
  assert.equal((await new Client(kb.port, '203.0.113.18').get(s.url)).status, 200);
});

test('分享后文件变成敏感：下一次索引起自动不可访问', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const full = path.join(kb.lib.root, 'share/公开二.md');
  const s = await share({ path: 'share/公开二.md' });
  const anon = new Client(kb.port, '203.0.113.19');
  assert.equal((await anon.get(s.url)).status, 200);
  fs.writeFileSync(full, '# 公开二\n\nsecret: abc123\n');
  const { reindex } = await import('./helpers.js');
  reindex(kb, { full: true });
  assert.equal((await anon.get(s.url)).status, 404);
});

test('资源请求不计入访问次数', async () => {
  const s = await share({ path: 'share/公开说明.md' });
  const anon = new Client(kb.port, '203.0.113.20');
  await anon.get(s.url);
  await anon.get(`${s.url}/raw/${enc('notes/图片.png')}`);
  const row = kb.db.prepare(`SELECT COUNT(CASE WHEN kind = 'view' THEN 1 END) v, COUNT(CASE WHEN kind = 'asset' THEN 1 END) a FROM visits WHERE share_id = ?`).get(s.id);
  assert.deepEqual(row, { v: 1, a: 1 });
});
