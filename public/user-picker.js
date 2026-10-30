(() => {
  // 设置码别留在地址栏和历史记录里
  if (document.querySelector('[data-strip-token]') && location.search.includes('token=')) history.replaceState(null, '', location.pathname);

  // 头像加载失败就露出底下的首字。CSP 不许内联 onerror；脚本 defer，有的图在这之前就已经失败了
  document.addEventListener('error', (event) => {
    if (event.target.matches?.('.avatar img')) event.target.remove();
  }, true);
  for (const img of document.querySelectorAll('.avatar img')) {
    if (img.complete && !img.naturalWidth) img.remove();
  }

  for (const picker of document.querySelectorAll('[data-picker]')) {
    const search = picker.querySelector('[data-picker-search]');
    const rows = [...picker.querySelectorAll('li')];
    const count = picker.querySelector('[data-picker-count]');
    const empty = picker.querySelector('[data-picker-empty]');

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        row.hidden = !row.dataset.search.includes(q);
        if (!row.hidden) shown++;
      }
      empty.hidden = shown > 0;
    });
    // 在搜索框里按回车是想搜索，不是提交整张表单
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    picker.addEventListener('change', () => {
      count.textContent = picker.querySelectorAll('input[type=checkbox]:checked').length;
    });
  }
})();
