import { randomBytes, timingSafeEqual } from 'node:crypto';

export const STATE_COOKIE = 'kb_sso_state';
export const STATE_MS = 10 * 60 * 1000;

// sso_error 查询参数只接受这些键，页面不回显任何外部传来的文字
export const SSO_ERRORS = {
  state: '登录校验没有通过，请重新点一次登录。',
  expired: '登录等待太久已超时，请重新点一次登录。',
  refused: '平台没有完成授权，请重新登录。',
  code: '平台的授权码无效或已过期，请重新点一次登录。',
  credentials: '平台不认这个应用的凭证，请联系管理员检查 YH_CLIENT_ID / YH_CLIENT_SECRET。',
  unreachable: '连不上平台，请稍后再试。',
  platform: '平台返回了异常结果，请稍后再试。',
};

export class SsoError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// 只认精确匹配。白名单为空时没有任何值能命中，一律拒绝
export function isAllowed(user, allowed) {
  return [user?.username, user?.id]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .some((v) => allowed.includes(String(v)));
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createSso({ clientId, clientSecret, webUrl, apiUrl, appUrl, basePath }) {
  const redirectUri = `${appUrl}/sso/callback`;
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  function begin(next) {
    const state = randomBytes(24).toString('base64url');
    const url = new URL('/sso/authorize', webUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return { url: url.toString(), cookie: Buffer.from(JSON.stringify({ state, next, at: Date.now() })).toString('base64url') };
  }

  // state 存在浏览器 cookie 里：服务重启不丢，也不必给每次跳转都建一条会话
  function checkState(cookie, state) {
    let pending = null;
    try {
      pending = JSON.parse(Buffer.from(String(cookie), 'base64url').toString('utf8'));
    } catch { /* 按校验失败处理 */ }
    if (!pending?.state || typeof state !== 'string' || !sameText(pending.state, state)) throw new SsoError('state');
    if (Date.now() - pending.at > STATE_MS) throw new SsoError('expired');
    return pending.next;
  }

  async function exchange(code) {
    if (typeof code !== 'string' || !code) throw new SsoError('code');
    let res;
    let data;
    try {
      res = await fetch(`${apiUrl}/api/sso/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basic },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10000),
      });
      data = await res.json().catch(() => null);
    } catch {
      throw new SsoError('unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new SsoError('credentials');
    if (res.status === 400) throw new SsoError('code');
    const user = data?.data?.user;
    if (!res.ok || data?.code !== 0 || user?.id === undefined || user?.id === null) throw new SsoError('platform');
    return user;
  }

  // 平台也退出，换个账号登录后回到本应用
  function logoutUrl(base) {
    const home = base || basePath;
    return `${webUrl}/logout${home ? `?redirect=${encodeURIComponent(`${home}/`)}` : ''}`;
  }

  return { begin, checkState, exchange, logoutUrl };
}
