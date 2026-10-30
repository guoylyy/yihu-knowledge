(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式下不保存 */ } };
  const BASE = document.documentElement.dataset.base ?? ''; // 挂在平台 /apps/<code>/ 下时的路径前缀

  // 目录抽屉
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  const openBtn = $('#drawer-open');
  const setDrawer = (open) => {
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    scrim.hidden = !open;
    openBtn?.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('drawer-locked', open);
  };
  openBtn?.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
  $('#drawer-close')?.addEventListener('click', () => setDrawer(false));
  scrim?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
  $('.tree-file.active')?.scrollIntoView({ block: 'center' });

  // 目录树按需加载，避免每页都带上全库的 HTML
  drawer?.addEventListener('toggle', async (e) => {
    const node = e.target;
    if (!node.open || node.hasAttribute('data-loaded')) return;
    node.setAttribute('data-loaded', '');
    const res = await fetch(`${drawer.dataset.treeUrl}?dir=${encodeURIComponent(node.dataset.dir)}`);
    if (res.ok) node.insertAdjacentHTML('beforeend', await res.text());
    else node.removeAttribute('data-loaded');
  }, true);

  // 深色模式
  $('#theme-toggle')?.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store('kb-theme', root.dataset.theme);
  });

  // 字号
  const sizes = $$('.font-size button');
  const markSize = () => sizes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === document.documentElement.dataset.fs)));
  sizes.forEach((b) => b.addEventListener('click', () => {
    document.documentElement.dataset.fs = b.dataset.size;
    store('kb-fs', b.dataset.size);
    markSize();
  }));
  markSize();

  // 从搜索结果进入时高亮命中词
  const hl = new URLSearchParams(location.search).get('hl');
  const content = $('#content');
  if (hl && content) {
    const terms = hl.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
    let first = null;
    for (const node of nodes) {
      const parts = node.nodeValue.split(re);
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => {
        if (i % 2) {
          const mark = document.createElement('mark');
          mark.textContent = part;
          first ??= mark;
          frag.append(mark);
        } else if (part) frag.append(part);
      });
      node.replaceWith(frag);
    }
    first?.scrollIntoView({ block: 'center' });
  }

  // AI 总结与追问：只发当前这一篇，或用户选中的片段
  const aiSheet = $('#ai-sheet');
  if (aiSheet) {
    const article = $('article[data-path]');
    const aiLog = $('#ai-log');
    const aiForm = $('#ai-form');
    const aiInput = $('#ai-input');
    const aiScrim = $('#ai-scrim');
    const turns = [];
    let busy = false;
    let summarized = false;

    const post = async (url, body) => {
      try {
        const res = await fetch(`${BASE}${url}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': article.dataset.csrf },
          body: JSON.stringify({ path: article.dataset.path, ...body }),
          signal: AbortSignal.timeout(110000),
        });
        if ((res.headers.get('content-type') ?? '').includes('json')) return { ok: res.ok, ...(await res.json()) };
        const known = { 401: '登录已过期，请刷新页面重新登录。', 403: '页面已过期，请刷新后再试。', 413: '选中的内容太长，请少选一些。' };
        return { ok: false, message: known[res.status] ?? `服务暂时不可用（HTTP ${res.status}），请稍后再试。` };
      } catch (err) {
        return { ok: false, message: err.name === 'TimeoutError' ? '模型响应超时，请稍后再试。' : '连不上服务器，请检查网络后重试。' };
      }
    };

    const bubble = (cls, text) => {
      const el = document.createElement('div');
      el.className = `ai-msg ${cls}`;
      if (text) el.textContent = text;
      aiLog.append(el);
      aiLog.scrollTop = aiLog.scrollHeight;
      return el;
    };
    const fmtWhen = (ts) => new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const showAnswer = (el, data) => {
      el.className = 'ai-msg ai-answer prose';
      el.innerHTML = data.html; // 服务端已渲染：不含原始 HTML，也不含图片
      const notes = [];
      if (data.truncated) notes.push(`已截断，只看前 ${data.shownChars.toLocaleString('zh-CN')} 字`);
      notes.push(data.cached ? `已缓存 · ${fmtWhen(data.cachedAt)}` : `用时 ${(data.ms / 1000).toFixed(1)} 秒`);
      const foot = document.createElement('p');
      foot.className = 'ai-foot';
      foot.textContent = notes.join(' · ');
      if (data.truncated) foot.classList.add('warn');
      el.append(foot);
    };

    const showError = (el, message, retry) => {
      el.className = 'ai-msg ai-error';
      el.textContent = message;
      if (!retry) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = '重试';
      btn.addEventListener('click', () => {
        el.remove();
        retry();
      });
      el.append(btn);
    };

    const setBusy = (on) => {
      busy = on;
      $('#ai-send').disabled = on;
    };

    const summarize = async (selection) => {
      if (busy) return;
      setBusy(true);
      const el = bubble('ai-wait', selection ? '正在读选中的片段…（可能需要 10~20 秒）' : '正在读这篇…（可能需要 10~20 秒）');
      const data = await post('/ai/summarize', { selection });
      if (data.ok) {
        showAnswer(el, data);
        summarized = !selection;
        turns.push({ q: selection ? '总结选中的片段' : '总结这篇', a: data.answer });
      } else showError(el, data.message, () => summarize(selection));
      setBusy(false);
    };

    const ask = async (question) => {
      setBusy(true);
      const el = bubble('ai-wait', '正在想…');
      const data = await post('/ai/ask', { question, history: turns.slice(-6) });
      if (data.ok) {
        showAnswer(el, data);
        turns.push({ q: question, a: data.answer });
      } else showError(el, data.message, () => ask(question));
      setBusy(false);
    };

    const setSheet = (open) => {
      aiSheet.hidden = !open;
      aiScrim.hidden = !open;
      document.body.classList.toggle('drawer-locked', open);
      if (open) $('#ai-close').focus();
      else $('#ai-summary').focus();
    };

    $('#ai-summary').addEventListener('click', () => {
      const selection = getSelection()?.toString().trim() ?? '';
      setSheet(true);
      if (selection || !summarized) summarize(selection);
    });
    $('#ai-close').addEventListener('click', () => setSheet(false));
    aiScrim.addEventListener('click', () => setSheet(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aiSheet.hidden) setSheet(false); });

    aiForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const question = aiInput.value.trim();
      if (!question || busy) return;
      aiInput.value = '';
      bubble('ai-question', question);
      ask(question);
    });

    // 把手下拉关闭
    const grip = $('#ai-grip');
    let dragFrom = null;
    grip.addEventListener('pointerdown', (e) => {
      dragFrom = e.clientY;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointerup', (e) => {
      if (dragFrom !== null && e.clientY - dragFrom > 60) setSheet(false);
      dragFrom = null;
    });

    // iOS 弹出键盘时 fixed 元素不跟随缩小，手动贴合可视区域，输入框才不会被挡住
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', () => {
      aiSheet.style.setProperty('--ai-vh', `${viewport.height}px`);
    });
  }

  // iPadOS 伪装成桌面 UA，服务端判断不出来，这里再兜一次
  const pdf = $('#pdf-frame');
  if (pdf && navigator.maxTouchPoints > 1) {
    pdf.remove();
    $('#pdf-fallback').hidden = false;
  }

  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const input = $(btn.dataset.copy);
    input.select();
    try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
    btn.textContent = '已复制';
  }));

  // 分享路径联想
  const pathInput = $('#share-path');
  const options = $('#share-paths');
  let timer;
  pathInput?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const res = await fetch(`${BASE}/admin/paths?q=${encodeURIComponent(pathInput.value)}`);
      if (!res.ok) return;
      options.replaceChildren(...(await res.json()).map((value) => Object.assign(document.createElement('option'), { value })));
    }, 200);
  });

  // 趋势图：触屏没有悬停，点一下在图下显示当天数据
  const readout = $('#trend-readout');
  $$('#trend g[data-label]').forEach((g) => {
    const show = () => { readout.textContent = g.dataset.label; };
    g.addEventListener('pointerenter', show);
    g.addEventListener('click', show);
    g.addEventListener('focus', show);
  });
})();
