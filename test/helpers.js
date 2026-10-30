import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { effectiveDenyGlobs } from '../src/config.js';
import { createDeny } from '../src/deny.js';
import { runIndex } from '../src/indexer.js';

export const PASSWORD = 'correct-horse-battery';

const FILES = {
  'README.md': '---\ntitle: 总览页\ntags: [项目, 入门]\nstatus: 进行中\n---\n# 文件内标题\n\n链到 [[笔记甲|别名甲]] 和 [[笔记乙#第二节]] 还有 [[不存在的笔记]]。\n\n内联标签 #工作/周报 与代码 `#notatag`。\n',
  'notes/笔记甲.md': '# 笔记甲\n\n合同条款说明，反向链接 [[README]]。\n\n![[图片.png|300]]\n\n![[笔记乙#第二节]]\n\n```js\nconst tag = "#fake [[假链接]]";\n```\n',
  'notes/笔记乙.md': '# 笔记乙\n\n## 第一节\n第一节正文\n\n## 第二节\n第二节正文，工资核算流程。\n\n> [!warning] 注意事项\n> 这是提示内容\n',
  'notes/图片.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  'notes/附件.html': '<html><head><title>网页</title></head><body><script>alert(1)</script><p>网页正文内容</p></body></html>',
  'notes/脚本图.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'notes/数据.csv': '姓名,部门\n"张,三",研发\n李四,销售\n',
  'notes/配置.json': '{"name": "demo"}\n',
  'notes/gbk.txt': Buffer.from('b1b1bea9', 'hex'),
  'notes/xss.md': '# XSS\n\n<script>alert("x")</script>\n\n[bad](javascript:alert(1))\n\n<a href="javascript:alert(2)">bad2</a>\n\n<img src=x onerror="alert(3)">\n\n<iframe src="https://evil.example"></iframe>\n',
  'notes/泄密笔记.md': '# 运维备忘\n\n数据库 password: hunter2-super\n',
  'notes/引用泄密.md': '# 引用\n\n![[泄密笔记]]\n\n![[../secrets-dir/隐藏.md]]\n\n[[工资密码表]]\n',
  'share/公开说明.md': '# 公开说明\n\n可以分享的内容，链接 [[公开二]] 和 [[README]]。\n\n![[../notes/图片.png]]\n',
  'share/公开二.md': '# 公开二\n\n第二篇，引用 [[公开说明]]。\n',
  'share/运维.md': '# 运维\n\napi_key = abcdef123456\n',
  'share/子目录/深层.txt': '深层文本\n',
  '工资密码表.md': '# 绝密\n\n这段内容绝不能被索引 ZZSECRETZZ\n',
  '银行支付模板配置.json': '{"bank": "ZZBANKZZ"}',
  'id-身份证扫描.txt': 'ZZIDZZ',
  'prod.env': 'A=1',
  'server.pem': 'x',
  'MY_TOKEN_NOTES.md': '大小写命中 ZZTOKENZZ',
  '.obsidian/app.json': '{}',
  '.git/config': 'ZZGITZZ',
  '.tmp.driveupload/a.md': 'tmp',
  'node_modules/x/index.js': 'x',
};

export function makeLibrary() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kb-test-'));
  const root = path.join(base, 'library');
  for (const [rel, content] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.join(root, 'secrets-dir'));
  fs.writeFileSync(path.join(root, 'secrets-dir', '隐藏.md'), '不在 deny 里，但被 引用');
  fs.writeFileSync(path.join(base, 'outside.md'), 'OUTSIDE-CONTENT');
  fs.symlinkSync(path.join(base, 'outside.md'), path.join(root, 'link-out.md'));
  fs.symlinkSync(path.join(base), path.join(root, 'link-dir'));
  return { base, root, dataDir: path.join(base, 'data') };
}

export function testConfig(lib, overrides = {}) {
  return {
    root: lib.root,
    dataDir: lib.dataDir,
    password: PASSWORD,
    authMode: 'password',
    allowedUsers: [],
    allowedUserIds: [],
    allowedProfiles: {},
    sso: null,
    baseUrl: 'https://kb.example.com',
    port: 0,
    denyGlobs: effectiveDenyGlobs(),
    ownerName: '测试主人',
    trustProxy: 1,
    cookieSecure: true,
    aiProvider: 'off',
    timeZone: 'Asia/Shanghai',
    zipMaxBytes: 1024 * 1024 * 1024,
    scanIntervalMs: 0,
    ...overrides,
  };
}

export function reindex(kb, opts = {}) {
  return runIndex({ db: kb.db, root: kb.config.root, deny: createDeny(kb.config.denyGlobs), ...opts });
}

export async function startServer(overrides) {
  const lib = makeLibrary();
  const config = testConfig(lib, overrides);
  const kb = await createApp(config);
  reindex(kb);
  const server = await new Promise((resolve) => {
    const s = kb.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    ...kb,
    lib,
    port,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      kb.close();
      fs.rmSync(lib.base, { recursive: true, force: true });
    },
  };
}

// 用原始 http.request，保证 ../ 这类路径不被客户端先规范化
export function request(port, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export class Client {
  constructor(port, ip = '10.0.0.1') {
    this.port = port;
    this.ip = ip;
    this.cookies = new Map();
  }

  async send(target, opts = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = { 'X-Forwarded-For': this.ip, 'User-Agent': 'kb-test-agent', ...(cookie ? { Cookie: cookie } : {}), ...opts.headers };
    const res = await request(this.port, target, { ...opts, headers });
    for (const line of res.headers['set-cookie'] ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  }

  get(target, opts) {
    return this.send(target, opts);
  }

  post(target, form = {}) {
    const body = new URLSearchParams(form).toString();
    return this.send(target, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    });
  }

  login(password = PASSWORD) {
    return this.post('/login', { password });
  }

  async csrf() {
    const page = await this.get('/admin');
    return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  }

  async createShare(fields) {
    const res = await this.post('/admin/shares', { _csrf: await this.csrf(), days: '7', ...fields });
    return res;
  }
}

export const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
