import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { strToU8, zipSync } from 'fflate';
import { createConverter, findSoffice, previewKey } from '../src/convert.js';
import { Client, enc, reindex, startServer } from './helpers.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-conv-'));
const log = path.join(base, 'soffice.log');
let serial = 0;

// 假的 soffice：真 spawn、真超时、真杀进程组，行为由输入文件内容决定。环境变量是白名单，路径只能写死在脚本里
const FAKE = `#!/bin/sh
outdir=""; input=""; profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) outdir="$2"; shift ;;
    -env:UserInstallation=*) profile="$1" ;;
    --*) ;;
    *) input="$1" ;;
  esac
  shift
done
echo "start $$ $profile $(env | cut -d= -f1 | tr '\\n' ',')" >> "${log}"
: > "$(dirname "$input")/.~lock.input#"
case "$(head -c 6 "$input")" in
  CRASH*) exit 3 ;;
  SILENT) exit 0 ;;
  HANG*) sleep 30 & echo "child $!" >> "${log}"; wait ;;
esac
sleep 0.15
printf '%%PDF-1.4 converted %s' "$(cat "$input")" > "$outdir/input.pdf"
echo "end $$" >> "${log}"
`;
const fake = path.join(base, 'soffice');
fs.writeFileSync(fake, FAKE, { mode: 0o755 });

const started = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start')) : []);
const resetLog = () => fs.rmSync(log, { force: true });
const source = (content, name = `src${++serial}.pptx`) => {
  const full = path.join(base, name);
  fs.writeFileSync(full, content);
  return { rel: name, full, ext: path.extname(name).slice(1) };
};
const converter = (opts = {}) => {
  const dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  return { dataDir, conv: createConverter({ dataDir, soffice: fake, ...opts }) };
};
async function settled(conv, { rel, full, ext }, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const status = conv.request(rel, full, ext);
    if (status.state === 'ready' || status.state === 'failed') return status;
    await sleep(20);
  }
  throw new Error('转换没有结束');
}

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('探测：KB_SOFFICE 优先；配错不回退到别的路径；PATH 里找 soffice', () => {
  assert.equal(findSoffice({ KB_SOFFICE: fake, PATH: '' }), fake);
  assert.equal(findSoffice({ KB_SOFFICE: path.join(base, 'nope'), PATH: base }), null);
  assert.equal(findSoffice({ PATH: base }), fake);
});

test('缓存键：路径、mtime、size 任何一个变了都不同', () => {
  const key = previewKey('a.pptx', { mtimeMs: 1000.4, size: 10 });
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(key, previewKey('a.pptx', { mtimeMs: 1000.1, size: 10 }));
  assert.notEqual(key, previewKey('b.pptx', { mtimeMs: 1000, size: 10 }));
  assert.notEqual(key, previewKey('a.pptx', { mtimeMs: 2000, size: 10 }));
  assert.notEqual(key, previewKey('a.pptx', { mtimeMs: 1000, size: 11 }));
});

test('缓存：同文件重复请求只转换一次，产物落在 previews/<sha1>.pdf', async () => {
  resetLog();
  const { conv, dataDir } = converter();
  const src = source('plain');
  const first = conv.request(src.rel, src.full, src.ext);
  assert.equal(first.state, 'running');
  assert.equal(conv.request(src.rel, src.full, src.ext).state, 'running');
  const done = await settled(conv, src);
  assert.equal(done.state, 'ready');
  assert.equal(done.pdf, path.join(dataDir, 'previews', `${done.key}.pdf`));
  assert.equal(conv.request(src.rel, src.full, src.ext).state, 'ready');
  assert.equal(started().length, 1);
});

test('缓存：源文件 mtime 变了就失效，重新转换', async () => {
  resetLog();
  const { conv } = converter();
  const src = source('plain');
  const first = await settled(conv, src);
  fs.utimesSync(src.full, new Date(), new Date(Date.now() + 5000));
  assert.equal(conv.request(src.rel, src.full, src.ext).state, 'running');
  const second = await settled(conv, src);
  assert.notEqual(second.key, first.key);
  assert.equal(started().length, 2);
});

