import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { getMeta, setMeta } from './db.js';
import { IMAGE_EXTS } from './markdown.js';

export const EXPIRY_DAYS = [1, 3, 7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class ShareError extends Error {}

function formatDay(ts, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

export function createShares({ db, catalog, config, deny }) {
  let secret = getMeta(db, 'cookie_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setMeta(db, 'cookie_secret', secret);
  }

  const q = {
    insert: db.prepare(`INSERT INTO shares (token, kind, path, password_hash, allow_sensitive, created_at, expires_at)
                        VALUES (@token, @kind, @path, @password_hash, @allow_sensitive, @created_at, @expires_at)`),
    byToken: db.prepare('SELECT * FROM shares WHERE token = ?'),
    byId: db.prepare('SELECT * FROM shares WHERE id = ?'),
    list: db.prepare(`SELECT s.*, COUNT(CASE WHEN v.kind IN ('view', 'download') THEN 1 END) AS visit_count,
                             MAX(CASE WHEN v.kind IN ('view', 'download') THEN v.ts END) AS last_visit
                      FROM shares s LEFT JOIN visits v ON v.share_id = s.id
                      GROUP BY s.id ORDER BY s.created_at DESC`),
    active: db.prepare('SELECT COUNT(*) FROM shares WHERE retired_at IS NULL AND revoked_at IS NULL AND expires_at > ?').pluck(),
    revoke: db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    visit: db.prepare('INSERT INTO visits (share_id, path, ip, ua, referer, kind, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    linkedFrom: db.prepare(`SELECT src.path FROM links l JOIN files src ON src.id = l.src_id
                            WHERE l.target_id = ? AND l.kind IN ('embed', 'image')`),
    visits: db.prepare('SELECT * FROM visits WHERE share_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
    daily: db.prepare(`SELECT ts, kind FROM visits WHERE share_id = ? AND kind IN ('view', 'download') AND ts >= ?`),
    summary: db.prepare(`SELECT COUNT(CASE WHEN kind = 'view' THEN 1 END) AS views,
                                COUNT(CASE WHEN kind = 'download' THEN 1 END) AS downloads,
                                COUNT(DISTINCT CASE WHEN kind IN ('view', 'download') THEN ip END) AS ips,
                                MAX(CASE WHEN kind IN ('view', 'download') THEN ts END) AS last_visit
                         FROM visits WHERE share_id = ?`),
  };

  // 分享范围的唯一判定点：页面、原文件、下载、打包、内嵌全部经过这里
  function inScope(share, file) {
    if (deny.isDenied(file.path)) return false;
    if (share.kind === 'file') {
      if (file.path === share.path) return !file.is_sensitive || Boolean(share.allow_sensitive);
      return false;
    }
    return file.path.startsWith(`${share.path}/`) && !file.is_sensitive;
  }

  function allows(share, file) {
    if (inScope(share, file)) return true;
    // 笔记引用的图片可能放在附件目录，只放行图片，且引用方本身必须在范围内
    if (!IMAGE_EXTS.has(file.ext) || deny.isDenied(file.path)) return false;
    return q.linkedFrom.all(file.id).some(({ path }) => {
      const src = catalog.file(path);
      return src && inScope(share, src);
    });
  }

  async function create({ path, days = 7, password = '', allowSensitive = false }) {
    if (!EXPIRY_DAYS.includes(Number(days))) throw new ShareError('有效期不合法');
    const target = String(path ?? '').trim().replace(/\/+$/, '');
    if (!target) throw new ShareError('不能分享整个知识库，请选择文件或子目录');
    if (deny.isDenied(target)) throw new ShareError('该路径命中 deny 规则，不可分享');
    const file = catalog.file(target);
    const isDir = !file && catalog.hasDir(target);
    if (!file && !isDir) throw new ShareError('路径不存在，或未被索引');
    if (file?.is_sensitive && !allowSensitive) throw new ShareError('该文件正文疑似含口令或密钥，默认禁止分享；确认无误后可勾选强制分享');
    const now = Date.now();
    const row = {
      token: randomBytes(32).toString('base64url'),
      kind: file ? 'file' : 'dir',
      path: target,
      password_hash: password ? await argon2.hash(password) : null,
      allow_sensitive: file && allowSensitive ? 1 : 0,
      created_at: now,
      expires_at: now + Number(days) * DAY_MS,
    };
    return q.byId.get(q.insert.run(row).lastInsertRowid);
  }

  function lookup(token) {
    if (!TOKEN_RE.test(token)) return { state: 'invalid' };
    const share = q.byToken.get(token);
    if (!share || share.retired_at) return { state: 'invalid' };
    if (share.revoked_at) return { state: 'revoked', share };
    if (share.expires_at <= Date.now()) return { state: 'expired', share };
    return { state: 'ok', share };
  }

  const unlockValue = (share) => createHmac('sha256', secret).update(`${share.id}:${share.password_hash}`).digest('base64url');

  function isUnlocked(share, cookie) {
    if (!share.password_hash) return true;
    const a = Buffer.from(cookie ?? '');
    const b = Buffer.from(unlockValue(share));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function scopeCounts(share) {
    if (share.kind === 'file') return { included: 1, excluded: 0 };
    const all = catalog.filesUnder(share.path);
    const included = all.filter((f) => inScope(share, f)).length;
    return { included, excluded: all.length - included };
  }

  function logVisit(share, req, kind, path = null) {
    q.visit.run(share.id, path, req.ip ?? '', (req.get('user-agent') ?? '').slice(0, 512), (req.get('referer') ?? '').slice(0, 512), kind, Date.now());
  }

  function detail(id) {
    const share = q.byId.get(id);
    if (!share) return null;
    const days = [];
    const now = Date.now();
    for (let i = 29; i >= 0; i--) days.push({ day: formatDay(now - i * DAY_MS, config.timeZone), views: 0, downloads: 0 });
    const index = new Map(days.map((d) => [d.day, d]));
    for (const { ts, kind } of q.daily.all(id, now - 31 * DAY_MS)) {
      const bucket = index.get(formatDay(ts, config.timeZone));
      if (bucket) bucket[kind === 'view' ? 'views' : 'downloads']++;
    }
    return { share, summary: q.summary.get(id), days, visits: q.visits.all(id, 300), counts: scopeCounts(share) };
  }

  return {
    create, lookup, allows, inScope, isUnlocked, unlockValue, logVisit, detail, scopeCounts,
    list: () => q.list.all(),
    activeCount: () => q.active.get(Date.now()),
    revoke: (id) => q.revoke.run(Date.now(), id),
    linkFor: (share) => `${config.baseUrl}/s/${share.token}`,
    filesFor: (share) => (share.kind === 'file' ? [catalog.file(share.path)].filter(Boolean) : catalog.filesUnder(share.path)).filter((f) => inScope(share, f)),
  };
}
