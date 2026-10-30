// 用演示库（虚构内容）+ 本地模拟模型截 AI 面板：打开态、问答进行中、错误态、敏感拦截；同时检查横向溢出和 CSP 报错
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createApp } from '../src/app.js';
import { effectiveDenyGlobs } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { runIndex } from '../src/indexer.js';

const base = path.resolve('data/demo-ai');
const out = path.resolve('docs/screenshots');
fs.rmSync(base, { recursive: true, force: true });
execFileSync('node', ['scripts/make-demo.js', path.join(base, 'library')]);
fs.writeFileSync(path.join(base, 'library', '项目周报', '运维备忘.md'), '# 运维备忘\n\n测试环境 password: demo-only-1234\n');
fs.writeFileSync(path.join(base, 'library', '项目周报', '长文档.md'), `# 长文档\n\n${'这是一段用来撑长度的示例文字。'.repeat(4000)}\n`);

const SUMMARY = '- **进度：** 接口联调完成八成，排期比计划晚两天。\n- **风险：** 第三方回调文档缺失，影响验收。\n- **下周：** 补齐回调文档，推进灰度。\n\n**结论：** 主线可控，关键是尽快拿到回调文档。';
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages[1].content;
    if (prompt.includes('现在的问题：触发错误')) return res.writeHead(401).end('{}');
    const reply = prompt.includes('现在的问题') ? '最大的风险是**第三方回调文档缺失**，它会直接卡住验收。' : SUMMARY;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'demo-model', choices: [{ message: { content: reply } }] }));
    }, prompt.includes('现在的问题') ? 1500 : 200);
  });
});
await new Promise((resolve) => { mock.listen(0, '127.0.0.1', resolve); });

const config = {
  root: path.join(base, 'library'), dataDir: path.join(base, 'data'), password: 'demo-password', baseUrl: 'http://localhost', port: 0,
  denyGlobs: effectiveDenyGlobs(), ownerName: '示例团队', trustProxy: 0, cookieSecure: false, timeZone: 'Asia/Shanghai', zipMaxBytes: 1e9, scanIntervalMs: 0,
  aiProvider: 'openai', aiBaseUrl: `http://127.0.0.1:${mock.address().port}/v1`, aiApiKey: 'demo', aiModel: 'demo-model', aiTimeoutMs: 5000,
};
const kb = await createApp(config);
runIndex({ db: kb.db, root: config.root, deny: createDeny(config.denyGlobs) });
const server = await new Promise((resolve) => { const s = kb.app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const url = (name) => `/v/${encodeURIComponent('项目周报')}/${encodeURIComponent(name)}`;

const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
for (const width of [375, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => {
    // 错误态是故意触发的，浏览器不会替 200 以外的 fetch 打印别的内容
    if (m.type() === 'error' && !m.text().includes('401') && !m.text().includes('502')) problems.push(`${width} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  const shot = async (name) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
    await page.screenshot({ path: path.join(out, `ai-${name}-${width}.png`) });
  };
  await page.goto(`${origin}/login`);
  await page.fill('input[name=password]', config.password);
  await Promise.all([page.waitForURL(`${origin}/`), page.click('button[type=submit]')]);

  await page.goto(origin + url('2026-W43.md'), { waitUntil: 'networkidle' });
  await page.click('#ai-summary');
  await shot('reading');
  await page.waitForSelector('.ai-answer');
  await shot('open');

  await page.fill('#ai-input', '这周最大的风险是什么');
  await page.click('#ai-send');
  await page.waitForSelector('.ai-wait');
  await shot('asking');
  await page.waitForFunction(() => document.querySelectorAll('.ai-answer').length === 2);

  await page.fill('#ai-input', '触发错误');
  await page.click('#ai-send');
  await page.waitForSelector('.ai-error');
  await shot('error');

  const box = await page.locator('#ai-grip').boundingBox();
  if (width === 375 && (box.y > 20)) problems.push('375 面板没有铺满全屏');
  await page.click('#ai-close');
  if (await page.locator('#ai-sheet').isVisible()) problems.push(`${width} 关闭按钮无效`);

  await page.goto(origin + url('长文档.md'), { waitUntil: 'networkidle' });
  await page.click('#ai-summary');
  await page.waitForSelector('.ai-answer');
  if (!(await page.locator('.ai-foot.warn', { hasText: '已截断，只看前 40,000 字' }).isVisible())) problems.push(`${width} 没有截断提示`);
  await shot('truncated');

  await page.goto(origin + url('运维备忘.md'), { waitUntil: 'networkidle' });
  if (!(await page.locator('#ai-summary').isDisabled())) problems.push(`${width} 敏感文件按钮没有置灰`);
  await shot('sensitive');
  await context.close();
}
await browser.close();
server.closeAllConnections();
server.close();
mock.close();
kb.close();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错');
