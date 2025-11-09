// wilsonart-scrape.js
//
// Usage:
//   node wilsonart-scrape.js                  # default (filter run is optional; see flags)
//   node wilsonart-scrape.js --unfiltered     # scrape catalog without any filters applied
//   node wilsonart-scrape.js --report color   # print products missing 'color'
//   node wilsonart-scrape.js --missing finish # (future: constrain scraping to missing fields)
//
// What this version adds:
//   • --unfiltered mode that paginates *all* products (list mode) with no filters.
//   • Robust code/SKU resolution from each Product Detail Page (PDP) when needed,
//     fixing cases like '20BIRCH' → 8219 and '20PARFA' → Y0687.
//   • Merge/upsert into wilsonart-laminate-index.json (never erase existing fields).
//
// Notes:
//   This file focuses on the two urgent needs: --unfiltered and correct codes.
//   It preserves simple --report / --missing flags with safe behavior.
//
// -----------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasUnfilteredFlag = argv.includes('--unfiltered');
const hasMissingFlag = argv.some((a) => a === '--missing' || a.startsWith('--missing='));
const hasReportFlag  = argv.some((a) => a === '--report'  || a.startsWith('--report='));

function collectMulti(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.push(next); i++; }
      else { out.push(''); }
    } else if (a.startsWith(flag + '=')) {
      out.push(a.split('=')[1] || '');
    }
  }
  return out;
}

const missingFields = hasMissingFlag ? collectMulti('--missing').filter(Boolean) : [];
const reportFields  = hasReportFlag  ? collectMulti('--report').filter(Boolean)  : [];

if (hasMissingFlag && missingFields.length === 0) missingFields.push('finish'); // backward-compat default
if (hasReportFlag  && reportFields.length  === 0) reportFields.push('finish');   // backward-compat default

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const OUT_PATH   = path.resolve(process.cwd(), 'wilsonart-laminate-index.json');
// Catalog root; force list mode for stable markup and easy paging
const START_URL  = 'https://www.wilsonart.com/laminate/design-library?product_list_mode=list';

// How many detail-page attempts on SKU extraction
const PDP_FETCH_RETRIES = 3;

// Treat URLs with a clear code suffix as trustworthy:  -8219, -y0792, -y0792x, -13096, etc.
const TRUSTED_CODE_SUFFIX_RE = /-(?:[A-Za-z]?\d{3,5}[A-Za-z]?)$/i;

// Patterns that look *suspicious* on tiles (e.g., "20BIRCH", "20PARFA") and should trigger a PDP check.
const SUSPICIOUS_TILE_CODE_RE = /^(?:\d{2}[A-Z]{3,}|[A-Z]{4,}|[A-Za-z]+[A-Za-z]+)$/;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function logStep(msg) { const t = new Date().toISOString(); console.log(`[${t}] ${msg}`); }

function normalizeCodeValue(x) {
  if (!x) return '';
  const s = String(x).trim().toUpperCase();
  // normalize spaces/dashes away
  return s.replace(/\s+/g, '').replace(/–|—/g, '-');
}

/**
 * Permissive validator covering numeric & Y#### (and some 5-digit metal/legacy codes).
 * Examples: 8219, 13096, Y0687, Y0385, 4830K-07 (will normalize to 4830K-07).
 */
function isValidCodeValue(s) {
  if (!s) return false;
  const x = normalizeCodeValue(s);
  // Allow a letter prefix (like Y), 3-5 digits, optional trailing letter or -## (finish variant)
  if (/^[A-Z]?\d{3,5}[A-Z]?$/.test(x)) return true;
  if (/^[A-Z]?\d{3,5}K-\d{2}$/.test(x)) return true; // e.g., 4830K-07
  return false;
}

