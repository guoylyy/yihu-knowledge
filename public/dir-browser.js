// 向导和设置页共用的目录浏览器。列表由 /browse 接口返回，大目录不会卡住首屏
(() => {
  const box = document.querySelector('#dir-browser');
  if (!box) return;
  const $ = (s) => box.querySelector(s);
  const input = document.querySelector(box.dataset.input);
  const panel = $('#dir-panel');
  const hints = $('#dir-hints');
  const list = $('#dir-list');
  const status = $('#dir-status');
  const crumbs = $('#dir-crumbs');
  const filter = $('#dir-filter');
  const pick = $('#dir-pick');
  const selected = $('#dir-selected');
  const command = $('#dir-command');
  const token = document.querySelector('#setup-token');
  const FILTER_FROM = 12; // 少于这个数一眼能看完，不用搜索框

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const num = (n) => n.toLocaleString('zh-CN');
  const count = (n, more) => `${num(n)}${more ? '+' : ''}`;
  const showStatus = (text) => {
    status.hidden = !text;
    status.textContent = text ?? '';
  };

  let controller = null;
  let timer = null;
  let current = '';
  let last = null;

  function fetchList(path, q) {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (q) params.set('q', q);
    const headers = token?.value.trim() ? { 'X-Setup-Token': token.value.trim() } : {};
    controller?.abort();
    controller = new AbortController();
    return fetch(`${box.dataset.url}?${params}`, { headers, signal: controller.signal });
  }

  function select(path, label) {
    input.value = path;
    selected.hidden = false;
    selected.replaceChildren(el('strong', '', '已选择 '), el('code', '', path), document.createTextNode(label ? `（${label}）` : ''));
    document.querySelector(box.dataset.check)?.click();
  }

  function renderHints(data) {
    const { selectable, elsewhere } = data.hints;
    hints.hidden = !selectable.length && !elsewhere.length;
    hints.replaceChildren();
    if (selectable.length) {
      const line = el('p', 'notice dir-hint', '检测到这些目录可以选：');
      selectable.forEach((dir, i) => {
        if (i) line.append('、');
        const link = el('button', 'dir-hint-link', dir.path);
        link.type = 'button';
        link.addEventListener('click', () => open(dir.path));
        line.append(link, `（${count(dir.mdCount, dir.more)} 个 md 文件，${dir.writable ? '读写' : '只读'}）`);
      });
      hints.append(line);
    }
    if (elsewhere.length) hints.append(el('p', 'muted small', `还挂载了 ${elsewhere.join('、')}，不在 KB_ROOTS 里所以不能浏览。可以展开「高级」手填，或把它加进 KB_ROOTS。`));
    command.hidden = !data.command;
    if (data.command) {
      $('#dir-command-note').textContent = '容器里没有可选的目录：笔记还没挂进来。用下面的命令重新创建容器（已有同名容器先删掉），把路径换成你的笔记目录，再回到这个页面。';
      $('#dir-command-text').textContent = data.command;
    }
  }

  function renderCrumbs(data) {
    crumbs.replaceChildren();
    const add = (name, path, isLast) => {
      if (isLast) {
        const here = el('span', 'dir-crumb-here', name);
        here.setAttribute('aria-current', 'location');
        crumbs.append(here);
        return;
      }
      const link = el('button', 'dir-crumb', name);
      link.type = 'button';
      link.addEventListener('click', () => open(path));
      crumbs.append(link, el('span', 'dir-crumb-sep', '›'));
    };
    add('全部目录', '', !data.crumbs.length);
    data.crumbs.forEach((crumb, i) => add(crumb.name, crumb.path, i === data.crumbs.length - 1));
  }

  function renderRow(dir) {
    const row = el('li', 'dir-row');
    const meta = el('span', 'dir-meta');
    meta.append(
      el('span', 'dir-count', dir.unreadable ? '没有读取权限' : `${count(dir.mdCount, dir.more)} 篇`),
      el('span', `dir-tag${dir.writable ? '' : ' readonly'}`, dir.writable ? '读写' : '只读'),
    );
    const text = el('span', 'dir-text');
    text.append(el('span', 'dir-name', dir.name), meta);
    const enter = el('button', 'btn dir-enter', '进入');
    enter.type = 'button';
    enter.setAttribute('aria-label', `进入 ${dir.name}`);
    enter.addEventListener('click', () => open(dir.path));
    row.append(text, enter);
    return row;
  }

  const labelOf = (data) => `${count(data.currentMdCount, data.currentMore)} 篇`;
  const accessOf = (data) => (data.writable ? '读写' : '只读');

  function statusOf(data) {
    if (data.truncated) return `共 ${num(data.matched)} 个子目录，只列出前 ${data.dirs.length} 个。用上面的搜索框按名字过滤。`;
    if (filter.value.trim() && !data.dirs.length) return '没有名字匹配的子目录。';
    if (data.path && !data.currentMdCount && !data.currentMore) return '这个目录里没有 .md 文件';
    if (!data.path && !data.dirs.length && !data.command) return 'KB_ROOTS 里的目录都不存在或是空的。设置 KB_ROOTS 后重启，或在「高级」里手填路径。';
    return '';
  }

  function render(data) {
    current = data.path;
    last = data;
    panel.hidden = Boolean(data.command);
    renderCrumbs(data);
    list.replaceChildren(...data.dirs.map(renderRow));
    filter.hidden = data.total < FILTER_FROM;
    pick.hidden = !data.currentMdCount;
    pick.textContent = `选这个目录（${labelOf(data)}）`;
    pick.onclick = () => select(data.path, `${labelOf(data)}，${accessOf(data)}`);
    if (data.hints) renderHints(data);
    else command.hidden = true;
    // 没东西可浏览时，手填是唯一的路
    if (!data.path && !data.dirs.length) box.parentElement.querySelector('.dir-advanced').open = true;
    showStatus(statusOf(data));
  }

  async function load(path, q) {
    list.setAttribute('aria-busy', 'true');
    panel.hidden = false;
    showStatus('读取中…');
    try {
      const res = await fetchList(path, q);
      if (res.status === 401) {
        panel.hidden = true;
        hints.hidden = false;
        hints.replaceChildren(el('p', 'notice', '填上面的设置码后，这里会列出可以选的目录。'));
        return;
      }
      // 不在范围、不存在、没权限在接口上是同一个 403
      if (res.status === 403) { showStatus('进不去这个目录：不在可选范围、不存在，或没有读取权限。'); return; }
      if (!res.ok) { showStatus('读取失败，请重试。'); return; }
      render(await res.json());
    } catch (err) {
      if (err.name !== 'AbortError') showStatus('连不上服务，请重试。');
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  function open(path) {
    filter.value = '';
    return load(path, '');
  }

  filter.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(current, filter.value.trim()), 200);
  });
  // 在表单里按回车不能把向导提交出去
  filter.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    load(current, filter.value.trim());
  });

  $('#dir-command-copy').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const code = $('#dir-command-text');
    try {
      await navigator.clipboard.writeText(code.textContent);
    } catch {
      // http 下没有 clipboard：选中文本，让人自己复制
      getSelection().selectAllChildren(code);
      button.textContent = '已选中，按复制键';
      return;
    }
    button.textContent = '已复制';
  });

  // 检测按钮先用这个接口给个快结果，完整报告由原来的预检接着出
  window.dirBrowserPeek = async (path) => {
    const quick = (data) => `${count(data.currentMdCount, data.currentMore)} 个 md 文件，${accessOf(data)}`;
    if (path === last?.path) return quick(last);
    try {
      const res = await fetchList(path, '');
      if (!res.ok) return null;
      const data = await res.json();
      render(data);
      return quick(data);
    } catch {
      return null;
    }
  };

  token?.addEventListener('change', () => open(current));
  open('');
})();
