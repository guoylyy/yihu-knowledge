// 用模拟平台走一遍用户勾选和 /access，截 375 / 1440 两档；名单全是假数据，真实用户不进仓库
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { boot } from '../src/boot.js';

const USERS = [
  ['demo-admin', '演示管理员', '信息中心', '平台管理员'], ['demo-chen', '陈示例', '研发部', '后端工程师'], ['demo-lin', '林样本', '研发部', '前端工程师'],
  ['demo-zhao', '赵假名', '产品部', '产品经理'], ['demo-sun', '孙虚构', '市场部', '市场专员'], ['demo-zhou', '周测试', '财务部', '会计'],
  ['demo-wu', '吴占位', '行政部', null], ['demo-long-name', '名字特别特别长的一位演示同事', '一个名字也特别长的部门用来测试换行', '一个同样很长的职务名称'],
].map(([username, name, dept, title], i) => ({
  id: i + 1, username, name, title, avatar: i === 1 ? 'https://cdn.mock.test/ok.svg' : i === 2 ? 'https://cdn.mock.test/broken.png' : null, jobNumber: `D${100 + i}`, mobile: null, active: true, depts: [{ id: i, name: dept, isPrimary: true }],
}));
const STRANGER = { id: 77, username: 'demo-visitor', name: '访客示例' };

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-access-shots-'));
const library = path.join(base, 'library');
const out = path.resolve(process.env.ACCESS_OUT ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/make-demo.js', library]);

// 模拟平台：浏览器走 /sso/authorize 时以 platform.who 的身份回跳
const platform = { who: 'demo-admin', down: false };
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (url.pathname === '/sso/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', platform.who);
    back.searchParams.set('state', url.searchParams.get('state'));
    return res.writeHead(302, { Location: back.href }).end();
  }
  if (url.pathname === '/api/sso/token') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      const { code } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      json(200, { code: 0, data: { user: [...USERS, STRANGER].find((u) => u.username === code) } });
    });
  }
  if (platform.down) return res.writeHead(502).end();
  json(200, { code: 0, data: { total: USERS.length, list: USERS } });
});
await new Promise((resolve) => { mock.listen(0, '127.0.0.1', resolve); });
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

const PLATFORM_ENV = { HOME: '/nonexistent', PATH: '', YH_CLIENT_ID: 'demo', YH_CLIENT_SECRET: 'demo', YH_WEB_URL: mockUrl, YH_API_URL: mockUrl, KB_COOKIE_INSECURE: '1' };

const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });

async function start(env) {
  const booted = await boot({ ...PLATFORM_ENV, ...env });
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { booted, server, origin: `http://localhost:${server.address().port}` };
}

async function stop({ booted, server }) {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
  booted.stop();
}

// 回调地址要提前知道端口，所以先占一个再放掉
async function live(name, width, env) {
  const probe = http.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  const booted = await boot({ ...PLATFORM_ENV, KB_ROOT: library, KB_DATA_DIR: path.join(base, `${name}-${width}`), AUTH_MODE: 'sso', YH_APP_URL: `http://localhost:${port}`, ...env });
  const server = http.createServer(booted.handler);
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  return { booted, server, origin: `http://localhost:${port}` };
}

async function newPage(width) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 780 : 900 }, deviceScaleFactor: width === 375 ? 2 : 1, hasTouch: width === 375, colorScheme: 'light' });
  await context.route('https://cdn.mock.test/ok.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" fill="#5b8def"/></svg>' }));
  await context.route('https://cdn.mock.test/broken.png', (route) => route.abort());
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text())) problems.push(`${width} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${width} pageerror: ${e.message}`));
  return page;
}

async function capture(page, width, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`${width} ${name}: 横向溢出 ${overflow}px`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, `access-${name}-${width}.png`), fullPage: true });
}

