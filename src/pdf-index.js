import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getMeta, setMeta } from './db.js';
import { resolveInside } from './paths.js';
import { scanSecrets } from './secrets.js';
import { countWords, tokenizeForFts } from './text.js';

const PDF_PARSER_VERSION = '1';
export const PDF_MAX_PAGES = 50;
export const PDF_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PDF_MAX_FILE_BYTES = 200 * 1024 * 1024;
const PDF_TIMEOUT_MS = 30 * 1000;
const EXAMPLES = 5;

const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const dirUrl = (name) => `${path.join(pdfjsDir, name)}${path.sep}`;

class PdfTimeout extends Error {}

// 只抽文字不画图，镜像里也没装可选的 canvas。pdfjs 加载时找不到它会往日志打警告，这几行警告说的事这里都用不到
async function loadPdfjs() {
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) globalThis[name] ??= class {};
  const { warn } = console;
  console.warn = () => {};
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.warn = warn;
  }
}

function withTimeout(work, ms, onTimeout) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new PdfTimeout()); }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function readPages(task, maxPages, maxBytes) {
  const doc = await task.promise;
  const scanned = Math.min(doc.numPages, maxPages);
  const parts = [];
  let bytes = 0;
  let read = 0;
  for (let n = 1; n <= scanned && bytes < maxBytes; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const text = items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`).join('');
    page.cleanup();
    parts.push(text);
    bytes += Buffer.byteLength(text);
    read = n;
  }
  const joined = parts.join('\n');
  // 上限按字节算，最后一页可能冲过头；切在多字节字符中间时去掉半个字
  const cut = Buffer.byteLength(joined) > maxBytes;
  const text = cut ? Buffer.from(joined).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '') : joined;
  return { pages: doc.numPages, read, text, truncated: cut || read < doc.numPages };
}

// text_layer 只回答「有没有抽到字」：扫描件上的水印会让它为 true，但比漏掉一份有字的文档强
export async function extractPdfText(file, { maxPages = PDF_MAX_PAGES, maxBytes = PDF_MAX_TEXT_BYTES, timeoutMs = PDF_TIMEOUT_MS } = {}) {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    cMapUrl: dirUrl('cmaps'), cMapPacked: true, standardFontDataUrl: dirUrl('standard_fonts'),
    useSystemFonts: false, disableFontFace: true, stopAtErrors: false, verbosity: 0,
  });
  try {
    const result = await withTimeout(readPages(task, maxPages, maxBytes), timeoutMs, () => task.destroy());
    return { ...result, text_layer: /[\p{L}\p{N}]/u.test(result.text) };
  } finally {
    await task.destroy().catch(() => {});
  }
}

const failureOf = (err) => {
  if (err?.name === 'PasswordException') return 'encrypted';
  return err instanceof PdfTimeout ? 'timeout' : 'unreadable';
};

async function describe(file, size, opts) {
  if (size > opts.maxFileBytes) return { info: { text_layer: null, skipped: 'too-large' }, text: '' };
  try {
    const { text, pages, read, truncated, text_layer } = await extractPdfText(file, opts);
    return { info: { text_layer, pages, read, truncated }, text };
  } catch (err) {
    return { info: { text_layer: false, error: failureOf(err) }, text: '' };
  }
}

function statements(db) {
  return {
    update: db.prepare(`UPDATE files SET pdf_info = @pdf_info, excerpt = @excerpt, words = @words,
                        is_sensitive = @is_sensitive, sensitive_kinds = @sensitive_kinds WHERE id = @id`),
    clearText: db.prepare('DELETE FROM file_text WHERE file_id = ?'),
    clearFts: db.prepare('DELETE FROM fts WHERE rowid = ?'),
    insertText: db.prepare('INSERT INTO file_text (file_id, body) VALUES (?, ?)'),
    insertFts: db.prepare('INSERT INTO fts (rowid, title, path, body) VALUES (?, ?, ?, ?)'),
  };
}

function summarize(rows) {
  const summary = { total: rows.length, noText: 0, encrypted: 0, failed: 0, skipped: 0, truncated: 0, truncatedExamples: [] };
  for (const row of rows) {
    const info = JSON.parse(row.pdf_info ?? '{}');
    if (info.error === 'encrypted') summary.encrypted++;
    else if (info.error) summary.failed++;
    else if (info.skipped) summary.skipped++;
    else if (info.text_layer === false) summary.noText++;
    if (info.truncated) {
      summary.truncated++;
      if (summary.truncatedExamples.length < EXAMPLES) summary.truncatedExamples.push(row.path);
    }
  }
  return summary;
}

// 第二阶段：pdfjs 是异步的，塞不进 runIndex 的同步事务。每份 PDF 自己一个事务，中途退出下次接着做。
// 只碰 is_denied = 0 的行：deny 命中的文件连打开都不打开
export async function indexPdfs({ db, root, maxPages = PDF_MAX_PAGES, maxBytes = PDF_MAX_TEXT_BYTES, maxFileBytes = PDF_MAX_FILE_BYTES, onProgress }) {
  const started = performance.now();
  const realRoot = fs.realpathSync(root);
  const rows = db.prepare("SELECT id, path, title, size, mtime, pdf_info FROM files WHERE ext = 'pdf' AND is_denied = 0").all();
  const keyOf = (row) => [PDF_PARSER_VERSION, row.mtime, row.size, maxPages, maxBytes, maxFileBytes].join(':');
  const pending = rows.filter((row) => JSON.parse(row.pdf_info ?? '{}').key !== keyOf(row));
  const st = statements(db);
  const write = db.transaction((row, info, text) => {
    const kinds = scanSecrets(text);
    st.update.run({
      id: row.id,
      pdf_info: JSON.stringify({ key: keyOf(row), ...info }),
      excerpt: kinds.length ? '' : text.trim().slice(0, 200).replace(/\s+/g, ' '),
      words: countWords(text),
      is_sensitive: kinds.length ? 1 : 0,
      sensitive_kinds: kinds.length ? kinds.join(',') : null,
    });
    st.clearText.run(row.id);
    st.clearFts.run(row.id);
    if (text) st.insertText.run(row.id, text);
    st.insertFts.run(row.id, tokenizeForFts(row.title ?? ''), tokenizeForFts(row.path), tokenizeForFts(text));
  });
  const options = { maxPages, maxBytes, maxFileBytes };
  let done = 0;
  for (const row of pending) {
    let full = null;
    try {
      full = resolveInside(realRoot, row.path);
    } catch { /* 路径变成了符号链接，当作读不到 */ }
    if (full) {
      const { info, text } = await describe(full, row.size, options);
      write(row, info, text);
    }
    onProgress?.({ done: ++done, total: pending.length });
  }
  if (pending.length) setMeta(db, 'index_generation', Number(getMeta(db, 'index_generation') ?? 0) + 1); // 目录快照里的 pdf_info 要跟着换
  const after = db.prepare("SELECT path, pdf_info FROM files WHERE ext = 'pdf' AND is_denied = 0").all();
  return { ...summarize(after), processed: pending.length, seconds: (performance.now() - started) / 1000 };
}
