// 用演示库（虚构内容）截 375 / 768 / 1440 三档；同时检查横向溢出和 CSP 报错
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createApp } from '../src/app.js';
import { effectiveDenyGlobs } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { runIndex } from '../src/indexer.js';

const base = path.resolve('data/demo');
const out = path.resolve('docs/screenshots');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/make-demo.js', path.join(base, 'library')]);

const config = {
  root: path.join(base, 'library'), dataDir: path.join(base, 'data'), password: 'demo-password', baseUrl: 'http://localhost', port: 0,
  denyGlobs: effectiveDenyGlobs(), ownerName: '示例团队', trustProxy: 0, cookieSecure: false, aiProvider: 'off',
  timeZone: 'Asia/Shanghai', zipMaxBytes: 1e9, scanIntervalMs: 0,
};
const kb = await createApp(config);
runIndex({ db: kb.db, root: config.root, deny: createDeny(config.denyGlobs) });
const server = await new Promise((resolve) => { const s = kb.app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;

const share = await kb.shares.create({ path: '项目周报', days: 7 });
const visit = kb.db.prepare('INSERT INTO visits (share_id, path, ip, ua, referer, kind, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
for (let d = 0; d < 24; d++) {
  for (let i = 0; i < 1 + ((d * 7) % 9); i++) {
    visit.run(share.id, '项目周报/2026-W43.md', `198.51.100.${i + 1}`, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', '', i % 4 ? 'view' : 'download', Date.now() - d * 864e5 - i * 6e5);
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const doc = `/v/${encodeURIComponent('项目周报')}/${encodeURIComponent('2026-W43.md')}`;
const shots = [
  ['reading', doc],
  ['search', `/search?q=${encodeURIComponent('合同')}`],
  ['share', `/s/${share.token}/v/${encodeURIComponent('项目周报')}/${encodeURIComponent('2026-W43.md')}`],
  ['share-gate-expired', '/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['admin', '/admin'],
  ['admin-share-detail', `/admin/shares/${share.id}`],
  ['admin-settings', '/admin/settings'],
];

for (const width of [375, 768, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.includes('/s/AAAA')) problems.push(`${width} console: ${m.text()} ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  await page.goto(`${origin}/login`);
  await page.screenshot({ path: path.join(out, `login-${width}.png`) });
  await page.fill('input[name=password]', config.password);
  await Promise.all([page.waitForURL(`${origin}/`), page.click('button[type=submit]')]);
  for (const [name, url] of shots) {
    await page.goto(origin + url, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
    await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: name !== 'reading' && name !== 'admin-share-detail' });
  }
  await page.goto(origin + doc, { waitUntil: 'networkidle' });
  if (width < 768) {
    await page.click('#drawer-open');
    await page.waitForTimeout(300);
    await page.click(`details[data-dir="${'技术文档'}"] summary`);
    await page.waitForTimeout(200);
  } else {
    await page.click(`details[data-dir="${'技术文档'}"] summary`);
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: path.join(out, `drawer-${width}.png`) });
  if (!(await page.locator('.tree-file', { hasText: '接口约定' }).isVisible())) problems.push(`${width}: 懒加载目录未显示`);
  await context.close();
}

const dark = await browser.newContext({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await dark.newPage();
await page.goto(`${origin}/s/${share.token}/v/${encodeURIComponent('项目周报')}/${encodeURIComponent('2026-W43.md')}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(out, 'share-375-dark.png') });
await browser.close();
server.closeAllConnections();
server.close();
kb.close();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错');
console.log(`截图 ${fs.readdirSync(out).length} 张：docs/screenshots/`);
