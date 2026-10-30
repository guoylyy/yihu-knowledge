import os from 'node:os';
import path from 'node:path';
import { findClaude, resolveProvider } from './ai-providers.js';

export const DEFAULT_DENY = [
  '.obsidian/', '.git/', '.tmp.*/', 'node_modules/', '.vmark/', '.trash/', '.DS_Store',
  '*.env', '.env.*', '*.key', '*.pem', '*.p12', '*.pfx', 'id_rsa*',
  '*密码*', '*password*', '*secret*', '*token*', '银行*', '*身份证*',
];

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// KB_DENY_GLOBS 在默认规则上追加；`!规则` 表示移除一条默认规则，避免配置时不小心丢掉全部默认保护
export function effectiveDenyGlobs(spec = '') {
  const rules = new Set(DEFAULT_DENY);
  for (const raw of spec.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (item.startsWith('!')) rules.delete(item.slice(1));
    else rules.add(item);
  }
  return [...rules];
}

export const AUTH_MODES = ['password', 'sso', 'both'];

const splitList = (spec = '') => spec.split(',').map((s) => s.trim()).filter(Boolean);
const trimUrl = (url = '') => url.replace(/\/+$/, '');

// password 模式返回 null：即使环境里有 YH_*，也完全不启用 SSO
function loadSso(env, authMode) {
  if (authMode === 'password') return null;
  const sso = {
    clientId: env.YH_CLIENT_ID || '',
    clientSecret: env.YH_CLIENT_SECRET || '',
    webUrl: trimUrl(env.YH_WEB_URL),
    apiUrl: trimUrl(env.YH_API_URL),
    appUrl: trimUrl(env.YH_APP_URL || env.KB_BASE_URL),
    basePath: trimUrl(env.YH_BASE_PATH),
  };
  const missing = [['YH_CLIENT_ID', sso.clientId], ['YH_CLIENT_SECRET', sso.clientSecret], ['YH_WEB_URL', sso.webUrl], ['YH_API_URL', sso.apiUrl], ['YH_APP_URL', sso.appUrl]]
    .filter(([, v]) => !v).map(([k]) => k);
  return { ...sso, problem: missing.length ? `未配置 ${missing.join(' / ')}` : null };
}

export function loadConfig(env = process.env) {
  if (!env.KB_ROOT) throw new Error('缺少 KB_ROOT 环境变量');
  const authMode = (env.AUTH_MODE || 'password').trim().toLowerCase();
  if (!AUTH_MODES.includes(authMode)) throw new Error(`AUTH_MODE 只能是 ${AUTH_MODES.join(' / ')}`);
  const port = Number(env.PORT || 3030);
  const appUrl = authMode === 'password' ? '' : env.YH_APP_URL;
  return {
    root: path.resolve(expandHome(env.KB_ROOT)),
    dataDir: path.resolve(expandHome(env.KB_DATA_DIR || './data')),
    password: env.KB_PASSWORD || '',
    authMode,
    allowedUsers: splitList(env.KB_ALLOWED_USERS),
    sso: loadSso(env, authMode),
    baseUrl: trimUrl(env.KB_BASE_URL || appUrl || `http://localhost:${port}`),
    port,
    denyGlobs: effectiveDenyGlobs(env.KB_DENY_GLOBS),
    ownerName: env.KB_OWNER_NAME || '知识库主人',
    trustProxy: Number(env.KB_TRUST_PROXY || 0),
    cookieSecure: env.KB_COOKIE_INSECURE !== '1',
    aiProvider: resolveProvider(env),
    aiMaxChars: Number(env.AI_MAX_CHARS) > 0 ? Number(env.AI_MAX_CHARS) : 40000,
    aiBaseUrl: env.AI_BASE_URL || '',
    aiApiKey: env.AI_API_KEY || '',
    aiModel: env.AI_MODEL || '',
    aiCliModel: env.AI_CLI_MODEL || '',
    aiClaudeBin: findClaude(env),
    aiPlatformUrl: trimUrl(env.YH_API_URL),
    aiPlatformId: env.YH_CLIENT_ID || '',
    aiPlatformSecret: env.YH_CLIENT_SECRET || '',
    aiPlatformModel: env.AI_PLATFORM_MODEL || '',
    timeZone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    zipMaxBytes: Number(env.KB_ZIP_MAX_MB || 1024) * 1024 * 1024,
    scanIntervalMs: 30 * 60 * 1000,
  };
}

// 启动时打到日志；都不致命：登录页会把同样的原因展示给访问者
export function authWarnings(config) {
  const out = [];
  if (config.sso?.problem) out.push(`AUTH_MODE=${config.authMode} 但${config.sso.problem}，平台登录入口已禁用`);
  if (config.sso && !config.allowedUsers.length) out.push('KB_ALLOWED_USERS 为空，所有平台账号都会被拒绝');
  if (config.authMode === 'sso' && config.password) out.push('AUTH_MODE=sso 时 KB_PASSWORD 不生效，口令登录已关闭');
  return out;
}
