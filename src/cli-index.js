import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { pdfOptions } from './index-runner.js';
import { indexAll } from './indexer.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const result = await indexAll({ db, root: config.root, deny: createDeny(config.denyGlobs), full: process.argv.includes('--full'), pdf: pdfOptions(config) });
db.close();
console.log(`索引 ${result.total} 个文件，耗时 ${result.seconds.toFixed(2)} 秒`);
console.log(`  PDF ${result.pdf.total} 份，本次抽取 ${result.pdf.processed}，耗时 ${result.pdf.seconds.toFixed(2)} 秒；扫描件 ${result.pdf.noText}、已截断 ${result.pdf.truncated}、加密 ${result.pdf.encrypted}、读取失败 ${result.pdf.failed}`);
console.log(`  本次处理 ${result.processed}，删除 ${result.removed}；deny 命中文件 ${result.denied}、目录 ${result.deniedDirs}；内容敏感标记 ${result.sensitive}`);
