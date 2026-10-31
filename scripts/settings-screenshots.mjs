// 走一遍 /admin/settings 的可编辑、只读、换库确认、换库进度、失败，截 375 / 1440 两档；库都是现造的假数据
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { chromium } from 'playwright-core';
import { boot } from '../src/boot.js';

const PASSWORD = 'screenshot-pass-10';
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-settings-shots-'));
const library = path.join(base, 'library');
const out = path.resolve(process.env.SETTINGS_OUT ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/make-demo.js', library]);

// 够大才看得到进度条
const big = path.join(base, 'big');
fs.mkdirSync(big);
for (let i = 0; i < 12000; i++) fs.writeFileSync(path.join(big, `笔记-${i}.md`), `# 第 ${i} 篇\n\n${'演示正文 '.repeat(300)}\n`);

const hash = await argon2.hash(PASSWORD);
const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });

async function start(name, env = {}, file = {}) {
  const dataDir = path.join(base, name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    root: library, siteName: '演示知识库', ownerName: '演示主人', authMode: 'password', passwordHash: hash, baseUrl: 'http://localhost', ai: { provider: 'openai', baseUrl: 'https://llm.example.com/v1', apiKey: 'demo-not-a-real-key', model: 'demo-1' }, ...file,
  }));
  const booted = await boot({ KB_DATA_DIR: dataDir, HOME: '/nonexistent', PATH: '', ...env });
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  await booted.state.kb.indexer.run({ full: true });
  return { booted, server, origin: `http://localhost:${server.address().port}` };
}

async function stop({ booted, server }) {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
  await booted.state.kb.indexer.idle();
  booted.stop();
}

async function capture(page, width, name, { full = true } = {}) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
  if (full) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, `settings-${name}-${width}.png`), fullPage: full });
}

for (const width of [375, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text())) problems.push(`${width} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  const login = async (origin) => {
    await page.goto(`${origin}/login?next=${encodeURIComponent('/admin/settings')}`);
    await page.fill('input[name=password]', PASSWORD);
    await Promise.all([page.waitForURL('**/admin/settings'), page.click('button[type=submit]')]);
  };

  const live = await start(`live-${width}`);
  await login(live.origin);
  await capture(page, width, 'editable');

  // 改通道时 OpenAI 那组置灰
  await page.locator('input[name=aiProvider][value=off]').check({ force: true });
  if (!(await page.locator('input[name=aiModel]').isDisabled())) problems.push(`${width}: 换通道后 OpenAI 字段没有置灰`);
  await page.locator('input[name=aiProvider][value=openai]').check({ force: true });

  // 预检失败
  await page.click('#library-advanced summary');
  await page.fill('#library-root', path.join(base, 'nope'));
  await page.click('#library-check');
  await page.waitForSelector('#check-result .alert');
  await page.locator('#settings-library').scrollIntoViewIfNeeded();
  await capture(page, width, 'check-error', { full: false });

  // 一篇 Markdown 都没有：弹层里要额外勾选
  const tiny = path.join(base, `tiny-${width}`);
  fs.mkdirSync(tiny);
  fs.writeFileSync(path.join(tiny, '只有一份.pdf'), 'x');
  await page.fill('#library-root', tiny);
  await page.click('#library-save');
  await page.waitForSelector('#library-dialog[open]');
  if (!(await page.locator('#library-confirm').isDisabled())) problems.push(`${width}: 异常时没勾选也能确认`);
  await capture(page, width, 'confirm-anomaly', { full: false });
  await page.click('#library-cancel');

  await page.fill('#library-root', big);
  await page.click('#library-save');
  await page.waitForSelector('#library-dialog[open]');
  await capture(page, width, 'confirm', { full: false });
  await Promise.all([page.waitForURL('**/admin/settings*'), page.click('#library-confirm')]);
  await page.waitForSelector('#library-progress');
  await page.waitForFunction(() => Number(document.querySelector('#library-bar')?.value) > 0);
  await capture(page, width, 'progress');
  const reader = await context.newPage();
  const read = await reader.goto(`${live.origin}/`);
  if (read.status() !== 200) problems.push(`${width}: 换库期间首页 ${read.status()}`);
  await reader.close();
  await page.waitForSelector('#settings-library .notice', { timeout: 120000 });
  await capture(page, width, 'done');
  await stop(live);

  // 全部交给环境变量
  await context.clearCookies();
  const locked = await start(`env-${width}`, { KB_ROOT: library, KB_PASSWORD: PASSWORD, KB_OWNER_NAME: '环境主人', KB_BASE_URL: 'https://kb.example.com', AI_PROVIDER: 'off', KB_COOKIE_INSECURE: '1' });
  await login(locked.origin);
  if (!(await page.locator('#library-root').isDisabled())) problems.push(`${width}: 环境变量控制的目录还能改`);
  await capture(page, width, 'readonly');
  await stop(locked);
  await context.close();
}

await browser.close();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错，交互全部符合预期');
console.log(`截图：${out}/settings-*.png`);
