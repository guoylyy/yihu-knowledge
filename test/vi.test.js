import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DIVIDER, HEADER, readTokens, render } from '../scripts/sync-vi.mjs';

const PLATFORM_CSS = '../yihu-one/console/frontend/src/styles/main.css';
const SOURCE = `/* 不相关 */
:root {
  /* 注释里的 --yh-fake: 1; 不算 */
  --yh-primary: #123456;
  --yh-radius: 12px;
  --el-color-primary: #123456;
  --el-color-primary-light-3: #777777;
}
.other { --yh-not-root: 1; }
`;
const read = (p) => fs.readFileSync(p, 'utf8');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const views = (dir = 'views') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? views(p) : p.endsWith('.ejs') ? [p] : [];
});

test('令牌：--yh-* 全要，--el-* 只留主色和状态色，值原样，注释不算', () => {
  assert.deepEqual(readTokens(SOURCE), [['--yh-primary', '#123456'], ['--yh-radius', '12px'], ['--el-color-primary', '#123456']]);
  assert.throws(() => readTokens('body { color: red }'), /没有 :root/);
});

test('同步：只动令牌段，组件段一个字节不变；没有分隔线时报错', () => {
  const current = `${HEADER}\n:root {\n  --yh-primary: #000000;\n}\n\n${DIVIDER}\n.yh-btn { color: var(--yh-primary); }\n`;
  const next = render(readTokens(SOURCE), current);
  assert.match(next, /--yh-primary: #123456;/);
  assert.equal(next.slice(next.indexOf(DIVIDER)), current.slice(current.indexOf(DIVIDER)));
  assert.throws(() => render(readTokens(SOURCE), '.yh-btn {}'), /分隔线/);
});

test('同步脚本：--check 能发现手改', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-vi-'));
  try {
    const from = path.join(dir, 'main.css');
    const to = path.join(dir, 'vi.css');
    fs.writeFileSync(from, SOURCE);
    fs.writeFileSync(to, `${DIVIDER}\n.x {}\n`);
    const run = (...args) => execFileSync(process.execPath, ['scripts/sync-vi.mjs', '--from', from, '--to', to, ...args], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(run(), /已同步 3 个令牌/);
    assert.match(run('--check'), /令牌一致/);
    fs.writeFileSync(from, SOURCE.replaceAll('#123456', '#654321'));
    assert.throws(() => run('--check'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yh-vi.css 的令牌和平台 main.css 完全一致', { skip: !fs.existsSync(PLATFORM_CSS) && '没有平台仓库' }, () => {
  assert.deepEqual(readTokens(read('public/yh-vi.css')), readTokens(read(PLATFORM_CSS)));
});

test('yh-vi.css 在 app.css 之前引入', () => {
  const head = read('views/partials/head.ejs');
  assert.ok(head.indexOf('/assets/yh-vi.css') > 0);
  assert.ok(head.indexOf('/assets/yh-vi.css') < head.indexOf('/assets/app.css'));
});

test('组件段只有 .yh-* 类，没有全局规则：引入它不影响现有页面', () => {
  const vi = read('public/yh-vi.css');
  const body = noComments(vi.slice(vi.indexOf(DIVIDER)));
  for (const [, selector] of body.matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)) {
    if (/:root/.test(selector) || /--/.test(selector.split(':')[0]) && !selector.includes('.')) continue;
    for (const one of selector.split(',')) assert.match(one.trim(), /^(a)?\.yh-/, one);
  }
});

test('app.css 和模板里没有十六进制颜色', () => {
  for (const file of ['public/app.css', ...views()]) assert.deepEqual(read(file).match(/#[0-9a-fA-F]{3,6}\b/g), null, file);
});

test('app.css 用到的变量都有定义，改名不漏', () => {
  const vi = read('public/yh-vi.css');
  const app = read('public/app.css');
  const defined = new Set([...`${vi}\n${app}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const [, name, fallback] of app.matchAll(/var\((--[\w-]+)(,)?/g)) {
    if (!fallback && name !== '--ai-vh') assert.ok(defined.has(name), name);
  }
  for (const [, name] of read('public/graph.js').matchAll(/v\('(--[\w-]+)'\)/g)) assert.ok(defined.has(name), `graph.js ${name}`);
});

test('深色模式覆盖了主色，近黑不会落在深色底上', () => {
  const blocks = read('public/yh-vi.css').match(/:root\[data-theme="dark"\] \{[^}]*\}/g).join('\n');
  for (const name of ['--yh-primary', '--yh-on-primary', '--yh-bg', '--yh-card', '--yh-text']) assert.match(blocks, new RegExp(`${name}: #`), name);
});

test('app.css 里强调色只用一处；圆角只用两档令牌，圆形和拆开分段除外', () => {
  const app = noComments(read('public/app.css'));
  assert.equal(app.match(/var\(--yh-highlight\)/g).length, 1);
  for (const [, value] of app.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.match(value, /^(var\(--yh-radius(-sm)?\)( var\(--yh-radius(-sm)?\)){0,3}( 0 0)?|50%|0)$/, value);
  }
});
