(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

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
  const showReport = (report) => window.showLibraryReport(result, report);

  $('#setup-check').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    result.textContent = '检测中…';
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
