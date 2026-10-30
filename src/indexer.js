import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeMarkdown } from './markdown.js';
import { createResolver } from './catalog.js';
import { getMeta, setMeta } from './db.js';
import { scanSecrets } from './secrets.js';
import { countWords, decodeText, tokenizeForFts } from './text.js';

const PARSER_VERSION = '1';
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_FTS_CHARS = 2 * 1024 * 1024;
const BATCH = 250;

export const TEXT_EXTS = new Set(['txt', 'json', 'sql', 'csv', 'py', 'js', 'ts', 'yaml', 'yml', 'sh', 'css', 'xml', 'log', 'base']);

// 符号链接一律不跟随；Icon\r 这类带控制字符的系统文件不是用户内容
export const isIgnoredEntry = (entry) => entry.isSymbolicLink() || /[\x00-\x1f\x7f\\]/.test(entry.name);

function walk(root, deny) {
  const found = [];
  let denied = 0;
  const visit = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (isIgnoredEntry(entry)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (deny.isDenied(rel, { isDir: true })) { denied++; continue; }
        visit(abs, rel);
      } else if (entry.isFile()) {
        const st = fs.statSync(abs);
        const dot = entry.name.lastIndexOf('.');
        found.push({
          path: rel,
          abs,
          name: entry.name,
          dir: relDir,
          ext: dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '',
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
          denied: deny.isDenied(rel),
        });
      }
    }
  };
  visit(root, '');
  return { found, deniedDirs: denied };
}

function stripHtml(html) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  return { title, text };
}

function parseFile(entry) {
  const base = { title: entry.name, excerpt: '', text: '', frontmatter: null, links: [], tags: [], words: 0, kinds: [] };
  const isMd = entry.ext === 'md';
  const isHtml = entry.ext === 'html' || entry.ext === 'htm';
  if (!isMd && !isHtml && !TEXT_EXTS.has(entry.ext)) return base;
  if (entry.size > MAX_TEXT_BYTES) return base;
  let source;
  try {
    source = decodeText(fs.readFileSync(entry.abs));
  } catch {
    return base;
  }
  const kinds = scanSecrets(source);
  if (isMd) {
    const stem = entry.name.replace(/\.md$/i, '');
    const parsed = analyzeMarkdown(source, stem);
    return { ...base, ...parsed, words: countWords(parsed.text), kinds };
  }
  if (isHtml) {
    const { title, text } = stripHtml(source);
    return { ...base, title: title || entry.name, excerpt: text.trim().slice(0, 200), text, words: countWords(text), kinds };
  }
  return { ...base, excerpt: source.trim().slice(0, 200).replace(/\s+/g, ' '), text: source, words: countWords(source), kinds };
}

function statements(db) {
  return {
    upsert: db.prepare(`
      INSERT INTO files (path, name, dir, ext, size, mtime, title, excerpt, frontmatter_json, is_denied, is_sensitive, sensitive_kinds, words)
      VALUES (@path, @name, @dir, @ext, @size, @mtime, @title, @excerpt, @frontmatter_json, @is_denied, @is_sensitive, @sensitive_kinds, @words)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name, dir = excluded.dir, ext = excluded.ext, size = excluded.size, mtime = excluded.mtime,
        title = excluded.title, excerpt = excluded.excerpt, frontmatter_json = excluded.frontmatter_json,
        is_denied = excluded.is_denied, is_sensitive = excluded.is_sensitive,
        sensitive_kinds = excluded.sensitive_kinds, words = excluded.words
      RETURNING id`),
    clearLinks: db.prepare('DELETE FROM links WHERE src_id = ?'),
    clearTags: db.prepare('DELETE FROM tags WHERE file_id = ?'),
    clearText: db.prepare('DELETE FROM file_text WHERE file_id = ?'),
    clearFts: db.prepare('DELETE FROM fts WHERE rowid = ?'),
    deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
    insertLink: db.prepare('INSERT INTO links (src_id, target_text, kind) VALUES (?, ?, ?)'),
    insertTag: db.prepare('INSERT OR IGNORE INTO tags (file_id, tag) VALUES (?, ?)'),
    insertText: db.prepare('INSERT INTO file_text (file_id, body) VALUES (?, ?)'),
    insertFts: db.prepare('INSERT INTO fts (rowid, title, path, body) VALUES (?, ?, ?, ?)'),
  };
}

function writeEntry(st, entry) {
  // 命中 deny 的文件只留路径级元数据，不解析、不读内容，连 title 都不取
  const parsed = entry.denied ? null : parseFile(entry);
  const { id } = st.upsert.get({
    path: entry.path,
    name: entry.name,
    dir: entry.dir,
    ext: entry.ext,
    size: entry.size,
    mtime: entry.mtime,
    title: parsed?.title ?? null,
    excerpt: parsed?.kinds.length ? '' : parsed?.excerpt ?? null,
    frontmatter_json: parsed?.frontmatter ? JSON.stringify(parsed.frontmatter) : null,
    is_denied: entry.denied ? 1 : 0,
    is_sensitive: parsed?.kinds.length ? 1 : 0,
    sensitive_kinds: parsed?.kinds.length ? parsed.kinds.join(',') : null,
    words: parsed?.words ?? 0,
  });
  st.clearLinks.run(id);
  st.clearTags.run(id);
  st.clearText.run(id);
  st.clearFts.run(id);
  if (!parsed) return;
  for (const link of parsed.links) st.insertLink.run(id, link.target_text, link.kind);
  for (const tag of parsed.tags) st.insertTag.run(id, tag);
  const body = parsed.text.slice(0, MAX_FTS_CHARS);
  if (body) st.insertText.run(id, body);
  st.insertFts.run(id, tokenizeForFts(parsed.title ?? ''), tokenizeForFts(entry.path), tokenizeForFts(body));
}

