// 把平台的设计令牌同步到 public/yh-vi.css，组件段原样保留。平台改 VI → 跑一次 → 应用跟上
//   node scripts/sync-vi.mjs            从 ../yihu-one 同步
//   node scripts/sync-vi.mjs --check    只比较，不一致时退出码 1（放 CI 里防手改）
//   --from <main.css> --to <yh-vi.css>  换来源或目标
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HEADER = '/* 由 scripts/sync-vi.mjs 从 yihu-one 平台同步，勿手改 */';
export const DIVIDER = '/* === 组件（本文件手写，同步时保留）=== */';
const DEFAULT_FROM = '../yihu-one/console/frontend/src/styles/main.css';
const DEFAULT_TO = 'public/yh-vi.css';
// Element Plus 的令牌应用用不到，只留主色和两个状态色，其余是控制台自己的
const EL_KEEP = ['--el-color-primary', '--el-color-success', '--el-color-danger'];

/** 取第一个 :root { } 里的令牌，顺序和值都不动 */
export function readTokens(css) {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1];
  if (!block) throw new Error('来源文件里没有 :root { } 块');
  const out = [];
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1].startsWith('--yh-') || EL_KEEP.includes(m[1])) out.push([m[1], m[2].trim()]);
  }
  if (!out.length) throw new Error('来源文件的 :root 里没有 --yh-* 令牌');
  return out;
}

/** 重写令牌段，分隔线以下一个字节都不动 */
export function render(tokens, current) {
  const at = current.indexOf(DIVIDER);
  if (at < 0) throw new Error(`目标文件里找不到分隔线：${DIVIDER}`);
  return `${HEADER}\n:root {\n${tokens.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n\n${current.slice(at)}`;
}

function main(argv) {
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const from = opt('--from', DEFAULT_FROM);
  const to = opt('--to', DEFAULT_TO);
  const tokens = readTokens(readFileSync(from, 'utf8'));
  const current = readFileSync(to, 'utf8');
  const next = render(tokens, current);
  if (argv.includes('--check')) {
    if (next === current) return console.log(`令牌一致，共 ${tokens.length} 个`);
    console.error('令牌和平台不一致，跑一次 node scripts/sync-vi.mjs');
    process.exitCode = 1;
    return;
  }
  writeFileSync(to, next);
  console.log(`已同步 ${tokens.length} 个令牌`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
