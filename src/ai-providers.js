import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_DEFAULT_MODEL = 'CLI 默认模型';
export const PLATFORM_DEFAULT_MODEL = '平台默认模型';
// 这段顶替 Claude Code 自带的系统提示；真正的说明按约定拼在 prompt 首位
const CLI_PERSONA = '你是个人知识库的阅读助手，只根据用户消息里的内容作答。';

export class AiError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const timedOut = () => new AiError('timeout', '模型响应超时', 504);

export function findClaude(env = process.env) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const nvm = path.join(env.HOME || os.homedir(), '.nvm', 'versions', 'node');
  try {
    dirs.push(...fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, 'bin')));
  } catch { /* 没装 nvm */ }
  for (const dir of dirs) {
    const bin = path.join(dir, 'claude');
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch { /* 看下一个目录 */ }
  }
  return null;
}

export function resolveProvider(env = process.env) {
  if (env.AI_PROVIDER) return env.AI_PROVIDER;
  if (env.YH_CLIENT_ID && env.YH_CLIENT_SECRET) return 'platform';
  if (env.AI_API_KEY) return 'openai';
  return findClaude(env) ? 'claude-cli' : 'off';
}

// launchd 下未必有 USER，而 CLI 靠它去钥匙串取登录态；KB_/AI_/YH_ 里有口令和凭证，子进程用不上
function cliEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KB|AI|YH)_/.test(k)));
  try {
    const { username, homedir } = os.userInfo();
    return { ...env, HOME: env.HOME || homedir, USER: env.USER || username, LOGNAME: env.LOGNAME || username };
  } catch {
    return env;
  }
}

function cliFailure(detail, code) {
  if (/not logged in|\/login/i.test(detail)) return new AiError('auth', '本机 claude 命令行未登录');
  if (/rate.?limit|usage limit|hit your .*limit|overloaded|\b429\b/i.test(detail)) return new AiError('rate_limit', '调用太频繁', 429);
  if (/selected model|model.*(not exist|access)/i.test(detail)) return new AiError('model', '模型不可用，请检查 AI_CLI_MODEL');
  return new AiError('cli', code == null ? 'claude 命令行调用失败' : `claude 命令行调用失败（退出码 ${code}）`);
}

function cliProvider({ bin, model, timeoutMs }) {
  const args = ['-p', '--output-format', 'json', '--safe-mode', '--tools', '', '--no-session-persistence', '--system-prompt', CLI_PERSONA];
  if (model) args.push('--model', model);
  return {
    name: 'claude-cli',
    model: model || CLI_DEFAULT_MODEL,
    problem: bin ? null : '本机没有 claude 命令行',
    // 正文走 stdin：不进 ps，也不受 Linux 单参数 128KB 的限制
    send: ({ system, prompt, maxChars }) => new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd: os.tmpdir(), env: cliEnv(), detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const killGroup = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch { /* 已退出 */ }
      };
      const timer = setTimeout(() => {
        killGroup();
        reject(timedOut());
      }, timeoutMs);
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
      child.stdin.on('error', () => {}); // 进程提前退出时写 stdin 会 EPIPE，结果以 close 为准
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT' || err.code === 'EACCES' ? new AiError('no_cli', '本机没有 claude 命令行', 503) : new AiError('cli', 'claude 命令行调用失败'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let data;
        try {
          data = JSON.parse(out);
        } catch {
          return reject(cliFailure(out, code));
        }
        // 出错时 subtype 仍可能是 success，只有 is_error 可靠；不判它的话错误文案会被当成答案写进缓存
        if (data.is_error) return reject(cliFailure(String(data.result ?? ''), code));
        const text = String(data.result ?? '').trim();
        if (!text) return reject(new AiError('empty', '模型返回了空内容'));
        resolve({ text, model: Object.keys(data.modelUsage ?? {})[0] ?? model ?? CLI_DEFAULT_MODEL });
      });
      child.stdin.end(`${system}\n\n${prompt}`.slice(0, maxChars));
    }),
  };
}

