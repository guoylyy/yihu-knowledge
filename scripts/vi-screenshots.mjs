// VI 验收：用演示库（虚构内容）截 375 / 1440 各 4 张到 artifacts/vi/，同时量主色、触控尺寸、元素坐标
//   node scripts/vi-screenshots.mjs          截到 artifacts/vi/
//   node scripts/vi-screenshots.mjs before   截到 artifacts/vi/before/，换 CSS 前先跑一次，用来比对布局
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { chromium, webkit } from 'playwright-core';
import { boot } from '../src/boot.js';

const label = process.argv[2] ?? '';
const out = path.resolve('artifacts/vi', label);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vi-'));
fs.mkdirSync(path.join(out, 'dark'), { recursive: true });
execFileSync('node', ['scripts/make-demo.js', path.join(base, 'library')]);

const PASSWORD = 'screenshot-pass-10';
const dataDir = path.join(base, 'data');
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  root: path.join(base, 'library'), siteName: '知识库', ownerName: '示例团队', authMode: 'password', passwordHash: await argon2.hash(PASSWORD), baseUrl: 'http://localhost',
}));
const booted = await boot({ KB_DATA_DIR: dataDir, HOME: '/nonexistent', PATH: '' });
const server = http.createServer(booted.handler);
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
await booted.state.kb.indexer.run({ full: true });
const origin = `http://localhost:${server.address().port}`;

const shots = [
  ['home', '/'],
  ['reading', `/v/${encodeURIComponent('项目周报')}/${encodeURIComponent('2026-W43.md')}`],
  ['search', `/search?q=${encodeURIComponent('合同')}`],
  ['settings', '/admin/settings'],
];

const login = async (page) => {
  await page.goto(`${origin}/login`);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForURL(`${origin}/`), page.click('button[type=submit]')]);
};

// 每个可见元素的坐标。两次跑的结果逐项比，布局动过就有差异
const layoutOf = (page) => page.evaluate(() => [...document.querySelectorAll('body *')]
  .filter((el) => !el.closest('svg') && el.getClientRects().length)
  .map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}.${el.classList.value} ${[r.x, r.y + scrollY, r.width, r.height].map((n) => Math.round(n * 2) / 2).join(' ')}`;
  }));

// 低于 44px 的可点元素；正文行内链接本来就不放大，不算
const tapsOf = (page) => page.evaluate(() => [...document.querySelectorAll('a, button, input, select, summary')]
  .filter((el) => el.getClientRects().length && !el.closest('.prose') && el.type !== 'hidden' && getComputedStyle(el).visibility !== 'hidden')
  .filter((el) => { const r = el.getBoundingClientRect(); return r.height < 44 || r.width < 44; })
  .map((el) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()}.${el.classList.value} ${Math.round(r.width)}×${Math.round(r.height)} ${el.textContent.trim().slice(0, 12)}`; }));

const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const report = { layout: {}, taps: {} };

for (const width of [375, 1440]) {
  const mobile = width === 375;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${width} console: ${m.text()} ${m.location().url}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  await login(page);
  for (const [name, url] of shots) {
    await page.goto(origin + url, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
    report.layout[`${name}-${width}`] = await layoutOf(page);
    if (mobile) report.taps[`chromium ${name}`] = await tapsOf(page);
    if (name === 'home' && mobile) {
      await page.click('#drawer-open');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: name !== 'home' || !mobile });
  }
  if (!mobile) {
    await page.goto(origin + shots[1][1], { waitUntil: 'networkidle' });
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const link = document.querySelector('.prose a:not(.tag)');
      return {
        '--yh-primary': root.getPropertyValue('--yh-primary').trim() || '（未定义）',
        '--accent': root.getPropertyValue('--accent').trim() || '（未定义）',
        '链接': `${link.textContent.trim().slice(0, 12)} → ${getComputedStyle(link).color}`,
        '正文字体': getComputedStyle(document.body).fontFamily,
      };
    });
    console.log('计算值', JSON.stringify(colors, null, 2));
  }
  // 顶栏图标：画板底部 3/24 是留白，墨迹底边应落在文字基线上
  const baseline = await page.evaluate(() => {
    const brand = document.querySelector('.brand');
    const probe = brand.appendChild(document.createElement('span'));
    probe.style.cssText = 'display:inline-block;width:0;height:0';
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    const icon = brand.querySelector('.brand-icon').getBoundingClientRect();
    return { 基线: y, 墨迹底边: icon.bottom - (icon.height * 3) / 24, 文字色: getComputedStyle(brand).color, 字号: getComputedStyle(brand).fontSize };
  });
  console.log(`${width} 顶栏图标`, JSON.stringify(baseline));
  await context.close();
}

// 深色跟着切一遍：平台令牌只有浅色，这里防止近黑主色落在深色底上
const dark = await browser.newContext({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: 'dark' });
const page = await dark.newPage();
await login(page);
for (const [name, url] of shots) {
  await page.goto(origin + url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(out, 'dark', `${name}-375.png`), fullPage: true });
}
await dark.close();
await browser.close();

const wk = await webkit.launch();
const wkContext = await wk.newContext({ viewport: { width: 375, height: 780 }, hasTouch: true, colorScheme: 'light' });
const wkPage = await wkContext.newPage();
await login(wkPage);
for (const [name, url] of shots) {
  await wkPage.goto(origin + url, { waitUntil: 'networkidle' });
  report.taps[`webkit ${name}`] = await tapsOf(wkPage);
}
await wk.close();

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
server.closeAllConnections();
await new Promise((resolve) => { server.close(resolve); });
await booted.state.kb.indexer.idle();
booted.stop();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错');
for (const [k, v] of Object.entries(report.taps)) console.log(`${k}：低于 44px ${v.length} 个`, v.join(' | '));
