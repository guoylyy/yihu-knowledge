// 把 pdfjs-dist 里浏览器要用的文件拷到 public/vendor/pdfjs/，离线可用、不走 CDN。升级 pdfjs-dist 后重跑一次：npm run vendor:pdfjs
// 用 legacy 构建：现代构建要求很新的浏览器，主要读者是手机，iOS 15/16 还要能打开
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const from = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const to = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'pdfjs');
const FILES = ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE'];
const DIRS = ['cmaps', 'standard_fonts', 'iccs'];
const WASM = /^(jbig2|openjpeg|qcms)|^LICENSE/;

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const file of FILES) fs.copyFileSync(path.join(from, file), path.join(to, path.basename(file)));
for (const dir of DIRS) fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
fs.mkdirSync(path.join(to, 'wasm'));
for (const name of fs.readdirSync(path.join(from, 'wasm')).filter((n) => WASM.test(n))) fs.copyFileSync(path.join(from, 'wasm', name), path.join(to, 'wasm', name));
const { version } = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(to, 'VERSION'), `${version}\n`);
console.log(`pdfjs-dist ${version} -> ${path.relative(process.cwd(), to)}`);
