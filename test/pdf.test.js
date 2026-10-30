import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { indexPdfs, extractPdfText, PDF_MAX_PAGES } from '../src/pdf-index.js';
import { search } from '../src/search.js';
import { Client, enc, reindex, startServer } from './helpers.js';
import { makePdf } from './pdf-fixture.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pdf-'));
const write = (name, buf) => { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; };
const hits = (kb, q) => search(kb.db, { q }).results.map((r) => r.path);
const info = (kb, rel) => JSON.parse(kb.db.prepare('SELECT pdf_info FROM files WHERE path = ?').pluck().get(rel));
let s;
let client;

const FILES = {
  'docs/有字.pdf': makePdf(['alphatoken first page', 'second page words']),
  'docs/中文.pdf': makePdf([{ cjk: '增值税电子普通发票回单' }]),
  'docs/扫描件.pdf': makePdf([null, null]),
  'docs/加密.pdf': makePdf(['lockedword'], { encrypted: true }),
  'docs/坏文件.pdf': Buffer.from('%PDF-1.4 this is not really a pdf'),
  'docs/长文档.pdf': makePdf(Array.from({ length: PDF_MAX_PAGES + 10 }, (_, i) => `longdoc pagemark${i + 1}`)),
  'docs/含密钥.pdf': makePdf(['password: hunter2-super']),
  '工资密码表.pdf': makePdf(['deniedsecretword']),
};

before(async () => {
  s = await startServer();
  for (const [rel, buf] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(s.lib.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.lib.root, rel), buf);
  }
  reindex(s);
  s.report = await indexPdfs({ db: s.db, root: s.config.root });
  client = new Client(s.port);
  await client.login();
});

