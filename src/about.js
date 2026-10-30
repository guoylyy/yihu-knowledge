import fs from 'node:fs';

const PACKAGE = new URL('../package.json', import.meta.url);
const MANIFEST = new URL('../yh-app.json', import.meta.url);

// 平台发版时可以往 yh-app.json 写 builtAt；本地跑或没写时退回 package.json 的修改时间
export function readBuiltAt(manifest = MANIFEST, pkg = PACKAGE) {
  try {
    const stamp = Date.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')).builtAt);
    if (stamp) return stamp;
  } catch { /* 没有清单或清单坏了都不影响启动 */ }
  return fs.statSync(pkg).mtimeMs;
}

// 启动时读一次，运行中改文件不算换版本
export const VERSION = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')).version;
const BUILT_AT = readBuiltAt();

export const modeOf = (soffice) => (soffice ? 'full' : 'lite');

export const aboutInfo = (soffice) => ({ builtAt: BUILT_AT, mode: modeOf(soffice), node: process.version });

// 免登录，只放排障要用的这几个字段：路径、口令、key、白名单一律不进来
export const healthCheck = (soffice) => (req, res) => {
  if (req.query.plain === '1') return res.type('text').send('ok');
  return res.json({ status: 'ok', version: VERSION, mode: modeOf(soffice), uptime: Math.floor(process.uptime()) });
};
