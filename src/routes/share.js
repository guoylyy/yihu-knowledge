import path from 'node:path';
import argon2 from 'argon2';
import { Router } from 'express';
import { parseCookies } from '../auth.js';
import { NotFound, createContext } from '../reader.js';

const GATE = {
  invalid: [404, '链接无效', '这个分享链接不存在，请向分享人确认。'],
  revoked: [410, '分享已取消', '分享人已经取消了这个分享。'],
  expired: [410, '分享已过期', '这个分享链接已超过有效期，请联系分享人重新生成。'],
};

export function shareRoutes({ catalog, realRoot, auth, shares, reader, config }) {
  const r = Router();
  const unlockCookie = (share) => `kb_s_${share.id}`;

  function renderGate(res, state) {
    const [status, title, message] = GATE[state];
    res.status(status).render('share-gate', { pageTitle: title, title, message, form: false, error: null, token: null });
  }

  function renderPassword(res, status, token, error = null, retryAfter = 0) {
    if (retryAfter) res.set('Retry-After', String(retryAfter));
    res.status(status).render('share-gate', { pageTitle: '需要访问密码', title: '需要访问密码', message: '这个分享设置了访问密码。', form: true, error, token });
  }

  r.post('/:token/unlock', async (req, res) => {
    const { token } = req.params;
    const found = shares.lookup(token);
    if (found.state !== 'ok') return renderGate(res, found.state);
    const { share } = found;
    if (!share.password_hash) return res.redirect(303, `${req.base}/s/${token}`);
    const key = `share:${share.id}:${req.ip}`;
    const locked = auth.throttle.retryAfter(key);
    if (locked) return renderPassword(res, 429, token, `尝试次数过多，请 ${Math.ceil(locked / 60)} 分钟后再试。`, locked);
    auth.throttle.register(key);
    if (!(await argon2.verify(share.password_hash, String(req.body?.password ?? '').slice(0, 1024)))) {
      shares.logVisit(share, req, 'auth_fail');
      return renderPassword(res, 403, token, '访问密码不正确。');
    }
    auth.throttle.clear(key);
    res.cookie(unlockCookie(share), shares.unlockValue(share), { ...auth.cookieOptions(12 * 60 * 60 * 1000), path: `${req.base}/s/${token}` });
    res.redirect(303, `${req.base}/s/${token}`);
  });

  // 所有 /s/<token>/* 的统一入口：无效、过期、未解锁都在触及文件之前返回，响应里不带路径信息
  r.use('/:token', (req, res, next) => {
    const { token } = req.params;
    const found = shares.lookup(token);
    if (found.state !== 'ok') return renderGate(res, found.state);
    const { share } = found;
    if (!shares.isUnlocked(share, parseCookies(req)[unlockCookie(share)])) return renderPassword(res, 401, token);
    req.share = share;
    req.ctx = createContext({
      catalog, realRoot, mode: 'share', base: req.base, prefix: `${req.base}/s/${token}`, share, allow: (f) => shares.allows(share, f),
    });
    next();
  });

  r.get('/:token', (req, res) => {
    const { share, ctx } = req;
    if (share.kind === 'file') {
      const file = catalog.file(share.path);
      if (!file || !ctx.allow(file)) throw new NotFound();
      reader.view(ctx, req, res, `/${encodeURIComponent(file.path)}`);
      shares.logVisit(share, req, 'view', file.path);
    } else {
      reader.dir(ctx, req, res, `/${encodeURIComponent(share.path)}`);
      shares.logVisit(share, req, 'view', share.path);
    }
  });

  r.use('/:token/v', (req, res) => {
    const file = reader.view(req.ctx, req, res, req.path);
    shares.logVisit(req.share, req, 'view', file.path);
  });

  r.use('/:token/d', (req, res) => {
    reader.dir(req.ctx, req, res, req.path);
    shares.logVisit(req.share, req, 'view', decodeURIComponent(req.path).replace(/^\//, ''));
  });

  r.get('/:token/tree', (req, res) => reader.treeFragment(req.ctx, req, res));

  r.use('/:token/raw', (req, res, next) => {
    const file = reader.raw(req.ctx, req, res, next, req.path, 'private, max-age=300');
    if (file) shares.logVisit(req.share, req, 'asset', file.path);
  });

  r.use('/:token/html', (req, res, next) => {
    const file = reader.html(req.ctx, req, res, next, req.path);
    if (file) shares.logVisit(req.share, req, 'asset', file.path);
  });

  r.get('/:token/download', (req, res, next) => {
    const { share, ctx } = req;
    const wanted = typeof req.query.path === 'string' ? req.query.path : null;
    if (!wanted && share.kind === 'dir') {
      const files = shares.filesFor(share);
      if (!files.length) throw new NotFound();
      if (files.reduce((sum, f) => sum + f.size, 0) > config.zipMaxBytes) {
        return res.status(413).render('error', { pageTitle: '文件过大', ctx: null, title: '文件过大', message: '目录体积超过打包上限，请分别下载。' });
      }
      reader.zip(res, files, share.path, path.posix.basename(share.path));
      shares.logVisit(share, req, 'download', share.path);
      return;
    }
    const target = wanted ?? share.path;
    const file = reader.download(ctx, req, res, next, `/${encodeURIComponent(target)}`);
    shares.logVisit(share, req, 'download', file.path);
  });

  return r;
}
