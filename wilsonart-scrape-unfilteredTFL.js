// wilsonart-scrape-unfilteredTFL.js
//   node wilsonart-scrape-unfilteredTFL.js --headless=false
//   node wilsonart-scrape-unfilteredTFL.js --maxPages=40
//   node wilsonart-scrape-unfilteredTFL.js --concurrency=4   // visit product pages in parallel
//
// What this does:
// - Opens the Wilsonart Laminate Design Library in GRID mode
// - **Does NOT apply any filters**
// - Pages through all result pages & lazy loads each page
// - For every item, visits the product page and extracts the Name
// - Updates ./wilsonart-laminate-index.json with product-link and name for each code
//
// Output file: wilsonart-laminate-index.json (written atomically)
//
// Notes:
// - Safe to re-run. Only 'product-link' and 'name' are updated/added for each code.
// - If a code is not yet in the JSON, an entry is created: { code, surface-group:'Laminate', name, product-link }
// - Robust pagination: stops when 'Next' is missing or clicking it doesn't change URL.
// - Lazy scrolling is used to load all tiles on a page before extraction.
//
// Requires: puppeteer (npm i puppeteer)
//
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const START_URL = process.env.START_URL ||
  'https://www.wilsonart.com/laminate/thermally-fused-laminate/design-library?product_list_mode=grid';
const OUT_PATH = path.resolve(process.cwd(), 'wilsonart-tfl-laminate-index.json');

const ARGV = process.argv.slice(2);
function flag(name, def) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const raw = hit.split('=')[1];
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}
const HEADLESS = flag('headless', true);
const MAX_PAGES = Math.max(1, Number(flag('maxPages', 60)));
const CONCURRENCY = Math.max(1, Math.min(16, Number(flag('concurrency', 4))));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function logStep(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function readIndex() {
  try {
    const text = fs.readFileSync(OUT_PATH, 'utf-8');
    const arr = JSON.parse(text);
    const map = new Map();
    for (const obj of Array.isArray(arr) ? arr : []) {
      if (obj && typeof obj === 'object' && obj.code) map.set(String(obj.code).trim(), obj);
    }
    return map;
  } catch (err) {
    logStep('readIndex: starting with empty index because:', err.message);
    return new Map();
  }
}

function writeIndex(map) {
  const list = Array.from(map.values()).map(finalizeRecord);
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8');
  fs.renameSync(tmp, OUT_PATH);
  logStep(`writeIndex: wrote ${list.length} records → ${OUT_PATH}`);
}

function finalizeRecord(rec) {
  // Only ensure the fields we care about. Preserve any other fields present.
  const out = { code: rec.code, 'surface-group': rec['surface-group'] || 'Laminate' };
  if (rec.name) out.name = rec.name;
  if (rec['product-link']) out['product-link'] = rec['product-link'];
  // Merge through any additional keys the existing record may have
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'code' || k === 'surface-group' || k === 'name' || k === 'product-link') continue;
    out[k] = v;
  }
  return out;
}

// Try to extract a code from an href like ".../aged-bronze-y0385" or ".../north-bridge-5073"
function codeFromHref(href) {
  try {
    const url = new URL(href, START_URL);
    const parts = url.pathname.split('/').filter(Boolean);
    // Common patterns:
    //  - /laminate/design-library/<slug>         (sometimes, detail links include code in slug)
    //  - /laminate/design-library/<slug>-<code>
    //  - /catalog/product/view/id/<id>/s/<slug-with-possible-code>/category/53
    // We'll try to get the last segment that looks like a slug, then pick the trailing -CODE
    let slug = parts[parts.length - 1] || '';
    if (slug === 'category' && parts.length >= 2) slug = parts[parts.length - 3] || slug; // handle /category/53/
    const m = slug.match(/-([a-z0-9]+)$/i);
    if (m) return m[1].toUpperCase();
  } catch {}
  return null;
}

// Choose best title selector found on various product layouts
async function readProductName(page) {
  const selList = [
    '.qkView_title h1',
    '.product-info-main h1',
    'h1.page-title span',
    'h1.page-title',
    'h1'
  ];
  for (const sel of selList) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = (await page.evaluate(el => el.textContent || '', el)).replace(/\s+/g, ' ').trim();
      if (text) return text;
    } catch {}
  }
  return '';
}

