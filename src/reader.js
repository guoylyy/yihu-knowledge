import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { highlightCode, IMAGE_EXTS, renderMarkdown, VIDEO_EXTS } from './markdown.js';
import { TEXT_EXTS } from './indexer.js';
import { decodeRel, encodePath, normalizeRel, PathRejected, resolveInside } from './paths.js';
import { MAX_OFFICE_BYTES, MAX_SHEET_BYTES, parseCsv, previewDocx, previewPptx, previewSheet } from './preview.js';
import { decodeText, escapeHtml, formatBytes } from './text.js';

const MAX_RENDER_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_DISPLAY = 512 * 1024;
const LANG = { json: 'json', sql: 'sql', py: 'python', js: 'javascript', ts: 'typescript', yaml: 'yaml', yml: 'yaml', sh: 'bash', css: 'css', xml: 'xml', base: 'yaml' };
const INLINE_RAW = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, 'pdf']);
const SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'";
const HTML_CSP = "sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod/i;

// 页面顶部已有标题，正文开头的同名 H1 不再重复显示
function dropRepeatedTitle(html, title) {
  const m = html.match(/^\s*<h1[^>]*>([\s\S]*?)<\/h1>\s*/);
  return m && m[1] === escapeHtml(title ?? '') ? html.slice(m[0].length) : html;
}

export class NotFound extends Error {
  constructor() {
    super('not found');
    this.status = 404;
  }
}

