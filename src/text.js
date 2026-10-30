const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

// FTS5 的 unicode61 不切分中文；每个 CJK 字单独成词后，用短语查询即可命中任意长度的中文词
export function tokenizeForFts(text) {
  return text.replace(CJK, ' $& ');
}

export function countWords(text) {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + latin;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
