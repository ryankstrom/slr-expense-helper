/* Receipt Renamer
 * Pure client-side: PDF.js for PDF text extraction (with OCR fallback),
 * Tesseract.js for images, JSZip for bundling renamed outputs.
 */

// ---------- PDF.js worker setup ----------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const browseBtn = $('#browse-btn');
const tableBody = $('#files-table tbody');
const filesSection = $('#files-section');
const statusBar = $('#status-bar');
const statusText = $('#status-text');
const progressFill = $('#progress-fill');
const downloadZipBtn = $('#download-zip');
const clearBtn = $('#clear-all');

// ---------- State ----------
const state = {
  files: [], // { id, originalName, ext, blob, status, date, total, vendor, category, newName, error }
};
let nextId = 1;
let processing = false;

// ---------- Wire up upload ----------
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', (e) => {
  handleFiles([...e.target.files]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (evt === 'dragleave' && e.target !== dropZone) return;
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  handleFiles(files);
});

downloadZipBtn.addEventListener('click', downloadZip);
clearBtn.addEventListener('click', clearAll);

// ---------- File intake ----------
function handleFiles(fileList) {
  const accepted = fileList.filter(isSupported);
  const rejected = fileList.length - accepted.length;
  for (const f of accepted) {
    const { name, ext } = splitName(f.name);
    state.files.push({
      id: nextId++,
      originalName: name,
      ext,
      blob: f,
      status: 'queued',
      date: null,
      total: null,
      vendor: null,
      category: null,
      newName: null,
      error: null,
    });
  }
  if (state.files.length) {
    filesSection.hidden = false;
    statusBar.hidden = false;
  }
  render();
  if (rejected) {
    setStatus(`Skipped ${rejected} unsupported file${rejected === 1 ? '' : 's'}.`);
  }
  pumpQueue();
}

function isSupported(file) {
  if (file.type === 'application/pdf') return true;
  if (file.type.startsWith('image/')) return true;
  // some browsers don't set type — fall back to extension check
  return /\.(pdf|png|jpe?g|bmp|webp|tiff?)$/i.test(file.name);
}

function splitName(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return { name: filename, ext: '' };
  return { name: filename.slice(0, dot), ext: filename.slice(dot) };
}

// ---------- Processing queue ----------
async function pumpQueue() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const item = state.files.find((f) => f.status === 'queued');
      if (!item) break;
      await processItem(item);
    }
  } finally {
    processing = false;
    updateDownloadButton();
    const total = state.files.length;
    const done = state.files.filter((f) => f.status === 'done').length;
    const errors = state.files.filter((f) => f.status === 'error').length;
    setStatus(
      total === 0 ? 'Idle'
      : `${done} of ${total} processed${errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}.`
    );
    progressFill.style.width = total ? `${Math.round((done + errors) / total * 100)}%` : '0%';
  }
}

async function processItem(item) {
  item.status = 'processing';
  render();
  setStatus(`Processing ${item.originalName}${item.ext}…`);
  try {
    const text = await extractText(item);
    item.date = parseDate(text);
    item.dateSource = item.date ? 'ocr' : null;
    if (!item.date) {
      item.date = dateFromFileMtime(item.blob);
      if (item.date) item.dateSource = 'file';
    }
    item.total = parseTotal(text);
    item.vendor = parseVendor(text);
    item.category = parseCategory(text, item.vendor);
    item.newName = buildNewName(item);
    item.status = 'done';
  } catch (err) {
    console.error(err);
    item.status = 'error';
    item.error = err?.message || String(err);
  }
  // refresh progress
  const total = state.files.length;
  const done = state.files.filter((f) => f.status === 'done' || f.status === 'error').length;
  progressFill.style.width = `${Math.round(done / total * 100)}%`;
  render();
}

// ---------- Text extraction ----------
async function extractText(item) {
  const isPdf = item.ext.toLowerCase() === '.pdf' || item.blob.type === 'application/pdf';
  if (isPdf) return extractTextFromPdf(item.blob);
  return extractTextFromImage(item.blob);
}

async function extractTextFromPdf(blob) {
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  const pageLimit = Math.min(pdf.numPages, 3); // receipts are short
  for (let p = 1; p <= pageLimit; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join('\n') + '\n';
  }
  if (text.replace(/\s/g, '').length >= 30) return text;
  // Scanned PDF — render and OCR the first page.
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return await ocrCanvas(canvas);
}

async function extractTextFromImage(blob) {
  return await ocrBlob(blob);
}

