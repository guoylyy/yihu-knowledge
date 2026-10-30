// 文件名规则挡不住“正文里写着口令”的笔记，这里按内容打标。宁可误报：误报只是分享时多确认一步
const PATTERNS = [
  ['password', /(?:password|passwd|pwd|密码|口令)["'`*\s]*[:=：]\s*\S/i],
  ['password', /\|\s*(?:password|passwd|密码|口令)\s*\|/i],
  ['api-key', /(?:api|access|app)[_\- ]?key["'`*\s]*[:=：]\s*\S/i],
  ['secret', /secret["'`*\s]*[:=：]\s*\S/i],
  ['token', /token["'`*\s]*[:=：]\s*["'`]?[A-Za-z0-9_\-.]{16,}/i],
  ['known-key', /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[bpars]-[A-Za-z0-9-]{20,})/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function scanSecrets(text) {
  const kinds = new Set();
  for (const [kind, re] of PATTERNS) if (re.test(text)) kinds.add(kind);
  return [...kinds];
}
