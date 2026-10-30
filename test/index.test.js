import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createDeny } from '../src/deny.js';
import { openDb } from '../src/db.js';
import { runIndex } from '../src/indexer.js';
import { effectiveDenyGlobs } from '../src/config.js';
import { search } from '../src/search.js';
import { makeLibrary } from './helpers.js';

let lib;
let db;
const deny = createDeny(effectiveDenyGlobs());
const index = (opts = {}) => runIndex({ db, root: lib.root, deny, ...opts });
const file = (p) => db.prepare('SELECT * FROM files WHERE path = ?').get(p);
const write = (rel, text, future = 5000) => {
  const full = path.join(lib.root, rel);
  fs.writeFileSync(full, text);
  const t = new Date(Date.now() + future);
  fs.utimesSync(full, t, t);
};

before(() => {
  lib = makeLibrary();
  db = openDb(lib.dataDir);
  index();
});
after(() => {
  db.close();
  fs.rmSync(lib.base, { recursive: true, force: true });
});

test('入库：frontmatter、标题、摘要、标签', () => {
  const row = file('README.md');
  assert.equal(row.title, '总览页');
  assert.equal(JSON.parse(row.frontmatter_json).status, '进行中');
  assert.match(row.excerpt, /链到 别名甲/);
  const tags = db.prepare('SELECT tag FROM tags WHERE file_id = ? ORDER BY tag').pluck().all(row.id);
  assert.deepEqual(tags.sort(), ['入门', '工作/周报', '项目'].sort());
});

test('入库：双链解析到目标，缺失目标 target_id 为空', () => {
  const links = db.prepare('SELECT l.target_text, l.kind, t.path AS target FROM links l LEFT JOIN files t ON t.id = l.target_id WHERE l.src_id = ?').all(file('README.md').id);
  assert.deepEqual(links.find((l) => l.target_text === '笔记甲'), { target_text: '笔记甲', kind: 'wiki', target: 'notes/笔记甲.md' });
  assert.equal(links.find((l) => l.target_text === '笔记乙').target, 'notes/笔记乙.md');
  assert.equal(links.find((l) => l.target_text === '不存在的笔记').target, null);
});

test('反向链接：能从 target_id 反查到来源', () => {
  const sources = db.prepare(`SELECT f.path FROM links l JOIN files f ON f.id = l.src_id
                              WHERE l.target_id = ? ORDER BY f.path`).pluck().all(file('notes/笔记甲.md').id);
  assert.deepEqual(sources, ['README.md']);
});

test('deny：命中文件只留元数据，内容、链接、标签、全文都不入库', () => {
  for (const p of ['工资密码表.md', '银行支付模板配置.json', 'id-身份证扫描.txt', 'prod.env', 'server.pem', 'MY_TOKEN_NOTES.md']) {
    const row = file(p);
    assert.equal(row.is_denied, 1, p);
    assert.equal(row.title, null);
    assert.equal(row.excerpt, null);
    assert.equal(db.prepare('SELECT COUNT(*) FROM file_text WHERE file_id = ?').pluck().get(row.id), 0);
  }
  for (const marker of ['ZZSECRETZZ', 'ZZBANKZZ', 'ZZIDZZ', 'ZZTOKENZZ']) assert.equal(search(db, { q: marker }).results.length, 0, marker);
});

test('deny：目录被整棵跳过，不留任何记录', () => {
  const n = db.prepare(`SELECT COUNT(*) FROM files WHERE path LIKE '.obsidian/%' OR path LIKE '.git/%' OR path LIKE '.tmp.%' OR path LIKE 'node_modules/%'`).pluck().get();
  assert.equal(n, 0);
});

test('deny：指向被排除文件的双链视同不存在', () => {
  const row = db.prepare("SELECT target_id FROM links WHERE target_text = '工资密码表'").get();
  assert.equal(row.target_id, null);
});

