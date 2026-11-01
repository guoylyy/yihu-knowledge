import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Client, PASSWORD, startServer } from './helpers.js';

test('品牌图标：清单写 svg:brand-knowledge', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../yh-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.icon, 'svg:brand-knowledge');
});

test('品牌图标：未登录、登录后、分享访客的页面都有顶栏图标和 favicon，图标文件不用登录', async () => {
  const kb = await startServer();
  try {
    const owner = new Client(kb.port);
    await owner.login(PASSWORD);
    const created = await owner.createShare({ path: 'share/公开说明.md' });
    const link = (await owner.get(created.headers.location)).text.match(/\/s\/[\w-]+/)[0];

    const guest = new Client(kb.port);
    for (const { text } of [await guest.get('/login'), await owner.get('/'), await new Client(kb.port).get(link)]) {
      assert.ok(text.includes('<link rel="icon" type="image/svg+xml" href="/assets/icon.svg">'));
      assert.match(text, /<a class="brand" href="[^"]*"><svg class="brand-icon"[^>]*aria-hidden="true">.*#d2521e.*<\/svg>[^<]/);
    }

    const icon = await guest.get('/assets/icon.svg');
    assert.equal(icon.status, 200);
    assert.match(icon.headers['content-type'], /^image\/svg\+xml/);
    assert.ok(icon.text.includes('#d2521e'));
  } finally {
    await kb.stop();
  }
});
