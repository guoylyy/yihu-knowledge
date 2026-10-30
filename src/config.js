import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude, resolveProvider } from './ai-providers.js';
import { findSoffice } from './convert.js';
import { allowlistMembers } from './sso.js';

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

export const splitList = (spec = '') => spec.split(',').map((s) => s.trim()).filter(Boolean);
const trimUrl = (url = '') => url.replace(/\/+$/, '');
const dataDirOf = (env) => path.resolve(expandHome(env.KB_DATA_DIR || './data'));
const portOf = (env) => Number(env.PORT || 3030);
const MB = 1024 * 1024;
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

export const configFileOf = (env = process.env) => path.join(dataDirOf(env), 'config.json');

// 文件坏了要报错而不是当成「未配置」：否则一次手误就把向导重新暴露出来
function readConfigFile(env) {
  const file = configFileOf(env);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`读不了配置文件 ${file}（${err.code}）`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* 走下面的统一报错 */ }
  throw new Error(`配置文件不是合法的 JSON：${file}。修好它，或删除后重启重新配置`);
}

export const needsSetup = (env = process.env) => !env.KB_ROOT && !readConfigFile(env);

// 向导要知道的环境信息都从这里拿
export function loadSetupEnv(env = process.env) {
  const missing = (names) => names.filter((k) => !env[k]);
  return {
    dataDir: dataDirOf(env),
    configFile: configFileOf(env),
    port: portOf(env),
    inDocker: env.KB_IN_DOCKER === '1' || fs.existsSync('/.dockerenv'),
    ssoMissing: missing(['YH_CLIENT_ID', 'YH_CLIENT_SECRET', 'YH_WEB_URL', 'YH_API_URL']),
    platformAiMissing: missing(['YH_CLIENT_ID', 'YH_CLIENT_SECRET', 'YH_API_URL']),
    claudeBin: findClaude(env),
    soffice: findSoffice(env),
    denyGlobs: effectiveDenyGlobs(env.KB_DENY_GLOBS),
    overrides: ['AUTH_MODE', 'KB_PASSWORD', 'KB_ALLOWED_USERS', 'KB_OWNER_NAME', 'KB_BASE_URL', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].filter((k) => env[k]),
  };
}

// password 模式返回 null：即使环境里有 YH_*，也完全不启用 SSO
function loadSso(env, authMode, fileBaseUrl) {
  if (authMode === 'password') return null;
  const sso = {
    clientId: env.YH_CLIENT_ID || '',
    clientSecret: env.YH_CLIENT_SECRET || '',
    webUrl: trimUrl(env.YH_WEB_URL),
    apiUrl: trimUrl(env.YH_API_URL),
    appUrl: trimUrl(env.YH_APP_URL || env.KB_BASE_URL || fileBaseUrl),
    basePath: trimUrl(env.YH_BASE_PATH),
  };
  const missing = [['YH_CLIENT_ID', sso.clientId], ['YH_CLIENT_SECRET', sso.clientSecret], ['YH_WEB_URL', sso.webUrl], ['YH_API_URL', sso.apiUrl], ['YH_APP_URL', sso.appUrl]]
    .filter(([, v]) => !v).map(([k]) => k);
  return { ...sso, problem: missing.length ? `未配置 ${missing.join(' / ')}` : null };
}

// KB_ALLOWED_USERS 非空时整份白名单都听它的，config.json 里的 id 也不能再放人进来
function allowlistOf(env, file, pick, sources) {
  const fromEnv = splitList(env.KB_ALLOWED_USERS);
  const allowedUsers = pick('allowedUsers', fromEnv.length ? fromEnv : '', file?.allowedUsers, []);
  if (fromEnv.length) return { allowedUsers, allowedUserIds: [], allowedProfiles: {} };
  const allowedUserIds = Array.isArray(file?.allowedUserIds) ? file.allowedUserIds : [];
  if (allowedUserIds.length) sources.allowedUsers = 'file';
  return { allowedUsers, allowedUserIds, allowedProfiles: file?.allowedProfiles ?? {} };
}

