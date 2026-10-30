(() => {
  const $ = (s) => document.querySelector(s);
  const forms = $('#settings-forms');
  if (!forms) return;

  const progress = $('#library-progress');
  if (progress) {
    const PHASES = { checking: '正在检查目录', indexing: '正在建立新索引', swapping: '正在替换索引' };
    const poll = async () => {
      let job;
      try {
        job = await (await fetch(progress.dataset.url)).json();
      } catch {
        setTimeout(poll, 1000);
        return;
      }
      if (!job.running) { location.reload(); return; }
      $('#library-phase').textContent = PHASES[job.phase];
      $('#library-bar').max = job.total || 1;
      $('#library-bar').value = job.done;
      $('#library-count').textContent = `${job.done} / ${job.total}`;
      setTimeout(poll, 500);
    };
    poll();
  }

  const authForm = $('#auth-form');
  const syncAuth = () => {
    for (const box of document.querySelectorAll('[data-show-auth]')) box.hidden = !box.dataset.showAuth.split(' ').includes(authForm.elements.authMode.value);
  };
  authForm.addEventListener('change', syncAuth);
  syncAuth();

  const aiForm = $('#ai-form');
  const syncAi = () => {
    $('#ai-openai').disabled = aiForm.elements.aiProvider.value !== 'openai';
  };
  aiForm.addEventListener('change', syncAi);

  const form = $('#library-form');
  const dialog = $('#library-dialog');
  if (!form || !dialog) return;
  const result = $('#check-result');

  async function check() {
    try {
      const res = await fetch(form.dataset.checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': forms.dataset.csrf },
        body: JSON.stringify({ root: $('#library-root').value }),
      });
      return await res.json();
    } catch {
      return { ok: false, error: '连不上服务，请重试' };
    }
  }

  $('#library-check').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    result.textContent = '检测中…';
    window.showLibraryReport(result, await check());
    button.disabled = false;
  });

  const accept = $('#library-accept');
  const syncConfirm = () => { $('#library-confirm').disabled = !$('#library-accept-row').hidden && !accept.checked; };
  accept.addEventListener('change', syncConfirm);

  $('#library-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const report = await check();
    button.disabled = false;
    window.showLibraryReport(result, report);
    if (!report.ok) return;
    $('#library-target').textContent = `换到 ${report.root}`;
    $('#library-before').textContent = report.current.toLocaleString('zh-CN');
    $('#library-after').textContent = report.files.toLocaleString('zh-CN');
    $('#library-shares').textContent = report.shares;
    $('#library-anomaly').hidden = !report.anomaly;
    $('#library-anomaly').textContent = report.anomaly ?? '';
    $('#library-accept-row').hidden = !report.anomaly;
    accept.checked = false;
    syncConfirm();
    dialog.showModal();
  });

  $('#library-cancel').addEventListener('click', () => dialog.close());
})();
