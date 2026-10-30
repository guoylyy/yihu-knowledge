// 平台用户目录。平台（实测）忽略 page / perPage / keyword，每页都返回全部用户，所以按 id 去重、没有新 id 就停，搜索也只能在本地做
const CACHE_MS = 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const TIMEOUT_MS = 5000;

export class PlatformUsersError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const unreachable = () => new PlatformUsersError('unreachable', '平台暂时连不上');
const badResponse = () => new PlatformUsersError('platform', '读不到平台用户列表：平台返回了异常结果');

// 页面的 CSP 只放行 https 图片，http 头像显示不出来，不如直接退回首字
function avatarUrl(avatar, apiUrl) {
  if (typeof avatar !== 'string' || !avatar) return null;
  try {
    const url = new URL(avatar, apiUrl);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const primaryDept = (depts) => (Array.isArray(depts) ? depts.find((d) => d?.isPrimary) ?? depts[0] : null)?.name ?? null;

function normalize(raw, apiUrl) {
  return {
    id: raw.id,
    username: raw.username || null,
    name: raw.name || null,
    avatar: avatarUrl(raw.avatar, apiUrl),
    dept: primaryDept(raw.depts) ?? raw.dept?.name ?? (typeof raw.dept === 'string' ? raw.dept : null),
    title: raw.title || null,
    jobNumber: raw.jobNumber || null,
    mobile: raw.mobile || null,
    active: raw.active !== false,
  };
}

export const matchesKeyword = (user, keyword) => {
  const q = String(keyword ?? '').trim().toLowerCase();
  return !q || [user.name, user.username, user.jobNumber, user.mobile].some((v) => v && String(v).toLowerCase().includes(q));
};

export function createPlatformUsers({ clientId, clientSecret, apiUrl }, { timeoutMs = TIMEOUT_MS, cacheMs = CACHE_MS } = {}) {
  const missing = [['YH_CLIENT_ID', clientId], ['YH_CLIENT_SECRET', clientSecret], ['YH_API_URL', apiUrl]].filter(([, v]) => !v).map(([k]) => k);
  const reason = missing.length ? `未配置 ${missing.join(' / ')}` : null;
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  let cache = null;
  let loading = null;

  async function fetchPage(page) {
    let res;
    let body;
    try {
      res = await fetch(`${apiUrl}/api/open/users?page=${page}&perPage=${PER_PAGE}`, {
        headers: { Authorization: basic }, signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.json().catch(() => null);
    } catch {
      throw unreachable();
    }
    // client_id 错是 400 + code 1001，client_secret 错才是 401
    if ([400, 401, 403].includes(res.status)) throw new PlatformUsersError('credentials', '读不到平台用户列表：凭证无效');
    if (res.status >= 500) throw unreachable();
    if (!res.ok || body?.code !== 0 || !Array.isArray(body.data?.list) || !Number.isFinite(body.data?.total)) throw badResponse();
    return body.data;
  }

  async function fetchAll() {
    const byId = new Map();
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchPage(page);
      const before = byId.size;
      for (const raw of data.list) {
        if (raw?.id !== null && raw?.id !== undefined) byId.set(raw.id, normalize(raw, apiUrl));
      }
      total = data.total;
      if (byId.size >= total || byId.size === before) break;
    }
    return { users: [...byId.values()], truncated: byId.size < total };
  }

  async function load() {
    if (cache && Date.now() - cache.at < cacheMs) return cache;
    loading ??= fetchAll().then((result) => {
      cache = { ...result, at: Date.now() };
      return cache;
    }).finally(() => { loading = null; });
    return loading;
  }

  // 不传 page 时返回全部匹配的人
  async function listPlatformUsers({ keyword = '', page = 1, perPage = Infinity } = {}) {
    if (reason) return { available: false, reason, total: 0, users: [], truncated: false };
    const { users, truncated } = await load();
    const hits = users.filter((u) => matchesKeyword(u, keyword));
    return { available: true, reason: null, total: hits.length, users: hits.slice((page - 1) * perPage, page * perPage), truncated };
  }

  // 给页面用：拉不到时不抛错，带上原因和上一次的名单，让姓名还能显示
  async function directory() {
    try {
      return await listPlatformUsers();
    } catch (err) {
      if (!(err instanceof PlatformUsersError)) throw err;
      return { available: false, reason: err.message, total: 0, users: cache?.users ?? [], truncated: false };
    }
  }

  return { available: !reason, reason, listPlatformUsers, directory };
}