export function createContext({ catalog, realRoot, mode, base = '', prefix, allow, share = null }) {
  const url = (kind, rel, anchor) => `${prefix}/${kind}/${encodePath(rel)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
  const pick = (file) => (file && allow(file) ? file : null);
  return {
    mode,
    share,
    allow,
    base,
    prefix,
    home: mode === 'share' ? prefix : `${base}/`,
    href: (file, anchor) => url('v', file.path, anchor),
    raw: (file) => url('raw', file.path),
    html: (file) => url('html', file.path),
    dirHref: (dir) => (dir ? url('d', dir) : mode === 'share' ? prefix : `${base}/d`),
    download: (file) => (mode === 'share' ? `${prefix}/download?path=${encodeURIComponent(file.path)}` : url('dl', file.path)),
    tagHref: (tag) => (mode === 'share' ? '#' : `${base}/search?tag=${encodeURIComponent(tag)}`),
    treeUrl: `${prefix}/tree`,
    resolveLink: (text, from) => pick(catalog.resolveWiki(text, from)),
    resolveRelative: (text, from) => pick(catalog.resolveRelative(text, from)),
    readNote(file) {
      if (!allow(file)) return null;
      try {
        const full = resolveInside(realRoot, file.path);
        return full ? decodeText(fs.readFileSync(full)) : null;
      } catch {
        return null;
      }
    },
  };
}

export function createReader({ db, catalog, realRoot }) {
  const backlinks = db.prepare(`SELECT DISTINCT f.path FROM links l JOIN files f ON f.id = l.src_id
                                WHERE l.target_id = ? AND l.kind IN ('wiki', 'embed', 'md') AND l.src_id != l.target_id`).pluck();
  const fmJson = db.prepare('SELECT frontmatter_json FROM files WHERE id = ?').pluck();
  const previews = new Map();

  function locate(ctx, encoded) {
    const rel = decodeRel(encoded);
    const file = catalog.file(rel);
    if (!file || !ctx.allow(file)) throw new NotFound();
    const full = resolveInside(realRoot, file.path);
    if (!full) throw new NotFound();
    return { rel, file, full };
  }

  function cachedPreview(file, sheet, build) {
    const key = `${file.path}|${file.mtime}|${file.size}|${sheet ?? ''}`;
    if (previews.has(key)) return previews.get(key);
    const value = build();
    previews.set(key, value);
    if (previews.size > 24) previews.delete(previews.keys().next().value);
    return value;
  }

  function office(file, full, sheet) {
    const limit = file.ext === 'docx' || file.ext === 'pptx' ? MAX_OFFICE_BYTES : MAX_SHEET_BYTES;
    if (file.size > limit) return { kind: 'too-large' };
    try {
      return cachedPreview(file, sheet, () => {
        const buf = fs.readFileSync(full);
        if (file.ext === 'docx') return previewDocx(buf);
        if (file.ext === 'pptx') return previewPptx(buf);
        return previewSheet(buf, sheet);
      });
    } catch {
      return { kind: 'unreadable' };
    }
  }

  function content(ctx, file, full, req) {
    const { ext } = file;
    if (ext === 'md') {
      if (file.size > MAX_RENDER_BYTES) return { kind: 'too-large' };
      const { html, frontmatter } = renderMarkdown(decodeText(fs.readFileSync(full)), { ctx, filePath: file.path });
      return { kind: 'md', html: dropRepeatedTitle(html, file.title), frontmatter };
    }
    if (IMAGE_EXTS.has(ext)) return { kind: 'image', src: ctx.raw(file) };
    if (VIDEO_EXTS.has(ext)) return { kind: 'video', src: ctx.raw(file) };
    if (ext === 'pdf') return { kind: 'pdf', src: ctx.raw(file), mobile: MOBILE_UA.test(req.get('user-agent') ?? '') };
    if (ext === 'html' || ext === 'htm') return { kind: 'html', src: ctx.html(file) };
    if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
      const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
      return { kind: 'office', preview: office(file, full, sheet) };
    }
    if (ext === 'csv' || TEXT_EXTS.has(ext)) {
      const text = decodeText(fs.readFileSync(full));
      if (ext === 'csv') return { kind: 'csv', ...parseCsv(text) };
      const truncated = text.length > MAX_TEXT_DISPLAY;
      const shown = truncated ? text.slice(0, MAX_TEXT_DISPLAY) : text;
      return { kind: 'text', html: highlightCode(shown, LANG[ext]), truncated };
    }
    return { kind: 'binary' };
  }

  function crumbs(ctx, rel) {
    const root = ctx.mode === 'share' ? (ctx.share.kind === 'dir' ? ctx.share.path : null) : '';
    if (root === null) return [];
    const out = [{ name: ctx.mode === 'share' ? path.posix.basename(root) : '全部', href: ctx.dirHref(root) }];
    const relative = root ? rel.slice(root.length + 1) : rel;
    if (!relative) return out;
    const parts = relative.split('/');
    let cur = root;
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      out.push({ name: part, href: ctx.dirHref(cur) });
    }
    return out;
  }

  function neighbours(ctx, file) {
    const siblings = catalog.list(file.dir).files.filter(ctx.allow);
    const i = siblings.findIndex((f) => f.id === file.id);
    return { prev: siblings[i - 1] ?? null, next: siblings[i + 1] ?? null };
  }

  function dirHasAllowed(ctx, dir) {
    return ctx.mode === 'private' || catalog.filesUnder(dir).some(ctx.allow);
  }

  function treeLevel(ctx, dir, activePath) {
    const { dirs, files } = catalog.list(dir);
    return {
      dirs: dirs.filter((d) => dirHasAllowed(ctx, d)).map((d) => {
        const open = activePath === d || activePath.startsWith(`${d}/`);
        return { path: d, name: path.posix.basename(d), open, children: open ? treeLevel(ctx, d, activePath) : null };
      }),
      files: files.filter(ctx.allow).map((f) => ({ ...f, href: ctx.href(f), active: f.path === activePath })),
    };
  }

  function treeRoot(ctx) {
    if (ctx.mode === 'private') return '';
    return ctx.share.kind === 'dir' ? ctx.share.path : null;
  }

  function tree(ctx, activePath = '') {
    const root = treeRoot(ctx);
    return root === null ? null : treeLevel(ctx, root, activePath);
  }

  function view(ctx, req, res, encoded) {
    const { rel, file, full } = locate(ctx, encoded);
    const body = content(ctx, file, full, req);
    const links = ctx.mode === 'private' || ctx.share.kind === 'dir'
      ? backlinks.all(file.id).map((p) => catalog.file(p)).filter((f) => f && ctx.allow(f)) : [];
    const frontmatter = body.frontmatter ?? (fmJson.get(file.id) ? JSON.parse(fmJson.get(file.id)) : null);
    res.render('read', {
      ctx, file, body, frontmatter, backlinks: links,
      ...neighbours(ctx, file),
      crumbs: crumbs(ctx, file.dir),
      tree: tree(ctx, rel),
      pageTitle: file.title || file.name,
      sizeLabel: formatBytes(file.size),
      download: ctx.download(file),
    });
    return file;
  }

  function dir(ctx, req, res, encoded) {
    const rel = encoded.replace(/^\/+/, '') ? decodeRel(encoded) : '';
    const root = treeRoot(ctx);
    if (root === null) throw new NotFound();
    const within = rel === root || rel.startsWith(root ? `${root}/` : '');
    if (!within || !catalog.hasDir(rel) || !dirHasAllowed(ctx, rel)) throw new NotFound();
    const { dirs, files } = catalog.list(rel);
    res.render('dir', {
      ctx,
      dir: rel,
      dirs: dirs.filter((d) => dirHasAllowed(ctx, d)).map((d) => ({ name: path.posix.basename(d), href: ctx.dirHref(d), path: d, count: catalog.filesUnder(d).filter(ctx.allow).length })),
      files: files.filter(ctx.allow).map((f) => ({ ...f, href: ctx.href(f), sizeLabel: formatBytes(f.size) })),
      crumbs: crumbs(ctx, rel),
      tree: tree(ctx, rel),
      pageTitle: rel ? path.posix.basename(rel) : '全部文件',
    });
  }

  function treeFragment(ctx, req, res) {
    const rel = String(req.query.dir ?? '');
    const root = treeRoot(ctx);
    if (root === null) throw new NotFound();
    if (rel) normalizeRel(rel);
    if (rel !== root && !(rel && rel.startsWith(root ? `${root}/` : ''))) throw new NotFound();
    res.render('partials/tree-level', { level: treeLevel(ctx, rel, ''), ctx, depth: 0 });
  }

  function send(res, full, headers, next) {
    res.sendFile(full, { dotfiles: 'allow', cacheControl: false, headers }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  }

  function raw(ctx, req, res, next, encoded, cacheControl = 'private, max-age=3600') {
    const { file, full } = locate(ctx, encoded);
    if (!INLINE_RAW.has(file.ext)) return download(ctx, req, res, next, encoded);
    const headers = { 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' };
    // 所有原文件都不得在本站 origin 下执行脚本；PDF 例外是因为浏览器内置阅读器不能运行在 sandbox 文档里
    headers['Content-Security-Policy'] = file.ext === 'pdf' ? "default-src 'none'; frame-ancestors 'self'" : SANDBOX_CSP;
    send(res, full, headers, next);
    return file;
  }

  function html(ctx, req, res, next, encoded) {
    const { file, full } = locate(ctx, encoded);
    if (file.ext !== 'html' && file.ext !== 'htm') return raw(ctx, req, res, next, encoded);
    res.set({ 'Content-Security-Policy': HTML_CSP, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.type('text/html; charset=utf-8').send(decodeText(fs.readFileSync(full)));
    return file;
  }

  function download(ctx, req, res, next, encoded) {
    const { file, full } = locate(ctx, encoded);
    res.attachment(file.name);
    send(res, full, { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SANDBOX_CSP }, next);
    return file;
  }

  function zip(res, files, baseDir, name) {
    const out = new yazl.ZipFile();
    for (const file of files) {
      const full = resolveInside(realRoot, file.path);
      if (full) out.addFile(full, file.path.slice(baseDir.length + 1), { mtime: new Date(file.mtime) });
    }
    res.attachment(`${name}.zip`);
    res.set('Cache-Control', 'private, no-store');
    out.outputStream.on('error', () => res.destroy());
    out.outputStream.pipe(res);
    out.end();
  }

  return { view, dir, treeFragment, raw, html, download, zip, tree };
}

export function pathErrorStatus(err) {
  return err instanceof PathRejected ? 403 : err instanceof NotFound ? 404 : null;
}

export { encodePath };
