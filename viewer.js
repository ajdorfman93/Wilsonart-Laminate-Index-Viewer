/* viewer.js
   Renders wilsonart-laminate-details.json with thumbnails and filters.
   Requires Filters (filters.js) to be loaded before this file.

   UPDATE: If a row has `banner_cropped: true`, we crop exactly 93 source pixels
   from the *bottom* of the image using <canvas>. This ensures the crop is in
   intrinsic pixels, independent of display scale. Applies to thumbnails and lightbox.
*/

const DEFAULT_URL = './wilsonart-laminate-details.json';

// Inject minimal CSS
injectViewerStyles();

// Elements (created if missing)
const statusEl = document.getElementById('status') || mk('#status');
const qEl = document.getElementById('q') || mk('#q', 'input');
const fileEl = document.getElementById('file') || mk('#file', 'input');
const reloadEl = document.getElementById('reload') || mk('#reload', 'button');
const headRow = document.getElementById('head-row') || mk('#head-row', 'tr');
const bodyRows = document.getElementById('body-rows') || mk('#body-rows', 'tbody');
const filtersContainer = document.getElementById('filters') || mk('#filters');
const lightbox = ensureLightbox();
const lightboxImg = lightbox.querySelector('.lightbox-img');
const lightboxCanvas = lightbox.querySelector('.lightbox-canvas');
const lightboxCaption = lightbox.querySelector('.lightbox-caption');
const lightboxClose = lightbox.querySelector('.lightbox-close');
let lightboxLastFocus = null;

let rawData = [];
let visible = [];

// Columns to render
const COLUMNS = [
  { key: 'texture_image_url', label: 'Image', render: renderImage },
  { key: 'code', label: 'Code', render: (r) => safe(r.code) },
  { key: 'name', label: 'Name', render: (r) => safe(r.name) },
  { key: 'product-link', label: 'Product Link', render: (r) => r['product-link'] ? `<a class="link" href="${escapeAttr(r['product-link'])}" target="_blank" rel="noopener">Open</a>` : '' },
  { key: 'surface-group', label: 'Surface Group', render: (r) => safe(r['surface-group']) },

  { key: 'design_groups', label: 'Design Groups', render: renderPills },
  { key: 'colors', label: 'Colors', render: renderPills },
  { key: 'sheet_sizes', label: 'Sheet Sizes', render: renderPills },
  { key: 'texture_scale', label: 'Texture Scale (WA-H in)', render: renderScale },
  { key: 'species', label: 'Species', render: renderPills },
  { key: 'cut', label: 'Cut', render: renderPills },
  { key: 'match', label: 'Match', render: renderPills },
  { key: 'shade', label: 'Shade', render: renderPills },
  { key: 'finish', label: 'Finish', render: renderFinish },
  { key: 'performance_enhancements', label: 'Performance Enhancements', render: renderPills },
  { key: 'specialty_features', label: 'Specialty Features', render: renderPills },
  { key: 'design_collections', label: 'Design Collections', render: renderPills },

  { key: 'no_repeat', label: 'No Repeat', render: (r) => r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : '') },
  { key: 'no_repeat_texture_scale', label: 'No Repeat Texture Scale (WA-H in)', render: renderScale },
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

const COLUMN_ALIASES = {
  colors: ['color'],
  performance_enhancements: ['performace_enchancments'],
  specialty_features: ['specality_features'],
};

const ORIGINAL_INDEX_KEY = '__sourceRowIndex';

function dedupeColumns(cols) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    const k = c && c.key;
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(c);
    } else if (!k) {
      out.push(c);
    }
  }
  return out;
}

