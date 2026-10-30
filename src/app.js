import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAi } from './ai.js';
import { basePathOf, createAuth } from './auth.js';
import { createCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createDeny } from './deny.js';
import { createIndexRunner } from './index-runner.js';
import { createPlatformUsers } from './platform-users.js';
import { pathErrorStatus, createReader } from './reader.js';
import { createSettings } from './settings.js';
import { createShares } from './shares.js';
import { createSso } from './sso.js';
import { accessRoutes } from './routes/access.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { privateRoutes } from './routes/private.js';
import { shareRoutes } from './routes/share.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const csp = (formTargets) => [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https:", "media-src 'self'",
  "frame-src 'self'", "connect-src 'self'", `form-action ${formTargets}`, "base-uri 'none'", "frame-ancestors 'self'",
].join('; ');

// 用户勾选列表每人一个字段，平台名单上限 2000 人；默认的 1000 不够
export const MAX_FORM_FIELDS = 3000;

// 向导和正式应用共用：路径前缀 + 安全响应头
export const commonHeaders = (policy, baseUrl) => (req, res, next) => {
  req.base = basePathOf(req);
  res.locals.base = req.base;
  res.set({
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-store',
  });
  if (baseUrl.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
};

export const notFound = (req, res) => res.status(404).render('error', { pageTitle: '未找到', ctx: null, title: '未找到', message: '页面不存在，或你没有访问权限。' });

export async function createApp(config, { env = process.env } = {}) {
  const db = openDb(config.dataDir);
  const deny = createDeny(config.denyGlobs);
  const indexer = createIndexRunner(config);
  const settings = createSettings({
    db, config, env, deny, indexer,
    async apply() {
      Object.assign(config, loadConfig(env));
      await assemble();
    },
  });
  let live;
  let builds = 0;

  // 库目录、登录方式、平台登录、CSP 都在这里定型，所以改设置时重新装配一次，而不是逐项改闭包。
  // 数据库连接和索引 worker 不重建：还没结束的请求继续用旧路由，同一个连接，不受影响
  async function assemble() {
    const build = ++builds;
    const realRoot = fs.realpathSync(config.root);
    const catalog = createCatalog(db);
    const auth = createAuth({ db, config });
    await auth.init();
    const shares = createShares({ db, catalog, config, deny });
    const reader = createReader({ db, catalog, realRoot });
    const ai = createAi({ db, config });
    const sso = config.sso && !config.sso.problem ? createSso(config.sso) : null;
    const platformUsers = createPlatformUsers(config.sso ?? {});
    const deps = { db, config, deny, realRoot, catalog, auth, shares, reader, ai, indexer, sso, platformUsers, settings };
    // 「退出平台登录」是表单提交后 303 到平台，Chrome 的 form-action 连重定向目标一起管
    const CSP = csp(sso ? `'self' ${new URL(config.sso.webUrl).origin}` : "'self'");

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.set('view engine', 'ejs');
    app.set('views', path.join(here, '..', 'views'));
    app.locals.siteName = config.siteName ?? '知识库';
    app.locals.ownerName = config.ownerName;
    const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' });
    app.locals.fmtTime = (ts) => (ts ? dateFmt.format(ts) : '—');

    app.use(commonHeaders(CSP, config.baseUrl));
    app.use('/assets', express.static(path.join(here, '..', 'public'), { maxAge: '1h', etag: true }));
    app.get(['/health', '/healthz'], (req, res) => res.type('text').send('ok'));
    // 必须排在登录拦截之前：否则未登录时是 302 到 /login，等于告诉外人这条路径有特殊待遇
    app.all(['/setup', '/setup/{*rest}'], notFound);
    app.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: MAX_FORM_FIELDS }));
    app.use(express.json({ limit: '256kb' }));
    app.use(auth.session);

    // 公开面只有这两组：登录（含平台回调）、分享链接。其余一切都在 requireAuth 之后
    app.use(authRoutes(deps));
    app.use('/s', shareRoutes(deps));
    // 要接住设置码和临时会话，所以排在 requireAuth 前面，自己把关
    app.use('/access', accessRoutes(deps));
    app.use(auth.requireAuth);
    app.use(privateRoutes(deps));
    app.use('/admin', adminRoutes(deps));

    app.use(notFound);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      const status = pathErrorStatus(err) ?? (err.status >= 400 && err.status < 500 ? err.status : 500);
      if (status >= 500) console.error(`请求失败: ${err.name} ${err.code ?? ''}`);
      if (res.headersSent) return res.destroy();
      res.status(status).render('error', {
        pageTitle: '无法访问', ctx: null, title: status === 403 ? '拒绝访问' : status === 404 ? '未找到' : '出错了',
        message: status === 403 || status === 404 ? '页面不存在，或你没有访问权限。' : '服务暂时不可用，请稍后再试。',
      });
    });

    if (build === builds) live = app;
    return deps;
  }

  const deps = await assemble();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => live(req, res, next));

  return { app, ...deps, close: () => db.close() };
}
