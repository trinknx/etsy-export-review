// Export formats and downloads. All output is built in memory as Blobs and
// handed to chrome.downloads; nothing leaves the machine.

import { createZip } from './zip.js';

export const COLUMNS = [
  ['id', 'Review ID'],
  ['rating', 'Rating'],
  ['date', 'Date'],
  ['text', 'Review'],
  ['originalText', 'Original text (before translation)'],
  ['author', 'Author'],
  ['authorUrl', 'Author profile'],
  ['recommends', 'Recommends'],
  ['variation', 'Variation'],
  ['itemTitle', 'Purchased item'],
  ['itemUrl', 'Purchased item URL'],
  ['sellerResponse', 'Seller response'],
  ['photoCount', 'Photo count'],
  ['photos', 'Photo URLs'],
];

function cellValue(review, key) {
  if (key === 'photoCount') return review.photos.length;
  if (key === 'photos') return review.photos.join(' ');
  if (key === 'recommends') return review.recommends === '' ? '' : review.recommends ? 'Yes' : 'No';
  return review[key] ?? '';
}

export function toCsv(reviews) {
  const esc = (v) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [COLUMNS.map(([, label]) => esc(label)).join(',')];
  for (const r of reviews) lines.push(COLUMNS.map(([key]) => esc(cellValue(r, key))).join(','));
  // BOM so Excel opens UTF-8 correctly; CRLF for widest compatibility.
  return new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

export function toJson(reviews) {
  return new Blob([JSON.stringify(reviews, null, 2)], { type: 'application/json' });
}

// ---------- XLSX (hand-built OOXML package; no SheetJS needed) ----------

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function xmlEscape(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toXlsx(reviews) {
  const rows = [
    COLUMNS.map(([, label]) => label),
    ...reviews.map((r) => COLUMNS.map(([key]) => cellValue(r, key))),
  ];

  const sheetData = rows
    .map((row, ri) => {
      const cells = row
        .map((v, ci) => {
          const ref = colName(ci) + (ri + 1);
          const style = ri === 0 ? ' s="1"' : ''; // bold header style
          if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
          if (v === '' || v === null || v === undefined) return '';
          // Excel caps a cell at 32767 characters.
          const text = xmlEscape(String(v).slice(0, 32767));
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');

  const widths = [14, 7, 11, 60, 40, 18, 30, 11, 25, 35, 35, 40, 8, 50];
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Reviews" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<cols>${cols}</cols><sheetData>${sheetData}</sheetData></worksheet>`,
    },
  ];

  return new Blob([createZip(files)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ---------- Review photos ----------

const safeFileToken = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 60) || 'review';

/** Downloads every review photo with a small worker pool and zips the results. */
export async function photosZip(reviews, onProgress) {
  const jobs = [];
  for (const r of reviews) {
    r.photos.forEach((url, i) => jobs.push({ url, name: `${safeFileToken(r.id || r.author)}_${i + 1}` }));
  }

  const files = [];
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const job = jobs.shift();
      try {
        const res = await fetch(job.url);
        if (res.ok) {
          const ext = (job.url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i) || [, 'jpg'])[1];
          files.push({ name: `${job.name}.${ext}`, data: new Uint8Array(await res.arrayBuffer()) });
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        console.warn('Photo failed', job.url, e);
      }
      onProgress && onProgress(++done, jobs.length);
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { blob: createZip(files), count: files.length, failed };
}

// ---------- Downloads ----------

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'etsy-reviews';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: safeName(filename), saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}
