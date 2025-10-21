/* viewer.js
   Renders wilsonart-laminate-details.json in a table with light filtering + thumbnails.
   - Put index.html + viewer.js + wilsonart-laminate-details.json in the same folder
   - Serve with a local http server (to allow fetch), e.g.:
       npx http-server .
*/

const DEFAULT_URL = './wilsonart-laminate-details.json';

const statusEl = document.getElementById('status');
const qEl = document.getElementById('q');
const fileEl = document.getElementById('file');
const reloadEl = document.getElementById('reload');
const headRow = document.getElementById('head-row');
const bodyRows = document.getElementById('body-rows');

let rawData = [];
let filtered = [];

// Columns to render (order matters)
const COLUMNS = [
  // Thumbnail (linked to full image if present)
  { key: 'texture_image_url', label: 'Image', render: renderImage },

  { key: 'code', label: 'Code', render: (r) => safe(r.code) },
  { key: 'name', label: 'Name', render: (r) => safe(r.name) },
  { key: 'product-link', label: 'Product Link', render: (r) => r['product-link'] ? `<a class="link" href="${escapeAttr(r['product-link'])}" target="_blank" rel="noopener">Open</a>` : '' },
  { key: 'surface-group', label: 'Surface Group', render: (r) => safe(r['surface-group']) },

  // Buckets (arrays or strings)
  { key: 'design_groups', label: 'Design Groups', render: renderPills },
  { key: 'color', label: 'Color', render: renderPills },
  { key: 'shade', label: 'Shade', render: (r) => renderPills(normalizeArray(r.shade)) },
  { key: 'finish', label: 'Finish', render: renderFinish },
  { key: 'performace_enchancments', label: 'Performance Enhancements', render: renderPills },
  { key: 'design_collections', label: 'Design Collections', render: renderPills },
  { key: 'species', label: 'Species', render: renderPills },
  { key: 'cut', label: 'Cut', render: renderPills },
  { key: 'match', label: 'Match', render: renderPills },

  // Detail fields gathered during detail scraping
  { key: 'no_repeat', label: 'No Repeat', render: (r) => r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : '') },
  { key: 'texture_scale', label: 'Texture Scale (W×H in)', render: renderScale },
  { key: 'description', label: 'Description', render: (r) => safe(r.description) },
];

function safe(v) { return v == null ? '' : String(v); }
function escapeAttr(v) { return String(v).replace(/"/g, '&quot;'); }
function normalizeArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function renderPills(v, row) {
  const arr = Array.isArray(v) ? v : normalizeArray(row?.[this?.key]); // fallback if bound
  if (!arr || !arr.length) return '';
  return arr.map(x => `<span class="pill">${safe(x)}</span>`).join('');
}

function renderFinish(row) {
  const items = Array.isArray(row.finish) ? row.finish : [];
  if (!items.length) return '';
  return items.map(f => {
    const code = f.code ? `<span class="pill">${safe(f.code)}</span>` : '';
    const name = f.name ? `<span class="pill">${safe(f.name)}</span>` : '';
    return `<div>${code} ${name}</div>`;
  }).join('');
}

function renderScale(row) {
  const s = row.texture_scale;
  if (!s || (typeof s.width !== 'number' && typeof s.height !== 'number')) return '';
  const w = s.width != null ? Number(s.width).toFixed(3).replace(/\.?0+$/,'') : '';
  const h = s.height != null ? Number(s.height).toFixed(3).replace(/\.?0+$/,'') : '';
  if (!w && !h) return '';
  return `${w}${w ? '"' : ''} × ${h}${h ? '"' : ''}`;
}

function renderImage(row) {
  const url = row.texture_image_url;
  if (!url) return '';
  const alt = `${row.code ?? ''} ${row.name ?? ''}`.trim() || 'preview';
  // Link wraps image; constrain size for table
  const img = `<img
      src="${escapeAttr(url)}"
      alt="${escapeAttr(alt)}"
      loading="lazy"
      referrerpolicy="no-referrer"
      style="max-width:140px; max-height:120px; object-fit:contain; border-radius:8px; box-shadow:0 0 0 1px rgba(0,0,0,.06);" />`;
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${img}</a>`;
}

function setStatus(msg) {
  const total = rawData?.length ?? 0;
  const vis = filtered?.length ?? 0;
  statusEl.innerHTML = `${msg} &mdash; <span class="count">${vis}</span> shown of <span class="count">${total}</span>`;
}

async function loadDefault() {
  setStatus('Loading default JSON…');
  try {
    const res = await fetch(DEFAULT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    rawData = Array.isArray(json) ? json : [];
    filtered = rawData.slice();
    renderTable();
    setStatus('Loaded default JSON');
  } catch (err) {
    setStatus(`Failed to load default JSON (${err.message})`);
    console.error(err);
  }
}

function renderTable() {
  // Build header (once)
  if (!headRow.dataset.built) {
    headRow.innerHTML = COLUMNS.map(c => `<th scope="col">${c.label}</th>`).join('');
    headRow.dataset.built = '1';
  }

  // Filter with query
  const q = qEl.value.trim().toLowerCase();
  let rows = filtered;
  if (q) rows = filtered.filter(r => matchRow(r, q));

  // Build body
  const html = rows.map(r => {
    const tds = COLUMNS.map(col => {
      const rendered = (col.render.length === 1 ? col.render(r) : col.render.call(col, r[col.key], r));
      return `<td>${rendered}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  bodyRows.innerHTML = html;
  setStatus(q ? `Filter: “${q}”` : 'Ready');
}

function matchRow(row, q) {
  // Combine common fields into a searchable string
  const fields = [
    row.code,
    row.name,
    row['surface-group'],
    row.description,
    row.texture_image_url,
    ...(normalizeArray(row.design_groups)),
    ...(normalizeArray(row.color)),
    ...(normalizeArray(row.shade)),
    ...(normalizeArray(row.design_collections)),
    ...(normalizeArray(row.performace_enchancments)),
    ...(normalizeArray(row.species)),
    ...(normalizeArray(row.cut)),
    ...(normalizeArray(row.match)),
    ...(Array.isArray(row.finish) ? row.finish.flatMap(f => [f.code, f.name]) : []),
    ...(row.texture_scale ? [`${row.texture_scale.width}x${row.texture_scale.height}`] : []),
  ].filter(Boolean).map(String.toLowerCase);

  return fields.some(s => s.includes(q));
}

// Wire up UI
qEl.addEventListener('input', () => renderTable());

fileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Loading file: ${file.name}…`);
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    rawData = Array.isArray(json) ? json : [];
    filtered = rawData.slice();
    qEl.value = '';
    renderTable();
    setStatus(`Loaded ${file.name}`);
  } catch (err) {
    setStatus(`Failed parsing ${file.name}: ${err.message}`);
    console.error(err);
  } finally {
    fileEl.value = '';
  }
});

reloadEl.addEventListener('click', () => {
  qEl.value = '';
  loadDefault();
});

// Kick it off
loadDefault();
