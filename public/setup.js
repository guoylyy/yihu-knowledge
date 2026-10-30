(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const progress = $('#setup-progress');
  if (progress) {
    const bar = $('#progress-bar');
    const label = $('#progress-text');
    const poll = async () => {
      let res;
      try {
        res = await fetch(progress.dataset.url);
      } catch {
        setTimeout(poll, 1000);
        return;
      }
      // 配置完成后接口是 404：这就是「完成了」的信号
      if (res.status === 404) { location.href = progress.dataset.doneUrl; return; }
      const data = await res.json();
      if (data.phase === 'form') { location.reload(); return; }
      bar.max = data.total || 1;
      bar.value = data.done;
      label.textContent = `${data.done} / ${data.total}`;
      setTimeout(poll, 500);
    };
    poll();
    return;
  }

  const form = $('#setup-form');
  if (!form) return;

  const sync = () => {
    const pick = (name) => form.elements[name].value;
    for (const box of $$('[data-show-auth]')) box.hidden = !box.dataset.showAuth.split(' ').includes(pick('authMode'));
    for (const box of $$('[data-show-ai]')) box.hidden = box.dataset.showAi !== pick('aiProvider');
  };
  form.addEventListener('change', sync);
  sync();

  const result = $('#check-result');
  const showReport = (report) => {
    result.replaceChildren();
    if (!report.ok) { result.append(el('p', 'alert', report.error)); return; }
    const tiles = el('dl', 'tiles');
    const tile = (name, value) => {
      const box = el('div');
      box.append(el('dt', '', name), el('dd', '', String(value)));
      tiles.append(box);
    };
    tile('可读文件', report.files.toLocaleString('zh-CN'));
    tile('被排除', report.denied);
    tile('Obsidian 库', report.obsidian ? '是' : '否');
    tile('预计索引', `${report.estimatedSeconds} 秒`);
    const exts = Object.entries(report.byExt).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const chips = el('ul', 'chips');
    for (const [ext, count] of exts) {
      const chip = el('li');
      chip.append(el('code', '', `${ext} ${count}`));
      chips.append(chip);
    }
    result.append(tiles, chips);
    if (report.truncated) result.append(el('p', 'notice', '文件太多，只统计了前 20 万项。确认一下目录没有选错。'));
    if (report.deniedExamples.length) result.append(el('p', 'muted small', `不会被索引的例子：${report.deniedExamples.join('、')}`));
    result.append(el('p', 'muted small', '数字对不上的话，可能是选错了目录。'));
  };

  $('#setup-check').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    result.replaceChildren(el('p', 'muted small', '检测中…'));
    try {
      const res = await fetch(form.dataset.checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: $('#setup-root').value, token: $('#setup-token')?.value }),
      });
      showReport(await res.json());
    } catch {
      showReport({ ok: false, error: '连不上服务，请重试' });
    } finally {
      button.disabled = false;
    }
  });

  $('#picker-unlock')?.addEventListener('click', (event) => {
    const token = $('#setup-token').value.trim();
    if (token) location.href = `${event.currentTarget.dataset.url}?token=${encodeURIComponent(token)}`;
    else $('#setup-token').focus();
  });

  const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  $('#setup-generate').addEventListener('click', () => {
    const limit = 256 - (256 % ALPHABET.length); // 丢弃尾部，避免取模偏差
    let out = '';
    while (out.length < 24) {
      for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        if (byte < limit && out.length < 24) out += ALPHABET[byte % ALPHABET.length];
      }
    }
    const input = $('#setup-password');
    input.type = 'text';
    input.value = out;
    $('#password-note').hidden = false;
  });

  form.addEventListener('submit', (event) => {
    const needsPassword = form.elements.authMode.value !== 'sso';
    const tooShort = needsPassword && $('#setup-password').value.length < Number(form.dataset.minPassword);
    const note = $('#form-error');
    note.hidden = !tooShort;
    if (!tooShort) return;
    event.preventDefault();
    note.textContent = `口令至少 ${form.dataset.minPassword} 位`;
    note.scrollIntoView({ block: 'center' });
  });
})();
