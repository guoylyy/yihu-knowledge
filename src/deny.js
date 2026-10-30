function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'iu');
}

function compile(glob) {
  const dirOnly = glob.endsWith('/');
  const body = dirOnly ? glob.slice(0, -1) : glob;
  return { glob, dirOnly, hasSlash: body.includes('/'), re: globToRegex(body.normalize('NFC')) };
}

// 规则作用于路径的每一段：`*密码*` 既拦文件，也拦名字匹配的目录及其全部内容
export function createDeny(globs) {
  const rules = globs.map(compile);
  function matchRule(relPath, { isDir = false } = {}) {
    const segments = relPath.normalize('NFC').split('/');
    for (const rule of rules) {
      for (let i = 0; i < segments.length; i++) {
        if (rule.dirOnly && i === segments.length - 1 && !isDir) continue;
        const candidate = rule.hasSlash ? segments.slice(0, i + 1).join('/') : segments[i];
        if (rule.re.test(candidate)) return rule.glob;
      }
    }
    return null;
  }
  return { globs, matchRule, isDenied: (p, opts) => matchRule(p, opts) !== null };
}
