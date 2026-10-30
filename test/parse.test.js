import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMarkdown, parseWikiInner, renderMarkdown, splitFrontmatter } from '../src/markdown.js';
import { createResolver } from '../src/catalog.js';
import { parseCsv } from '../src/preview.js';
import { scanSecrets } from '../src/secrets.js';
import { parseTerms, toFtsQuery } from '../src/search.js';
import { countWords, decodeText, tokenizeForFts } from '../src/text.js';

test('frontmatter：解析 YAML，正文被切开', () => {
  const { data, body } = splitFrontmatter('---\ntitle: 标题\ntags:\n  - a\n---\n正文');
  assert.deepEqual(data, { title: '标题', tags: ['a'] });
  assert.equal(body, '正文');
});

test('frontmatter：损坏的 YAML 不抛错', () => {
  const { data } = splitFrontmatter('---\na: b: c\n  - [x\n---\n正文');
  assert.equal(data, null);
});

test('wiki 语法：别名、锚点、组合', () => {
  assert.deepEqual(parseWikiInner('笔记|别名', false), { file: '笔记', anchor: null, alias: '别名', embed: false });
  assert.deepEqual(parseWikiInner('笔记#标题', false), { file: '笔记', anchor: '标题', alias: null, embed: false });
  assert.deepEqual(parseWikiInner('a/笔记#标题|别名', true), { file: 'a/笔记', anchor: '标题', alias: '别名', embed: true });
  assert.deepEqual(parseWikiInner('笔记\\|别名', false), { file: '笔记', anchor: null, alias: '别名', embed: false });
});

test('analyze：标题优先级、双链、嵌入、标签', () => {
  const a = analyzeMarkdown('---\ntitle: FM 标题\ntags: [x, "#y"]\n---\n# H1\n[[甲]] ![[乙.png]] #内联 [m](dir/c.md) ![i](a%20b.png)\n', '回退');
  assert.equal(a.title, 'FM 标题');
  assert.deepEqual(a.links, [
    { target_text: '甲', kind: 'wiki' }, { target_text: '乙.png', kind: 'embed' },
    { target_text: 'dir/c.md', kind: 'md' }, { target_text: 'a b.png', kind: 'image' },
  ]);
  assert.deepEqual(a.tags.sort(), ['x', 'y', '内联'].sort());
  assert.equal(analyzeMarkdown('# H1\n正文', '回退').title, 'H1');
  assert.equal(analyzeMarkdown('正文', '回退').title, '回退');
});

test('analyze：代码块里的 [[x]] 和 #y 不算；纯数字不算标签', () => {
  const a = analyzeMarkdown('```\n[[假]] #假\n```\n\n`[[也假]]` #123 正文 a#b\n', 't');
  assert.deepEqual(a.links, []);
  assert.deepEqual(a.tags, []);
});

test('callout：解析类型与标题，渲染成提示块', () => {
  const src = '> [!warning] 小心\n> 内容在这\n';
  assert.deepEqual(analyzeMarkdown(src, 't').callouts, [{ type: 'warning', title: '小心' }]);
  const { html } = renderMarkdown(src);
  assert.match(html, /class="callout callout-warning"/);
  assert.match(html, /callout-title">小心/);
  assert.match(html, /内容在这/);
  assert.doesNotMatch(html, /\[!warning\]/);
});

test('渲染：GFM 表格、任务列表、删除线、代码高亮', () => {
  const { html } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 未完成\n\n~~删~~\n\n```js\nconst a = 1;\n```\n');
  assert.match(html, /<table>/);
  assert.match(html, /<s>删<\/s>|<del>删<\/del>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
  assert.match(html, /hljs-keyword/);
});

test('md 注入：script / 事件属性 / javascript: / iframe 全部失效', () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n\n[a](javascript:alert(1))\n\n[b](JaVa\tScript:alert(1))\n\n<a href="javascript:alert(2)">c</a>\n\n<a href="java&#10;script:alert(3)">d</a>\n\n<img src=x onerror=alert(4)>\n\n<iframe src="https://e"></iframe>\n\n<svg onload=alert(5)></svg>\n\n<form action="/admin"><button>e</button></form>\n');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="[^"]*script:/i);
  assert.doesNotMatch(html, /<[a-z]+[^>]*\son(error|load)=/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /<svg/i);
});

test('md 注入：wiki 别名里的 HTML 被转义', () => {
  const ctx = {
    resolveLink: () => ({ path: 'a.md', ext: 'md', name: 'a.md' }), resolveRelative: () => null, href: () => '/v/a.md',
    raw: () => '#', tagHref: () => '#', readNote: () => null,
  };
  const { html } = renderMarkdown('[[a|<img src=x onerror=alert(1)>]]', { ctx });
  assert.doesNotMatch(html, /<img/);
});

test('解析器：别名优先同目录，其次最短路径；大小写不敏感', () => {
  const row = (p) => ({ id: p, path: p, name: p.split('/').pop(), dir: p.split('/').slice(0, -1).join('/'), ext: p.split('.').pop() });
  const r = createResolver(['a/x/笔记.md', 'b/笔记.md', 'c/Note.md', 'pic.png'].map(row));
  assert.equal(r.resolveWiki('笔记', 'a/x/当前.md').path, 'a/x/笔记.md');
  assert.equal(r.resolveWiki('笔记', 'z/当前.md').path, 'b/笔记.md');
  assert.equal(r.resolveWiki('x/笔记', 'z/当前.md').path, 'a/x/笔记.md');
  assert.equal(r.resolveWiki('note', 'z/a.md').path, 'c/Note.md');
  assert.equal(r.resolveWiki('pic.png', 'z/a.md').path, 'pic.png');
  assert.equal(r.resolveWiki('不存在', 'z/a.md'), null);
  assert.equal(r.resolveRelative('../b/笔记.md', 'a/x.md').path, 'b/笔记.md');
});

test('搜索词：用户输入不会变成 FTS 语法', () => {
  assert.equal(toFtsQuery(parseTerms('合同')), '"合 同"');
  assert.equal(toFtsQuery(parseTerms('foo"bar OR')), '"foo"* "bar"* "OR"*');
  assert.equal(tokenizeForFts('abc合同'), 'abc 合  同 ');
});

test('文本：GBK 回退解码、中英字数统计', () => {
  assert.equal(decodeText(Buffer.from('b1b1bea9', 'hex')), '北京');
  assert.equal(countWords('中文两字 and two'), 6);
});

test('CSV：引号、逗号、行数上限', () => {
  assert.deepEqual(parseCsv('a,b\n"x,1","y""z"\n').rows, [['a', 'b'], ['x,1', 'y"z']]);
  const { rows, truncated } = parseCsv('a\n'.repeat(600));
  assert.equal(rows.length, 500);
  assert.equal(truncated, true);
});

test('内容敏感扫描：命中口令/密钥，普通文本不命中', () => {
  assert.deepEqual(scanSecrets('数据库密码：abc123'), ['password']);
  assert.deepEqual(scanSecrets('API_KEY=xyz'), ['api-key']);
  assert.ok(scanSecrets('-----BEGIN RSA PRIVATE KEY-----').includes('private-key'));
  assert.deepEqual(scanSecrets('我们讨论了密码学和 secret santa'), []);
});