after(async () => {
  await s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('抽取：有文字层的按页取文字', async () => {
  const r = await extractPdfText(write('a.pdf', makePdf(['hello world', 'second page'])));
  assert.equal(r.pages, 2);
  assert.equal(r.text_layer, true);
  assert.equal(r.truncated, false);
  assert.match(r.text, /hello world/);
  assert.match(r.text, /second page/);
});

test('抽取：无嵌入字体的中文靠 CMap 解码，不乱码', async () => {
  const r = await extractPdfText(write('b.pdf', makePdf([{ cjk: '中文回单' }])));
  assert.equal(r.text.trim(), '中文回单');
});

test('抽取：没有字的页面 text_layer 为 false，不报错', async () => {
  const r = await extractPdfText(write('c.pdf', makePdf([null, null])));
  assert.equal(r.pages, 2);
  assert.equal(r.text_layer, false);
  assert.equal(r.text.trim(), '');
});

test('抽取：超过页数上限只读前面，标记截断', async () => {
  const r = await extractPdfText(write('d.pdf', makePdf(Array.from({ length: 8 }, (_, i) => `mark${i + 1}x`))), { maxPages: 3 });
  assert.equal(r.pages, 8);
  assert.equal(r.read, 3);
  assert.equal(r.truncated, true);
  assert.match(r.text, /mark3x/);
  assert.doesNotMatch(r.text, /mark4x/);
});

test('抽取：文本字节上限生效，中文不留半个字', async () => {
  const f = write('e.pdf', makePdf([{ cjk: '中'.repeat(40) }, { cjk: '文'.repeat(40) }]));
  const r = await extractPdfText(f, { maxBytes: 50 });
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= 50);
  assert.doesNotMatch(r.text, /�/);
});

test('索引：有文字层的正文进搜索，英文中文都能搜到', () => {
  assert.deepEqual(hits(s, 'alphatoken'), ['docs/有字.pdf']);
  assert.deepEqual(hits(s, '电子普通发票'), ['docs/中文.pdf']);
  assert.equal(info(s, 'docs/有字.pdf').text_layer, true);
  assert.equal(info(s, 'docs/有字.pdf').pages, 2);
  assert.match(s.db.prepare("SELECT excerpt FROM files WHERE path = 'docs/有字.pdf'").pluck().get(), /alphatoken/);
});

test('索引：扫描件标记 text_layer:false，不影响其他文件', () => {
  assert.equal(info(s, 'docs/扫描件.pdf').text_layer, false);
  assert.equal(s.report.noText, 1);
});

test('索引：超过 50 页只抽前 50 页，报告里写明已截断', () => {
  assert.deepEqual(hits(s, 'pagemark50'), ['docs/长文档.pdf']);
  assert.deepEqual(hits(s, 'pagemark51'), []);
  assert.equal(info(s, 'docs/长文档.pdf').read, PDF_MAX_PAGES);
  assert.equal(info(s, 'docs/长文档.pdf').truncated, true);
  assert.equal(s.report.truncated, 1);
  assert.deepEqual(s.report.truncatedExamples, ['docs/长文档.pdf']);
});

test('索引：加密、损坏的 PDF 记下原因，不算扫描件也不中断', () => {
  assert.equal(info(s, 'docs/加密.pdf').error, 'encrypted');
  assert.equal(info(s, 'docs/坏文件.pdf').error, 'unreadable');
  assert.equal(s.report.encrypted, 1);
  assert.equal(s.report.failed, 1);
});

test('索引：deny 命中的 PDF 不打开、不入库', () => {
  assert.deepEqual(hits(s, 'deniedsecretword'), []);
  assert.equal(s.db.prepare("SELECT pdf_info FROM files WHERE path = '工资密码表.pdf'").pluck().get(), null);
});

test('索引：PDF 正文里的密钥标记敏感，摘要清空', () => {
  const row = s.db.prepare("SELECT is_sensitive, excerpt FROM files WHERE path = 'docs/含密钥.pdf'").get();
  assert.equal(row.is_sensitive, 1);
  assert.equal(row.excerpt, '');
});

test('索引：增量跳过没变的，改过的重抽，全量重建后文字还在', async () => {
  const twice = await indexPdfs({ db: s.db, root: s.config.root });
  assert.equal(twice.processed, 0);
  const rel = 'docs/有字.pdf';
  const full = path.join(s.lib.root, rel);
  fs.writeFileSync(full, makePdf(['betatoken replaced']));
  reindex(s);
  assert.equal((await indexPdfs({ db: s.db, root: s.config.root })).processed, 1);
  assert.deepEqual(hits(s, 'betatoken'), [rel]);
  assert.deepEqual(hits(s, 'alphatoken'), []);
  reindex(s, { full: true });
  await indexPdfs({ db: s.db, root: s.config.root });
  assert.deepEqual(hits(s, 'betatoken'), [rel]);
  fs.writeFileSync(full, FILES[rel]);
  reindex(s);
  await indexPdfs({ db: s.db, root: s.config.root });
});

test('索引：worker 路径走完两个阶段，报告带 PDF 小结', async () => {
  const report = await s.indexer.run({ full: true });
  assert.equal(report.pdf.total, Object.keys(FILES).length - 1);
  assert.equal(report.pdf.truncated, 1);
  assert.deepEqual(hits(s, 'alphatoken'), ['docs/有字.pdf']);
  const admin = await client.get('/admin');
  assert.match(admin.text, /PDF 已截断/);
  assert.match(admin.text, /长文档\.pdf/);
});

test('页面：PDF 用内置阅读器，顶部一行，不再有 iframe 和手机下载墙', async () => {
  const page = await client.get(`/v/${enc('docs/有字.pdf')}`, { headers: { 'User-Agent': 'iPhone Mobi' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /id="pdfv"/);
  assert.match(page.text, /data-src="\/raw\/docs\//);
  assert.match(page.text, /assets\/pdf-viewer\.mjs/);
  assert.match(page.text, /class="doc-head"/);
  assert.doesNotMatch(page.text, /<iframe/);
  assert.doesNotMatch(page.text, /手机浏览器不便内嵌/);
  assert.doesNotMatch(page.text, /没有文字层/);
});

test('页面：扫描件提示没有文字层；加密文件不误报成扫描件', async () => {
  const scan = await client.get(`/v/${enc('docs/扫描件.pdf')}`);
  assert.match(scan.text, /这份 PDF 没有文字层（扫描件），只能看图，暂不能搜索或让 AI 读/);
  assert.doesNotMatch(scan.text, /id="ai-summary"/);
  const locked = await client.get(`/v/${enc('docs/加密.pdf')}`);
  assert.doesNotMatch(locked.text, /没有文字层/);
});

test('AI：有文字层的 PDF 能读索引正文，扫描件和敏感件不能', async () => {
  const page = await client.get(`/v/${enc('docs/有字.pdf')}`);
  assert.match(page.text, /id="ai-summary"/);
  const csrf = page.text.match(/data-csrf="([^"]+)"/)[1];
  const ask = (rel) => client.send('/ai/summarize', {
    method: 'POST', body: JSON.stringify({ path: rel }),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  });
  assert.equal((await ask('docs/有字.pdf')).status, 503); // 能走到 AI 通道，测试环境 AI 关闭
  assert.equal((await ask('docs/扫描件.pdf')).status, 404);
  assert.equal((await ask('docs/含密钥.pdf')).status, 403);
});

test('Range：bytes=0-1023 返回 206 和 Content-Range', async () => {
  const size = FILES['docs/长文档.pdf'].length;
  const res = await client.get(`/raw/${enc('docs/长文档.pdf')}`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 0-1023/${size}`);
  assert.equal(res.buffer.length, 1024);
  assert.deepEqual(res.buffer, FILES['docs/长文档.pdf'].subarray(0, 1024));
});

test('Range：整文件响应声明 Accept-Ranges，超出范围返回 416', async () => {
  const url = `/raw/${enc('docs/长文档.pdf')}`;
  const whole = await client.get(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.match(whole.headers['content-type'], /application\/pdf/);
  assert.equal((await client.get(url, { headers: { Range: 'bytes=99999999-' } })).status, 416);
});

test('If-None-Match 命中返回 304', async () => {
  const url = `/raw/${enc('docs/有字.pdf')}`;
  const { headers } = await client.get(url);
  assert.ok(headers.etag);
  const res = await client.get(url, { headers: { 'If-None-Match': headers.etag } });
  assert.equal(res.status, 304);
  assert.equal(res.buffer.length, 0);
});

test('权限：未登录访问 /raw 和 /preview 都被登录墙拦下', async () => {
  const anon = new Client(s.port, '10.0.0.77');
  for (const target of [`/raw/${enc('docs/有字.pdf')}`, `/preview/${enc('docs/有字.pdf')}`, `/preview-status/${enc('docs/有字.pdf')}`]) {
    const res = await anon.get(target);
    assert.equal(res.status, 302, target);
    assert.match(res.headers.location, /\/login/);
  }
  assert.equal((await anon.get(`/raw/${enc('docs/有字.pdf')}`, { headers: { Range: 'bytes=0-10' } })).status, 302);
});

test('分享：阅读器的 Range 分段请求不刷访问记录', async () => {
  const created = await client.createShare({ path: 'docs/有字.pdf' });
  assert.equal(created.status, 303);
  const share = s.db.prepare("SELECT * FROM shares WHERE path = 'docs/有字.pdf'").get();
  const visitor = new Client(s.port, '10.0.0.88');
  const url = `/s/${share.token}/raw/${enc('docs/有字.pdf')}`;
  await visitor.get(url);
  await visitor.get(url, { headers: { Range: 'bytes=0-100' } });
  await visitor.get(url, { headers: { Range: 'bytes=101-200' } });
  const assets = s.db.prepare("SELECT COUNT(*) FROM visits WHERE share_id = ? AND kind = 'asset'").pluck().get(share.id);
  assert.equal(assets, 1);
});

test('上限：超过预览体积不渲染，只给下载', async () => {
  const small = await startServer({ previewMaxBytes: 10 });
  try {
    fs.writeFileSync(path.join(small.lib.root, 'big.pdf'), makePdf(['x']));
    reindex(small);
    const c = new Client(small.port);
    await c.login();
    const page = await c.get('/v/big.pdf');
    assert.doesNotMatch(page.text, /id="pdfv"/);
    assert.match(page.text, /文件过大/);
    assert.match(page.text, /href="\/dl\/big\.pdf"/);
  } finally {
    await small.stop();
  }
});

test('静态资源：PDF.js 随包发布，版本和依赖一致，wasm 权限只放给这个目录', async () => {
  const { version } = createRequire(import.meta.url)('pdfjs-dist/package.json');
  assert.equal(fs.readFileSync(new URL('../public/vendor/pdfjs/VERSION', import.meta.url), 'utf8').trim(), version);
  const worker = await client.get('/assets/vendor/pdfjs/pdf.worker.min.mjs');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /javascript/);
  assert.match(worker.headers['content-security-policy'], /'wasm-unsafe-eval'/);
  const cmap = await client.get('/assets/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap');
  assert.equal(cmap.status, 200);
  const page = await client.get(`/v/${enc('docs/有字.pdf')}`);
  assert.doesNotMatch(page.headers['content-security-policy'], /wasm-unsafe-eval/);
});
