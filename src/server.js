import fs from 'node:fs';
import { createApp } from './app.js';
import { authWarnings, loadConfig } from './config.js';

const config = loadConfig();
for (const warning of authWarnings(config)) console.warn(`配置警告: ${warning}`);
// 平台首次安装时 /data 是空的，没有库目录也要能起来，否则健康检查不过会被回滚
if (!fs.existsSync(config.root)) {
  fs.mkdirSync(config.root, { recursive: true });
  console.warn(`库目录不存在，已创建空目录: ${config.root}`);
}
const { app, indexer } = await createApp(config);

const scan = (label) => indexer.run().then(
  (r) => console.log(`${label}: 索引 ${r.total} 个文件，处理 ${r.processed}，耗时 ${r.seconds.toFixed(2)} 秒`),
  () => console.error(`${label}: 索引失败`),
);

app.listen(config.port, () => {
  console.log(`知识库已启动，端口 ${config.port}`);
  scan('启动索引');
  setInterval(() => scan('增量索引'), config.scanIntervalMs).unref();
});