async function lazyScrollAll(page, maxPasses = 20) {
  let prev = -1;
  for (let i = 0; i < maxPasses; i++) {
    const count = await page.$$eval('#product-grid-view > ol > li', els => els.length).catch(() => 0);
    if (count === prev) break;
    prev = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(700);
  }
}

async function collectGridItemsOnPage(page) {
  const items = await page.$$eval('#product-grid-view > ol > li', (tiles) => {
    const out = [];
    for (const li of tiles) {
      const a = li.querySelector('a.product-item-link');
      if (!a) continue;
      const href = a.href || a.getAttribute('href') || '';
      const codeText = (a.textContent || '').trim();
      out.push({ href, codeText });
    }
    return out;
  }).catch(() => []);
  return items;
}

async function goNextPage(page, curIndex) {
  const nextSel = '#product-grid-view .category-pager .pages .pages-item-next a';
  const a = await page.$(nextSel);
  if (!a) return false;
  const prevURL = page.url();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    a.click().catch(() => {}),
  ]);
  const newURL = page.url();
  if (newURL === prevURL) {
    // Try a direct p= param hop as a fallback
    try {
      const url = new URL(prevURL);
      const p = Number(url.searchParams.get('p') || '1');
      const next = (Number.isFinite(p) ? p + 1 : curIndex + 1);
      url.searchParams.set('p', String(next));
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      return page.url() !== prevURL;
    } catch {}
    return false;
  }
  return true;
}

// Simple pool executor
async function runPool(items, limit, worker) {
  const q = items.slice();
  const workers = new Array(Math.min(limit, q.length)).fill(0).map(async () => {
    while (q.length) {
      const item = q.shift();
      try { await worker(item); } catch (e) { logStep('worker error:', e.message); }
    }
  });
  await Promise.all(workers);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
(async () => {
  const indexMap = readIndex();

  const browser = await puppeteer.launch({ headless: HEADLESS });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  page.setDefaultNavigationTimeout(60000);

  logStep('Opening', START_URL);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#product-grid-view', { timeout: 60000 }).catch(() => {});

  const discovered = new Map(); // code -> href
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    logStep(`Page ${pageNo}: lazy scrolling to load all tiles...`);
    await lazyScrollAll(page);

    const items = await collectGridItemsOnPage(page);
    logStep(`Page ${pageNo}: found ${items.length} grid items`);

    for (const it of items) {
      const href = it.href;
      let code = codeFromHref(href);
      if (!code && it.codeText) code = String(it.codeText).trim().toUpperCase();
      if (!code) continue;
      if (!discovered.has(code)) discovered.set(code, href);
    }

    // Attempt next
    const hasNext = await goNextPage(page, pageNo);
    if (!hasNext) {
      logStep(`Pagination: no next after page ${pageNo}; stopping.`);
      break;
    }
    // Wait for grid again
    await page.waitForSelector('#product-grid-view', { timeout: 60000 }).catch(() => {});
  }

  logStep(`Discovered ${discovered.size} unique codes`);

  // Visit product pages to get names
  const toVisit = Array.from(discovered.entries()).map(([code, href]) => ({ code, href }));

  await runPool(toVisit, CONCURRENCY, async ({ code, href }) => {
    const p = await browser.newPage();
    try {
      await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Fixup to canonical product url if SPA redirects
      const finalUrl = p.url();
      const name = (await readProductName(p)) || '';
      // Update map
      let rec = indexMap.get(code);
      if (!rec) rec = { code, 'surface-group': 'Laminate' };
      rec['product-link'] = finalUrl || href;
      if (name) rec.name = name;
      indexMap.set(code, rec);
      logStep(`Updated ${code} — ${name || '(no name found)'} `);
    } catch (e) {
      logStep(`Failed ${code}: ${e.message}`);
      // still set link if we can
      let rec = indexMap.get(code) || { code, 'surface-group': 'Laminate' };
      rec['product-link'] = href;
      indexMap.set(code, rec);
    } finally {
      await p.close().catch(() => {});
    }
  });

  writeIndex(indexMap);
  await browser.close();
  logStep('Done.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
