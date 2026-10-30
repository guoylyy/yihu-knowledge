import fs from 'node:fs';
import path from 'node:path';

export class PathRejected extends Error {
  constructor() {
    super('path rejected');
    this.status = 403;
  }
}

// 只接受形如 a/b/c.md 的库内相对路径；任何可疑形态都不做“修正”，直接拒绝
export function normalizeRel(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) throw new PathRejected();
  if (/[\x00-\x1f\x7f\\]/.test(input)) throw new PathRejected();
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) throw new PathRejected();
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new PathRejected();
  }
  return input;
}

export function decodeRel(encoded) {
  const trimmed = encoded.replace(/^\/+/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new PathRejected();
  }
  return normalizeRel(decoded);
}

// realpath 必须与字面路径完全一致：路径上任何一段是符号链接都会让两者不同
export function resolveInside(realRoot, rel) {
  const full = path.join(realRoot, normalizeRel(rel));
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  if (real !== full) throw new PathRejected();
  return full;
}

export function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}
