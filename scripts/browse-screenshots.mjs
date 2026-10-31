// 对着一个已经跑起来的向导截目录浏览器，375 / 1440 两档。真实库的截图含私人目录名，默认放 /tmp
// 用法：BROWSE_URL=http://localhost:3050 BROWSE_TOKEN=设置码 BROWSE_NAME=real BROWSE_DIR=进入的子目录名 npm run screenshots:browse
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.BROWSE_URL ?? 'http://localhost:3050';
const token = process.env.BROWSE_TOKEN ?? '';
const name = process.env.BROWSE_NAME ?? 'browse';
const dir = process.env.BROWSE_DIR;
const out = path.resolve(process.env.BROWSE_OUT ?? '/tmp/kb-browse-shots');
fs.mkdirSync(out, { recursive: true });

const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });

for (const width of [375, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`${width} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  const capture = async (step) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} ${step}: 横向溢出 ${overflow}px`);
    const file = path.join(out, `${name}-${step}-${width}.png`);
    await page.locator('#dir-browser').evaluate((el) => el.closest('fieldset').scrollIntoView());
    await page.screenshot({ path: file });
    console.log(file);
  };

  await page.goto(`${origin}/setup${token ? `?token=${token}` : ''}`);
  await page.waitForSelector('#dir-hints:not([hidden]) .dir-hint, #dir-command:not([hidden])', { timeout: 15000 });

  if (await page.locator('#dir-command').isVisible()) {
    await capture('no-mount');
    await context.close();
    continue;
  }
  await page.waitForSelector('.dir-row');
  await capture('list');
  await page.click('.dir-enter');
  await page.waitForSelector('.dir-crumb');
  await page.waitForSelector('#dir-list:not([aria-busy])', { state: 'attached' });
  if (dir) {
    await page.locator('.dir-row', { hasText: dir }).locator('.dir-enter').click();
    await page.waitForFunction((d) => document.querySelector('.dir-crumb-here')?.textContent === d, dir);
  }
  await capture('crumbs');
  await page.click('#dir-pick');
  await page.waitForSelector('#dir-selected:not([hidden])');
  await page.waitForSelector('#check-result .tiles, #check-result .alert', { timeout: 30000 });
  await capture('selected');
  await context.close();
}
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
