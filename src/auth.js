import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { getMeta, setMeta } from './db.js';
import { isAllowed } from './sso.js';

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
// 平台账号被停用后，这里最多再放行这么久
export const SSO_SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_LOG_KEEP = 5000;
const BASE_PATH = /^\/apps\/[a-z0-9-]+$/;
export const SESSION_COOKIE = 'kb_sid';

// 平台剥掉 /apps/<code> 再转发，前缀放在 X-Forwarded-Prefix；直连时为空串
export function basePathOf(req) {
  const prefix = String(req.headers['x-forwarded-prefix'] ?? '').trim().replace(/\/$/, '');
  return BASE_PATH.test(prefix) ? prefix : '';
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* 非法 cookie 值直接忽略 */
    }
  }
  return out;
}

export function createThrottle(db) {
  const get = db.prepare('SELECT * FROM throttle WHERE key = ?');
  const put = db.prepare(`INSERT INTO throttle (key, fails, last_fail, locked_until) VALUES (@key, @fails, @last, @until)
                          ON CONFLICT(key) DO UPDATE SET fails = @fails, last_fail = @last, locked_until = @until`);
  const del = db.prepare('DELETE FROM throttle WHERE key = ?');
  return {
    retryAfter(key, now = Date.now()) {
      const row = get.get(key);
      return row && row.locked_until > now ? Math.ceil((row.locked_until - now) / 1000) : 0;
    },
    // 在校验口令之前先记一次失败，并发请求也无法绕过次数上限；校验成功再 clear
    register(key, now = Date.now()) {
      const row = get.get(key);
      const stale = !row || now - row.last_fail > LOCK_MS;
      const fails = stale ? 1 : row.fails + 1;
      put.run({ key, fails, last: now, until: fails >= MAX_FAILS ? now + LOCK_MS : 0 });
    },
    clear: (key) => del.run(key),
  };
}

const hashId = (id) => createHash('sha256').update(id).digest('hex');
const isHash = (s) => /^\$(argon2|2[aby]\$)/.test(s);

export function createAuth({ db, config }) {
  const throttle = createThrottle(db);
  const passwordEnabled = config.authMode !== 'sso';
  let passwordHash = null;

  // 平台同域名下挂着多个应用，cookie 限定在本应用路径下
  const cookieOptions = (maxAge, base = '') => ({
    httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: base || '/', maxAge,
  });

  async function init() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('DELETE FROM login_log WHERE id <= (SELECT MAX(id) FROM login_log) - ?').run(LOGIN_LOG_KEEP);
    if (!passwordEnabled) return;
    if (!config.password) throw new Error('缺少 KB_PASSWORD 环境变量');
    if (isHash(config.password)) {
      passwordHash = config.password;
    } else {
      if (config.password.length < 8) throw new Error('KB_PASSWORD 至少 8 位');
      const stored = getMeta(db, 'auth_hash');
      if (stored && (await argon2.verify(stored, config.password))) {
        passwordHash = stored;
      } else {
        passwordHash = await argon2.hash(config.password);
        setMeta(db, 'auth_hash', passwordHash);
        db.prepare("DELETE FROM sessions WHERE login_via = 'password'").run();
      }
    }
  }

  function createSession({ via, username = null, userId = null }) {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const now = Date.now();
    const maxAge = via === 'sso' ? SSO_SESSION_MS : SESSION_MS;
    db.prepare('INSERT INTO sessions (id_hash, csrf, created_at, expires_at, login_via, username, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashId(id), csrf, now, now + maxAge, via, username, userId);
    return { id, maxAge };
  }

  const logLogin = db.prepare('INSERT INTO login_log (ts, via, username, user_id, ip, ua, result) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const recordLogin = (req, { via, username = null, userId = null, result }) => {
    logLogin.run(Date.now(), via, username, userId, req.ip, (req.get('user-agent') ?? '').slice(0, 256), result);
  };
  const recent = db.prepare('SELECT * FROM login_log ORDER BY id DESC LIMIT ?');

  async function login(password, ip) {
    const key = `login:${ip}`;
    const retryAfter = throttle.retryAfter(key);
    if (retryAfter) return { ok: false, retryAfter };
    throttle.register(key);
    const ok = await argon2.verify(passwordHash, String(password ?? '').slice(0, 1024));
    if (!ok) return { ok: false, retryAfter: throttle.retryAfter(key) };
    throttle.clear(key);
    return { ok: true, ...createSession({ via: 'password' }) };
  }

  const findSession = db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?');

  const dropSession = db.prepare('DELETE FROM sessions WHERE id_hash = ?');

  // 每次请求都按当前配置复核：改 AUTH_MODE 或把人移出白名单后，旧会话立刻失效，不用等到期
  const stillAllowed = (row) => (row.login_via === 'sso'
    ? Boolean(config.sso) && isAllowed({ username: row.username, id: row.user_id }, config.allowedUsers)
    : passwordEnabled);

  function session(req, res, next) {
    const id = parseCookies(req)[SESSION_COOKIE];
    const row = id ? findSession.get(hashId(id), Date.now()) ?? null : null;
    if (row && !stillAllowed(row)) dropSession.run(row.id_hash);
    req.session = row && stillAllowed(row) ? row : null;
    res.locals.session = req.session;
    res.locals.csrf = req.session?.csrf ?? null;
    next();
  }

  function requireAuth(req, res, next) {
    if (req.session) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).type('text').send('未登录');
    res.redirect(302, `${req.base}/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  function requireCsrf(req, res, next) {
    const sent = String(req.get('x-csrf-token') ?? req.body?._csrf ?? '');
    const expected = req.session?.csrf ?? '';
    const a = Buffer.from(sent);
    const b = Buffer.from(expected);
    if (expected && a.length === b.length && timingSafeEqual(a, b)) return next();
    res.status(403).type('text').send('CSRF 校验失败');
  }

  function logout(req, res) {
    if (req.session) dropSession.run(req.session.id_hash);
    res.clearCookie(SESSION_COOKIE, cookieOptions(undefined, req.base));
  }

  return {
    init, login, createSession, recordLogin, recentLogins: (limit = 20) => recent.all(limit),
    session, requireAuth, requireCsrf, logout, cookieOptions, throttle,
  };
}

// 登录后跳转只接受站内绝对路径，防开放重定向
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && !/[\r\n]/.test(next) ? next : '/';
}
