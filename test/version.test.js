import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { modeOf, readBuiltAt, VERSION } from '../src/about.js';
import { Client, PASSWORD, startServer } from './helpers.js';

const readJson = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('版本号：package.json、yh-app.json、lock 三处同步，服务端读到的就是它', () => {
  const { version } = readJson('package.json');
  assert.equal(VERSION, version);
  assert.equal(readJson('yh-app.json').version, version);
  const lock = readJson('package-lock.json');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('版本号：登录页未登录可见；登录后顶栏和设置页都有；分享访客的顶栏没有', async () => {
  const kb = await startServer();
  try {
    const guest = new Client(kb.port);
    assert.match((await guest.get('/login')).text, new RegExp(`class="muted login-version">v${VERSION}<`));

    const owner = new Client(kb.port);
    await owner.login(PASSWORD);
    assert.match((await owner.get('/')).text, new RegExp(`class="top-version">v${VERSION}<`));

    const settings = (await owner.get('/admin/settings')).text;
    assert.match(settings, new RegExp(`<th>版本</th><td>v${VERSION}</td>`));
    assert.match(settings, /<th>运行模式<\/th><td>lite/);
    assert.ok(settings.includes(`<th>Node</th><td>${process.version}</td>`));
    assert.match(settings, /<th>构建时间<\/th><td>\d/);

    const created = await owner.createShare({ path: 'share/公开说明.md' });
    const detail = await owner.get(created.headers.location);
    const link = detail.text.match(/\/s\/[\w-]+/)[0];
    const shared = await new Client(kb.port).get(link);
    assert.equal(shared.status, 200);
    assert.doesNotMatch(shared.text, /top-version/);
  } finally {
    await kb.stop();
  }
});

test('/health：结构化字段，?plain=1 仍是纯文本 ok', async () => {
  const kb = await startServer({ soffice: '/opt/fake/soffice' });
  try {
    const guest = new Client(kb.port);
    const res = await guest.get('/health');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    const body = JSON.parse(res.text);
    assert.deepEqual(Object.keys(body), ['status', 'version', 'mode', 'uptime']);
    assert.equal(body.status, 'ok');
    assert.equal(body.version, VERSION);
    assert.equal(body.mode, 'full');
    assert.ok(Number.isInteger(body.uptime) && body.uptime >= 0);

    const plain = await guest.get('/health?plain=1');
    assert.equal(plain.text, 'ok');
    assert.match(plain.headers['content-type'], /^text\/plain/);
  } finally {
    await kb.stop();
  }
});

test('/health 不含敏感字段：路径、口令、key、白名单都不出现', async () => {
  const kb = await startServer({ aiApiKey: 'sk-should-not-leak', allowedUsers: ['alice-in-list'] });
  try {
    for (const target of ['/health', '/healthz']) {
      const { text } = await new Client(kb.port).get(target);
      for (const secret of ['password', 'key', '/Users', '/library', PASSWORD, 'sk-should-not-leak', 'alice-in-list', kb.lib.root, kb.lib.dataDir]) {
        assert.ok(!text.includes(secret), `${target} 含有 ${secret}`);
      }
    }
  } finally {
    await kb.stop();
  }
});

test('构建时间：优先 yh-app.json 的 builtAt，没有或不合法时退回 package.json 的修改时间', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-about-'));
  try {
    const manifest = path.join(dir, 'yh-app.json');
    const pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, '{}');
    const mtime = fs.statSync(pkg).mtimeMs;
    assert.equal(readBuiltAt(manifest, pkg), mtime, '没有清单');
    fs.writeFileSync(manifest, '{}');
    assert.equal(readBuiltAt(manifest, pkg), mtime, '清单没有 builtAt');
    fs.writeFileSync(manifest, '{"builtAt":"not-a-date"}');
    assert.equal(readBuiltAt(manifest, pkg), mtime, 'builtAt 不合法');
    fs.writeFileSync(manifest, '{"builtAt":"2026-10-30T08:00:00Z"}');
    assert.equal(readBuiltAt(manifest, pkg), Date.parse('2026-10-30T08:00:00Z'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运行模式：探测到 soffice 是 full，否则 lite', () => {
  assert.equal(modeOf('/usr/bin/soffice'), 'full');
  assert.equal(modeOf(null), 'lite');
  assert.equal(modeOf(undefined), 'lite');
});