// pull token-ish fragments from a URL-like string
function collectTokensFromUrl(urlLike) {
  const tokens = [];
  const add = (t) => {
    if (!t) return;
    const m = String(t).match(/[A-Za-z0-9]+/g);
    if (m) tokens.push(...m);
  };
  try {
    const u = new URL(urlLike, START_URL);
    u.pathname.split('/').filter(Boolean).forEach(add);
    u.searchParams.forEach((v) => add(v));
    if (u.hash) add(u.hash);
  } catch {
    add(urlLike);
  }
  return tokens;
}

function codeFromHref(href) {
  try {
    const u = new URL(href, START_URL);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    // quick hit for suffixes that already contain code
    const m = seg.match(/[A-Za-z]?\d{3,5}(?:K-\d{2}|[A-Za-z]?)/);
    return m ? normalizeCodeValue(m[0]) : '';
  } catch { return ''; }
}

// -----------------------------------------------------------------------------
// PDP (detail page) SKU extraction
// -----------------------------------------------------------------------------
function needsDetailFetch(href, candidateCode) {
  const urlHasTrustedSuffix = TRUSTED_CODE_SUFFIX_RE.test(String(href || ''));
  if (!urlHasTrustedSuffix) return true;
  if (!candidateCode) return true;
  if (SUSPICIOUS_TILE_CODE_RE.test(candidateCode)) return true;
  if (!isValidCodeValue(candidateCode)) return true;
  return false;
}

async function fetchSkuFromDetailUrl(browser, href) {
  const page = await browser.newPage();
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // settle
    await page.waitForSelector('.product-info-main, #maincontent', { timeout: 15000 }).catch(()=>{});

    // Try a few ways in the page context
    const raw = await page.evaluate(() => {
      const text = (el) => (el ? (el.textContent || '').trim() : '');
      const val  = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute('content') || el.getAttribute('value') || text(el)) : '';
      };

      // 1) Common Magento places
      const sku1 =
        val('.product-info-main .product.attribute.sku .value') ||
        val('[itemprop="sku"]') ||
        val('meta[itemprop="sku"]') ||
        val('meta[property="product:retailer_item_id"]') ||
        val('[data-product-sku]');
      if (sku1) return sku1;

      // 2) JSON-LD Product blocks
      const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => s.textContent)
        .filter(Boolean);

      for (const block of blocks) {
        try {
          const json = JSON.parse(block);
          const arr = Array.isArray(json) ? json : [json];
          for (const item of arr) {
            if (item && typeof item === 'object') {
              if (item.sku) return String(item.sku);
              if (item.mpn) return String(item.mpn);
              if (item.productID) return String(item.productID);
              if (item.identifier) return String(item.identifier);
            }
          }
        } catch {}
      }

      // 3) Fallback: scan visible text
      const body = document.body ? document.body.innerText : '';
      const m =
        body.match(/\bSKU[:\s]*([A-Za-z0-9-]+)\b/i) ||
        body.match(/\b(Product|Pattern|Design)\s*(No\.?|Number)[:\s]*([A-Za-z0-9-]+)\b/i);
      if (m) return (m[1] || m[3] || '').trim();

      return '';
    });

    const normalized = normalizeCodeValue(raw);
    return isValidCodeValue(normalized) ? normalized : '';
  } catch (e) {
    logStep(`fetchSkuFromDetailUrl error for ${href}: ${e && e.message ? e.message : e}`);
    return '';
  } finally {
    try { await page.close(); } catch {}
  }
}

async function resolveProductCode(browser, tile) {
  const candidate =
    normalizeCodeValue(
      codeFromHref(tile.href) ||
      tile.codeText ||
      tile.sku ||
      ''
    );

  if (!needsDetailFetch(tile.href, candidate)) return candidate;

  // Try PDP a few times
  for (let i = 0; i < PDP_FETCH_RETRIES; i++) {
    const code = await fetchSkuFromDetailUrl(browser, tile.href);
    if (code) return code;
    await sleep(350);
  }
  // Fallback
  return candidate;
}