test('失败：进程崩溃返回 failed，一小时内不重复尝试，过后可以再试', async () => {
  resetLog();
  let clock = Date.now();
  const { conv } = converter({ now: () => clock });
  const src = source('CRASH');
  const status = await settled(conv, src);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'crash');
  assert.equal(conv.request(src.rel, src.full, src.ext).state, 'failed');
  assert.equal(started().length, 1);
  clock += 2 * 60 * 60 * 1000;
  assert.equal(conv.request(src.rel, src.full, src.ext).state, 'running');
  await settled(conv, src);
  assert.equal(started().length, 2);
});

test('失败：退出码 0 但没有产物（soffice 打不开文件时就是这样）也算失败', async () => {
  const { conv } = converter();
  const status = await settled(conv, source('SILENT'));
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'no-output');
});

test('超时：杀掉整个进程组，子进程不残留，工作目录清干净', async () => {
  resetLog();
  const { conv, dataDir } = converter({ timeoutMs: 300 });
  const at = Date.now();
  const status = await settled(conv, source('HANG'));
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'timeout');
  assert.ok(Date.now() - at < 3000);
  const child = Number(fs.readFileSync(log, 'utf8').match(/child (\d+)/)[1]);
  await sleep(100);
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'previews')).filter((n) => n.startsWith('.job-')), []);
});

test('并发：最多同时两个，配置目录互不相同，第三个排队', async () => {
  resetLog();
  const { conv } = converter();
  const [a, b, c] = [source('one'), source('two'), source('three')];
  const states = [a, b, c].map((s) => conv.request(s.rel, s.full, s.ext));
  assert.deepEqual(states.map((s) => s.state), ['running', 'running', 'queued']);
  assert.equal(states[2].ahead, 2);
  await Promise.all([a, b, c].map((s) => settled(conv, s)));
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  let live = 0;
  let peak = 0;
  for (const line of lines) {
    live += line.startsWith('start') ? 1 : -1;
    peak = Math.max(peak, live);
  }
  assert.equal(peak, 2);
  const profiles = started().map((l) => l.split(' ')[2]);
  assert.notEqual(profiles[0], profiles[1]);
  assert.ok(profiles.every((p) => p.includes('.profile-')));
});

test('隔离：不把密钥传给 soffice，也不在源文件目录留下锁文件', async () => {
  resetLog();
  process.env.KB_PASSWORD = 'leak-check';
  process.env.AI_API_KEY = 'leak-check';
  const dir = path.join(base, '只读库');
  fs.mkdirSync(dir);
  const full = path.join(dir, '含 空格.pptx');
  fs.writeFileSync(full, 'plain');
  const { conv } = converter();
  try {
    await settled(conv, { rel: '只读库/含 空格.pptx', full, ext: 'pptx' });
  } finally {
    delete process.env.KB_PASSWORD;
    delete process.env.AI_API_KEY;
  }
  assert.doesNotMatch(started()[0], /KB_PASSWORD|AI_API_KEY/);
  assert.deepEqual(fs.readdirSync(dir), ['含 空格.pptx']);
});

test('淘汰：超过缓存上限时清掉最久没打开的，刚转好的留下', async () => {
  const { conv, dataDir } = converter({ cacheBytes: 60 });
  const previews = path.join(dataDir, 'previews');
  const oldest = source('a'.repeat(30));
  const middle = source('b'.repeat(30));
  const first = await settled(conv, oldest);
  fs.utimesSync(first.pdf, new Date(Date.now() - 9000), new Date(Date.now() - 9000));
  await settled(conv, middle);
  assert.equal(fs.existsSync(first.pdf), false);
  assert.equal(fs.readdirSync(previews).filter((n) => n.endsWith('.pdf')).length, 1);
});