test('内容敏感：文件名正常但正文含口令的被打标，摘要清空', () => {
  const row = file('notes/泄密笔记.md');
  assert.equal(row.is_sensitive, 1);
  assert.equal(row.excerpt, '');
  assert.match(row.sensitive_kinds, /password/);
  assert.equal(file('notes/笔记甲.md').is_sensitive, 0);
});

test('增量：无变化时什么都不处理', () => {
  const r = index();
  assert.equal(r.processed, 0);
  assert.equal(r.removed, 0);
});

test('增量：只处理变化的文件，并更新内容与全文', () => {
  write('notes/笔记乙.md', '# 改过了\n\n新增关键词 独角兽计划\n');
  const r = index();
  assert.equal(r.processed, 1);
  assert.equal(file('notes/笔记乙.md').title, '改过了');
  assert.equal(search(db, { q: '独角兽' }).results.length, 1);
  assert.equal(search(db, { q: '工资核算' }).results.length, 0);
});

test('增量：删除文件后记录、全文、链接一起清理，反向悬空', () => {
  fs.rmSync(path.join(lib.root, 'notes/配置.json'));
  const r = index();
  assert.equal(r.removed, 1);
  assert.equal(file('notes/配置.json'), undefined);
  assert.equal(search(db, { q: 'demo' }).results.filter((x) => x.path === 'notes/配置.json').length, 0);
});

test('增量：新文件让之前悬空的双链自动解析', () => {
  const before = db.prepare("SELECT target_id FROM links WHERE target_text = '不存在的笔记'").get();
  assert.equal(before.target_id, null);
  write('notes/不存在的笔记.md', '# 现在有了\n');
  index();
  const row = db.prepare("SELECT target_id FROM links WHERE target_text = '不存在的笔记'").get();
  assert.equal(row.target_id, file('notes/不存在的笔记.md').id);
});

test('规则变更：新规则会清掉已入库内容，mtime 没变也一样', () => {
  const stricter = createDeny([...deny.globs, '笔记甲.md']);
  assert.ok(search(db, { q: '合同条款' }).results.length > 0);
  const r = runIndex({ db, root: lib.root, deny: stricter });
  assert.ok(r.processed > 1);
  assert.equal(file('notes/笔记甲.md').is_denied, 1);
  assert.equal(search(db, { q: '合同条款' }).results.length, 0);
  index();
  assert.ok(search(db, { q: '合同条款' }).results.length > 0);
});

test('搜索：两字中文词命中，<mark> 高亮，结果 HTML 已转义', () => {
  write('notes/高亮.md', '# 高亮测试\n\n前文 <b>合同</b> 后文\n');
  index();
  const { results } = search(db, { q: '合同' });
  assert.ok(results.some((r) => r.snippet.includes('<mark>合同</mark>')));
  assert.ok(!results.some((r) => r.snippet.includes('<b>')));
});

test('搜索：相关度标题优先，可按目录和标签过滤', () => {
  write('notes/合同模板.md', '# 合同模板\n\n内容\n');
  index();
  const { results } = search(db, { q: '合同' });
  assert.equal(results[0].path, 'notes/合同模板.md');
  assert.ok(search(db, { q: '说明', dir: 'share' }).results.every((r) => r.path.startsWith('share/')));
  assert.deepEqual(search(db, { tag: '项目' }).results.map((r) => r.path), ['README.md']);
});

test('搜索：内容敏感文件能搜到但摘要隐藏', () => {
  const hit = search(db, { q: 'hunter2' }).results[0];
  assert.equal(hit.path, 'notes/泄密笔记.md');
  assert.doesNotMatch(hit.snippet, /hunter2/);
});

test('搜索：FTS 语法字符不会报错', () => {
  for (const q of ['"', 'a"b', 'NEAR(', '*', 'a AND', '(((', ':']) assert.doesNotThrow(() => search(db, { q }), q);
});
