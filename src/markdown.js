import path from 'node:path';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';
import YAML from 'yaml';
import { escapeHtml } from './text.js';

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm']);
const HIGHLIGHT_LIMIT = 200 * 1024;

export function splitFrontmatter(source) {
  const src = source.replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, body: src };
  let data = null;
  try {
    const parsed = YAML.parse(m[1], { logLevel: 'error' });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    data = null;
  }
  return { data, body: src.slice(m[0].length) };
}

export function parseWikiInner(inner, embed) {
  const text = inner.replace(/\\\|/g, '|');
  const bar = text.indexOf('|');
  const left = bar >= 0 ? text.slice(0, bar) : text;
  const alias = bar >= 0 ? text.slice(bar + 1).trim() : null;
  const hash = left.indexOf('#');
  const file = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const anchor = hash >= 0 ? left.slice(hash + 1).trim() : null;
  return { file, anchor, alias, embed };
}

export function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

function wikilinkRule(state, silent) {
  const { src, pos } = state;
  let p = pos;
  let embed = false;
  if (src.charCodeAt(p) === 0x21) {
    embed = true;
    p++;
  }
  if (src.charCodeAt(p) !== 0x5b || src.charCodeAt(p + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', p + 2);
  if (end < 0) return false;
  const inner = src.slice(p + 2, end);
  if (!inner.trim() || inner.includes('\n')) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.meta = parseWikiInner(inner, embed);
  }
  state.pos = end + 2;
  return true;
}

const TAG_RE = /^#([\p{L}\p{N}_/-]+)/u;

function tagRule(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x23) return false;
  const prev = state.pos === 0 ? ' ' : state.src[state.pos - 1];
  if (!/\s/.test(prev)) return false;
  const m = state.src.slice(state.pos).match(TAG_RE);
  if (!m || /^[\d/_-]+$/.test(m[1])) return false;
  if (!silent) {
    const token = state.push('kbtag', '', 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

function calloutRule(state) {
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open' || tokens[i + 2]?.type !== 'inline') continue;
    const inline = tokens[i + 2];
    const m = inline.content.match(/^\[!([\w-]+)\]([+-]?)[ \t]*(.*)/);
    if (!m) continue;
    const [, type, fold, title] = m;
    const callout = type.toLowerCase();
    (state.env.callouts ??= []).push({ type: callout, title });
    const open = tokens[i];
    let depth = 0;
    let close = null;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      if (tokens[j].type === 'blockquote_close' && --depth === 0) { close = tokens[j]; break; }
    }
    const tag = fold ? 'details' : 'div';
    open.tag = tag;
    close.tag = tag;
    open.attrSet('class', `callout callout-${slugify(callout)}`);
    if (fold === '+') open.attrSet('open', '');
    const breakAt = inline.children.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
    inline.children = breakAt >= 0 ? inline.children.slice(breakAt + 1) : [];
    inline.content = '';
    const titleToken = new state.Token('callout_title', '', 0);
    titleToken.content = title || type;
    titleToken.meta = { fold };
    tokens.splice(i + 1, 0, titleToken);
  }
}

function headingIdRule(state) {
  const seen = new Map();
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const base = slugify(state.tokens[i + 1].content) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    token.attrSet('id', n ? `${base}-${n}` : base);
  });
}

function highlight(code, lang) {
  if (lang && code.length <= HIGHLIGHT_LIMIT && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* 高亮失败时退回纯文本 */
    }
  }
  return escapeHtml(code);
}

export function highlightCode(code, lang) {
  return highlight(code, lang);
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: true, highlight });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
md.use(taskLists, { enabled: false });
md.inline.ruler.before('link', 'wikilink', wikilinkRule);
md.inline.ruler.before('wikilink', 'kbtag', tagRule);
md.core.ruler.after('inline', 'callout', calloutRule);
md.core.ruler.after('callout', 'heading_id', headingIdRule);

const nullContext = {
  resolveLink: () => null,
  resolveRelative: () => null,
  href: () => '#',
  raw: () => '#',
  tagHref: (tag) => `#${encodeURIComponent(tag)}`,
  readNote: () => null,
};

const isExternal = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