test('关闭：close 杀掉在跑的转换', async () => {
  resetLog();
  const { conv } = converter({ timeoutMs: 60000 });
  const src = source('HANG');
  conv.request(src.rel, src.full, src.ext);
  await sleep(200);
  const pid = Number(started()[0].split(' ')[1]);
  conv.close();
  await sleep(100);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

const slideXml = (title) => strToU8(`<p:sld><p:sp><p:nvPr><p:ph type="title"/></p:nvPr><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:sp></p:sld>`);
const pptx = (title) => Buffer.from(zipSync({ 'ppt/slides/slide1.xml': slideXml(title) }));

let s;
let client;
const addFile = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(s.lib.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(s.lib.root, rel), content);
};

before(async () => {
  s = await startServer({ soffice: fake });
  addFile('slides/好文件.pptx', pptx('好文件标题'));
  addFile('slides/转不了.pptx', Buffer.concat([Buffer.from('CRASH'), pptx('转不了的标题')]));
  addFile('slides/坏文件.pptx', Buffer.from('CRASH not a zip at all'));
  addFile('slides/老格式.ppt', 'CRASH');
  addFile('slides/老格式好的.doc', 'plain');
  reindex(s);
  client = new Client(s.port);
  await client.login();
});

after(() => s.stop());

async function waitReady(c, rel, prefix = '') {
  for (let i = 0; i < 200; i++) {
    const res = await c.get(`${prefix}/preview-status/${enc(rel)}`);
    assert.equal(res.status, 200);
    const { state } = JSON.parse(res.text);
    if (state === 'ready' || state === 'failed') return state;
    await sleep(25);
  }
  throw new Error('一直没有转好');
}

test('页面：转换中先给文字预览和进度，转好后是阅读器，第二次直接命中缓存', async () => {
  resetLog();
  const url = `/v/${enc('slides/好文件.pptx')}`;
  const pending = await client.get(url);
  assert.equal(pending.status, 200);
  assert.match(pending.text, /id="convert-status"/);
  assert.match(pending.text, /好文件标题/);
  assert.doesNotMatch(pending.text, /id="pdfv"/);
  assert.equal(await waitReady(client, 'slides/好文件.pptx'), 'ready');
  const ready = await client.get(url);
  assert.match(ready.text, /id="pdfv"/);
  const src = ready.text.match(/data-src="([^"]+)"/)[1];
  assert.match(src, /^\/preview\/slides\/.*\?v=[0-9a-f]{12}$/);
  await client.get(url);
  assert.equal(started().length, 1);
});

