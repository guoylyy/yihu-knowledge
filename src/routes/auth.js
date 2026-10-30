import { Router } from 'express';
import { parseCookies, safeNext, SESSION_COOKIE } from '../auth.js';
import { isAllowed, SsoError, SSO_ERRORS, STATE_COOKIE, STATE_MS } from '../sso.js';

export function authRoutes({ auth, config, sso }) {
  const r = Router();
  const passwordEnabled = config.authMode !== 'sso';

  const renderLogin = (req, res, { status = 200, next, error = null }) => res.status(status).render('login', {
    pageTitle: '登录', next, error, passwordEnabled,
    platformEntry: Boolean(config.sso),
    platformProblem: config.sso?.problem ?? null,
    platformLogoutUrl: sso?.logoutUrl(req.base) ?? null,
  });

  const setSession = (req, res, { id, maxAge }) => res.cookie(SESSION_COOKIE, id, auth.cookieOptions(maxAge, req.base));

  r.get('/login', (req, res) => {
    if (req.session) return res.redirect(req.base + safeNext(req.query.next));
    renderLogin(req, res, { next: safeNext(req.query.next), error: SSO_ERRORS[req.query.sso_error] ?? null });
  });

  r.post('/login', async (req, res) => {
    const next = safeNext(req.body?.next);
    if (!passwordEnabled) return renderLogin(req, res, { status: 403, next, error: '这个知识库只能用平台账号登录。' });
    const result = await auth.login(req.body?.password, req.ip);
    if (result.ok) {
      auth.recordLogin(req, { via: 'password', result: 'ok' });
      setSession(req, res, result);
      return res.redirect(303, req.base + next);
    }
    if (result.retryAfter) {
      res.set('Retry-After', String(result.retryAfter));
      return renderLogin(req, res, { status: 429, next, error: `尝试次数过多，请 ${Math.ceil(result.retryAfter / 60)} 分钟后再试。` });
    }
    renderLogin(req, res, { status: 401, next, error: '口令不正确。' });
  });

  if (!sso) return r;

  const stateCookie = (req, maxAge) => ({ ...auth.cookieOptions(maxAge, req.base), path: `${req.base}/sso` });

  r.get('/sso/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (req.session) return res.redirect(req.base + next);
    const { cookie, url } = sso.begin(next);
    res.cookie(STATE_COOKIE, cookie, stateCookie(req, STATE_MS));
    res.redirect(302, url);
  });

  r.get('/sso/callback', async (req, res) => {
    const pending = parseCookies(req)[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, stateCookie(req, undefined));
    let next;
    let user;
    try {
      if (req.query.error) throw new SsoError('refused');
      next = sso.checkState(pending, req.query.state);
      user = await sso.exchange(req.query.code);
    } catch (err) {
      if (!(err instanceof SsoError)) throw err;
      console.warn(`平台登录失败: ${err.code}`);
      return res.redirect(303, `${req.base}/login?sso_error=${err.code}`);
    }
    const who = { via: 'sso', username: user.username || null, userId: String(user.id) };
    if (!isAllowed(user, config.allowedUsers)) {
      auth.recordLogin(req, { ...who, username: who.username ?? user.name ?? null, result: 'denied' });
      return res.status(403).render('sso-denied', {
        pageTitle: '没有访问权限', ctx: null, account: user.username || user.name || user.id, userId: user.id,
        unconfigured: !config.allowedUsers.length, platformLogoutUrl: sso.logoutUrl(req.base),
      });
    }
    setSession(req, res, auth.createSession(who));
    auth.recordLogin(req, { ...who, username: who.username ?? user.name ?? null, result: 'ok' });
    res.redirect(302, req.base + next);
  });

  return r;
}
