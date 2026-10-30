// 手写最小 PDF，测试不依赖外部工具。pages 每项：字符串（Helvetica）/ { cjk: '中文' }（无嵌入字体，靠预定义 CMap 解码）/ null（空白页，等同扫描件）
const content = (page) => {
  if (page === null) return '';
  if (typeof page === 'string') return `BT /F1 12 Tf 72 720 Td (${page}) Tj ET`;
  const hex = [...page.cjk].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
  return `BT /F2 12 Tf 72 720 Td <${hex}> Tj ET`;
};

export function makePdf(pages, { encrypted = false } = {}) {
  const FIRST = 5;
  const kids = pages.map((_, i) => `${FIRST + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>] >>',
  ];
  pages.forEach((page, i) => {
    const stream = content(page);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${FIRST + i * 2 + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  const secure = encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00> <00>]` : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${secure} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
