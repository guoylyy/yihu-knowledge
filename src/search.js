import { escapeHtml, tokenizeForFts } from './text.js';

export function parseTerms(q) {
  return q.replace(/["'*^:()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
}

// 词项一律包成带引号的短语，用户输入不会被当作 FTS5 语法
export function toFtsQuery(terms) {
  return terms.map((term) => {
    const tokens = tokenizeForFts(term).trim().split(/\s+/).join(' ');
    const isCjk = tokens.includes(' ') || /^\P{ASCII}+$/u.test(tokens);
    return isCjk ? `"${tokens}"` : `"${tokens}"*`;
  }).join(' ');
}

function highlightSnippet(text, terms, radius = 70) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - radius);
  const raw = text.slice(start, start + radius * 2 + 20).replace(/\s+/g, ' ').trim();
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = raw.split(new RegExp(`(${pattern})`, 'gi'));
  const body = parts.map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
  return `${start > 0 ? '…' : ''}${body}${start + raw.length < text.length ? '…' : ''}`;
}

export function search(db, { q = '', dir = '', tag = '', limit = 50 }) {
  const terms = parseTerms(q);
  if (!terms.length && !tag) return { terms, results: [] };
  const where = ['f.is_denied = 0'];
  const params = {};
  if (dir) {
    where.push('(f.dir = @dir OR substr(f.dir, 1, length(@dirPrefix)) = @dirPrefix)');
    params.dir = dir;
    params.dirPrefix = `${dir}/`;
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.tag = @tag)');
    params.tag = tag;
  }
  const columns = 'f.id, f.path, f.name, f.dir, f.ext, f.title, f.excerpt, f.is_sensitive, f.mtime';
  let rows;
  if (terms.length) {
    params.match = toFtsQuery(terms);
    rows = db.prepare(`SELECT ${columns} FROM fts JOIN files f ON f.id = fts.rowid
                       WHERE fts MATCH @match AND ${where.join(' AND ')}
                       ORDER BY bm25(fts, 10.0, 4.0, 1.0) LIMIT ${Number(limit)}`).all(params);
  } else {
    rows = db.prepare(`SELECT ${columns} FROM files f WHERE ${where.join(' AND ')}
                       ORDER BY f.mtime DESC LIMIT ${Number(limit)}`).all(params);
  }
  const body = db.prepare('SELECT body FROM file_text WHERE file_id = ?').pluck();
  const results = rows.map((row) => {
    let snippet;
    if (row.is_sensitive) snippet = '（含敏感内容，摘要已隐藏）';
    else if (terms.length) snippet = highlightSnippet(body.get(row.id) ?? row.excerpt ?? '', terms);
    else snippet = escapeHtml(row.excerpt ?? '');
    return { ...row, snippet };
  });
  return { terms, results };
}

export function topTags(db, limit = 40) {
  return db.prepare(`SELECT t.tag, COUNT(*) AS n FROM tags t JOIN files f ON f.id = t.file_id
                     WHERE f.is_denied = 0 GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT ?`).all(limit);
}