// 优先级：环境变量 > config.json > 默认值。空字符串算没设，docker compose 会把没填的变量传成空串
export function loadConfig(env = process.env) {
  const file = readConfigFile(env);
  const ai = file?.ai ?? {};
  const sources = {};
  const pick = (key, envValue, fileValue, fallback = '') => {
    if (envValue) { sources[key] = 'env'; return envValue; }
    if (fileValue?.length) { sources[key] = 'file'; return fileValue; }
    sources[key] = 'default';
    return fallback;
  };

  const rootSpec = pick('root', env.KB_ROOT, file?.root);
  if (!rootSpec) throw new Error('缺少 KB_ROOT 环境变量，也没有 config.json。先用 npm start 打开配置向导');
  const authMode = pick('authMode', env.AUTH_MODE, file?.authMode, 'password').trim().toLowerCase();
  if (!AUTH_MODES.includes(authMode)) throw new Error(`AUTH_MODE 只能是 ${AUTH_MODES.join(' / ')}`);
  const port = portOf(env);
  const appUrl = authMode === 'password' ? '' : env.YH_APP_URL;
  const baseUrl = trimUrl(pick('baseUrl', env.KB_BASE_URL || appUrl, file?.baseUrl, `http://localhost:${port}`));
  const aiProvider = pick('aiProvider', env.AI_PROVIDER, ai.provider, resolveProvider(env));
  return {
    root: path.resolve(expandHome(rootSpec)),
    dataDir: dataDirOf(env),
    configFile: file ? configFileOf(env) : null,
    password: pick('password', env.KB_PASSWORD, file?.passwordHash),
    authMode,
    ...allowlistOf(env, file, pick, sources),
    sso: loadSso(env, authMode, file?.baseUrl),
    baseUrl,
    port,
    denyGlobs: effectiveDenyGlobs(env.KB_DENY_GLOBS),
    siteName: pick('siteName', '', file?.siteName, '知识库'),
    ownerName: pick('ownerName', env.KB_OWNER_NAME, file?.ownerName, '知识库主人'),
    trustProxy: Number(env.KB_TRUST_PROXY || 0),
    // 向导配出来的实例常常先跑在 http 上，带 Secure 的 cookie 浏览器不存，表现为登录后又跳回登录页
    cookieSecure: env.KB_COOKIE_INSECURE !== '1' && !(file && baseUrl.startsWith('http:')),
    aiProvider,
    aiMaxChars: Number(env.AI_MAX_CHARS) > 0 ? Number(env.AI_MAX_CHARS) : 40000,
    aiBaseUrl: pick('aiBaseUrl', env.AI_BASE_URL, ai.baseUrl),
    aiApiKey: pick('aiApiKey', env.AI_API_KEY, ai.apiKey),
    aiModel: pick('aiModel', env.AI_MODEL, ai.model),
    aiCliModel: env.AI_CLI_MODEL || '',
    aiClaudeBin: findClaude(env),
    aiPlatformUrl: trimUrl(env.YH_API_URL),
    aiPlatformId: env.YH_CLIENT_ID || '',
    aiPlatformSecret: env.YH_CLIENT_SECRET || '',
    aiPlatformModel: env.AI_PLATFORM_MODEL || '',
    timeZone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    zipMaxBytes: Number(env.KB_ZIP_MAX_MB || 1024) * 1024 * 1024,
    previewMaxBytes: positive(env.KB_PREVIEW_MAX_MB, 200) * MB,
    previewCacheBytes: positive(env.KB_PREVIEW_CACHE_MB, 2048) * MB,
    convertTimeoutMs: positive(env.KB_CONVERT_TIMEOUT_S, 120) * 1000,
    pdfMaxPages: positive(env.KB_PDF_MAX_PAGES, 50),
    soffice: findSoffice(env),
    scanIntervalMs: 30 * 60 * 1000,
    sources,
  };
}

export const SOURCE_LABELS = { env: '环境变量', file: '配置文件', default: '默认值' };

// /admin 用来排查「这一项到底是谁定的」；口令和 key 只说有没有，不给值
export function configSummary(config) {
  const isSet = (v) => (v ? '已设置' : '未设置');
  return [
    ['知识库目录', 'root', config.root],
    ['站点名', 'siteName', config.siteName],
    ['主人名', 'ownerName', config.ownerName],
    ['对外地址', 'baseUrl', config.baseUrl],
    ['登录方式', 'authMode', config.authMode],
    ['登录口令', 'password', isSet(config.password)],
    ['白名单', 'allowedUsers', `${allowlistMembers(config).length} 人`],
    ['AI 通道', 'aiProvider', config.aiProvider],
    ['AI 接口地址', 'aiBaseUrl', config.aiBaseUrl || '—'],
    ['AI Key', 'aiApiKey', isSet(config.aiApiKey)],
    ['AI 模型', 'aiModel', config.aiModel || '—'],
  ].map(([label, key, value]) => ({ label, value, source: SOURCE_LABELS[config.sources?.[key]] ?? '—' }));
}

// 启动时打到日志；都不致命：登录页会把同样的原因展示给访问者
export function authWarnings(config) {
  const out = [];
  if (config.sso?.problem) out.push(`AUTH_MODE=${config.authMode} 但${config.sso.problem}，平台登录入口已禁用`);
  if (config.sso && !allowlistMembers(config).length) out.push('白名单为空，所有平台账号都会被拒绝');
  if (config.authMode === 'sso' && config.password) out.push('AUTH_MODE=sso 时 KB_PASSWORD 不生效，口令登录已关闭');
  if (config.configFile && !config.cookieSecure) out.push(`对外地址是 ${config.baseUrl}，登录 cookie 不带 Secure。公网部署请走 HTTPS，并设 KB_BASE_URL`);
  return out;
}
