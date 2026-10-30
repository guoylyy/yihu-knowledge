// 向导和设置页共用的「检测」结果展示
window.showLibraryReport = (result, report) => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
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
