import { Router } from 'express';
import { aboutInfo } from '../about.js';
import { MIN_PASSWORD, KEY_MASK } from '../setup.js';
import { SettingsError } from '../settings.js';
import { allowlistMembers } from '../sso.js';

const NEXT_ANCHOR = { site: 'site', auth: 'auth', password: 'auth', ai: 'ai' };

export function settingsRoutes({ db, config, auth, shares, ai, settings }) {
  const r = Router();
  const counts = db.prepare(`SELECT COUNT(CASE WHEN is_denied = 0 THEN 1 END) AS indexed, COUNT(CASE WHEN is_denied = 1 THEN 1 END) AS denied FROM files`);
  const sensitive = db.prepare('SELECT path, sensitive_kinds FROM files WHERE is_sensitive = 1 ORDER BY path');

  const who = (req) => {
    const { login_via: via, username, user_id: id } = req.session;
    return { actor: username ?? (via === 'password' ? '口令登录' : `平台用户 ${id}`), ip: req.ip };
  };

  function render(req, res, { status = 200, section = null, error = null, form = {}, anomaly = false } = {}) {
    res.status(status).render('admin/settings', {
      pageTitle: '设置', section: 'settings', globs: config.denyGlobs, counts: counts.get(), sensitive: sensitive.all(),
      aiChannel: ai.status().channel, aiLog: ai.recent(), trustProxy: config.trustProxy,
      config, about: aboutInfo(config.soffice), fields: settings.fields(), env: settings.setupEnv(), keyMask: KEY_MASK, minPassword: MIN_PASSWORD,
      allowedCount: allowlistMembers(config).length, job: settings.job, changes: settings.recentChanges(),
      saved: NEXT_ANCHOR[req.query.saved] ? req.query.saved : null, failed: { section, error }, form, anomaly,
    });
  }

  // 每个分区一个入口；校验不过回到同一页，错误显示在那个分区里
  const section = (name, action) => [auth.requireCsrf, async (req, res) => {
    try {
      await action(req);
    } catch (err) {
      if (!(err instanceof SettingsError)) console.error(`设置保存失败: ${err.code ?? err.name}`);
      const known = err instanceof SettingsError;
      const { password, currentPassword, newPassword, confirmPassword, aiApiKey, _csrf, ...form } = req.body ?? {};
      return render(req, res, {
        status: known ? err.status : 503, section: name, error: known ? err.message : `没有保存：${err.message}`, form, anomaly: Boolean(err.anomaly),
      });
    }
    res.redirect(303, `${req.base}/admin/settings?saved=${name}#settings-${NEXT_ANCHOR[name]}`);
  }];

  r.get('/', (req, res) => render(req, res));

  r.get('/library/progress', (req, res) => res.json(settings.job));

  r.post('/library/check', auth.requireCsrf, async (req, res) => {
    const report = await settings.inspect(req.body?.root);
    res.status(report.ok ? 200 : 400).json(report.ok ? { ...report, shares: shares.activeCount() } : report);
  });

  r.post('/library', auth.requireCsrf, async (req, res) => {
    try {
      await settings.startSwitch({ input: req.body?.root, confirmed: req.body?.confirm === '1', acceptAnomaly: req.body?.acceptAnomaly === '1', who: who(req) });
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      return render(req, res, { status: err.status, section: 'library', error: err.message, form: { root: String(req.body?.root ?? '') }, anomaly: Boolean(err.anomaly) });
    }
    res.redirect(303, `${req.base}/admin/settings#settings-library`);
  });

  r.post('/site', ...section('site', (req) => settings.saveSite(req.body ?? {}, who(req))));
  r.post('/auth', ...section('auth', (req) => settings.saveAuthMode(req.body ?? {}, who(req))));
  r.post('/ai', ...section('ai', (req) => settings.saveAi(req.body ?? {}, who(req))));
  r.post('/password', ...section('password', (req) => settings.changePassword({ auth, form: req.body ?? {}, who: who(req), session: req.session, ip: req.ip })));

  return r;
}
