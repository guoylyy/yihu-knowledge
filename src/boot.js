import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createApp } from './app.js';
import { probeMounts } from './browse.js';
import { authWarnings, loadConfig, loadSetupEnv, needsSetup } from './config.js';
import { createPlatformUsers } from './platform-users.js';
import { createSetupApp } from './routes/setup.js';
import { allowlistMembers } from './sso.js';

// 对外只有一个 handler：未配置时指向向导，向导收尾后原地换成正式应用，不用重启
export async function boot(env = process.env) {
  const state = { handler: null, kb: null, timer: null };
  // 向导和 /access 共用一份，只活在这个进程里，重启就换；白名单为空时才打到日志
  const setupToken = randomBytes(6).toString('hex');
  // 容器的挂载在进程活着时不会变，启动时看一次
  const mounts = probeMounts({ inDocker: loadSetupEnv(env).inDocker });
  if (mounts.length) console.log(`检测到挂载: ${mounts.join('、')}`);

  async function goLive(config) {
    for (const warning of authWarnings(config)) console.warn(`配置警告: ${warning}`);
    config.setupToken = setupToken;
    state.kb = await createApp(config, { env, mounts });
    state.handler = state.kb.app;
    if (config.sso && !config.sso.problem && !allowlistMembers(config).length) console.log(`白名单为空，打开 /access?token=${setupToken} 添加成员（设置码：${setupToken}）`);
  }

  function schedule(config, { scanNow }) {
    const scan = (label) => state.kb.indexer.run().then(
      (r) => console.log(`${label}: 索引 ${r.total} 个文件，处理 ${r.processed}，耗时 ${r.seconds.toFixed(2)} 秒`),
      () => console.error(`${label}: 索引失败`),
    );
    if (scanNow) scan('启动索引');
    if (config.scanIntervalMs) state.timer = setInterval(() => scan('增量索引'), config.scanIntervalMs).unref();
  }

  const stop = () => {
    clearInterval(state.timer);
    state.kb?.close();
  };
  const handler = (req, res) => state.handler(req, res);

  if (!needsSetup(env)) {
    const config = loadConfig(env);
    // 平台首次安装时 /data 是空的，没有库目录也要能起来，否则健康检查不过会被回滚
    if (!fs.existsSync(config.root)) {
      fs.mkdirSync(config.root, { recursive: true });
      console.warn(`库目录不存在，已创建空目录: ${config.root}`);
    }
    await goLive(config);
    return {
      handler, port: config.port, stop, state, setupToken,
      onListening() {
        console.log(`知识库已启动，端口 ${config.port}`);
        schedule(config, { scanNow: true });
      },
    };
  }

  const setupEnv = loadSetupEnv(env);
  const setup = createSetupApp({
    setupEnv,
    mounts,
    token: setupToken,
    platformUsers: createPlatformUsers({ clientId: env.YH_CLIENT_ID, clientSecret: env.YH_CLIENT_SECRET, apiUrl: env.YH_API_URL?.replace(/\/+$/, '') }),
    loadFinalConfig: () => loadConfig(env),
    async finish(config, result) {
      await goLive(config);
      console.log(`首次索引: 索引 ${result.total} 个文件，处理 ${result.processed}，耗时 ${result.seconds.toFixed(2)} 秒`);
      schedule(config, { scanNow: false });
    },
  });
  state.handler = setup.app;
  return {
    handler, port: setupEnv.port, stop, state, setupToken,
    onListening() {
      console.log(`知识库未配置，端口 ${setupEnv.port}`);
      console.log(`本机打开 http://localhost:${setupEnv.port}/setup 完成配置`);
      console.log(`从别的设备或反向代理配置时要用设置码：${setupToken}（也可以访问 /setup?token=${setupToken}）`);
    },
  };
}
