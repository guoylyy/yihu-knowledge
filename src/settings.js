import fs from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import { AUTH_MODES, loadSetupEnv, SOURCE_LABELS } from './config.js';
import { getMeta, setMeta } from './db.js';
import { pdfOptions, runWorker } from './index-runner.js';
import { aiProblems, inspectLibrary, KEY_MASK, nameProblems, passwordProblems, writeConfigFile } from './setup.js';
import { allowlistMembers } from './sso.js';

const TMP_DB = 'reindex.tmp.sqlite';
const PENDING = 'config.pending.json';
const BUSY = new Set(['checking', 'indexing', 'swapping']);
const IDLE_JOB = { phase: 'idle', done: 0, total: 0, root: '', from: '', before: 0, after: 0, retired: 0, error: null };
// 比旧库少这么多就要管理员亲口确认
const MIN_KEEP_RATIO = 0.1;

const FIELDS = {
  root: ['知识库目录', 'KB_ROOT'], siteName: ['站点名', ''], ownerName: ['主人名', 'KB_OWNER_NAME'], baseUrl: ['对外地址', 'KB_BASE_URL'],
  authMode: ['登录方式', 'AUTH_MODE'], password: ['登录口令', 'KB_PASSWORD'],
  aiProvider: ['AI 通道', 'AI_PROVIDER'], aiBaseUrl: ['AI 接口地址', 'AI_BASE_URL'], aiApiKey: ['AI Key', 'AI_API_KEY'], aiModel: ['AI 模型', 'AI_MODEL'],
};

export class SettingsError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function baseUrlProblem(value) {
  const bad = '对外地址必须以 http:// 或 https:// 开头';
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return bad;
  try {
    const url = new URL(value);
    return url.search || url.hash ? '对外地址不能带查询参数或 # 片段' : null;
  } catch {
    return bad;
  }
}

export function anomalyOf({ files, md }, current) {
  if (!md) return '新目录里一篇 Markdown 笔记都没有';
  return current > 0 && files < current * MIN_KEEP_RATIO ? `新目录只有 ${files} 个文件，比当前的 ${current} 个少了 90% 以上` : null;
}

const text = (form, name) => String(form[name] ?? '').trim();

