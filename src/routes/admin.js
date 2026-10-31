import { Router } from 'express';
import QRCode from 'qrcode';
import { browseHandler, createBrowser } from '../browse.js';
import { configSummary, loadSetupEnv } from '../config.js';
import { getMeta } from '../db.js';
import { allowlistMembers } from '../sso.js';
import { ShareError, EXPIRY_DAYS } from '../shares.js';
import { settingsRoutes } from './settings.js';

export function adminRoutes(deps) {
  const { db, config, deny, auth, shares, indexer, catalog, ai, mounts, env } = deps;
  const r = Router();
  const counts = db.prepare(`SELECT COUNT(CASE WHEN is_denied = 0 THEN 1 END) AS indexed, COUNT(CASE WHEN is_denied = 1 THEN 1 END) AS denied,
                                    COUNT(CASE WHEN is_sensitive = 1 THEN 1 END) AS sensitive FROM files`);
  const lastIndex = () => JSON.parse(getMeta(db, 'last_index') ?? 'null');

  const renderShares = (res, { status = 200, error = null, path = '' } = {}) => {
    res.status(status).render('admin/shares', {
      pageTitle: '分享管理', shares: shares.list(), expiryDays: EXPIRY_DAYS, error, path, section: 'shares', now: Date.now(),
    });
  };

  r.use((req, res, next) => {
    res.locals.adminPage = true;
    next();
  });

  r.get('/', (req, res) => {
    res.render('admin/index', {
      pageTitle: '管理后台', section: 'index', counts: counts.get(), last: lastIndex(), running: indexer.running, soffice: config.soffice,
      shareCount: shares.list().length, ai: ai.status(), aiLog: ai.recent(20), logins: auth.recentLogins(20),
      configRows: configSummary(config), configFile: config.configFile,
      authMode: config.authMode, allowedCount: allowlistMembers(config).length, deniedCount: auth.recentDenied(20).length,
    });
  });

  r.post('/reindex', auth.requireCsrf, (req, res) => {
    indexer.run({ full: req.body?.full === '1' }).catch(() => console.error('索引失败'));
    res.redirect(303, `${req.base}/admin`);
  });

  r.use('/settings', settingsRoutes(deps));

  const { inDocker } = loadSetupEnv(env);
  r.get('/browse', browseHandler(() => createBrowser({ roots: config.kbRoots ?? [], mounts, deny, dataDir: config.dataDir, inDocker, soffice: config.soffice })));

  r.get('/paths', (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    if (!q) return res.json([]);
    const { rows, dirs } = catalog.snapshot;
    const hit = (p) => p.toLowerCase().includes(q);
    res.json([...[...dirs.keys()].filter((d) => d && hit(d)).slice(0, 8), ...rows.filter((f) => hit(f.path)).slice(0, 12).map((f) => f.path)]);
  });

  r.get('/shares', (req, res) => renderShares(res, { path: String(req.query.path ?? '') }));

  r.post('/shares', auth.requireCsrf, async (req, res) => {
    try {
      const share = await shares.create({
        path: req.body?.path, days: req.body?.days, password: req.body?.password, allowSensitive: req.body?.allow_sensitive === '1',
      });
      res.redirect(303, `${req.base}/admin/shares/${share.id}`);
    } catch (err) {
      if (!(err instanceof ShareError)) throw err;
      renderShares(res, { status: 400, error: err.message, path: String(req.body?.path ?? '') });
    }
  });

  r.get('/shares/:id', async (req, res, next) => {
    const detail = shares.detail(Number(req.params.id));
    if (!detail) return next();
    const link = shares.linkFor(detail.share);
    res.render('admin/share-detail', {
      pageTitle: '分享详情', section: 'shares', ...detail, link, now: Date.now(),
      qr: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    });
  });

  r.post('/shares/:id/revoke', auth.requireCsrf, (req, res) => {
    shares.revoke(Number(req.params.id));
    res.redirect(303, `${req.base}/admin/shares/${Number(req.params.id)}`);
  });

  return r;
}
