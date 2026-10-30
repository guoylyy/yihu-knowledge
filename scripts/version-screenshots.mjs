// 版本号的落点：登录页、顶栏、设置页「关于」，截 375 / 1440 两档。起一个真实进程（默认 3050），库和数据目录都是现造的临时目录
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PASSWORD = 'screenshot-pass-10';
const PORT = process.env.PORT || '3050';
const origin = `http://localhost:${PORT}`;
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-version-shots-'));
const library = path.join(base, 'library');
const out = path.resolve(process.env.VERSION_OUT ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/make-demo.js', library]);

const server = spawn('node', ['src/server.js'], {
  stdio: 'ignore',
  env: { PATH: process.env.PATH, HOME: base, PORT, KB_DATA_DIR: path.join(base, 'data'), KB_ROOT: library, KB_PASSWORD: PASSWORD, KB_COOKIE_INSECURE: '1', AI_PROVIDER: 'off' },
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`${origin}/health`).then((r) => r.ok, () => false)) break;
  await new Promise((resolve) => { setTimeout(resolve, 100); });
}

const { version } = await (await fetch(`${origin}/health`)).json();
const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });

for (const width of [375, 1440]) {
  const mobile = width === 375;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text())) problems.push(`${width} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  const capture = async (name) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
    await page.screenshot({ path: path.join(out, `version-${name}-${width}.png`) });
  };
  const expectVisible = async (selector, visible) => {
    const locator = page.locator(selector);
    if ((await locator.isVisible()) !== visible) problems.push(`${width} ${selector}: 可见性应为 ${visible}`);
    if (visible && !(await locator.innerText()).includes(`v${version}`)) problems.push(`${width} ${selector}: 不含 v${version}`);
  };

  await page.goto(`${origin}/login?next=${encodeURIComponent('/admin/settings')}`);
  await expectVisible('.login-version', true);
  await capture('login');
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForURL('**/admin/settings'), page.click('button[type=submit]')]);
  await expectVisible('.top-version', !mobile);
  await expectVisible('.about', true);
  await capture('settings');
  await page.goto(`${origin}/`);
  await expectVisible('.top-version', !mobile);
  await capture('home');
  await context.close();
}

await browser.close();
server.kill();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : `v${version}：登录页、设置页两档可见，顶栏桌面可见、手机收起，无横向溢出，无 console / CSP 报错`);
console.log(`截图：${out}/version-*.png`);
