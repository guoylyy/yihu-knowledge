// 用演示库走一遍真实向导，截 375 / 1440 两档；同时检查横向溢出、CSP 报错和页面交互
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { boot } from '../src/boot.js';

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-setup-shots-'));
const library = path.join(base, 'library');
const out = path.resolve(process.env.SETUP_OUT ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/make-demo.js', library]);
fs.mkdirSync(path.join(library, '.obsidian'), { recursive: true });

const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });

async function wizard(env) {
  const booted = await boot({ HOME: '/nonexistent', PATH: '', ...env });
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { booted, server, origin: `http://localhost:${server.address().port}` };
}

async function stop({ booted, server }) {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
  booted.stop();
}

async function capture(page, width, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
  await page.screenshot({ path: path.join(out, `setup-${name}-${width}.png`), fullPage: true });
}

for (const width of [375, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`${width} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));

  const w = await wizard({ KB_DATA_DIR: path.join(base, `data-${width}`) });
  await page.goto(`${w.origin}/`);
  if (!page.url().endsWith('/setup')) problems.push(`${width}: 没有跳到 /setup`);
  await page.waitForSelector('#dir-list:not([aria-busy])', { state: 'attached' });
  await capture(page, width, 'form');

  await page.click('#setup-advanced summary');
  await page.fill('#setup-root', '/no/such/dir');
  await page.click('#setup-check');
  await page.waitForSelector('#check-result .alert');
  await capture(page, width, 'check-error');

  await page.fill('#setup-root', library);
  await page.click('#setup-check');
  await page.waitForSelector('#check-result .tiles');
  await capture(page, width, 'check-ok');

  // 口令太短：前端拦住，不丢表单
  await page.fill('#setup-password', 'short');
  await page.click('button[type=submit]');
  if (!(await page.locator('#form-error').isVisible())) problems.push(`${width}: 短口令没有被前端拦住`);
  await page.click('#setup-generate');
  const generated = await page.inputValue('#setup-password');
  if (generated.length !== 24) problems.push(`${width}: 生成的口令长度 ${generated.length}`);

  // 后端错误态：目录改成不存在的路径再提交
  await page.fill('#setup-root', '/no/such/dir');
  await page.locator('input[name=aiProvider][value=openai]').check({ force: true });
  await page.fill('input[name=aiBaseUrl]', 'https://llm.example.com/v1');
  await page.fill('input[name=aiApiKey]', 'demo-key-for-screenshot');
  await page.fill('input[name=aiModel]', 'demo-model');
  await page.click('button[type=submit]');
  await page.waitForSelector('.alert');
  await capture(page, width, 'submit-error');
  if ((await page.content()).includes('demo-key-for-screenshot')) problems.push(`${width}: 回显页出现了明文 key`);
  if (!(await page.locator('input[name=aiBaseUrl]').isVisible())) problems.push(`${width}: 回显后 openai 面板没展开`);

  await page.fill('#setup-root', library);
  await page.fill('#setup-password', generated);
  await Promise.all([page.waitForURL('**/login', { timeout: 30000 }), page.click('button[type=submit]')]);
  await page.fill('input[name=password]', generated);
  await Promise.all([page.waitForURL(`${w.origin}/`), page.click('button[type=submit]')]);
  const status = await page.goto(`${w.origin}/setup`);
  if (status.status() !== 404) problems.push(`${width}: 配置后 /setup 是 ${status.status()}`);
  if (fs.statSync(path.join(base, `data-${width}`, 'config.json')).mode % 512 !== 0o600) problems.push(`${width}: config.json 权限不是 600`);
  await stop(w);

  // 平台 + Docker 形态：选项全部可用，平台模型默认选中
  const yh = await wizard({
    KB_DATA_DIR: path.join(base, `data-yh-${width}`), KB_IN_DOCKER: '1', YH_CLIENT_ID: 'demo', YH_CLIENT_SECRET: 'demo', YH_WEB_URL: 'https://one.example.com', YH_API_URL: 'https://one.example.com',
  });
  await page.goto(`${yh.origin}/setup`);
  await page.locator('input[name=authMode][value=both]').check({ force: true });
  // 目录列表是异步来的：等它回来再截，也别在请求途中把服务停掉
  await page.waitForSelector('#dir-list:not([aria-busy])', { state: 'attached' });
  await capture(page, width, 'platform-docker');
  await stop(yh);
  await context.close();
}

await browser.close();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错，交互全部符合预期');
console.log(`截图：${out}/setup-*.png`);
