import { unzipSync } from 'fflate';
import * as XLSX from 'xlsx';

const MAX_ENTRY = 64 * 1024 * 1024;
export const MAX_OFFICE_BYTES = 128 * 1024 * 1024;
export const MAX_SHEET_BYTES = 30 * 1024 * 1024;
export const SHEET_ROWS = 200;
export const CSV_ROWS = 500;
const MAX_BLOCKS = 5000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function entries(buf, match) {
  const files = unzipSync(buf, { filter: (f) => match(f.name) && f.originalSize <= MAX_ENTRY });
  return Object.entries(files).map(([name, data]) => [name, new TextDecoder().decode(data)]);
}

export function previewDocx(buf) {
  const xml = entries(buf, (n) => n === 'word/document.xml')[0]?.[1];
  if (!xml) throw new Error('not docx');
  const blocks = [];
  let table = null;
  let row = null;
  let cell = null;
  let para = null;
  const scan = /<w:tbl[ >]|<\/w:tbl>|<w:tr[ >]|<\/w:tr>|<w:tc[ >]|<\/w:tc>|<w:p[ >]|<\/w:p>|<w:pStyle w:val="([^"]*)"|<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
  for (const m of xml.matchAll(scan)) {
    const tok = m[0];
    if (blocks.length >= MAX_BLOCKS) break;
    if (tok.startsWith('<w:tbl')) { table = table ?? { type: 'table', rows: [] }; }
    else if (tok === '</w:tbl>') { if (table) blocks.push(table); table = null; }
    else if (tok.startsWith('<w:tr')) { row = []; }
    else if (tok === '</w:tr>') { if (table && row) table.rows.push(row); row = null; }
    else if (tok.startsWith('<w:tc')) { cell = []; }
    else if (tok === '</w:tc>') { if (row && cell) row.push(cell.join('\n')); cell = null; }
    else if (tok.startsWith('<w:pStyle')) { if (para) para.style = m[1]; }
    else if (tok.startsWith('<w:p')) { para = { text: '', style: '' }; }
    else if (tok === '</w:p>') {
      if (para) {
        if (cell) cell.push(para.text);
        else if (para.text.trim()) {
          const level = para.style.match(/^(?:Heading|heading|标题)\s*(\d)$/)?.[1];
          blocks.push({ type: 'p', text: para.text, level: level ? Number(level) : 0 });
        }
      }
      para = null;
    } else if (tok === '<w:tab/>') { if (para) para.text += '\t'; }
    else if (tok === '<w:br/>') { if (para) para.text += '\n'; }
    else if (para) { para.text += decodeXml(m[2] ?? ''); }
  }
  return { kind: 'docx', blocks };
}

export function previewPptx(buf) {
  const slides = entries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(([a], [b]) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map(([, xml]) => {
      let title = '';
      const points = [];
      for (const shape of xml.matchAll(/<p:(sp|graphicFrame)[ >][\s\S]*?<\/p:\1>/g)) {
        const isTitle = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape[0]);
        for (const p of shape[0].matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g)) {
          const text = [...p[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join('').trim();
          if (!text) continue;
          if (isTitle && !title) title = text;
          else points.push(text);
        }
      }
      return { title, points };
    });
  return { kind: 'pptx', slides };
}

export function previewSheet(buf, sheetName) {
  const book = XLSX.read(buf, {
    type: 'buffer', sheetRows: SHEET_ROWS + 1, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, cellDates: true,
  });
  const names = book.SheetNames;
  const name = names.includes(sheetName) ? sheetName : names[0];
  const sheet = book.Sheets[name];
  const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false }) : [];
  const truncated = rows.length > SHEET_ROWS;
  return { kind: 'sheet', names, name, rows: rows.slice(0, SHEET_ROWS), truncated };
}

export function parseCsv(text, limit = CSV_ROWS) {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}