function resolveLinks(db) {
  const rows = db.prepare('SELECT id, path, name, dir, ext FROM files WHERE is_denied = 0').all();
  const resolver = createResolver(rows);
  const links = db.prepare(`SELECT l.id, l.target_text, l.kind, f.path AS src_path
                            FROM links l JOIN files f ON f.id = l.src_id`).all();
  const update = db.prepare('UPDATE links SET target_id = ? WHERE id = ?');
  let resolved = 0;
  for (const link of links) {
    const fn = link.kind === 'wiki' || link.kind === 'embed' ? resolver.resolveWiki : resolver.resolveRelative;
    const target = fn(link.target_text, link.src_path);
    if (target) resolved++;
    update.run(target?.id ?? null, link.id);
  }
  return resolved;
}

export function runIndex({ db, root, deny, full = false, onProgress }) {
  const started = performance.now();
  const realRoot = fs.realpathSync(root);
  const fingerprint = createHash('sha256').update(`${PARSER_VERSION}\n${deny.globs.join('\n')}`).digest('hex');
  const force = full || getMeta(db, 'index_fingerprint') !== fingerprint;

  const { found, deniedDirs } = walk(realRoot, deny);
  const seen = new Set(found.map((e) => e.path));
  const existing = new Map(db.prepare('SELECT id, path, size, mtime, is_denied FROM files').all().map((r) => [r.path, r]));
  const changed = found.filter((e) => {
    const row = existing.get(e.path);
    return force || !row || row.size !== e.size || row.mtime !== e.mtime || Boolean(row.is_denied) !== e.denied;
  });
  const removed = [...existing.values()].filter((r) => !seen.has(r.path));

  const st = statements(db);
  const dropFile = (row) => { st.clearFts.run(row.id); st.deleteFile.run(row.id); };
  db.transaction(() => removed.forEach(dropFile))();
  const writeBatch = db.transaction((batch) => batch.forEach((e) => writeEntry(st, e)));
  for (let i = 0; i < changed.length; i += BATCH) {
    writeBatch(changed.slice(i, i + BATCH));
    onProgress?.({ done: Math.min(i + BATCH, changed.length), total: changed.length });
  }

  const generation = Number(getMeta(db, 'index_generation') ?? 0);
  const finish = db.transaction(() => {
    if (changed.length || removed.length) resolveLinks(db);
    setMeta(db, 'index_fingerprint', fingerprint);
    setMeta(db, 'index_generation', generation + 1);
  });
  finish();

  const denied = found.filter((e) => e.denied).length;
  const seconds = (performance.now() - started) / 1000;
  const result = {
    total: found.length - denied,
    md: found.filter((e) => !e.denied && e.ext === 'md').length,
    denied,
    deniedDirs,
    processed: changed.length,
    removed: removed.length,
    sensitive: db.prepare('SELECT COUNT(*) FROM files WHERE is_sensitive = 1').pluck().get(),
    seconds,
    at: Date.now(),
  };
  setMeta(db, 'last_index', JSON.stringify(result));
  return result;
}

// 把临时库的索引搬进正式库。kb.sqlite 里还有会话、分享和审计，不能整个文件替换；放在一个事务里，WAL 下读者提交前看到的一直是旧库。
// fts 是 contentless 表读不出原文，影子表又写不了，只能按 file_text 重新灌。
// 旧分享在同一事务里失效：路径相同的文件在新库里是另一份内容，不能让旧链接继续打开
export function adoptIndex({ db, file, now = Date.now() }) {
  db.prepare('ATTACH DATABASE ? AS incoming').run(file);
  try {
    const page = db.prepare(`SELECT f.id, f.title, f.path, t.body FROM incoming.files f
                             LEFT JOIN incoming.file_text t ON t.file_id = f.id
                             WHERE f.is_denied = 0 AND f.id > ? ORDER BY f.id LIMIT ?`);
    const insertFts = db.prepare('INSERT INTO main.fts (rowid, title, path, body) VALUES (?, ?, ?, ?)');
    const retire = db.prepare('UPDATE main.shares SET retired_at = ? WHERE retired_at IS NULL AND revoked_at IS NULL AND expires_at > ?');
    const adopt = db.transaction(() => {
      db.exec(`INSERT INTO main.fts (fts) VALUES ('delete-all');
               DELETE FROM main.links; DELETE FROM main.tags; DELETE FROM main.file_text; DELETE FROM main.files;
               INSERT INTO main.files SELECT * FROM incoming.files;
               INSERT INTO main.links SELECT * FROM incoming.links;
               INSERT INTO main.tags SELECT * FROM incoming.tags;
               INSERT INTO main.file_text SELECT * FROM incoming.file_text;`);
      for (let rows = page.all(0, BATCH); rows.length; rows = page.all(rows.at(-1).id, BATCH)) {
        for (const r of rows) insertFts.run(r.id, tokenizeForFts(r.title ?? ''), tokenizeForFts(r.path), tokenizeForFts(r.body ?? ''));
      }
      db.exec("INSERT OR REPLACE INTO main.meta SELECT key, value FROM incoming.meta WHERE key IN ('index_fingerprint', 'last_index')");
      // 代数只能往上加：临时库从 1 数起，照抄过来可能和进程里缓存的快照撞号
      setMeta(db, 'index_generation', Number(getMeta(db, 'index_generation') ?? 0) + 1);
      return retire.run(now, now).changes;
    });
    const retiredShares = adopt.immediate();
    db.pragma('wal_checkpoint(TRUNCATE)'); // 整库搬一次 WAL 会涨到索引那么大，不收回就一直占着盘
    return { retiredShares };
  } finally {
    db.exec('DETACH DATABASE incoming');
  }
}
