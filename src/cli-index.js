import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { runIndex } from './indexer.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const result = runIndex({ db, root: config.root, deny: createDeny(config.denyGlobs), full: process.argv.includes('--full') });
db.close();
console.log(`索引 ${result.total} 个文件，耗时 ${result.seconds.toFixed(2)} 秒`);
console.log(`  本次处理 ${result.processed}，删除 ${result.removed}；deny 命中文件 ${result.denied}、目录 ${result.deniedDirs}；内容敏感标记 ${result.sensitive}`);