// -----------------------------------------------------------------------------
// Page collectors
// -----------------------------------------------------------------------------
async function waitForGrid(page) {
  await page.waitForSelector('#product-grid-view', { timeout: 60000 }).catch(()=>{});
}

async function collectGridItemsOnPage(page) {
  // compatible with current list/grid markup
  const items = await page.$$eval('#product-grid-view > ol > li', (tiles) => {
    const out = [];
    for (const li of tiles) {
      const a =
        li.querySelector('a.product-item-link') ||
        li.querySelector('div.thumbnail-image > a') ||
        null;
      if (!a) continue;
      const href = a.href || a.getAttribute('href') || '';

      const skuAttr =
        li.getAttribute('data-product-sku') ||
        li.getAttribute('data-sku') ||
        a.getAttribute('data-product-sku') ||
        '';

      const nameAlt = (a.textContent || '').replace(/\s+/g, ' ').trim();

      out.push({
        href,
        sku: (skuAttr || '').trim(),
        codeText: nameAlt, // sometimes code appears in tile text
        nameAlt,
      });
    }
    return out;
  }).catch(() => []);

  return items || [];
}

async function hasNextPage(page) {
  return page.evaluate(() => {
    const next = document.querySelector('#product-grid-view .category-pager .pages .pages-item-next a, .pages .item.pages-item-next a');
    if (!next) return false;
    const disabled =
      next.classList.contains('disabled') ||
      next.hasAttribute('disabled') ||
      next.getAttribute('aria-disabled') === 'true';
    return !disabled;
  }).catch(() => false);
}

// -----------------------------------------------------------------------------
// Merge utilities (never erase existing fields)
// -----------------------------------------------------------------------------
function finalizeRecord(rec) {
  if (!rec || !rec.code) return null;
  const obj = {
    code: rec.code,
    'surface-group': 'Laminate',
    name: rec.name || '',
    'product-link': rec['product-link'] || '',
  };
  // normalize set/map fields to arrays
  const setToArr = (s) => (s && s.size ? Array.from(s) : []);
  obj.design_groups          = setToArr(rec.design_groups);
  obj.species                = setToArr(rec.species);
  obj.cut                    = setToArr(rec.cut);
  obj.match                  = setToArr(rec.match);
  obj.shade                  = setToArr(rec.shade);
  obj.colors                 = setToArr(rec.colors);
  obj.performance_enhancements = setToArr(rec.performance_enhancements);
  obj.specialty_features     = setToArr(rec.specialty_features);
  obj.design_collections     = setToArr(rec.design_collections);

  if (rec.finish && rec.finish.size) {
    obj.finish = Array.from(rec.finish.values());
  }
  return obj;
}

function shallowMergeKeep(oldObj, newObj) {
  const out = { ...oldObj };
  for (const k of Object.keys(newObj)) {
    const v = newObj[k];
    if (v === undefined || v === null) continue;
    if (k === 'finish' && Array.isArray(v)) {
      const old = Array.isArray(out.finish) ? out.finish : [];
      // de-dupe by code+name
      const seen = new Set(old.map((x) => (x.code || x.name || '').toUpperCase()));
      for (const f of v) {
        const key = (f.code || f.name || '').toUpperCase();
        if (!seen.has(key)) { old.push(f); seen.add(key); }
      }
      out.finish = old;
    } else if (Array.isArray(v)) {
      const old = Array.isArray(out[k]) ? out[k] : [];
      const set = new Set(old.map(String));
      for (const x of v) set.add(String(x));
      out[k] = Array.from(set);
    } else if (!out[k]) {
      out[k] = v;
    }
  }
  return out;
}

