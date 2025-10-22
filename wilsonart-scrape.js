// wilsonart-scrape.js
// Usage:
//   node wilsonart-scrape.js
//   node wilsonart-scrape.js --limit=6
//   FILTER_LIMIT=6 node wilsonart-scrape.js
//   SKIP_BASELINE=1 node wilsonart-scrape.js      // optional: skip the 1 unfiltered search
//
// Output file: wilsonart-laminate-index.json
//
// What this does (high level):
// - Opens the Wilsonart Laminate Design Library in GRID mode
// - **Runs ONE baseline crawl with no filters** (your "search without any filter")
//   across all result pages and lazy loads.
// - Collects all filter options (checkboxes + color swatches), skipping Availability/Price and
//   specific labels, then for each filter:
//     * Navigates to the filter URL
//     * Loads all products across **all pages** (clicks next until it stops) and via lazy scroll
//     * Extracts code, name, product-link
//     * Adds the active filter’s label to the correct bucket
// - Writes the output JSON **after the baseline** and after **each filter** to keep progress on disk.

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const START_URL =
  "https://www.wilsonart.com/laminate/design-library?product_list_mode=grid";

const TEST_LIMIT = parseInt(
  process.env.FILTER_LIMIT ??
    (process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] ??
    "111",
  10
);

// Skip these labels anywhere they appear
const SKIP_LABELS = ["Quartz", "Solid Surface", "I am not sure"];

// Skip whole attribute sections
const SKIP_ATTRIBUTES = new Set(["availability", "price_designlibrary"]);

// Map site attribute -> output field
const ATTR_TO_OUTPUT = {
  design_groups: "design_groups",
  species: "species",
  cut_new: "cut",
  match: "match",
  shade: "shade",
  pa_finish: "finish",
  performace_enchancments: "performace_enchancments", // (site spelling)
  specality_features: "specality_features",           // (site spelling)
  design_collections: "design_collections",
  color_swatch: "color",
};

const OUT_PATH = path.resolve(process.cwd(), "wilsonart-laminate-index.json");

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanText = (t) =>
  (t || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

function logStep(label, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) console.log(`[${ts}] ${label}`, data);
  else console.log(`[${ts}] ${label}`);
}

function sanitizeFilterUrl(href) {
  try {
    const url = new URL(href, START_URL);
    ["availability", "price_designlibrary", "_"].forEach((p) =>
      url.searchParams.delete(p)
    );
    url.searchParams.set("product_list_mode", "grid");
    return url.toString();
  } catch {
    return href;
  }
}

// Parse finish label like "# 38 Fine Velvet" -> {code:"#38", name:"Fine Velvet"}
function parseFinish(label) {
  const m = label.match(/#\s*(\d+)\s*(.*)$/);
  if (m) return { code: `#${m[1]}`, name: cleanText(m[2]) || undefined };
  const m2 = label.match(/^#\s*([A-Za-z].*)$/);
  if (m2) return { code: undefined, name: cleanText(m2[1]) };
  return { code: undefined, name: cleanText(label) };
}

// Retry wrapper for evaluate/$$eval that handles SPA context resets
async function withRetry(fn, attempts = 4, pauseMs = 500, tag = "") {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      const ctxLost =
        msg.includes("Execution context was destroyed") ||
        msg.includes("Cannot find context with specified id") ||
        msg.includes("Target closed");
      logStep(
        `withRetry(${tag}) attempt ${i + 1}/${attempts} failed: ${msg.slice(
          0,
          160
        )}`
      );
      if (!ctxLost || i === attempts - 1) throw e;
      await sleep(pauseMs);
    }
  }
  throw lastErr;
}

async function waitForSettled(page, { needFilters = true } = {}) {
  logStep("waitForSettled: waiting for document.readyState === 'complete'");
  try {
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: 30000,
    });
  } catch {}
  if (needFilters) {
    logStep("waitForSettled: waiting for #narrow-by-list");
    await page.waitForSelector("#narrow-by-list", { timeout: 30000 });
    logStep("waitForSettled: waiting for at least one filter option");
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '#narrow-by-list .filter-options-item[attribute] a, #narrow-by-list a.swatch-option-link-layered'
        ),
      { timeout: 30000 }
    );
  }
  await sleep(250);
  logStep("waitForSettled: done");
}