const OPENAI_WORDS = { auth: 'API Key 无效', http: '模型', unreachable: '连不上模型' };
const PLATFORM_WORDS = { auth: '平台应用凭证无效', http: '平台模型', unreachable: '连不上平台模型' };

function httpFailure(status, words) {
  if (status === 401 || status === 403) return new AiError('auth', words.auth);
  if (status === 429) return new AiError('rate_limit', '调用太频繁', 429);
  return new AiError('http', `${words.http}返回 HTTP ${status}`);
}

async function chatCompletion({ url, authorization, body, timeoutMs, words }) {
  let data;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw httpFailure(res.status, words);
    }
    data = await res.json();
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err.name === 'TimeoutError') throw timedOut();
    if (err instanceof SyntaxError) throw new AiError('bad_response', '模型返回了无法解析的内容');
    throw new AiError('unreachable', words.unreachable);
  }
  // 平台的接口可能再包一层 { code, data }
  const result = data?.choices ? data : data?.data;
  const text = result?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AiError('empty', '模型返回了空内容');
  return { text, model: result.model };
}

const missingOf = (pairs) => pairs.filter(([, v]) => !v).map(([k]) => k);

function openaiProvider({ baseUrl, apiKey, model, timeoutMs }) {
  const missing = missingOf([['AI_BASE_URL', baseUrl], ['AI_API_KEY', apiKey], ['AI_MODEL', model]]);
  return {
    name: 'openai',
    model: model || '未配置',
    problem: missing.length ? `未配置 ${missing.join(' / ')}` : null,
    async send({ system, prompt, maxChars }) {
      const reply = await chatCompletion({
        url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
        authorization: `Bearer ${apiKey}`,
        body: { model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt.slice(0, maxChars) }] },
        timeoutMs,
        words: OPENAI_WORDS,
      });
      return { text: reply.text, model: reply.model || model };
    },
  };
}

// 平台托管模型与密钥，这里只带应用凭证；不传 model 时用平台默认模型。只发文字，图片在 ai.js 已剥掉
function platformProvider({ apiUrl, clientId, clientSecret, model, timeoutMs }) {
  const missing = missingOf([['YH_API_URL', apiUrl], ['YH_CLIENT_ID', clientId], ['YH_CLIENT_SECRET', clientSecret]]);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return {
    name: 'platform',
    model: model || PLATFORM_DEFAULT_MODEL,
    problem: missing.length ? `未配置 ${missing.join(' / ')}` : null,
    async send({ system, prompt, maxChars }) {
      const reply = await chatCompletion({
        url: `${apiUrl.replace(/\/+$/, '')}/api/open/llm/chat/completions`,
        authorization: `Basic ${basic}`,
        body: { ...(model ? { model } : {}), stream: false, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt.slice(0, maxChars) }] },
        timeoutMs,
        words: PLATFORM_WORDS,
      });
      return { text: reply.text, model: reply.model || model || PLATFORM_DEFAULT_MODEL };
    },
  };
}

export function createProvider(config) {
  const timeoutMs = config.aiTimeoutMs ?? 90000;
  if (config.aiProvider === 'platform') {
    return platformProvider({ apiUrl: config.aiPlatformUrl, clientId: config.aiPlatformId, clientSecret: config.aiPlatformSecret, model: config.aiPlatformModel, timeoutMs });
  }
  if (config.aiProvider === 'claude-cli') return cliProvider({ bin: config.aiClaudeBin, model: config.aiCliModel, timeoutMs });
  if (config.aiProvider === 'openai') return openaiProvider({ baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, model: config.aiModel, timeoutMs });
  if (config.aiProvider === 'off') return { name: 'off', model: '—', problem: 'AI 未启用（AI_PROVIDER=off）。' };
  return { name: config.aiProvider, model: '—', problem: `未知的 AI 通道：${config.aiProvider}` };
}
