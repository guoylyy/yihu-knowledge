import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_MODES, splitList } from './config.js';
import { isIgnoredEntry } from './indexer.js';

export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 1024; // 登录时只取前 1024 位，再长就永远对不上
const MAX_NAME = 40;
export const AI_PROVIDERS = ['platform', 'openai', 'claude-cli', 'off'];
export const KEY_MASK = '******';

// 检测要能经得起手滑填 `/`：到上限就停，不把机器扫一遍
const MAX_SCAN_ENTRIES = 200000;
const FILES_PER_SECOND = 800;
const EXAMPLES = 5;

const isDenied = (err) => err.code === 'EACCES' || err.code === 'EPERM';

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function expandRoot(input) {
  const value = String(input ?? '').trim();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

// 数据目录写不进去时，提交必然失败。Docker 绑定挂载的属主不对是最常见的原因，打开页面就要说
export function dataDirProblem(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.accessSync(dataDir, fs.constants.W_OK);
    return null;
  } catch (err) {
    return `数据目录 ${dataDir} 写不进去（${err.code}）。请把它改成运行用户可写的目录，或用 KB_DATA_DIR 换一个位置。`;
  }
}

// 口径和 indexer 的 walk 一致：不跟随符号链接、deny 目录不进入。用异步 readdir，大目录扫描时其它请求还能响应
export async function inspectLibrary(input, { deny, dataDir }) {
  const root = expandRoot(input);
  if (!root) return { ok: false, error: '请填写知识库目录' };
  if (!path.isAbsolute(root)) return { ok: false, error: '请填写绝对路径，例如 /home/me/notes' };
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
    if (!(await fsp.stat(realRoot)).isDirectory()) return { ok: false, error: '这不是一个目录' };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { ok: false, error: '目录不存在' };
    if (isDenied(err)) return { ok: false, error: '没有读取权限' };
    throw err;
  }
  // 库里的文件都会被索引并可分享，数据目录放在里面的话 config.json 也在其中
  if (isInside(realRoot, fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir))) {
    return { ok: false, error: '数据目录在这个目录里面，配置文件和数据库会被当成笔记。换一个目录，或用 KB_DATA_DIR 把数据放到库外面' };
  }

  const byExt = {};
  const deniedExamples = [];
  let files = 0;
  let denied = 0;
  let entries = 0;
  let truncated = false;
  const noteDenied = (rel) => {
    denied++;
    if (deniedExamples.length < EXAMPLES) deniedExamples.push(rel);
  };
  const stack = [''];
  while (stack.length && !truncated) {
    const relDir = stack.pop();
    let list;
    try {
      list = await fsp.readdir(path.join(realRoot, relDir), { withFileTypes: true });
    } catch (err) {
      if (isDenied(err)) return { ok: false, error: relDir ? `没有读取权限：${relDir}` : '没有读取权限' };
      if (err.code === 'ENOENT') continue; // 扫描途中被删了
      throw err;
    }
    for (const entry of list) {
      if (isIgnoredEntry(entry)) continue;
      if (++entries > MAX_SCAN_ENTRIES) { truncated = true; break; }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (deny.isDenied(rel, { isDir: true })) noteDenied(`${rel}/`);
        else stack.push(rel);
      } else if (entry.isFile()) {
        if (deny.isDenied(rel)) { noteDenied(rel); continue; }
        files++;
        const dot = entry.name.lastIndexOf('.');
        const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '无后缀';
        byExt[ext] = (byExt[ext] ?? 0) + 1;
      }
    }
  }
  if (!files) return { ok: false, error: denied ? '目录里的文件全部被 deny 规则排除了' : '目录是空的' };
  const report = {
    ok: true, root: realRoot, files, byExt, obsidian: fs.existsSync(path.join(realRoot, '.obsidian')),
    estimatedSeconds: Math.max(1, Math.ceil(files / FILES_PER_SECOND)), denied, deniedExamples,
  };
  return truncated ? { ...report, truncated: true } : report;
}

// 只校验表单本身；目录由 inspectLibrary 负责，口令 hash 由调用方算
export function validateForm(form, { setupEnv, keyDraft = '' }) {
  const text = (name) => String(form[name] ?? '').trim();
  const errors = [];
  const authMode = text('authMode');
  const aiProvider = text('aiProvider') || 'off';
  const password = String(form.password ?? '');
  const typedKey = text('aiApiKey');
  const values = {
    root: text('root'), siteName: text('siteName') || '知识库', ownerName: text('ownerName') || '管理员',
    authMode, allowedUsers: splitList(text('allowedUsers')), allowedUserIds: [], allowedProfiles: {}, aiProvider, aiBaseUrl: text('aiBaseUrl'), aiModel: text('aiModel'),
    aiApiKey: typedKey && typedKey !== KEY_MASK ? typedKey : keyDraft,
  };

  if (values.siteName.length > MAX_NAME) errors.push(`站点名不能超过 ${MAX_NAME} 个字`);
  if (values.ownerName.length > MAX_NAME) errors.push(`主人名不能超过 ${MAX_NAME} 个字`);

  if (!AUTH_MODES.includes(authMode)) errors.push('请选择谁能进');
  if (authMode !== 'password' && setupEnv.ssoMissing.length) errors.push('未检测到平台应用凭证，不能用平台登录');
  if (authMode !== 'sso') {
    if (password.length < MIN_PASSWORD) errors.push(`口令至少 ${MIN_PASSWORD} 位`);
    if (password.length > MAX_PASSWORD) errors.push(`口令不能超过 ${MAX_PASSWORD} 位`);
  }

  if (!AI_PROVIDERS.includes(aiProvider)) errors.push('AI 选项不正确');
  if (aiProvider === 'platform' && setupEnv.platformAiMissing.length) errors.push('未检测到平台应用凭证，不能用平台模型');
  if (aiProvider === 'claude-cli' && !setupEnv.claudeBin) errors.push('本机没有 claude 命令行');
  if (aiProvider === 'openai') {
    if (!/^https?:\/\/[^\s/]+/i.test(values.aiBaseUrl)) errors.push('OpenAI 兼容接口地址要以 http:// 或 https:// 开头');
    if (!values.aiApiKey) errors.push('请填写 API Key');
    if (!values.aiModel) errors.push('请填写模型名');
  }
  return { values, password, errors };
}

export function buildConfigFile(values, { root, passwordHash, baseUrl }) {
  const openai = values.aiProvider === 'openai';
  return {
    root, siteName: values.siteName, ownerName: values.ownerName, authMode: values.authMode,
    ...(passwordHash ? { passwordHash } : {}),
    allowedUsers: values.authMode === 'password' ? [] : values.allowedUsers,
    ...(values.authMode === 'password' ? {} : { allowedUserIds: values.allowedUserIds, allowedProfiles: values.allowedProfiles }),
    ...(baseUrl ? { baseUrl } : {}),
    ai: {
      provider: values.aiProvider, baseUrl: openai ? values.aiBaseUrl : '', apiKey: openai ? values.aiApiKey : '', model: openai ? values.aiModel : '',
    },
  };
}

// 先写临时文件再改名：写到一半崩溃也不会留下半个 config.json
export function writeConfigFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