async function ocrBlob(blob) {
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        setStatus(`Reading… ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });
  try {
    const { data: { text } } = await worker.recognize(blob);
    return text || '';
  } finally {
    await worker.terminate();
  }
}

async function ocrCanvas(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return ocrBlob(blob);
}

// ---------- Parsers ----------
// Date: try several common formats, pick the first plausible one.
function parseDate(text) {
  if (!text) return null;
  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const patterns = [
    // ISO: 2026-05-20
    { re: /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/, parts: ['y', 'm', 'd'] },
    // US: 05/20/2026 or 5-20-26
    { re: /\b(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])[-/.](20\d{2}|\d{2})\b/, parts: ['m', 'd', 'y'] },
    // Month DD, YYYY
    { re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2}|\d{2})\b/i, parts: ['mn', 'd', 'y'] },
    // DD Month YYYY
    { re: /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2}|\d{2})\b/i, parts: ['d', 'mn', 'y'] },
  ];
  for (const { re, parts } of patterns) {
    const matches = [...text.matchAll(new RegExp(re.source, re.flags + 'g'))];
    for (const m of matches) {
      const captured = {};
      parts.forEach((p, i) => { captured[p] = m[i + 1]; });
      let y = captured.y, mo, d = captured.d;
      if (captured.mn) {
        mo = monthMap[captured.mn.toLowerCase().slice(0, 4)] || monthMap[captured.mn.toLowerCase().slice(0, 3)];
      } else {
        mo = parseInt(captured.m, 10);
      }
      d = parseInt(d, 10);
      y = parseInt(y, 10);
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      if (!mo || !d || !y) continue;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      // Sanity check: not too far in the future
      const date = new Date(iso);
      const now = new Date();
      if (date > new Date(now.getFullYear() + 1, 0, 1)) continue;
      if (y < 2000) continue;
      return iso;
    }
  }
  return null;
}

// Total: prefer the rightmost amount on a line whose label looks like
// "TOTAL" / "Amount Due" / "Balance Due" / "Grand Total" (not "Subtotal").
function parseTotal(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const totalLineRe = /(grand\s*total|amount\s*due|balance\s*due|total\s*due|^total\b|\btotal\s*[:$]|total\s+\$)/i;
  const skipRe = /(sub[\s-]?total|subtotal|items?\s*total|total\s*items?|total\s*qty)/i;
  const amountRe = /\$?\s*(\d{1,4}(?:[,]\d{3})*(?:[.,]\d{2}))(?!\d)/g;

  const candidates = [];
  for (const line of lines) {
    if (skipRe.test(line)) continue;
    if (!totalLineRe.test(line)) continue;
    const amounts = [...line.matchAll(amountRe)].map((m) => normalizeAmount(m[1]));
    if (amounts.length) candidates.push(amounts[amounts.length - 1]);
  }
  if (candidates.length) return candidates[candidates.length - 1].toFixed(2);

  // Fallback: largest amount in the document.
  const all = [...text.matchAll(amountRe)].map((m) => normalizeAmount(m[1])).filter((n) => n > 0 && n < 100000);
  if (!all.length) return null;
  return Math.max(...all).toFixed(2);
}

// Fallback when OCR didn't find a date — use the File object's lastModified.
// For photos taken on a phone or camera and uploaded directly, this is the
// capture time. For files moved around it's the most recent modification.
function dateFromFileMtime(file) {
  const ts = file && file.lastModified;
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 2000 || y > new Date().getFullYear() + 1) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeAmount(s) {
  // Handle "1,234.56" → 1234.56 and "12,34" (EU) → 12.34
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  return parseFloat(s);
}

// Vendor: best-effort — first short, alpha-heavy line near the top.
function parseVendor(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const top = lines.slice(0, 8);
  for (const line of top) {
    if (line.length < 3 || line.length > 40) continue;
    const alpha = line.replace(/[^A-Za-z]/g, '').length;
    if (alpha < 3) continue;
    if (alpha / line.length < 0.5) continue;
    // Skip lines that look like addresses or phone numbers
    if (/\d{3}.*\d{4}/.test(line)) continue;
    if (/(street|st\.|ave|avenue|road|rd\.|blvd|suite|ste\.)/i.test(line)) continue;
    return cleanVendor(line);
  }
  // Fallback: just first non-empty line
  return cleanVendor(lines[0] || '');
}

function cleanVendor(s) {
  return s
    .replace(/[^A-Za-z0-9 &'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

// Category: keyword-based heuristic on vendor + body text.
function parseCategory(text, vendor) {
  const hay = ((vendor || '') + ' ' + (text || '')).toLowerCase();
  const rules = [
    ['Travel',   ['uber', 'lyft', 'taxi', 'airline', 'airlines', 'delta', 'united ', 'american airlines', 'southwest', 'jetblue', 'alaska air', 'hotel', 'motel', 'inn', 'airbnb', 'marriott', 'hilton', 'hyatt', 'sheraton', 'amtrak', 'rental car', 'hertz', 'avis', 'enterprise rent', 'budget rent']],
    ['Fuel',     ['shell', 'chevron', 'exxon', 'mobil', 'bp ', 'arco', 'valero', '76 ', 'sunoco', 'speedway', 'circle k', 'wawa', 'gas station', 'fuel', 'gallon']],
    ['Food',     ['restaurant', 'cafe', 'café', 'coffee', 'starbucks', 'mcdonald', 'burger', 'pizza', 'subway', 'chipotle', 'panera', 'kitchen', 'grill', 'bistro', 'bakery', 'diner', 'taco', 'sushi', 'ramen', 'thai', 'deli', 'doordash', 'grubhub', 'uber eats']],
    ['Grocery',  ['walmart', 'target', 'safeway', 'whole foods', 'trader joe', 'kroger', 'costco', 'albertsons', 'publix', 'wegmans', 'aldi', 'sam\'s club', 'grocery', 'supermarket']],
    ['Office',   ['staples', 'office depot', 'office max', 'paper', 'printer', 'toner', 'ink cartridge']],
    ['Tech',     ['best buy', 'apple store', 'apple.com', 'microsoft', 'newegg', 'micro center', 'b&h photo']],
    ['Shipping', ['ups store', 'fedex', 'usps', 'shipping', 'postage']],
    ['Parking',  ['parking', 'garage', 'meter']],
  ];
  for (const [name, keywords] of rules) {
    if (keywords.some((kw) => hay.includes(kw))) return name;
  }
  return 'Other';
}

// ---------- Filename ----------
function buildNewName(item) {
  // Inferred dates (from file metadata) use ~ instead of - so they stand out
  // in the filename as "this was a fallback, please verify". Dates found by
  // OCR use the standard ISO dashes.
  let dateForName;
  if (!item.date) {
    dateForName = 'unknown-date';
  } else if (item.dateSource === 'file') {
    dateForName = item.date.replace(/-/g, '~');
  } else {
    dateForName = item.date;
  }
  const parts = [
    dateForName,
    sanitizePart(item.originalName),
    item.total != null ? item.total : 'unknown-total',
    sanitizePart(item.vendor || 'unknown-vendor'),
    sanitizePart(item.category || 'Other'),
  ];
  return parts.join('_') + item.ext;
}

function sanitizePart(s) {
  return String(s)
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'unknown';
}

// ---------- Render ----------
function render() {
  tableBody.innerHTML = '';
  for (const f of state.files) {
    const tr = document.createElement('tr');
    tr.appendChild(td(f.originalName + f.ext, 'original'));
    tr.appendChild(tdHTML(pillFor(f), ''));
    tr.appendChild(td(renderDateCell(f), 'date'));
    tr.appendChild(td(f.total != null ? `$${f.total}` : dim('—')));
    tr.appendChild(td(f.vendor || dim('—')));
    tr.appendChild(td(f.category || dim('—')));
    const last = document.createElement('td');
    last.className = 'newname';
    if (f.status === 'error') {
      last.innerHTML = `<span class="error-detail">${escapeHtml(f.error || 'Failed')}</span>`;
    } else if (f.newName) {
      last.textContent = f.newName;
    } else {
      last.innerHTML = dim('—');
    }
    tr.appendChild(last);
    tableBody.appendChild(tr);
  }
  updateDownloadButton();
}

function td(content, cls) {
  const el = document.createElement('td');
  if (cls) el.className = cls;
  if (typeof content === 'string') el.innerHTML = content;
  else el.appendChild(content);
  return el;
}
function tdHTML(html) {
  const el = document.createElement('td');
  el.innerHTML = html;
  return el;
}
function pillFor(f) {
  return `<span class="pill ${f.status}">${f.status}</span>`;
}
function renderDateCell(f) {
  if (!f.date) return dim('—');
  if (f.dateSource === 'file') {
    const tip = "Date not found by OCR — inferred from the file's last-modified timestamp. Double-check that it matches the actual receipt date.";
    return `<span class="date-inferred" title="${escapeHtml(tip)}">${escapeHtml(f.date)}</span>`;
  }
  return escapeHtml(f.date);
}
function dim(s) { return `<span class="muted">${s}</span>`; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function setStatus(s) { statusText.textContent = s; }
function updateDownloadButton() {
  const ready = state.files.some((f) => f.status === 'done');
  downloadZipBtn.disabled = !ready || processing;
}

// ---------- ZIP download ----------
async function downloadZip() {
  const done = state.files.filter((f) => f.status === 'done');
  if (!done.length) return;
  downloadZipBtn.disabled = true;
  setStatus(`Building ZIP…`);
  try {
    const zip = new JSZip();
    const usedNames = new Set();
    for (const f of done) {
      let name = f.newName;
      let i = 2;
      while (usedNames.has(name)) {
        const { name: base, ext } = splitName(f.newName);
        name = `${base}-${i}${ext}`;
        i++;
      }
      usedNames.add(name);
      zip.file(name, f.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
      setStatus(`Building ZIP… ${Math.round(meta.percent)}%`);
    });
    triggerDownload(blob, `receipts-${todayStamp()}.zip`);
    setStatus(`ZIP downloaded (${done.length} file${done.length === 1 ? '' : 's'}).`);
  } catch (err) {
    console.error(err);
    setStatus('ZIP failed: ' + (err?.message || err));
  } finally {
    updateDownloadButton();
  }
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Clear ----------
function clearAll() {
  if (processing) return;
  state.files = [];
  render();
  filesSection.hidden = true;
  statusBar.hidden = true;
  setStatus('Idle');
  progressFill.style.width = '0%';
}
