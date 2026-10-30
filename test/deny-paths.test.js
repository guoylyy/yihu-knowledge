import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_DENY, effectiveDenyGlobs } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { decodeRel, normalizeRel, PathRejected, resolveInside } from '../src/paths.js';
import { Client, enc, makeLibrary, request, startServer } from './helpers.js';

const deny = createDeny(DEFAULT_DENY);

test('deny：目录规则命中任意层级', () => {
  for (const p of ['.obsidian/app.json', 'a/.git/config', 'b/.tmp.driveupload/x.md', 'node_modules/x/i.js']) assert.ok(deny.isDenied(p), p);
});

test('deny：文件规则大小写不敏感，覆盖中文模式', () => {
  for (const p of ['a/prod.env', '.env', 'k.key', 'c.PEM', 'x密码本.md', 'My_Password.txt', 'SECRET-notes.md', 'api-token.md', '银行支付模板配置.json', 'a/身份证正面.png']) {
    assert.ok(deny.isDenied(p), p);
  }
  for (const p of ['普通笔记.md', 'a/工资表.xlsx', 'keynote.md', '中国银行回单.pdf']) assert.ok(!deny.isDenied(p), p);
});

test('deny：匹配名字的目录，其内容一并排除', () => {
  assert.ok(deny.isDenied('密码本/a.md'));
  assert.ok(deny.isDenied('密码本', { isDir: true }));
});

test('KB_DENY_GLOBS：追加规则、! 移除默认规则，默认规则不被整体覆盖', () => {
  const globs = effectiveDenyGlobs('*.bak, 私人/,!*token*');
  assert.ok(globs.includes('*.bak') && globs.includes('私人/') && globs.includes('*.pem'));
  assert.ok(!globs.includes('*token*'));
  const d = createDeny(globs);
  assert.ok(d.isDenied('a/x.bak') && d.isDenied('私人/a.md') && !d.isDenied('token.md'));
});

test('normalizeRel：拒绝穿越、绝对路径、控制字符、反斜杠', () => {
  for (const bad of ['../a', 'a/../b', 'a/..', '/etc/passwd', 'C:/x', 'a\\..\\b', 'a\0b', './a', 'a//b', '']) {
    assert.throws(() => normalizeRel(bad), PathRejected, JSON.stringify(bad));
  }
  assert.equal(normalizeRel('a/b 中文.md'), 'a/b 中文.md');
});

test('decodeRel：编码绕过同样被拒绝', () => {
  for (const bad of ['/%2e%2e%2fsecret', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/x', '/a%5c..%5cb', '/%00', '/%E0%A4%A']) {
    assert.throws(() => decodeRel(bad), PathRejected, bad);
  }
});

test('resolveInside：符号链接文件与目录被拒绝，不存在返回 null', () => {
  const lib = makeLibrary();
  assert.throws(() => resolveInside(lib.root, 'link-out.md'), PathRejected);
  assert.throws(() => resolveInside(lib.root, 'link-dir/outside.md'), PathRejected);
  assert.equal(resolveInside(lib.root, 'nope.md'), null);
  assert.equal(resolveInside(lib.root, 'README.md'), path.join(lib.root, 'README.md'));
  fs.rmSync(lib.base, { recursive: true, force: true });
});

let kb;
let client;
before(async () => {
  kb = await startServer();
  client = new Client(kb.port);
  await client.login();
});
after(() => kb.stop());

const ATTACKS = [
  '../outside.md', '../../../../etc/passwd', '%2e%2e/outside.md', '%2e%2e%2foutside.md', '..%2f..%2f..%2fetc%2fpasswd',
  '%252e%252e%252foutside.md', '/etc/passwd', '%2Fetc%2Fpasswd', 'notes/../../outside.md', 'notes%2f..%2f..%2foutside.md', '..%5coutside.md',
];

for (const route of ['v', 'raw', 'dl', 'html']) {
  test(`路径穿越：已登录访问 /${route}/ 的所有变体都返回 403/404 且无内容`, async () => {
    for (const attack of ATTACKS) {
      const res = await client.get(`/${route}/${attack}`);
      assert.ok([403, 404].includes(res.status), `${attack} -> ${res.status}`);
      assert.doesNotMatch(res.text, /OUTSIDE-CONTENT|root:/, attack);
    }
  });
}

test('路径穿越：符号链接从未入库，直接访问也拿不到内容', async () => {
  assert.equal(kb.db.prepare("SELECT COUNT(*) FROM files WHERE path LIKE 'link-%'").pluck().get(), 0);
  for (const p of ['/v/link-out.md', '/raw/link-out.md', '/dl/link-dir/outside.md']) {
    const res = await client.get(p);
    assert.ok([403, 404].includes(res.status), p);
    assert.doesNotMatch(res.text, /OUTSIDE-CONTENT/);
  }
});

test('路径穿越：索引后被替换成符号链接的文件也被拒绝', async () => {
  const victim = path.join(kb.lib.root, 'notes/配置.json');
  const backup = fs.readFileSync(victim);
  fs.rmSync(victim);
  fs.symlinkSync(path.join(kb.lib.base, 'outside.md'), victim);
  const res = await client.get(`/dl/${enc('notes/配置.json')}`);
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, /OUTSIDE-CONTENT/);
  fs.rmSync(victim);
  fs.writeFileSync(victim, backup);
});

test('deny 文件：/v /raw /dl 与存在性探测结果一致（都是 404）', async () => {
  const denied = await client.get(`/v/${enc('工资密码表.md')}`);
  const missing = await client.get(`/v/${enc('根本不存在.md')}`);
  assert.equal(denied.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(denied.text, missing.text);
  for (const route of ['raw', 'dl', 'html']) assert.equal((await client.get(`/${route}/${enc('工资密码表.md')}`)).status, 404);
  assert.equal((await request(kb.port, '/v/.git/config', { headers: { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } })).status, 404);
});

test('大小写绕过：改变后缀大小写不能绕过索引白名单', async () => {
  assert.equal((await client.get('/raw/SERVER.PEM')).status, 404);
  assert.equal((await client.get('/dl/README.MD')).status, 404);
});