function decodeHref(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

const missing = (text) => `<span class="wikilink-missing" title="目标不存在或未包含">${escapeHtml(text)}</span>`;

function sectionOf(body, anchor) {
  const lines = body.split(/\r?\n/);
  const wanted = slugify(anchor);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slugify(l.replace(/^#+\s*/, '')) === wanted);
  if (start < 0) return body;
  const level = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(lines[end].match(/^#+(?=\s)/)?.[0].length <= level)) end++;
  return lines.slice(start, end).join('\n');
}

function renderEmbed(meta, env) {
  const { ctx } = env;
  const file = ctx.resolveLink(meta.file, env.filePath);
  if (!file) return missing(meta.alias || meta.file);
  if (IMAGE_EXTS.has(file.ext)) {
    const size = meta.alias?.match(/^(\d+)(?:x(\d+))?$/);
    const attrs = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '';
    const alt = size ? file.name : meta.alias || file.name;
    return `<img src="${escapeHtml(ctx.raw(file))}" alt="${escapeHtml(alt)}" loading="lazy"${attrs}>`;
  }
  if (VIDEO_EXTS.has(file.ext)) return `<video src="${escapeHtml(ctx.raw(file))}" controls preload="metadata"></video>`;
  if (file.ext !== 'md') return `<a class="embed-file" href="${escapeHtml(ctx.href(file))}">${escapeHtml(meta.alias || file.name)}</a>`;
  const link = `<a href="${escapeHtml(ctx.href(file))}">${escapeHtml(file.title || file.name)}</a>`;
  if (env.depth >= 2 || env.seen.has(file.path)) return `<div class="embed-note"><div class="embed-title">${link}</div></div>`;
  const source = ctx.readNote(file);
  if (source === null) return missing(meta.alias || meta.file);
  const { body } = splitFrontmatter(source);
  const inner = renderBody(meta.anchor ? sectionOf(body, meta.anchor) : body, {
    ctx, filePath: file.path, depth: env.depth + 1, seen: new Set([...env.seen, file.path]),
  });
  return `<div class="embed-note"><div class="embed-title">${link}</div>${inner}</div>`;
}

md.renderer.rules.wikilink = (tokens, idx, _opts, env) => {
  const meta = tokens[idx].meta;
  if (meta.embed) return renderEmbed(meta, env);
  if (!meta.file) {
    return meta.anchor ? `<a href="#${escapeHtml(encodeURIComponent(slugify(meta.anchor)))}">${escapeHtml(meta.alias || meta.anchor)}</a>` : '';
  }
  const label = meta.alias || (meta.anchor ? `${meta.file} › ${meta.anchor}` : meta.file);
  const file = env.ctx.resolveLink(meta.file, env.filePath);
  if (!file) return missing(label);
  const anchor = meta.anchor ? slugify(meta.anchor) : null;
  return `<a class="wikilink" href="${escapeHtml(env.ctx.href(file, anchor))}">${escapeHtml(label)}</a>`;
};

md.renderer.rules.kbtag = (tokens, idx, _opts, env) => {
  const tag = tokens[idx].content;
  return `<a class="tag" href="${escapeHtml(env.ctx.tagHref(tag))}">#${escapeHtml(tag)}</a>`;
};

md.renderer.rules.callout_title = (tokens, idx) => {
  const { content, meta } = tokens[idx];
  const tag = meta.fold ? 'summary' : 'div';
  return `<${tag} class="callout-title">${escapeHtml(content)}</${tag}>`;
};

md.renderer.rules.image = (tokens, idx, _opts, env) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  const alt = token.content || '';
  if (isExternal(src)) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  const file = env.ctx.resolveRelative(decodeHref(src), env.filePath);
  if (!file) return missing(alt || '图片');
  return `<img src="${escapeHtml(env.ctx.raw(file))}" alt="${escapeHtml(alt)}" loading="lazy">`;
};

const defaultLinkOpen = md.renderer.renderToken.bind(md.renderer);
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';
  if (isExternal(href)) {
    token.attrSet('rel', 'noopener noreferrer');
    token.attrSet('target', '_blank');
  } else if (!href.startsWith('#')) {
    const [target, anchor] = decodeHref(href).split('#');
    const file = env.ctx.resolveRelative(target, env.filePath);
    if (file) token.attrSet('href', env.ctx.href(file, anchor ? slugify(anchor) : null));
    else {
      token.attrs = token.attrs.filter(([k]) => k !== 'href');
      token.attrSet('class', 'wikilink-missing');
    }
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

function renderBody(body, env) {
  return md.render(body, env);
}

const SANITIZE_BASE = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'kbd', 'mark', 'sub', 'sup',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'video', 'span', 'div', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'small', 'abbr',
    'details', 'summary', 'input', 'center', 'font',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target', 'class'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    video: ['src', 'controls', 'preload'],
    input: ['type', 'checked', 'disabled', 'class'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
    details: ['open', 'class'],
    font: ['color'],
    '*': ['class'],
  },
  allowedClasses: {
    '*': ['hljs', 'hljs-*', 'language-*', 'callout', 'callout-*', 'wikilink', 'wikilink-missing', 'embed-*', 'tag', 'table-wrap', 'task-list-item', 'task-list-item-checkbox', 'contains-task-list'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'escape',
};

function sanitizeOptions(env) {
  return {
    ...SANITIZE_BASE,
    transformTags: {
      input: (tagName, attribs) => ({ tagName, attribs: { ...attribs, disabled: 'disabled' } }),
      // md 里手写的 <img src="相对路径"> 也要走库内路径解析，不能原样落到页面
      img: (tagName, attribs) => {
        const src = attribs.src || '';
        const base = env.ctx.base ?? '';
        if (!src || isExternal(src) || src.startsWith(`${base}/raw/`) || src.startsWith(`${base}/s/`)) return { tagName, attribs };
        const file = env.ctx.resolveRelative(decodeHref(src), env.filePath);
        const next = { ...attribs };
        if (file) next.src = env.ctx.raw(file);
        else delete next.src;
        return { tagName, attribs: next };
      },
    },
  };
}

// 模型输出当作不可信内容：笔记里的注入文字可能诱导模型输出外链图片，图片一加载就把内容带出站，所以不开 html 也不开图片
const answerMd = new MarkdownIt({ html: false, linkify: false, breaks: true }).disable('image');
export const renderAnswer = (text) => answerMd.render(text);

export function renderMarkdown(source, { ctx = nullContext, filePath = '' } = {}) {
  const { data, body } = splitFrontmatter(source);
  const env = { ctx, filePath, depth: 0, seen: new Set([filePath]) };
  return { html: sanitizeHtml(renderBody(body, env), sanitizeOptions(env)), frontmatter: data };
}

function normalizeTag(tag) {
  return String(tag).trim().replace(/^#/, '');
}

function frontmatterTags(data) {
  const raw = data?.tags ?? data?.tag;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list.map(normalizeTag).filter(Boolean);
}

// 索引用：解析与渲染共用同一套 token，保证代码块里的 [[x]]、#y 不会被误判
export function analyzeMarkdown(source, fallbackTitle = '') {
  const { data, body } = splitFrontmatter(source);
  const env = {};
  const tokens = md.parse(body, env);
  const links = [];
  const tags = new Set(frontmatterTags(data));
  const parts = [];
  let h1 = null;
  let excerptParts = [];
  let inHeading = false;

  const walkInline = (children, target) => {
    for (const child of children) {
      if (child.type === 'wikilink') {
        const { file, alias, embed } = child.meta;
        if (file) links.push({ target_text: file, kind: embed ? 'embed' : 'wiki' });
        target.push(alias || file);
      } else if (child.type === 'kbtag') {
        tags.add(child.content);
        target.push(`#${child.content}`);
      } else if (child.type === 'image') {
        const src = child.attrGet('src') || '';
        if (src && !isExternal(src)) links.push({ target_text: decodeHref(src), kind: 'image' });
        target.push(child.content);
      } else if (child.type === 'link_open') {
        const href = child.attrGet('href') || '';
        if (href && !isExternal(href) && !href.startsWith('#')) links.push({ target_text: decodeHref(href).split('#')[0], kind: 'md' });
      } else if (child.type === 'text' || child.type === 'code_inline') {
        target.push(child.content);
      } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
        target.push(' ');
      }
    }
  };

  tokens.forEach((token, i) => {
    if (token.type === 'heading_open') inHeading = true;
    if (token.type === 'heading_close') inHeading = false;
    if (token.type === 'inline') {
      const chunk = [];
      walkInline(token.children, chunk);
      const text = chunk.join('');
      parts.push(text);
      if (tokens[i - 1]?.tag === 'h1' && h1 === null) h1 = text.trim();
      if (!inHeading && text.trim()) excerptParts.push(text.trim());
    } else if (token.type === 'fence' || token.type === 'code_block') {
      parts.push(token.content);
    } else if (token.type === 'callout_title') {
      parts.push(token.content);
    }
  });

  const title = (typeof data?.title === 'string' && data.title.trim()) || h1 || fallbackTitle;
  return {
    title,
    excerpt: excerptParts.join(' ').slice(0, 200),
    text: parts.join('\n'),
    frontmatter: data,
    links,
    tags: [...tags],
    callouts: env.callouts ?? [],
  };
}

export function resolveRelativePath(target, fromPath) {
  const clean = target.replace(/^\.\//, '');
  if (clean.startsWith('/')) return path.posix.normalize(clean.slice(1));
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), clean));
  return joined.startsWith('..') ? null : joined;
}