function annotateData(data) {
  if (!Array.isArray(data)) return [];
  for (let i = 0; i < data.length; i += 1) {
    const row = data[i];
    if (!row || typeof row !== 'object') continue;
    try {
      if (Object.prototype.hasOwnProperty.call(row, ORIGINAL_INDEX_KEY)) {
        row[ORIGINAL_INDEX_KEY] = i;
      } else {
        Object.defineProperty(row, ORIGINAL_INDEX_KEY, {
          value: i,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    } catch (err) {
      row[ORIGINAL_INDEX_KEY] = i;
    }
  }
  return data;
}

function renderPills(v, row) {
  const column = this || {};
  const key = column && typeof column.key === 'string' ? column.key : null;
  let arr = Array.isArray(v) ? v : null;
  if (!arr || !arr.length) {
    let fallback = key && row ? row[key] : undefined;
    if ((!fallback || !normalizeArray(fallback).length) && key && COLUMN_ALIASES[key]) {
      const aliases = COLUMN_ALIASES[key];
      for (let i = 0; i < aliases.length; i += 1) {
        const alt = normalizeArray(row ? row[aliases[i]] : undefined);
        if (alt.length) {
          fallback = alt;
          break;
        }
      }
    }
    arr = normalizeArray(fallback);
  } else {
    arr = normalizeArray(arr);
  }
  const cleaned = [];
  for (let i = 0; i < arr.length; i += 1) {
    const value = arr[i];
    if (value == null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      cleaned.push(trimmed);
    } else {
      cleaned.push(value);
    }
  }
  if (!cleaned.length) return '';
  return cleaned.map(x => `<span class="pill">${safe(x)}</span>`).join('');
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

function renderScale(value, row) {
  const column = this || {};
  let source = (value && typeof value === 'object') ? value : undefined;
  if (!source && column && column.key === 'texture_scale' && row && typeof row === 'object') {
    source = row.texture_scale;
  }
  if (!source || (typeof source.width !== 'number' && typeof source.height !== 'number')) return '';
  const w = source.width != null ? Number(source.width).toFixed(3).replace(/\.?0+$/,'') : '';
  const h = source.height != null ? Number(source.height).toFixed(3).replace(/\.?0+$/,'') : '';
  if (!w && !h) return '';
  return `${w}${w ? '"' : ''} x ${h}${h ? '"' : ''}`;
}

/**
 * Thumbnail cell renderer.
 * If banner_cropped: true -> we render a <canvas> and draw (crop 93px bottom in source pixels).
 * Otherwise -> simple <img>.
 * The button wrapper carries data attributes for the lightbox.
 */
function renderImage(row) {
  const url = row.texture_image_url;
  if (!url) return '';
  const codeText = row && row.code ? row.code : '';
  const nameText = row && row.name ? row.name : '';
  const alt = `${codeText} ${nameText}`.trim() || 'preview';
  const isBanner = row.banner_cropped === true;
  const bannerAttr = isBanner ? '1' : '0';

  if (isBanner) {
    // Canvas thumbnail; draw after table render via initializeThumbCanvases()
    const canvas = `<canvas class="thumb-canvas" data-src="${escapeAttr(url)}" width="0" height="0" aria-hidden="true"></canvas>`;
    return `<button type="button" class="thumb" data-full="${escapeAttr(url)}" data-alt="${escapeAttr(alt)}" data-banner="${bannerAttr}" aria-label="View ${escapeAttr(alt)} full size">${canvas}</button>`;
  } else {
    // Normal <img> thumbnail
    const img = `<img
      src="${escapeAttr(url)}"
      alt="${escapeAttr(alt)}"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="thumb-img" />`;
    return `<button type="button" class="thumb" data-full="${escapeAttr(url)}" data-alt="${escapeAttr(alt)}" data-banner="${bannerAttr}" aria-label="View ${escapeAttr(alt)} full size">${img}</button>`;
  }
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
    rawData = annotateData(Array.isArray(json) ? json : []);
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
    const renderCols = dedupeColumns(COLUMNS);
    const headerCells = [
      '<th scope="col" class="col-index">#</th>',
      ...renderCols.map(c => `<th scope="col">${c.label}</th>`),
    ];
    headRow.innerHTML = headerCells.join('');
    headRow.dataset.built = '1';
  }
  const rows = visible || [];
  const html = rows.map((r, index) => {
    const baseIndex = (r && typeof r[ORIGINAL_INDEX_KEY] === 'number') ? r[ORIGINAL_INDEX_KEY] + 1 : index + 1;
    const numberCell = `<td class="col-index">${baseIndex}.</td>`;
    const renderCols = dedupeColumns(COLUMNS);
    const tds = renderCols.map(col => {
      const rendered = (col.render.length === 1 ? col.render(r) : col.render.call(col, r[col.key], r));
      return `<td>${rendered}</td>`;
    }).join('');
    return `<tr>${numberCell}${tds}</tr>`;
  }).join('');
  bodyRows.innerHTML = html;

  // After rendering, draw any banner canvases using SOURCE-pixel crop
  initializeThumbCanvases();
}

if (bodyRows) {
  bodyRows.addEventListener('click', (event) => {
    const thumb = findThumb(event.target);
    if (!thumb) return;
    event.preventDefault();
    const fullUrl = thumb.getAttribute('data-full');
    const altText = thumb.getAttribute('data-alt') || '';
    const isBanner = thumb.getAttribute('data-banner') === '1';
    lightboxLastFocus = thumb;
    showLightbox(fullUrl, altText, isBanner);
  });
}

if (lightbox) {
  lightbox.addEventListener('click', (event) => {
    const target = event.target;
    if (!target) return;
    const canReadAttr = typeof target.getAttribute === 'function';
    if (target === lightbox || (canReadAttr && target.getAttribute('data-close') === '1')) {
      hideLightbox();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (!lightbox.classList.contains('is-visible')) return;
  const key = event.key || event.keyCode;
  if (key === 'Escape' || key === 'Esc' || key === 27) {
    hideLightbox();
  }
});

function findThumb(node) {
  let current = node;
  while (current && current !== document.body) {
    if (current.classList && current.classList.contains('thumb')) return current;
    current = current.parentElement;
  }
  return null;
}

function showLightbox(url, altText, isBanner) {
  if (!lightbox) return;
  if (!url) return;

  if (isBanner) {
    // Use canvas in lightbox to crop in SOURCE pixels
    lightboxImg.style.display = 'none';
    lightboxCanvas.style.display = 'block';
    drawBannerCropToCanvas(lightboxCanvas, url, 93);
    lightboxCanvas.setAttribute('aria-label', altText || '');
  } else {
    // Use plain <img> in lightbox
    lightboxCanvas.style.display = 'none';
    lightboxImg.style.display = 'block';
    lightboxImg.setAttribute('src', url);
    lightboxImg.setAttribute('alt', altText || '');
  }

  if (lightboxCaption) lightboxCaption.textContent = altText || '';
  lightbox.classList.add('is-visible');
  lightbox.setAttribute('aria-hidden', 'false');
  if (lightboxClose) {
    lightboxClose.focus();
  }
}

function hideLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove('is-visible');
  lightbox.setAttribute('aria-hidden', 'true');
  if (lightboxImg) {
    lightboxImg.removeAttribute('src');
    lightboxImg.setAttribute('alt', '');
  }
  if (lightboxCaption) lightboxCaption.textContent = '';
  if (lightboxLastFocus && typeof lightboxLastFocus.focus === 'function') {
    lightboxLastFocus.focus();
  }
  lightboxLastFocus = null;
}

function ensureLightbox() {
  let existing = document.getElementById('image-lightbox');
  if (existing) return existing;
  const wrapper = document.createElement('div');
  wrapper.id = 'image-lightbox';
  wrapper.className = 'lightbox';
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.innerHTML = [
    '<div class="lightbox-backdrop" data-close="1"></div>',
    '<figure class="lightbox-inner" role="dialog" aria-modal="true">',
    '  <button type="button" class="lightbox-close" data-close="1" aria-label="Close full-size image">&times;</button>',
    '  <img class="lightbox-img" alt="" />',
    '  <canvas class="lightbox-canvas" aria-hidden="true"></canvas>',
    '  <figcaption class="lightbox-caption"></figcaption>',
    '</figure>'
  ].join('');
  document.body.appendChild(wrapper);
  return wrapper;
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
      rawData = annotateData(Array.isArray(json) ? json : []);
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

// ------------------------- image helpers -------------------------

/**
 * Draw 93 source pixels cropped from the bottom of the image onto a canvas.
 * We set canvas.width/height to the intrinsic (natural) size minus 93px.
 * The canvas will scale visually via CSS max-width/height but the crop is based
 * on the original pixels.
 */
function drawBannerCropToCanvas(canvas, url, cropBottomPx = 93) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear old content
  canvas.width = 0;
  canvas.height = 0;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    const W = img.naturalWidth || img.width || 0;
    const H = img.naturalHeight || img.height || 0;
    if (!W || !H) return;

    const crop = Math.max(1, Math.min(cropBottomPx, H - 1));
    const outW = W;
    const outH = Math.max(1, H - crop);

    canvas.width = outW;
    canvas.height = outH;

    try {
      // Draw upper portion 0..H-crop
      ctx.drawImage(img, 0, 0, W, H - crop, 0, 0, outW, outH);
    } catch (e) {
      // Fallback: draw full image if anything goes wrong
      ctx.drawImage(img, 0, 0);
    }
  };
  img.onerror = () => {
    // Leave canvas empty on error
  };
  img.src = url;
}

/**
 * After each table render, find any <canvas.thumb-canvas[data-src]> and draw.
 */
function initializeThumbCanvases() {
  const nodes = bodyRows.querySelectorAll('.thumb-canvas[data-src]');
  nodes.forEach((canvas) => {
    const url = canvas.getAttribute('data-src');
    if (!url) return;
    drawBannerCropToCanvas(canvas, url, 93);
    canvas.removeAttribute('data-src');
  });
}

// ------------------------- styles -------------------------

function injectViewerStyles() {
  if (document.getElementById('viewer-inline-styles')) return;
  const css = `
  /* Pills */
  .pill { display:inline-block; padding:2px 6px; border-radius:8px; background:rgba(0,0,0,.06); margin:2px; font-size:12px; }

  /* Row numbering */
  .col-index { width:48px; min-width:48px; text-align:right; font-weight:600; color:#444; font-variant-numeric:tabular-nums; }

  /* Table thumbnail wrapper */
  .thumb { background:transparent; border:0; padding:0; cursor:pointer; }
  .thumb:focus { outline:2px solid #66a3ff; outline-offset:2px; }

  /* Thumbnails — size constraints */
  .thumb-img, .thumb-canvas {
    max-width: 140px;
    max-height: 120px;
    display: block;
    border-radius: 8px;
    box-shadow: 0 0 0 1px rgba(0,0,0,.06);
    background: #fff;
  }
  .thumb-img { object-fit: contain; }

  /* Lightbox */
  .lightbox { position:fixed; inset:0; display:block; z-index:2000; opacity:0; pointer-events:none; transition:opacity .15s ease; }
  .lightbox.is-visible { opacity:1; pointer-events:auto; }
  .lightbox-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.65); }
  .lightbox-inner { position:absolute; inset:auto; top:50%; left:50%; transform:translate(-50%,-50%); max-width:90vw; max-height:90vh; margin:0; }
  .lightbox-img, .lightbox-canvas { max-width:90vw; max-height:85vh; display:block; border-radius:8px; background:#fff; }
  .lightbox-close { position:absolute; top:-40px; right:0; font-size:28px; width:36px; height:36px; line-height:32px; border-radius:6px; border:0; cursor:pointer; }
  .lightbox-caption { margin-top:8px; color:#fff; text-align:center; font-size:14px; }
  `;
  const style = document.createElement('style');
  style.id = 'viewer-inline-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