for (const width of [375, 1440]) {
  const page = await newPage(width);

  // 向导第三步：搜索、勾选、回车不提交
  const w = await start({ KB_DATA_DIR: path.join(base, `wizard-${width}`) });
  await page.goto(`${w.origin}/setup`);
  await page.locator('input[name=authMode][value=sso]').check({ force: true });
  await page.locator('input[name=member][value="1"]').check({ force: true });
  await page.locator('input[name=member][value="2"]').check({ force: true });
  await capture(page, width, 'wizard-picker');
  await page.fill('[data-picker-search]', 'D102');
  if ((await page.locator('.picker-list li:visible').count()) !== 1) problems.push(`${width}: 按号码搜索结果不是 1 行`);
  await page.press('[data-picker-search]', 'Enter');
  if (!page.url().endsWith('/setup') || (await page.locator('#setup-progress').count())) problems.push(`${width}: 搜索框回车提交了表单`);
  await page.locator('input[name=member][value="3"]').check({ force: true });
  if ((await page.textContent('[data-picker-count]')) !== '3') problems.push(`${width}: 已选人数不对`);
  await page.fill('[data-picker-search]', '不存在的人');
  if (!(await page.locator('[data-picker-empty]').isVisible())) problems.push(`${width}: 没有显示无匹配提示`);
  await stop(w);

  // 拉不到列表：退回手填
  platform.down = true;
  const fallback = await start({ KB_DATA_DIR: path.join(base, `fallback-${width}`) });
  await page.goto(`${fallback.origin}/setup`);
  await page.locator('input[name=authMode][value=sso]').check({ force: true });
  if (!(await page.locator('#picker-reason').isVisible())) problems.push(`${width}: 手填模式没有说明原因`);
  await capture(page, width, 'wizard-fallback');
  await stop(fallback);
  platform.down = false;

  // 白名单为空：设置码打开临时会话
  const empty = await live('empty', width, {});
  platform.who = 'demo-admin';
  await page.goto(`${empty.origin}/sso/login`);
  if (!(await page.textContent('body')).includes('设置码')) problems.push(`${width}: 403 页没有设置码引导`);
  await capture(page, width, 'denied-empty');
  await page.goto(`${empty.origin}/access?token=${empty.booted.setupToken}`);
  await page.waitForFunction(() => !location.search);
  await capture(page, width, 'temporary');
  await page.locator('input[name=member][value="1"]').check({ force: true });
  await Promise.all([page.waitForURL('**/access?saved=1'), page.getByRole('button', { name: '保存' }).click()]);

  // 名单外的人被拒绝后，一键加入
  const visitor = await newPage(width);
  platform.who = 'demo-visitor';
  await visitor.goto(`${empty.origin}/sso/login`);
  await visitor.context().close();
  await page.goto(`${empty.origin}/access`);
  await capture(page, width, 'page');
  if (await page.locator('.avatar img[src*="broken"]').count()) problems.push(`${width}: 坏头像没有退回首字`);
  await Promise.all([page.waitForURL('**/access?saved=1'), page.getByRole('button', { name: '加入白名单' }).first().click()]);
  if (!(await page.textContent('body')).includes('已在白名单')) problems.push(`${width}: 一键加入后状态没变`);
  await capture(page, width, 'approved');
  await stop(empty);

  // 环境变量控制：只读
  platform.who = 'demo-admin';
  const env = await live('env', width, { KB_ALLOWED_USERS: 'demo-admin,demo-chen' });
  await page.context().clearCookies();
  await page.goto(`${env.origin}/sso/login?next=${encodeURIComponent('/access')}`);
  await page.waitForURL('**/access');
  if (await page.locator('[data-picker], form[action$="/access/remove"]').count()) problems.push(`${width}: 环境变量控制时还能改`);
  await capture(page, width, 'env-readonly');
  await stop(env);
  await page.context().close();
}

await browser.close();
mock.closeAllConnections();
mock.close();
fs.rmSync(base, { recursive: true, force: true });
console.log(problems.length ? problems.join('\n') : '无横向溢出，无 console / CSP 报错，交互全部符合预期');
console.log(`截图：${out}/access-*.png`);
