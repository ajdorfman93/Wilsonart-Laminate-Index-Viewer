/* viewer.js
   Renders wilsonart-laminate-details.json with thumbnails and uses Filters.apply() to filter.
   Include filters.js BEFORE this file and add <div id="filters"></div> in your HTML.
*/

const DEFAULT_URL = './wilsonart-laminate-details.json';

// Grab elements (add these to your HTML if missing)
const statusEl = document.getElementById('status') || mk('#status');
const qEl = document.getElementById('q') || mk('#q', 'input');
const fileEl = document.getElementById('file') || mk('#file', 'input');
const reloadEl = document.getElementById('reload') || mk('#reload', 'button');
const headRow = document.getElementById('head-row') || mk('#head-row', 'tr');
const bodyRows = document.getElementById('body-rows') || mk('#body-rows', 'tbody');
const filtersContainer = document.getElementById('filters') || mk('#filters');
const lightbox = ensureLightbox();
const lightboxImg = lightbox.querySelector('.lightbox-img');
const lightboxCaption = lightbox.querySelector('.lightbox-caption');
let lightboxLastFocus = null;

let rawData = [];
let visible = [];

// Columns to render (order matters)
const COLUMNS = [
  { key: 'texture_image_url', label: 'Image', render: renderImage },
  { key: 'code', label: 'Code', render: (r) => safe(r.code) },
  { key: 'name', label: 'Name', render: (r) => safe(r.name) },
  { key: 'product-link', label: 'Product Link', render: (r) => r['product-link'] ? `<a class="link" href="${escapeAttr(r['product-link'])}" target="_blank" rel="noopener">Open</a>` : '' },
  { key: 'surface-group', label: 'Surface Group', render: (r) => safe(r['surface-group']) },

  { key: 'design_groups', label: 'Design Groups', render: renderPills },
  { key: 'color', label: 'Color', render: renderPills },
  { key: 'shade', label: 'Shade', render: (r) => renderPills(normalizeArray(r.shade)) },
  { key: 'finish', label: 'Finish', render: renderFinish },
  { key: 'performace_enchancments', label: 'Performance Enhancements', render: renderPills },
  { key: 'design_collections', label: 'Design Collections', render: renderPills },

  { key: 'no_repeat', label: 'No Repeat', render: (r) => r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : '') },
  { key: 'texture_scale', label: 'Texture Scale (W×H in)', render: renderScale },
  { key: 'description', label: 'Description', render: (r) => safe(r.description) },
];

function mk(sel, tag = 'div') {
  if (!document.querySelector(sel)) {
    const el = document.createElement(tag);
    if (sel.startsWith('#')) el.id = sel.slice(1);
    document.body.appendChild(el);
  }
  return document.querySelector(sel);
}

function safe(v) { return v == null ? '' : String(v); }
function escapeAttr(v) { return String(v).replace(/"/g, '&quot;'); }
function normalizeArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

function renderPills(v, row) {
  let arr = Array.isArray(v) ? v : null;
  if (!arr) {
    const column = this || {};
    const key = column && typeof column.key === 'string' ? column.key : null;
    const fallback = key && row ? row[key] : undefined;
    arr = normalizeArray(fallback);
  }
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
  const codeText = row && row.code ? row.code : '';
  const nameText = row && row.name ? row.name : '';
  const alt = `${codeText} ${nameText}`.trim() || 'preview';
  const img = `<img
      src="${escapeAttr(url)}"
      alt="${escapeAttr(alt)}"
      loading="lazy"
      referrerpolicy="no-referrer"
      style="max-width:140px; max-height:120px; object-fit:contain; border-radius:8px; box-shadow:0 0 0 1px rgba(0,0,0,.06);" />`;
  return `<button type="button" class="thumb" data-full="${escapeAttr(url)}" data-alt="${escapeAttr(alt)}" aria-label="View ${escapeAttr(alt)} full size">${img}</button>`;
}

function setStatus(msg) {
  const total = Array.isArray(rawData) ? rawData.length : 0;
  const vis = Array.isArray(visible) ? visible.length : 0;
  statusEl.innerHTML = `${msg} &mdash; <span class="count">${vis}</span> shown of <span class="count">${total}</span>`;
}

async function loadDefault() {
  setStatus('Loading default JSON...');
  try {
    const res = await fetch(DEFAULT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    rawData = Array.isArray(json) ? json : [];
    // init filters UI
    Filters.init({
      data: rawData,
      containerId: 'filters',
      queryInput: qEl,
      onChange: () => {
        visible = Filters.apply(rawData);
        renderTable();
        setStatus('Ready');
      }
    });
  } catch (err) {
    setStatus(`Failed to load default JSON (${err.message})`);
    console.error(err);
  }
}

function renderTable() {
  // header once
  if (!headRow.dataset.built) {
    headRow.innerHTML = COLUMNS.map(c => `<th scope="col">${c.label}</th>`).join('');
    headRow.dataset.built = '1';
  }
  const rows = visible || [];
  const html = rows.map(r => {
    const tds = COLUMNS.map(col => {
      const rendered = (col.render.length === 1 ? col.render(r) : col.render.call(col, r[col.key], r));
      return `<td>${rendered}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  bodyRows.innerHTML = html;
}

// file picker support (load arbitrary JSON)
if (fileEl) {
  fileEl.addEventListener('change', async (e) => {
    const input = e.target;
    const files = input && input.files ? input.files : null;
    const file = files && files.length ? files[0] : null;
    if (!file) return;
    setStatus(`Loading file: ${file.name}...`);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      rawData = Array.isArray(json) ? json : [];
      Filters.init({
        data: rawData,
        containerId: 'filters',
        queryInput: qEl,
        onChange: () => {
          visible = Filters.apply(rawData);
          renderTable();
          setStatus(`Loaded ${file.name}`);
        }
      });
    } catch (err) {
      setStatus(`Failed parsing ${file.name}: ${err.message}`);
      console.error(err);
    } finally {
      if (input) input.value = '';
    }
  });
}

if (reloadEl) {
  reloadEl.addEventListener('click', () => {
    qEl.value = '';
    Filters.reset();
    visible = Filters.apply(rawData);
    renderTable();
    setStatus('Reset');
  });
}

// kick off
loadDefault();