function readExistingIndex() {
  try {
    if (fs.existsSync(OUT_PATH)) {
      const arr = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) {
    logStep(`Warning: failed reading existing index → ${e && e.message ? e.message : e}`);
  }
  return [];
}

function writeOutput(productsMap) {
  // current run
  const current = new Map();
  for (const [, rec] of productsMap.entries()) {
    const fin = finalizeRecord(rec);
    if (!fin) continue;
    if (isValidCodeValue(fin.code)) current.set(fin.code, fin);
  }

  // existing file
  const existingArr = readExistingIndex();
  const existingByCode = new Map();
  for (const r of existingArr) {
    if (!r || typeof r !== 'object') continue;
    const code = normalizeCodeValue(r.code);
    if (code) existingByCode.set(code, { ...r, code });
  }

  // merge (never erase)
  const allCodes = new Set([...existingByCode.keys(), ...current.keys()]);
  const merged = [];
  for (const code of allCodes) {
    const oldRec = existingByCode.get(code) || { code };
    const newRec = current.get(code) || { code };
    merged.push(shallowMergeKeep(oldRec, newRec));
  }

  const tmp = OUT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, OUT_PATH);
  logStep(`Wrote ${merged.length} products → ${OUT_PATH}`);
}

// -----------------------------------------------------------------------------
// Simple reporting helpers
// -----------------------------------------------------------------------------
function hasField(rec, field) {
  if (!rec || typeof rec !== 'object') return false;
  if (field in rec) {
    const v = rec[field];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return Boolean(v);
  }
  return false;
}

function doReport(records, fields) {
  for (const f of fields) {
    const miss = records.filter((r) => !hasField(r, f)).map((r) => r.code);
    console.log('\n============================================');
    console.log(`Report: products missing "${f}" → ${miss.length}`);
    console.log('--------------------------------------------');
    for (const c of miss) console.log(c);
  }
  console.log('\n');
}

// -----------------------------------------------------------------------------
// UNFILTERED scrape
// -----------------------------------------------------------------------------
async function scrapeUnfiltered(browser) {
  const page = await browser.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForGrid(page);

  const products = new Map();
  const ensureRec = (code, { nameAlt, link } = {}) => {
    if (!products.has(code)) {
      products.set(code, {
        code,
        'surface-group': 'Laminate',
        name: '',
        'product-link': '',
        design_groups: new Set(),
        species: new Set(),
        cut: new Set(),
        match: new Set(),
        shade: new Set(),
        colors: new Set(),
        finish: new Map(),
        performance_enhancements: new Set(),
        specialty_features: new Set(),
        design_collections: new Set(),
      });
    }
    const rec = products.get(code);
    if (nameAlt && !rec.name) rec.name = nameAlt;
    if (link && !rec['product-link']) rec['product-link'] = link;
    return rec;
  };

  let pageNo = 1;
  while (true) {
    logStep(`Unfiltered page ${pageNo}: collecting tiles…`);
    const items = await collectGridItemsOnPage(page);

    for (const it of items) {
      const code = await resolveProductCode(browser, it);
      if (!code) { continue; }
      const rec = ensureRec(code, { nameAlt: it.nameAlt, link: it.href });
      // no extra buckets in unfiltered mode
    }

    const nextExists = await hasNextPage(page);
    if (!nextExists) break;
    pageNo++;
    const nextUrl = new URL(page.url());
    nextUrl.searchParams.set('p', String(pageNo));
    logStep(`→ Navigate to page ${pageNo}`);
    await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForGrid(page);
  }

  writeOutput(products);
  await page.close();
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
(async function main() {
  logStep('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    if (hasUnfilteredFlag) {
      await scrapeUnfiltered(browser);
    } else {
      // Default to unfiltered for now (user specifically asked for this mode).
      // If you want filter-based scraping, run with --unfiltered for a broad sweep first.
      await scrapeUnfiltered(browser);
    }

    // Optional reporting on current file
    if (hasReportFlag) {
      const records = readExistingIndex();
      doReport(records, reportFields);
    }
  } catch (e) {
    console.error('Fatal error:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    try { await browser.close(); } catch {}
  }
})();