function writeOutput(productsMap) {
  logStep("writeOutput: start");
  const final = Array.from(productsMap.values()).map(finalizeRecord);
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(final, null, 2), "utf-8");
  fs.renameSync(tmp, OUT_PATH);
  logStep(`writeOutput: wrote ${final.length} products → ${OUT_PATH}`);
}

function finalizeRecord(rec) {
  const out = {
    code: rec.code,
    "surface-group": "Laminate",
  };
  if (rec.name) out.name = rec.name;
  if (rec["product-link"]) out["product-link"] = rec["product-link"];

  for (const [key, val] of Object.entries(rec)) {
    if (key === "code" || key === "name" || key === "product-link") continue;
    if (key === "finish") {
      out.finish = Array.from(val.values());
      continue;
    }
    if (val instanceof Set) {
      const arr = Array.from(val.values());
      if (key === "shade") out.shade = arr.length === 1 ? arr[0] : arr;
      else out[key] = arr;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Grid extraction + pagination
// -----------------------------------------------------------------------------

// Count visible tiles
async function countGridTiles(page) {
  return (
    (await withRetry(
      () => page.$$eval("#product-grid-view > ol > li", (els) => els.length),
      4,
      500,
      "grid-count"
    ).catch(() => 0)) || 0
  );
}

// Lazy scroll until tile count plateaus
async function lazyScrollAll(page, maxPasses = 20) {
  logStep("lazyScrollAll: begin");
  let prev = -1;
  for (let i = 0; i < maxPasses; i++) {
    const count = await countGridTiles(page);
    logStep(`lazyScrollAll: pass ${i + 1}: count=${count}, prev=${prev}`);
    if (count === prev) break;
    prev = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(900);
  }
  logStep("lazyScrollAll: done");
}

async function extractGridItemsForCurrentPage(page) {
  const total = await countGridTiles(page);
  logStep(`extractGridItemsForCurrentPage: grid tiles detected: ${total}`);
  if (total === 0) return [];
  return await withRetry(async () => {
    return await page.$$eval("#product-grid-view > ol > li", (lis) =>
      lis
        .map((li) => {
          const a = li.querySelector("div.thumbnail-image > a");
          const img = a ? a.querySelector("img") : null;
          const link = a ? a.href : undefined;
          const nameAlt = img ? (img.getAttribute("alt") || "").trim() : undefined;

          // SKU in grid (if present)
          const skuEl = li.querySelector(".product-item-sku a, .product-item-sku");
          let code = skuEl && skuEl.textContent ? skuEl.textContent.trim() : undefined;

          // Fallback 1: parse from href slug (…-y0394)
          if (!code && link) {
            const m = link.match(/-([A-Za-z]?\d{3,6})(?:\/|$)/i);
            if (m) code = m[1].toUpperCase();
          }

          // Fallback 2: parse from image src (.../Y0395_*.jpg)
          const src = img ? img.getAttribute("src") : null;
          if (!code && src) {
            const m2 = src.match(/\/([A-Za-z]?\d{3,6})[_-][^/]*\.jpg/i);
            if (m2) code = m2[1].toUpperCase();
          }

          return code ? { code, nameAlt, link } : null;
        })
        .filter(Boolean)
    );
  }, 4, 500, "grid-map");
}

// Return absolute href for the NEXT page, or null if none/disabled
async function getNextPageHref(page) {
  return await withRetry(
    () =>
      page.evaluate(() => {
        const nextLi = document.querySelector(
          "#product-grid-view .pages li.item.pages-item-next"
        );
        if (!nextLi) return null;
        if (nextLi.classList.contains("disabled")) return null;
        const a = nextLi.querySelector("a");
        if (!a) return null;
        // prefer absolute href if possible
        return a.href || a.getAttribute("href") || null;
      }),
    3,
    300,
    "get-next"
  ).catch(() => null);
}

// Load **all** results for current filter (or baseline) across pages + lazy load
async function loadAllResults(page) {
  const seenUrls = new Set();
  let pageNum = 1;
  const items = [];

  while (true) {
    logStep(`Pagination: at page ${pageNum} (url=${page.url()})`);
    await lazyScrollAll(page);
    const here = await extractGridItemsForCurrentPage(page);
    logStep(`Page ${pageNum}: extracted ${here.length} items`);
    items.push(...here);

    const curr = page.url();
    seenUrls.add(curr);

    const nextHref = await getNextPageHref(page);
    if (!nextHref) {
      logStep("Pagination: next not available; done.");
      break;
    }
    if (seenUrls.has(nextHref)) {
      logStep("Pagination: next URL already visited; stopping to avoid loop.");
      break;
    }

    logStep(`Pagination: moving to page ${pageNum + 1} via ${nextHref}`);
    await page.goto(nextHref, { waitUntil: "networkidle2" });
    await waitForSettled(page, { needFilters: false });
    const after = page.url();
    if (after === curr) {
      logStep("Pagination: URL unchanged after navigating next; stopping to avoid loop.");
      break;
    }
    pageNum++;
    await sleep(350);
  }

  return items;
}

// -----------------------------------------------------------------------------
// Data store
// -----------------------------------------------------------------------------

function createStore() {
  const products = new Map();
  const ensureRec = (code, { nameAlt, link } = {}) => {
    if (!products.has(code)) {
      products.set(code, {
        code,
        name: undefined,
        "product-link": undefined,
        design_groups: new Set(),
        species: new Set(),
        cut: new Set(),
        match: new Set(),
        shade: new Set(),
        color: new Set(),
        finish: new Map(), // key -> {code,name}
        performace_enchancments: new Set(),
        specality_features: new Set(),
        design_collections: new Set(),
      });
    }
    const rec = products.get(code);
    if (nameAlt && !rec.name) rec.name = nameAlt;
    if (link && !rec["product-link"]) rec["product-link"] = link;
    return rec;
  };
  return { products, ensureRec };
}

// -----------------------------------------------------------------------------
// Filters collection
// -----------------------------------------------------------------------------

async function collectFilters(page) {
  logStep("Collecting filters (checkbox anchors) …");
  const checkboxFilters = await withRetry(async () => {
    return await page.$$eval(
      '#narrow-by-list .filter-options-item[attribute] a',
      (anchors, SKIP_LABELS, SKIP_ATTRIBUTES) => {
        const skipLabelsLower = SKIP_LABELS.map((s) => s.toLowerCase());
        const skipAttrs = new Set(SKIP_ATTRIBUTES);
        const list = [];
        for (const a of anchors) {
          const wrap = a.closest('.filter-options-item[attribute]');
          if (!wrap) continue;
          const attr = wrap.getAttribute("attribute") || "";
          if (skipAttrs.has(attr)) continue;

          const hasCheckbox = !!a.querySelector('input[type="checkbox"]');
          if (!hasCheckbox) continue;

          const label = (a.textContent || "").replace(/\s+/g, " ").trim();
          if (!label) continue;
          const labelLower = label.toLowerCase();
          if (skipLabelsLower.some((x) => labelLower.includes(x))) continue;

          const href = a.getAttribute("href");
          if (!href) continue;

          list.push({ attr, label, href, kind: "checkbox" });
        }
        return list;
      },
      SKIP_LABELS,
      Array.from(SKIP_ATTRIBUTES)
    );
  }, 4, 500, "collect-checkbox");

  logStep(`Collected ${checkboxFilters.length} checkbox filters.`);

  logStep("Collecting filters (color swatches) …");
  const colorFilters =
    (await withRetry(async () => {
      return await page.$$eval(
        '#narrow-by-list .filter-options-item[attribute="color_swatch"] a.swatch-option-link-layered',
        (anchors) =>
          anchors
            .map((a) => {
              const href = a.getAttribute("href");
              const label =
                a.getAttribute("aria-label") || a.textContent || "";
              return href && label
                ? {
                    attr: "color_swatch",
                    label: label.replace(/\s+/g, " ").trim(),
                    href,
                    kind: "swatch",
                  }
                : null;
            })
            .filter(Boolean)
      );
    }, 4, 500, "collect-color").catch(() => [])) || [];

  logStep(`Collected ${colorFilters.length} color filters.`);

  // Merge + de-dupe
  const seen = new Set();
  let filters = [...checkboxFilters, ...colorFilters].filter((f) => {
    const k = `${f.attr}||${f.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  logStep(`Total unique filters: ${filters.length}`);

  if (Number.isFinite(TEST_LIMIT) && TEST_LIMIT > 0) {
    filters = filters.slice(0, TEST_LIMIT);
    logStep(`TEST LIMIT active → will run ${filters.length} filters this session.`);
  }

  return filters;
}

// -----------------------------------------------------------------------------
// Clear filters (if any)
// -----------------------------------------------------------------------------

async function clearAllFiltersIfPresent(page) {
  logStep("Checking for 'Clear All' link…");
  const clearHref =
    (await withRetry(
      () =>
        page.$eval(
          '.filter-actions a.filter-clear, .filter-current a.clear_all_filter',
          (a) => a.getAttribute("href")
        ),
      2,
      500,
      "clearAll"
    ).catch(() => null)) || null;

  if (clearHref) {
    const url = sanitizeFilterUrl(clearHref);
    logStep(`'Clear All' found. Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await waitForSettled(page);
  } else {
    logStep("'Clear All' not present, continuing.");
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

(async () => {
  logStep("Launching Puppeteer…");
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1368, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  // Light asset throttling
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["media", "font"].includes(type)) return req.abort();
    req.continue();
  });

  // Realistic UA
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  logStep(`Navigating to START_URL (GRID mode): ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "networkidle2" });
  await waitForSettled(page);

  await clearAllFiltersIfPresent(page);

  const { products, ensureRec } = createStore();

  // ---------------------------- Baseline (no filters) -------------------------
  if (!process.env.SKIP_BASELINE) {
    logStep("=== BASELINE (no filters) — single unfiltered search across all pages ===");
    // Make sure we're on a clean, unfiltered page
    await page.goto(START_URL, { waitUntil: "networkidle2" });
    await waitForSettled(page, { needFilters: false });

    const baseItems = await loadAllResults(page);
    logStep(`Baseline: ${baseItems.length} items extracted.`);
    for (const { code, nameAlt, link } of baseItems) {
      ensureRec(code, { nameAlt, link });
    }
    writeOutput(products);
  } else {
    logStep("Skipping baseline due to SKIP_BASELINE env flag.");
  }

  // ----------------------------- Filters pass --------------------------------
  logStep("Collecting filters…");
  const filters = await collectFilters(page);

  logStep("Starting filter iteration…");
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    try {
      const url = sanitizeFilterUrl(f.href);
      logStep(
        `\n[${i + 1}/${filters.length}] Applying filter → attr="${f.attr}" label="${f.label}"`
      );
      logStep(`Navigate to: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2" });
      await waitForSettled(page, { needFilters: false });

      const items = await loadAllResults(page);
      logStep(`Filter "${f.label}": extracted ${items.length} items`);

      const bucket = ATTR_TO_OUTPUT[f.attr];
      if (!bucket) {
        logStep(`Bucket not mapped for attribute "${f.attr}" — skipping assignment`);
      } else {
        const label = cleanText(f.label);
        for (const { code, nameAlt, link } of items) {
          const rec = ensureRec(code, { nameAlt, link });
          if (bucket === "finish") {
            const parsed = parseFinish(label);
            const key = parsed.code || parsed.name || label;
            if (!rec.finish.has(key)) rec.finish.set(key, parsed);
          } else if (bucket === "shade") {
            rec.shade.add(label);
          } else {
            rec[bucket].add(label);
          }
        }
      }

      // Persist after each filter
      writeOutput(products);
      await sleep(350);
    } catch (e) {
      logStep(
        `⚠️  Skipping filter [${f.attr}] "${f.label}" due to error: ${String(
          e && e.message
        ).slice(0, 160)}`
      );
    }
  }

  // Final write (safety, already written after baseline + each filter)
  logStep("Finalizing output after all filters…");
  writeOutput(products);

  logStep("All done. Closing browser.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
