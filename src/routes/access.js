import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { membersFromIds, saveAllowlist, withMembers, withoutMember } from '../allowlist.js';
import { notFound } from '../app.js';
import { SESSION_COOKIE } from '../auth.js';
import { splitList } from '../config.js';
import { allowlistMembers, isAllowed } from '../sso.js';

const sameToken = (sent, token) => {
  const a = Buffer.from(String(sent ?? '').trim());
  const b = Buffer.from(String(token ?? ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

export function accessRoutes({ config, auth, sso, platformUsers }) {
  const r = Router();
  const envControlled = () => config.sources?.allowedUsers === 'env';
  const editable = () => Boolean(config.sso) && !envControlled();
  const inAllowlist = (entry) => isAllowed({ username: entry.username, id: entry.user_id }, config);

  const setCookie = (req, res, { id, maxAge }) => res.cookie(SESSION_COOKIE, id, auth.cookieOptions(maxAge, req.base));

  async function render(req, res, { status = 200, error = null, session = req.session, setupRow = req.setupSession } = {}) {
    const dir = config.sso ? await platformUsers.directory() : { users: [] };
    const members = allowlistMembers(config, dir.users);
    const listed = new Set(members.map((m) => m.id).filter(Boolean));
    res.locals.adminPage = Boolean(session);
    res.locals.csrf = (session ?? setupRow)?.csrf ?? null;
    res.status(status).render('access', {
      pageTitle: '访问权限', section: 'access', error, saved: req.query.saved === '1',
      temporary: Boolean(setupRow && !session), hasSso: Boolean(config.sso), envControlled: envControlled(), editable: editable(),
      members, directory: dir, candidates: (dir.users ?? []).filter((u) => u.active && !listed.has(String(u.id))),
      denied: auth.recentDenied(20).map((d) => ({ ...d, listed: inAllowlist(d) })),
    });
  }

  // 临时会话的命都在这一次保存上：加的是自己就换成正式会话，否则结束
  function finishSetup(req, res) {
    const row = req.setupSession;
    auth.dropSession(row);
    if (row.user_id && inAllowlist(row)) {
      const who = { via: 'sso', username: row.username, userId: row.user_id };
      setCookie(req, res, auth.createSession(who));
      auth.recordLogin(req, { ...who, result: 'ok' });
      return res.redirect(303, `${req.base}/access?saved=1`);
    }
    res.clearCookie(SESSION_COOKIE, auth.cookieOptions(undefined, req.base));
    res.render('access-done', { pageTitle: '已保存', ctx: null });
  }

  async function apply(req, res, lists) {
    try {
      saveAllowlist(config, lists);
    } catch (err) {
      console.error(`白名单保存失败: ${err.code ?? err.name}`);
      return render(req, res, { status: 503, error: `白名单没有保存：config.json 写不进去（${err.code ?? '内容不是合法的 JSON'}）。` });
    }
    if (req.setupSession) return finishSetup(req, res);
    if (config.sso && !allowlistMembers(config).length) console.log(`白名单已清空，打开 /access?token=${config.setupToken} 添加成员`);
    res.redirect(303, `${req.base}/access?saved=1`);
  }

  // 非 GET 的统一入口：先过登录和 CSRF，再看白名单能不能改
  const guard = (req, res, next) => (req.setupSession ? next() : auth.requireAuth(req, res, next));
  const writable = (req, res, next) => (editable() ? next() : render(req, res, { status: 409, error: envControlled() ? '当前由环境变量 KB_ALLOWED_USERS 控制，改这里不会生效。' : '现在只用口令登录，没有白名单可改。' }));

  r.get('/', async (req, res, next) => {
    if (req.query.token === undefined) return guard(req, res, () => render(req, res).catch(next));
    // 设置码能开管理会话，和登录口令一样限次；次数用完、码不对、白名单已有人，看起来都是不存在
    const key = `setup-token:${req.ip}`;
    if (auth.throttle.retryAfter(key)) return notFound(req, res);
    auth.throttle.register(key);
    if (!sso || !auth.canBootstrap() || !sameToken(req.query.token, config.setupToken)) return notFound(req, res);
    auth.throttle.clear(key);
    if (req.session) return res.redirect(303, `${req.base}/access`);
    const who = auth.deniedIdentity(req);
    const created = auth.createSession({ via: 'setup', username: who?.username ?? null, userId: who?.userId ?? null });
    setCookie(req, res, created);
    auth.recordLogin(req, { via: 'setup', username: who?.username ?? null, userId: who?.userId ?? null, result: 'ok' });
    return render(req, res, { setupRow: created });
  });

  r.post('/add', guard, auth.requireCsrf, writable, async (req, res) => {
    const { users } = await platformUsers.directory();
    const manual = splitList(String(req.body?.manual ?? '')).map((username) => ({ username }));
    const members = [...membersFromIds(req.body?.member ?? [], users), ...manual];
    if (!members.length) return render(req, res, { status: 400, error: '还没有选人。' });
    await apply(req, res, withMembers(config, members));
  });

  r.post('/remove', guard, auth.requireCsrf, writable, async (req, res) => {
    const { users } = await platformUsers.directory();
    const member = allowlistMembers(config, users).find((m) => m.key === req.body?.key);
    if (!member) return render(req, res, { status: 400, error: '这个人已经不在白名单里了。' });
    // 平台登录的人把自己移出去，当场就进不来了，要改回来只能靠别人
    const self = req.session?.login_via === 'sso' && [req.session.user_id, req.session.username].some((v) => v && [member.id, member.username].includes(v));
    if (self) return render(req, res, { status: 400, error: '不能把自己移出白名单。要移除自己，请让白名单里的其他人操作。' });
    await apply(req, res, withoutMember(config, member));
  });

  r.post('/approve', guard, auth.requireCsrf, writable, async (req, res) => {
    const entry = auth.deniedEntry(Number(req.body?.log));
    if (!entry?.user_id) return render(req, res, { status: 400, error: '这条记录不存在。' });
    const { users } = await platformUsers.directory();
    const [known] = membersFromIds(entry.user_id, users);
    // 老记录没有 name 列时，username 里可能是姓名，不能当用户名写进白名单；id 已经够放行了
    const username = known.username ?? (entry.name === null ? null : entry.username);
    await apply(req, res, withMembers(config, [{ id: known.id, username, name: known.name ?? entry.name }]));
  });

  return r;
}
