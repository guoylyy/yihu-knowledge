import { Router } from 'express';
import { MAX_QUESTION, MAX_TURN_ANSWER, MAX_TURNS } from '../ai.js';
import { SESSION_COOKIE } from '../auth.js';
import { createGraph } from '../graph.js';
import { createContext } from '../reader.js';
import { search, topTags } from '../search.js';

export function privateRoutes({ db, catalog, realRoot, auth, reader, ai, deny, sso }) {
  const r = Router();
  const allow = (f) => !deny.isDenied(f.path);
  const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM files WHERE is_denied = 0) AS files,
                                   (SELECT COALESCE(SUM(words), 0) FROM files WHERE is_denied = 0) AS words,
                                   (SELECT COUNT(*) FROM links WHERE kind IN ('wiki', 'embed') AND target_id IS NOT NULL) AS links`);
  const recent = db.prepare(`SELECT path, name, dir, ext, title, excerpt, mtime FROM files
                             WHERE is_denied = 0 AND ext = 'md' ORDER BY mtime DESC LIMIT 10`);

  r.use((req, res, next) => {
    req.ctx = createContext({ catalog, realRoot, mode: 'private', base: req.base, prefix: req.base, allow });
    next();
  });

  r.post('/logout', auth.requireCsrf, (req, res) => {
    const leavePlatform = req.body?.platform === '1' && sso && req.session.login_via === 'sso';
    const target = leavePlatform ? sso.logoutUrl(req.base) : `${req.base}/login`;
    auth.logout(req, res);
    res.redirect(303, target);
  });

  r.get('/', (req, res) => {
    const { ctx } = req;
    const { dirs } = catalog.list('');
    res.render('home', {
      ctx,
      pageTitle: '首页',
      stats: stats.get(),
      recent: recent.all().map((f) => ({ ...f, href: ctx.href(f) })),
      dirs: dirs.map((d) => ({ name: d, href: ctx.dirHref(d), count: catalog.filesUnder(d).length })),
      tree: reader.tree(ctx),
    });
  });

  r.get('/search', (req, res) => {
    const { ctx } = req;
    const q = String(req.query.q ?? '').slice(0, 200);
    const dir = String(req.query.dir ?? '');
    const tag = String(req.query.tag ?? '');
    const { terms, results } = search(db, { q, dir, tag });
    const hl = terms.length ? `?hl=${encodeURIComponent(terms.join(' '))}` : '';
    res.render('search', {
      ctx, q, dir, tag,
      pageTitle: q ? `搜索：${q}` : '搜索',
      results: results.map((f) => ({ ...f, href: ctx.href(f) + hl })),
      dirs: catalog.list('').dirs,
      tags: topTags(db),
      tree: reader.tree(ctx),
    });
  });

  const graphData = createGraph({ db, catalog, allow });
  r.get('/graph/data', (req, res) => res.json(graphData()));
  r.get('/graph', (req, res) => {
    const wanted = typeof req.query.focus === 'string' ? req.query.focus : '';
    const file = catalog.file(wanted);
    // deny 的路径与不存在的路径表现一致，不让人靠这个探测文件是否存在
    res.render('graph', { ctx: req.ctx, pageTitle: '关系图', focusMissing: Boolean(wanted) && !(file && allow(file)) });
  });

  r.get('/tree', (req, res) => reader.treeFragment(req.ctx, req, res));
  r.use('/v', (req, res) => { reader.view(req.ctx, req, res, req.path); });
  r.use('/d', (req, res) => reader.dir(req.ctx, req, res, req.path));
  r.use('/raw', (req, res, next) => { reader.raw(req.ctx, req, res, next, req.path); });
  r.use('/preview', (req, res, next) => { reader.previewFile(req.ctx, req, res, next, req.path); });
  r.use('/preview-status', (req, res) => { reader.previewStatus(req.ctx, req, res, req.path); });
  r.use('/html', (req, res, next) => { reader.html(req.ctx, req, res, next, req.path); });
  r.use('/dl', (req, res, next) => { reader.download(req.ctx, req, res, next, req.path); });

  const aiFile = (rel) => {
    const file = catalog.file(String(rel ?? ''));
    if (!file || deny.isDenied(file.path)) return null;
    const readable = ['md', 'txt'].includes(file.ext) || (file.ext === 'pdf' && JSON.parse(file.pdf_info ?? '{}').text_layer === true);
    return readable ? file : null;
  };
  const aiHistory = (raw) => (Array.isArray(raw) ? raw : []).slice(-MAX_TURNS)
    .filter((t) => typeof t?.q === 'string' && typeof t?.a === 'string')
    .map((t) => ({ q: t.q.slice(0, MAX_QUESTION), a: t.a.slice(0, MAX_TURN_ANSWER) }));
  // 前端靠 message 展示原因，这里不能落到全局的 HTML 错误页
  const aiReply = async (res, work) => {
    try {
      const { status, ...rest } = await work();
      res.status(status).json(rest);
    } catch {
      console.error('AI 请求处理失败');
      res.status(503).json({ code: 'internal', message: '服务暂时不可用，请稍后再试。' });
    }
  };

  r.post('/ai/summarize', auth.requireCsrf, (req, res) => aiReply(res, async () => {
    const file = aiFile(req.body?.path);
    if (!file) return { status: 404, message: '只能总结当前打开的文本笔记。' };
    const selection = typeof req.body?.selection === 'string' ? req.body.selection.trim() : '';
    const text = selection || req.ctx.readNote(file) || '';
    return ai.summarize({ file, text, isSelection: Boolean(selection) });
  }));

  r.post('/ai/ask', auth.requireCsrf, (req, res) => aiReply(res, async () => {
    const file = aiFile(req.body?.path);
    if (!file) return { status: 404, message: '只能针对当前打开的文本笔记提问。' };
    const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, MAX_QUESTION) : '';
    if (!question) return { status: 400, message: '请先输入问题。' };
    return ai.ask({ file, text: req.ctx.readNote(file) || '', question, history: aiHistory(req.body?.history) });
  }));

  return r;
}
