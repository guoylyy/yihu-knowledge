import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { previewDocx, previewPptx, previewSheet, SHEET_ROWS } from '../src/preview.js';

const docx = (body) => Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document><w:body>${body}</w:body></w:document>`) }));

test('docx：抽段落、标题层级、表格，解码实体', () => {
  const { blocks } = previewDocx(docx(`
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">甲 &amp; </w:t></w:r><w:r><w:t>乙</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
  assert.deepEqual(blocks, [
    { type: 'p', text: '第一章', level: 1 },
    { type: 'p', text: '甲 & 乙', level: 0 },
    { type: 'table', rows: [['A1', 'B1']] },
  ]);
});

test('docx：不是 zip 时抛错，由页面显示“无法解析”', () => {
  assert.throws(() => previewDocx(Buffer.from('not a zip file at all')));
});

test('pptx：按页序抽标题和要点', () => {
  const slide = (title, point) => strToU8(`<p:sld><p:sp><p:nvPr><p:ph type="title"/></p:nvPr><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:sp><p:sp><a:p><a:r><a:t>${point}</a:t></a:r></a:p></p:sp></p:sld>`);
  const buf = Buffer.from(zipSync({ 'ppt/slides/slide10.xml': slide('十', '要点十'), 'ppt/slides/slide2.xml': slide('二', '要点二') }));
  assert.deepEqual(previewPptx(buf).slides, [{ title: '二', points: ['要点二'] }, { title: '十', points: ['要点十'] }]);
});

test('xlsx / xls：选表、行数上限', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['名称', '值'], ['甲', 1]]), '第一页');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: SHEET_ROWS + 50 }, (_, i) => [i])), '长表');
  for (const bookType of ['xlsx', 'biff8']) {
    const buf = XLSX.write(book, { type: 'buffer', bookType });
    const first = previewSheet(buf);
    assert.deepEqual(first.names, ['第一页', '长表']);
    assert.deepEqual(first.rows, [['名称', '值'], ['甲', '1']]);
    const long = previewSheet(buf, '长表');
    assert.equal(long.rows.length, SHEET_ROWS);
    assert.equal(long.truncated, true);
    assert.equal(previewSheet(buf, '不存在').name, '第一页');
  }
});
