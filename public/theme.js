(() => {
  const root = document.documentElement;
  try {
    const theme = localStorage.getItem('kb-theme');
    if (theme) root.dataset.theme = theme;
    root.dataset.fs = localStorage.getItem('kb-fs') || '16';
  } catch {
    root.dataset.fs = '16';
  }
})();
