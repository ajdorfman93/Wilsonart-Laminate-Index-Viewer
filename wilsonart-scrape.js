// wilsonart-scrape.js
// Usage:
//   node wilsonart-scrape.js
//   node wilsonart-scrape.js --limit=6
//   FILTER_LIMIT=6 node wilsonart-scrape.js
//
// Output file: wilsonart-laminate-index.json
//
// What this does:
// - Opens the Wilsonart Laminate Design Library in GRID mode
// - Collects filters (checkbox + color swatches), skipping Availability/Price and certain labels
// - Iterates filters one-by-one; for each filter, navigates, loads all products, extracts:
//     * code (SKU fallback via href or image filename)
//     * name (from <img alt>)
//     * product-link (thumbnail <a href>)
//   and assigns the active filter's label to that product's bucket
// - Writes the output JSON **after each filter** to keep progress on disk
//
// Plenty of console.log statements show each step.

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// Force GRID mode so your selectors exist
const START_URL =
  "https://www.wilsonart.com/laminate/design-library?product_list_mode=grid";

// TEST LIMIT (how many filters to run this session)
const TEST_LIMIT = parseInt(
  process.env.FILTER_LIMIT ??
    (process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] ??
    "6",
  10
);

// Skip these labels anywhere they appear
const SKIP_LABELS = ["Quartz", "Solid Surface", "I am not sure"];

// Skip entire attribute sections
const SKIP_ATTRIBUTES = new Set(["availability", "price_designlibrary"]);

// Map site attribute -> output field
const ATTR_TO_OUTPUT = {
  design_groups: "design_groups",
  species: "species",
  cut_new: "cut",
  match: "match",
  shade: "shade",
  pa_finish: "finish",
  performace_enchancments: "performace_enchancments", // site spelling
  specality_features: "specality_features",           // site spelling
  design_collections: "design_collections",
  color_swatch: "color", // swatch links (not checkboxes)
};

// Output path
const OUT_PATH = path.resolve(process.cwd(), "wilsonart-laminate-index.json");

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanText = (t) =>
  (t || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

function logStep(label, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] ${label}`, data);
  } else {
    console.log(`[${ts}] ${label}`);
  }
}

function sanitizeFilterUrl(href) {
  try {
    const url = new URL(href, START_URL);
    // Drop noise + skip sections we don't want to couple with
    ["availability", "price_designlibrary", "_"].forEach((p) =>
      url.searchParams.delete(p)
    );
    // Force GRID mode
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

// Wait for DOM to stabilize: readyState + required panels
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

// Safe write (write temp then replace)
function writeOutput(productsMap) {
  logStep("writeOutput: start");
  const final = Array.from(productsMap.values()).map(finalizeRecord);
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(final, null, 2), "utf-8");
  fs.renameSync(tmp, OUT_PATH);
  logStep(
    `writeOutput: wrote ${final.length} products → ${OUT_PATH}`
  );
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
    // Block heavy assets; DOM still carries img alt + src
    if (["media", "font"].includes(type)) {
      return req.abort();
    }
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

  // Clear existing filters (if any), via href navigation (safer than click)
  try {
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
  } catch (e) {
    logStep("Warning: 'Clear All' handling failed, continuing.", e.message);
  }

  // Collect filters (checkbox anchors + color swatches)
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

  // Apply test limit if set
  if (Number.isFinite(TEST_LIMIT) && TEST_LIMIT > 0) {
    filters = filters.slice(0, TEST_LIMIT);
    logStep(`TEST LIMIT active → will run ${filters.length} filters this session.`);
  }

  // Data store
  const products = new Map();
  const ensureRec = (code, { nameAlt, link } = {}) => {
    if (!products.has(code)) {
      products.set(code, {
        code,
        name: undefined, // from <img alt>
        "product-link": undefined, // from thumbnail <a href>
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

  // Extract products from GRID: code, nameAlt, product-link
  async function extractGridItems() {
    logStep("extractGridItems: checking grid items count…");
    const totalLis =
      (await withRetry(
        () =>
          page.$$eval("#product-grid-view > ol > li", (els) => els.length),
        4,
        500,
        "grid-count"
      ).catch(() => 0)) || 0;

    logStep(`extractGridItems: grid tiles detected: ${totalLis}`);
    if (totalLis === 0) return [];

    logStep("extractGridItems: mapping tiles → {code, nameAlt, link}");
    return await withRetry(async () => {
      return await page.$$eval(
        "#product-grid-view > ol > li",
        (lis) =>
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

  async function applyFilterAndCollect(filter, index, total) {
    const url = sanitizeFilterUrl(filter.href);
    logStep(
      `\n[${index + 1}/${total}] Applying filter → attr="${filter.attr}" label="${filter.label}"`
    );
    logStep(`Navigate to: ${url}`);

    await page.goto(url, { waitUntil: "networkidle2" });
    await waitForSettled(page, { needFilters: false });

    // Lazy load by scrolling until count plateaus
    logStep("Scrolling to load all grid tiles…");
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      const count =
        (await withRetry(
          () => page.$$eval("#product-grid-view > ol > li", (els) => els.length),
          4,
          500,
          "scroll-count"
        ).catch(() => 0)) || 0;
      logStep(`scroll pass ${i + 1}: count=${count}, prev=${prev}`);
      if (count === prev) break;
      prev = count;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(900);
    }

    const items = await extractGridItems();
    logStep(`Items extracted under this filter: ${items.length}`);

    const bucket = ATTR_TO_OUTPUT[filter.attr];
    if (!bucket) {
      logStep(
        `Bucket not mapped for attribute "${filter.attr}" — skipping assignment`
      );
      return { newCodes: 0, updatedCodes: 0 };
    }

    let newCodes = 0;
    let updatedCodes = 0;
    const label = cleanText(filter.label);

    for (const { code, nameAlt, link } of items) {
      const existed = products.has(code);
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

      if (existed) updatedCodes++;
      else newCodes++;
    }

    logStep(
      `Assignment done for filter "${filter.label}": new=${newCodes}, updated=${updatedCodes}`
    );

    // After each filter, WRITE OUTPUT to keep progress
    writeOutput(products);

    return { newCodes, updatedCodes };
  }

  // ---------------------------------------------------------------------------
  // Run filters
  // ---------------------------------------------------------------------------
  logStep("Starting filter iteration…");
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    try {
      await applyFilterAndCollect(f, i, filters.length);
      await sleep(350);
    } catch (e) {
      logStep(
        `⚠️  Skipping filter [${f.attr}] "${f.label}" due to error: ${String(
          e && e.message
        ).slice(0, 160)}`
      );
    }
  }

  // Final write (already writing after each filter, but do one last time)
  logStep("Finalizing output after all filters…");
  writeOutput(products);

  logStep("All done. Closing browser.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