export function createSettings({ db, config, env, deny, indexer, apply }) {
  const file = path.join(config.dataDir, 'config.json');
  const tmpDb = path.join(config.dataDir, TMP_DB);
  const pending = path.join(config.dataDir, PENDING);
  const job = { ...IDLE_JOB };
  const indexed = db.prepare('SELECT COUNT(*) FROM files WHERE is_denied = 0').pluck();
  const logAudit = db.prepare('INSERT INTO audit_log (ts, action, actor, ip, detail) VALUES (?, ?, ?, ?, ?)');
  const recent = db.prepare("SELECT * FROM audit_log WHERE action = 'settings_change' ORDER BY id DESC LIMIT ?");

  const isEnv = (key) => config.sources?.[key] === 'env';
  const lockedMessage = (key) => `${FIELDS[key][0]}由环境变量控制，改这里不会生效。`;
  const setupEnv = () => loadSetupEnv(env);

  function discardTrial() {
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, pending]) {
      try {
        fs.rmSync(f, { force: true });
      } catch { /* 留给下一次换库报错 */ }
    }
  }

  if (fs.existsSync(pending)) console.warn('上次换库没有完成，配置和索引都还是旧的');
  discardTrial();

  function fields() {
    const out = {};
    for (const [key, [label, envName]] of Object.entries(FIELDS)) {
      const name = key === 'baseUrl' && !env.KB_BASE_URL ? 'YH_APP_URL' : envName;
      out[key] = { label, envName: name, locked: isEnv(key), source: SOURCE_LABELS[config.sources?.[key]] ?? '—' };
    }
    return out;
  }

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new SettingsError(`config.json 读不了（${err.code ?? '内容不是合法的 JSON'}）`, 503);
    }
  }

  // 现读现改：只动这一分区的字段，环境变量的值绝不落盘。新配置装配失败就退回去，不留半生效的状态
  async function save(patch) {
    const before = readRaw();
    const previousHash = getMeta(db, 'auth_hash');
    writeConfigFile(file, { ...before, ...patch });
    try {
      // 先记下新 hash：auth.init 见到陌生 hash 会清掉全部口令会话，包括正在操作的这个
      if (patch.passwordHash) setMeta(db, 'auth_hash', patch.passwordHash);
      await apply();
    } catch (err) {
      if (before) writeConfigFile(file, before);
      else fs.rmSync(file, { force: true });
      if (patch.passwordHash && previousHash) setMeta(db, 'auth_hash', previousHash);
      await apply().catch(() => {});
      throw err;
    }
  }

  const audit = (who, changes) => logAudit.run(Date.now(), 'settings_change', who.actor, who.ip, JSON.stringify(changes));
  const refuseLocked = (keys, form) => {
    for (const key of keys) {
      if (isEnv(key) && form[key] !== undefined && text(form, key) !== String(config[key])) throw new SettingsError(lockedMessage(key), 409);
    }
  };
  const refuse = (errors) => {
    if (errors.length) throw new SettingsError(errors.join('；'));
  };

  async function saveSite(form, who) {
    const keys = ['siteName', 'ownerName', 'baseUrl'];
    refuseLocked(keys, form);
    const values = Object.fromEntries(keys.map((k) => [k, isEnv(k) ? config[k] : text(form, k)]));
    values.baseUrl = values.baseUrl.replace(/\/+$/, '');
    const problem = baseUrlProblem(values.baseUrl);
    refuse([
      ...(values.siteName ? [] : ['站点名不能为空']), ...(values.ownerName ? [] : ['主人名不能为空']),
      ...nameProblems(values), ...(problem ? [problem] : []),
    ]);
    const changes = keys.filter((k) => !isEnv(k) && values[k] !== config[k]).map((field) => ({ field, from: config[field], to: values[field] }));
    if (!changes.length) return false;
    await save(Object.fromEntries(changes.map((c) => [c.field, c.to])));
    audit(who, changes);
    return true;
  }

  async function saveAi(form, who) {
    const keys = ['aiProvider', 'aiBaseUrl', 'aiModel'];
    refuseLocked(keys, form);
    const pick = (k) => (isEnv(k) ? config[k] : text(form, k));
    const aiProvider = pick('aiProvider');
    const openai = aiProvider === 'openai';
    const typed = text(form, 'aiApiKey');
    const newKey = !isEnv('aiApiKey') && openai && typed !== KEY_MASK ? typed : '';
    // 不选 OpenAI 时这组字段是置灰的：不提交也不清空，切回来还在
    const values = {
      aiProvider, aiBaseUrl: openai ? pick('aiBaseUrl') : config.aiBaseUrl, aiModel: openai ? pick('aiModel') : config.aiModel, aiApiKey: newKey || config.aiApiKey,
    };
    refuse(aiProblems(values, setupEnv()));
    const changes = keys.filter((k) => !isEnv(k) && values[k] !== config[k]).map((field) => ({ field, from: config[field] || '', to: values[field] }));
    if (newKey && newKey !== config.aiApiKey) changes.push({ field: 'aiApiKey', note: '已修改' });
    if (!changes.length) return false;
    const names = { aiProvider: 'provider', aiBaseUrl: 'baseUrl', aiModel: 'model' };
    const ai = { ...readRaw()?.ai };
    for (const c of changes) ai[names[c.field] ?? 'apiKey'] = c.to ?? newKey;
    await save({ ai });
    audit(who, changes);
    return true;
  }

  async function saveAuthMode(form, who) {
    if (isEnv('authMode')) throw new SettingsError(lockedMessage('authMode'), 409);
    const authMode = text(form, 'authMode');
    if (!AUTH_MODES.includes(authMode)) throw new SettingsError('请选择登录方式');
    if (authMode === config.authMode) return false;
    if (authMode !== 'password' && setupEnv().ssoMissing.length) throw new SettingsError('未检测到平台应用凭证，不能用平台登录');
    // /access 要开着平台登录才能加人，所以直接切过来的话，切完谁都进不来
    if (authMode === 'sso' && !allowlistMembers(config).length) throw new SettingsError('白名单是空的，切到只用平台登录后谁都进不来。先切到「两者都开」，在访问权限里加好人再切');
    const patch = { authMode };
    const changes = [{ field: 'authMode', from: config.authMode, to: authMode }];
    if (authMode !== 'sso' && !config.password) {
      const password = String(form.newPassword ?? '');
      refuse(passwordProblems(password));
      patch.passwordHash = await argon2.hash(password);
      changes.push({ field: 'password', note: '已修改' });
    }
    await save(patch);
    audit(who, changes);
    return true;
  }

  async function changePassword({ auth, form, who, session, ip }) {
    if (isEnv('password')) throw new SettingsError(lockedMessage('password'), 409);
    if (config.authMode === 'sso') throw new SettingsError('现在只用平台登录，没有口令可改', 409);
    const { ok, retryAfter } = await auth.checkPassword(form.currentPassword, ip);
    if (retryAfter) throw new SettingsError(`尝试次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`, 429);
    if (!ok) throw new SettingsError('当前口令不正确');
    const password = String(form.newPassword ?? '');
    refuse([...passwordProblems(password), ...(password === String(form.confirmPassword ?? '') ? [] : ['两次输入的新口令不一致'])]);
    await save({ passwordHash: await argon2.hash(password) });
    auth.dropOtherPasswordSessions(session);
    audit(who, [{ field: 'password', note: '已修改' }]);
  }

  async function inspect(input) {
    const report = await inspectLibrary(input, { deny, dataDir: config.dataDir });
    if (!report.ok) return report;
    if (report.truncated) return { ok: false, error: '这个目录超过 20 万项，不像一个知识库，确认一下有没有选错' };
    let current = config.root;
    try {
      current = fs.realpathSync(current);
    } catch { /* 当前目录已经不在了，正好可以换 */ }
    if (report.root === current) return { ok: false, error: '这就是现在的知识库目录' };
    const before = indexed.get();
    return { ...report, current: before, anomaly: anomalyOf({ files: report.files, md: report.byExt.md ?? 0 }, before) };
  }

  // 顺序保证「索引炸了但配置已改」不会出现：试跑全程不碰正式库，任何一步失败时旧配置和旧索引都还在
  async function perform(report, acceptAnomaly, who) {
    let adopted = false;
    try {
      discardTrial();
      writeConfigFile(pending, { root: report.root, at: Date.now() });
      const onProgress = ({ done, total }) => Object.assign(job, { done, total });
      const trial = await runWorker({ dataDir: config.dataDir, dbFile: TMP_DB, root: report.root, denyGlobs: config.denyGlobs, full: true, pdf: pdfOptions(config) }, onProgress);
      if (!trial.total) throw new Error('新目录里没有可索引的文件');
      const anomaly = anomalyOf({ files: trial.total, md: trial.md }, job.before);
      if (anomaly && !acceptAnomaly) {
        Object.assign(job, { phase: 'anomaly', after: trial.total, error: anomaly });
        return;
      }
      Object.assign(job, { phase: 'swapping', after: trial.total });
      await indexer.exclusive(async () => {
        const { retiredShares } = await runWorker({ dataDir: config.dataDir, adoptFrom: tmpDb });
        adopted = true;
        job.retired = retiredShares;
        await save({ root: report.root });
        return trial;
      });
      audit(who, [{ field: 'root', from: job.from, to: report.root, before: job.before, after: trial.total, retiredShares: job.retired }]);
      job.phase = 'done';
    } catch (err) {
      console.error(`换库失败: ${err.code ?? err.name}`);
      Object.assign(job, { phase: 'failed', error: `换库没有完成，配置和索引${adopted ? '已退回旧目录' : '都没有动'}：${err.message}` });
      // 索引已经搬了但配置没写上：按旧目录重建，下一次扫描本来也会这么做，这里只是不让它等半小时
      if (adopted) indexer.run({ full: true }).catch(() => console.error('索引失败'));
    } finally {
      discardTrial();
    }
  }

  async function startSwitch({ input, confirmed, acceptAnomaly, who }) {
    if (BUSY.has(job.phase)) throw new SettingsError('已经有一次换库在进行中', 409);
    if (isEnv('root')) throw new SettingsError(lockedMessage('root'), 409);
    Object.assign(job, IDLE_JOB, { phase: 'checking' }); // 先占位再 await，防止连点提交两次
    let report;
    try {
      report = await inspect(input);
      if (!report.ok) throw new SettingsError(report.error);
      if (!confirmed) throw new SettingsError('换目录要先确认后果：索引重建、已有分享链接失效');
      if (report.anomaly && !acceptAnomaly) throw new SettingsError(`${report.anomaly}。没有替换，勾选「确认这就是我要的库」后再提交一次`, 409, { anomaly: true });
    } catch (err) {
      Object.assign(job, IDLE_JOB);
      throw err;
    }
    Object.assign(job, { phase: 'indexing', root: report.root, from: config.root, before: report.current, total: report.files });
    perform(report, acceptAnomaly, who);
  }

  return {
    fields, saveSite, saveAi, saveAuthMode, changePassword, inspect, startSwitch, setupEnv,
    recentChanges: (limit = 20) => recent.all(limit).map((row) => ({ ...row, changes: JSON.parse(row.detail) })),
    get job() { return { ...job, running: BUSY.has(job.phase) }; },
  };
}
