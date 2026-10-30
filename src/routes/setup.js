import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import express from 'express';
import { commonHeaders, csp } from '../app.js';
import { createDeny } from '../deny.js';
import { createIndexRunner } from '../index-runner.js';
import { buildConfigFile, dataDirProblem, inspectLibrary, KEY_MASK, MIN_PASSWORD, validateForm, writeConfigFile } from '../setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const firstValue = (v) => String(v ?? '').split(',')[0].trim();

// 本机直连才算本机：同机反向代理转来的请求 socket 也是 127.0.0.1，要看转发头；Host 用来挡 DNS 重绑定
function isLocalRequest(req) {
  const hostname = String(req.get('host') ?? '').replace(/:\d+$/, '');
  const proxied = ['x-forwarded-for', 'x-real-ip', 'forwarded'].some((h) => req.get(h));
  return LOOPBACK.has(req.socket.remoteAddress) && !proxied && LOCAL_HOSTS.has(hostname.toLowerCase());
}

// 本机免设置码，所以要防别的网站从用户浏览器向 localhost 提交表单。
// 全站 no-referrer 下同源表单的 Origin 也是 null，只能先看 Sec-Fetch-Site，它由浏览器写，页面改不了
function isSameOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return [req.get('host'), firstValue(req.get('x-forwarded-host'))].includes(new URL(origin).host);
  } catch {
    return false;
  }
}

// 分享链接和回调要用对外地址。这一步的访问者通过了设置码校验，可以信任他带来的转发头
function publicUrl(req) {
  const proto = firstValue(req.get('x-forwarded-proto')) || req.protocol;
  const host = firstValue(req.get('x-forwarded-host')) || req.get('host');
  return /^https?$/.test(proto) && /^[\w.:[\]-]+$/.test(host ?? '') ? `${proto}://${host}${req.base}` : '';
}

export function createSetupApp({ setupEnv, loadFinalConfig, finish }) {
  const token = randomBytes(6).toString('hex');
  const deny = createDeny(setupEnv.denyGlobs);
  const state = { phase: 'form', done: 0, total: 0, form: {}, errors: [], keyDraft: '' };

  const tokenMatches = (sent) => {
    const a = Buffer.from(String(sent ?? '').trim());
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const accessProblem = (req) => {
    if (tokenMatches(req.body?.token)) return null;
    if (!isLocalRequest(req)) return '设置码不正确。设置码打印在服务启动日志里。';
    return isSameOrigin(req) ? null : '请求来源不对，请从配置页面提交。';
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, '..', '..', 'views'));
  app.locals.siteName = '知识库';
  app.use(commonHeaders(csp("'self'"), ''));
  app.use('/assets', express.static(path.join(here, '..', '..', 'public'), { maxAge: '1h', etag: true }));
  app.get(['/health', '/healthz'], (req, res) => res.type('text').send('ok'));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));

  const render = (req, res, { status = 200, errors = state.errors } = {}) => res.status(status).render('setup', {
    pageTitle: '首次配置', ctx: null, phase: state.phase, done: state.done, total: state.total,
    form: state.form, errors, keySaved: Boolean(state.keyDraft), keyMask: KEY_MASK,
    env: setupEnv, dataProblem: dataDirProblem(setupEnv.dataDir), minPassword: MIN_PASSWORD,
    needsToken: !isLocalRequest(req), token: String(req.body?.token ?? req.query.token ?? ''), publicUrl: publicUrl(req),
  });

  const rejectForm = (req, res, errors) => {
    state.phase = 'form';
    render(req, res, { status: 400, errors });
  };

  async function firstIndex() {
    try {
      const config = loadFinalConfig();
      state.phase = 'indexing';
      const onProgress = ({ done, total }) => Object.assign(state, { done, total });
      const result = await createIndexRunner(config, { onProgress }).run({ full: true });
      await finish(config, result);
    } catch (err) {
      fs.rmSync(setupEnv.configFile, { force: true });
      console.error(`首次索引失败: ${err.message}`);
      Object.assign(state, { phase: 'form', errors: [`首次索引失败，配置没有保存：${err.message}`] });
    }
  }

  app.get('/setup', (req, res) => render(req, res));

  app.get('/setup/progress', (req, res) => {
    res.json({ phase: state.phase, done: state.done, total: state.total, error: state.errors[0] ?? null });
  });

  app.post('/setup/check', async (req, res) => {
    const problem = accessProblem(req);
    if (problem) return res.status(403).json({ ok: false, error: problem });
    const report = await inspectLibrary(req.body?.root, { deny, dataDir: setupEnv.dataDir });
    res.status(report.ok ? 200 : 400).json(report);
  });

  app.post('/setup', async (req, res) => {
    if (state.phase !== 'form') return res.redirect(303, `${req.base}/setup`);
    const problem = accessProblem(req);
    if (problem) return render(req, res, { status: 403, errors: [problem] });
    state.phase = 'saving'; // 先占位再 await，防止连点提交两次
    const { values, password, errors } = validateForm(req.body ?? {}, { setupEnv, keyDraft: state.keyDraft });
    const { aiApiKey, ...echo } = values;
    state.form = { ...echo, allowedUsers: values.allowedUsers.join(', ') };
    state.keyDraft = aiApiKey;
    const dataProblem = dataDirProblem(setupEnv.dataDir);
    if (dataProblem) errors.push(dataProblem);
    const library = await inspectLibrary(values.root, { deny, dataDir: setupEnv.dataDir });
    if (!library.ok) errors.unshift(`知识库目录：${library.error}`);
    if (errors.length) return rejectForm(req, res, errors);
    try {
      const passwordHash = values.authMode === 'sso' ? '' : await argon2.hash(password);
      writeConfigFile(setupEnv.configFile, buildConfigFile(values, { root: library.root, passwordHash, baseUrl: publicUrl(req) }));
    } catch (err) {
      return rejectForm(req, res, [`配置写不进去：${err.message}`]);
    }
    state.errors = [];
    Object.assign(state, { done: 0, total: library.files });
    firstIndex();
    // 直接给进度页而不是重定向：小库索引得比浏览器跟随跳转还快，再 GET /setup 就是 404 了
    render(req, res);
  });

  // 其余一切都带回向导
  app.use((req, res) => res.redirect(302, `${req.base}/setup`));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) return res.status(err.status).type('text').send('请求不合法');
    console.error(`请求失败: ${err.name} ${err.code ?? ''}`);
    state.phase = state.phase === 'saving' ? 'form' : state.phase;
    res.status(500).type('text').send('服务暂时不可用，请稍后再试。');
  });

  return { app, token, state };
}