test('转换产物：支持 Range，未就绪返回 404 而不是 500', async () => {
  const res = await client.get(`/preview/${enc('slides/好文件.pptx')}`, { headers: { Range: 'bytes=0-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.text, '%PDF-');
  assert.equal((await client.get(`/preview/${enc('notes/笔记甲.md')}`)).status, 404);
});

test('失败：转换失败退回文字预览，页面看得到文字和说明', async () => {
  const rel = 'slides/转不了.pptx';
  const url = `/v/${enc(rel)}`;
  await client.get(url);
  assert.equal(await waitReady(client, rel), 'failed');
  const page = await client.get(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /转换失败，已退回文字预览/);
  assert.doesNotMatch(page.text, /id="pdfv"/);
});

test('失败：损坏的 pptx 连文字都读不出时给可读的说明，不是 500', async () => {
  const rel = 'slides/坏文件.pptx';
  const url = `/v/${enc(rel)}`;
  await client.get(url);
  assert.equal(await waitReady(client, rel), 'failed');
  const page = await client.get(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /转换失败，已退回文字预览/);
  assert.match(page.text, /无法解析这个文件/);
});

test('老格式：ppt 转换失败时没有文字可退，只提示下载；doc 能转成阅读器', async () => {
  const bad = 'slides/老格式.ppt';
  await client.get(`/v/${enc(bad)}`);
  assert.equal(await waitReady(client, bad), 'failed');
  const failed = await client.get(`/v/${enc(bad)}`);
  assert.match(failed.text, /转换失败，请下载查看/);
  const good = 'slides/老格式好的.doc';
  await client.get(`/v/${enc(good)}`);
  assert.equal(await waitReady(client, good), 'ready');
  assert.match((await client.get(`/v/${enc(good)}`)).text, /id="pdfv"/);
});

test('权限：deny 的文件查不到转换状态；分享只放行分享范围内的文件', async () => {
  addFile('工资密码表.pptx', pptx('绝密'));
  addFile('share/公开.pptx', pptx('公开内容'));
  reindex(s);
  assert.equal((await client.get(`/preview-status/${enc('工资密码表.pptx')}`)).status, 404);
  await client.createShare({ path: 'share/公开.pptx' });
  const { token } = s.db.prepare("SELECT token FROM shares WHERE path = 'share/公开.pptx'").get();
  const visitor = new Client(s.port, '10.0.0.99');
  const prefix = `/s/${token}`;
  await visitor.get(`${prefix}/v/${enc('share/公开.pptx')}`);
  assert.equal(await waitReady(visitor, 'share/公开.pptx', prefix), 'ready');
  const page = await visitor.get(`${prefix}/v/${enc('share/公开.pptx')}`);
  assert.ok(page.text.includes(`data-src="${prefix}/preview/`));
  assert.equal((await visitor.get(`${prefix}/preview/${enc('share/公开.pptx')}`)).status, 200);
  assert.equal((await visitor.get(`${prefix}/preview/${enc('slides/好文件.pptx')}`)).status, 404);
  assert.equal((await visitor.get(`/preview/${enc('share/公开.pptx')}`)).status, 302);
});

test('上限：超过 KB_PREVIEW_MAX_MB 不排队转换，只给下载', async () => {
  const small = await startServer({ soffice: fake, previewMaxBytes: 4 });
  try {
    resetLog();
    fs.writeFileSync(path.join(small.lib.root, '大.pptx'), pptx('标题'));
    reindex(small);
    const c = new Client(small.port);
    await c.login();
    const page = await c.get(`/v/${enc('大.pptx')}`);
    assert.match(page.text, /文件过大/);
    assert.equal(started().length, 0);
  } finally {
    await small.stop();
  }
});

test('没有 soffice：pptx 走文字预览并提示安装；分享访客看不到安装提示', async () => {
  const lite = await startServer();
  try {
    fs.writeFileSync(path.join(lite.lib.root, 'share', '幻灯片.pptx'), pptx('纯文字标题'));
    fs.writeFileSync(path.join(lite.lib.root, 'share', '老格式.ppt'), 'x');
    reindex(lite);
    const c = new Client(lite.port);
    await c.login();
    const page = await c.get(`/v/${enc('share/幻灯片.pptx')}`);
    assert.match(page.text, /纯文字标题/);
    assert.match(page.text, /当前版本未安装 LibreOffice，只显示文字/);
    assert.match(page.text, /Dockerfile\.full/);
    assert.match(page.text, /brew install --cask libreoffice/);
    assert.doesNotMatch(page.text, /id="pdfv"/);
    assert.equal((await c.get(`/preview-status/${enc('share/幻灯片.pptx')}`)).status, 404);
    assert.match((await c.get(`/v/${enc('share/老格式.ppt')}`)).text, /没有文字预览/);
    await c.createShare({ path: 'share/幻灯片.pptx' });
    const { token } = lite.db.prepare("SELECT token FROM shares WHERE path = 'share/幻灯片.pptx'").get();
    const shared = await new Client(lite.port, '10.0.0.98').get(`/s/${token}/v/${enc('share/幻灯片.pptx')}`);
    assert.match(shared.text, /纯文字标题/);
    assert.doesNotMatch(shared.text, /LibreOffice/);
  } finally {
    await lite.stop();
  }
});

test('配置：默认值与环境变量', async () => {
  const { loadConfig } = await import('../src/config.js');
  const env = { KB_ROOT: '/tmp', KB_DATA_DIR: '/nonexistent/kb-data', PATH: '' };
  const config = loadConfig(env);
  assert.equal(config.previewMaxBytes, 200 * 1024 * 1024);
  assert.equal(config.previewCacheBytes, 2048 * 1024 * 1024);
  assert.equal(config.convertTimeoutMs, 120000);
  assert.equal(config.pdfMaxPages, 50);
  const custom = loadConfig({ ...env, KB_SOFFICE: fake, KB_PREVIEW_MAX_MB: '10', KB_PREVIEW_CACHE_MB: '100', KB_CONVERT_TIMEOUT_S: '30', KB_PDF_MAX_PAGES: '5' });
  assert.equal(custom.soffice, fake);
  assert.equal(custom.previewMaxBytes, 10 * 1024 * 1024);
  assert.equal(custom.previewCacheBytes, 100 * 1024 * 1024);
  assert.equal(custom.convertTimeoutMs, 30000);
  assert.equal(custom.pdfMaxPages, 5);
});

test('镜像：Dockerfile.full 和 Dockerfile 只差默认的 WITH_OFFICE', () => {
  const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('# 和 Dockerfile 只差'));
  const lite = read('Dockerfile');
  const full = read('Dockerfile.full');
  assert.ok(lite.includes('ARG WITH_OFFICE=0'));
  assert.ok(full.includes('ARG WITH_OFFICE=1'));
  assert.deepEqual(full.map((l) => l.replace('WITH_OFFICE=1', 'WITH_OFFICE=0')), lite);
});
