import path from 'node:path';
import { collator } from './text.js';
import { resolveRelativePath } from './markdown.js';

const key = (s) => s.normalize('NFC').toLowerCase();

// 链接目标解析（Obsidian 语义）：完整路径 > 路径后缀 > 文件名；同名时优先同目录，其次路径最短
export function createResolver(rows) {
  const byPath = new Map();
  const byName = new Map();
  const add = (map, k, row) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  };
  for (const row of rows) {
    const lower = key(row.path);
    byPath.set(lower, row);
    add(byName, key(row.name), row);
    if (row.ext === 'md') add(byName, key(row.name.slice(0, -3)), row);
  }
  const pick = (candidates, fromDir) => {
    if (candidates.length === 1) return candidates[0];
    return [...candidates].sort((a, b) =>
      (b.dir === fromDir) - (a.dir === fromDir) || a.path.length - b.path.length || collator.compare(a.path, b.path))[0];
  };
  function resolveWiki(text, fromPath) {
    if (/^\.\.?\//.test(text)) {
      const rel = resolveRelativePath(text, fromPath);
      return (rel && (byPath.get(key(rel)) ?? byPath.get(`${key(rel)}.md`))) ?? null;
    }
    const t = key(text.replace(/^\//, ''));
    if (!t) return null;
    const fromDir = fromPath.includes('/') ? path.posix.dirname(fromPath) : '';
    if (t.includes('/')) {
      const exact = byPath.get(t) ?? byPath.get(`${t}.md`);
      if (exact) return exact;
      const suffix = `/${t}`;
      const hits = rows.filter((r) => { const p = key(r.path); return p.endsWith(suffix) || p.endsWith(`${suffix}.md`); });
      return hits.length ? pick(hits, fromDir) : null;
    }
    const hits = byName.get(t);
    return hits ? pick(hits, fromDir) : null;
  }
  function resolveRelative(text, fromPath) {
    const rel = resolveRelativePath(text, fromPath);
    const hit = rel && (byPath.get(key(rel)) ?? byPath.get(`${key(rel)}.md`));
    return hit ?? resolveWiki(path.posix.basename(text), fromPath);
  }
  return { resolveWiki, resolveRelative };
}

// 进程内快照：所有 is_denied=1 的行在这里就被丢弃，读路径只能看到这个视图
export function createCatalog(db) {
  const generation = db.prepare("SELECT value FROM meta WHERE key = 'index_generation'").pluck();
  const allRows = db.prepare(`SELECT id, path, name, dir, ext, size, mtime, title, excerpt, is_sensitive, words, pdf_info
                              FROM files WHERE is_denied = 0`);
  const body = db.prepare('SELECT body FROM file_text WHERE file_id = ?').pluck();
  let cached = null;
  let cachedGen = undefined;

  function load() {
    const gen = generation.get();
    if (cached && gen === cachedGen) return cached;
    const rows = allRows.all();
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const dirs = new Map([['', { dirs: new Set(), files: [] }]]);
    const ensure = (dir) => {
      if (dirs.has(dir)) return dirs.get(dir);
      const entry = { dirs: new Set(), files: [] };
      dirs.set(dir, entry);
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      ensure(parent).dirs.add(dir);
      return entry;
    };
    for (const row of rows) ensure(row.dir).files.push(row);
    for (const entry of dirs.values()) entry.files.sort((a, b) => collator.compare(a.name, b.name));
    cached = { rows, byPath, dirs, resolver: createResolver(rows) };
    cachedGen = gen;
    return cached;
  }

  return {
    get snapshot() { return load(); },
    file: (p) => load().byPath.get(p) ?? null,
    body: (id) => body.get(id) ?? null,
    hasDir: (d) => load().dirs.has(d),
    list(dir) {
      const entry = load().dirs.get(dir);
      if (!entry) return { dirs: [], files: [] };
      return { dirs: [...entry.dirs].sort(collator.compare), files: entry.files };
    },
    filesUnder(dir) {
      const prefix = dir ? `${dir}/` : '';
      return load().rows.filter((r) => r.path.startsWith(prefix));
    },
    resolveWiki: (t, from) => load().resolver.resolveWiki(t, from),
    resolveRelative: (t, from) => load().resolver.resolveRelative(t, from),
  };
}
