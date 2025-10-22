// wilsonart-scrape.js
// Usage:
//   node wilsonart-scrape.js
//   node wilsonart-scrape.js FILTER_LIMIT=1 
//
// --missing 
//   Scrape only products missing the specified field (default: texture_image_url).
//   Example: --missing texture_image_url
//   user can add multiple --missing arguments to check for multiple fields
//   Example: --missing texture_image_url --missing texture_scale
//
// --report
//   Print a report of all products missing the specified field (default: texture_image_url).
//   Example: --report texture_image_url
//   user can add multiple --report arguments to check for multiple fields
//  Example: --report texture_image_url --report texture_scale
//
// List of possible headers or data contained in wilsonart-laminate-index.json that can be used with --missing or --report:
//    code                 
//    surface-group        
//    name                 
//    product-link         
//    design_groups       
//    species              
//    cut                  
//    match                
//    shade                
//    color     
//    finish               
//      code             
//      name             
//    performace_enchancments        
//    specality_features             
//    design_collections             
//    texture_image_url              
//    texture_image_pixels    
//      width                 
//      height                
//    no_repeat               
//    description             
//    texture_scale           
//      width                 
//      height                


"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ----------------------------------------------------
// Config
// ----------------------------------------------------
const START_URL =
  "https://www.wilsonart.com/laminate/design-library?product_list_mode=list";

const TEST_LIMIT = parseInt(
  process.env.FILTER_LIMIT ??
    (process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] ??
    "0",
  10
);

// Skip these labels anywhere they appear
const SKIP_LABELS = ["Quartz", "Solid Surface", "I am not sure"];

// Skip entire attribute sections
const SKIP_ATTRIBUTES = new Set(["availability", "price_designlibrary"]);

// Map site attribute -> output field (normalize spellings; pluralize colors)
const ATTR_TO_OUTPUT = {
  design_groups: "design_groups",
  species: "species",
  cut_new: "cut",
  match: "match",
  shade: "shade",
  pa_finish: "finish",
  performace_enchancments: "performance_enhancements", // normalize spelling
  specality_features: "specialty_features",            // normalize spelling
  design_collections: "design_collections",
  color_swatch: "colors", // plural, per user example
};

const OUT_PATH = path.resolve(process.cwd(), "wilsonart-laminate-index.json");

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
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
    url.searchParams.set("product_list_mode", "list");
    return url.toString();
  } catch {
    return href;
  }
}

// Parse finish label like "# 38 Fine Velvet" -> { code:"#38", name:"Fine Velvet" }
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
  try {
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: 30000,
    });
  } catch {}
  if (needFilters) {
    await page.waitForSelector("#narrow-by-list", { timeout: 30000 });
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '#narrow-by-list .filter-options-item[attribute] a, #narrow-by-list a.swatch-option-link-layered'
        ),
      { timeout: 30000 }
    );
  }
  await sleep(200);
}

// Safe write (write temp then replace)
function writeOutput(productsMap) {
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
      out[key] = arr;
    }
  }
  return out;
}

// Extract code from href slug tail: "...-y0385"
function codeFromHref(href) {
  try {
    const url = new URL(href, START_URL);
    const parts = url.pathname.split("/").filter(Boolean);
    let slug = parts[parts.length - 1] || "";
    if (slug === "category" && parts.length >= 2) slug = parts[parts.length - 3] || slug;
    const m = slug.match(/-([a-z0-9]+)$/i);
    if (m) return m[1].toUpperCase();
  } catch {}
  return null;
}

// Lazy scrolling to load all tiles on current page
async function lazyScrollAll(page, maxPasses = 20) {
  let prev = -1;
  for (let i = 0; i < maxPasses; i++) {
    const count =
      (await page.$$eval("#product-grid-view > ol > li", (els) => els.length).catch(() => 0)) || 0;
    if (count === prev) break;
    prev = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(700);
  }
}

// Collect items present in the grid on the current page
async function collectGridItemsOnPage(page) {
  // Try to be robust across both grid variants
  const items =
    (await page
      .$$eval("#product-grid-view > ol > li", (tiles) => {
        const out = [];
        for (const li of tiles) {
          // Prefer explicit product link
          const a =
            li.querySelector("a.product-item-link") ||
            li.querySelector("div.thumbnail-image > a") ||
            null;
          if (!a) continue;
          const href = a.href || a.getAttribute("href") || "";

          // Sometimes the code is the anchor text; sometimes only in slug/img
          const codeText =
            (a.textContent || "").replace(/\s+/g, " ").trim() ||
            (li.querySelector(".product-item-sku a, .product-item-sku") || {}).textContent ||
            "";

          // name from image alt if present (fallback)
          const img = a.querySelector("img") || li.querySelector("img");
          const nameAlt = img ? (img.getAttribute("alt") || "").trim() : "";

          out.push({ href, codeText: (codeText || "").trim(), nameAlt });
        }
        return out;
      })
      .catch(() => [])) || [];
  return items;
}

// Click "Next" and verify URL changed; fallback to bumping p=
async function goNextPage(page, curIndex) {
  const nextSel = "#product-grid-view .category-pager .pages .pages-item-next a";
  const a = await page.$(nextSel);
  if (!a) return false;
  const prevURL = page.url();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    a.click().catch(() => {}),
  ]);
  const newURL = page.url();
  if (newURL === prevURL) {
    try {
      const url = new URL(prevURL);
      const p = Number(url.searchParams.get("p") || "1");
      const next = Number.isFinite(p) ? p + 1 : curIndex + 1;
      url.searchParams.set("p", String(next));
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      return page.url() !== prevURL;
    } catch {}
    return false;
  }
  return true;
}

// ----------------------------------------------------
// Main
// ----------------------------------------------------
(async () => {
  logStep("Launching Puppeteer…");
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1400, height: 900 },
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

  logStep(`Opening START_URL: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);

  // Clear existing filters if present
  try {
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
      logStep(`Clearing existing filters → ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForSettled(page);
    }
  } catch (e) {
    logStep("Warning: clear-all failed; continuing.", e.message);
  }

  // Collect filters (checkbox anchors + color swatches)
  logStep("Collecting checkbox filters…");
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

  logStep("Collecting color swatch filters…");
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

  // Merge + de-dupe
  const seen = new Set();
  let filters = [...checkboxFilters, ...colorFilters].filter((f) => {
    const k = `${f.attr}||${f.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  logStep(`Total unique filters discovered: ${filters.length}`);

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
        name: undefined,
        "product-link": undefined,
        design_groups: new Set(),
        species: new Set(),
        cut: new Set(),
        match: new Set(),
        shade: new Set(),
        colors: new Set(),
        finish: new Map(), // key -> {code,name}
        performance_enhancements: new Set(),
        specialty_features: new Set(),
        design_collections: new Set(),
      });
    }
    const rec = products.get(code);
    if (nameAlt && !rec.name) rec.name = nameAlt;
    if (link && !rec["product-link"]) rec["product-link"] = link;
    return rec;
  };

  async function extractGridAndAssign(bucket, label) {
    await lazyScrollAll(page);

    const items = await collectGridItemsOnPage(page);
    let newCodes = 0;
    let updatedCodes = 0;

    for (const it of items) {
      const href = it.href;
      let code = codeFromHref(href);
      if (!code && it.codeText) code = String(it.codeText).trim().toUpperCase();
      if (!code) continue;

      const existed = products.has(code);
      const rec = ensureRec(code, { nameAlt: it.nameAlt, link: href });

      if (bucket === "finish") {
        const parsed = parseFinish(label);
        const key = parsed.code || parsed.name || label;
        if (!rec.finish.has(key)) rec.finish.set(key, parsed);
      } else {
        rec[bucket]?.add(label);
      }

      if (existed) updatedCodes++;
      else newCodes++;
    }

    return { newCodes, updatedCodes, count: items.length };
  }

  async function applyFilterAndCollect(filter, index, total) {
    const url = sanitizeFilterUrl(filter.href);
    const bucket = ATTR_TO_OUTPUT[filter.attr];

    logStep(
      `\n[${index + 1}/${total}] Applying filter → attr="${filter.attr}" label="${filter.label}"`
    );
    logStep(`Navigate to: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#product-grid-view", { timeout: 60000 }).catch(() => {});

    if (!bucket) {
      logStep(`Attribute "${filter.attr}" not mapped → skipping assignment bucket.`);
      return;
    }

    const label = cleanText(filter.label);
    let pageNo = 1;
    let grandNew = 0;
    let grandUpd = 0;
    let grandSeen = 0;

    while (true) {
      logStep(`Filter "${label}" — Page ${pageNo}: collecting…`);
      const { newCodes, updatedCodes, count } = await extractGridAndAssign(bucket, label);
      logStep(
        `Filter "${label}" — Page ${pageNo}: tiles=${count}, new=${newCodes}, updated=${updatedCodes}`
      );
      grandNew += newCodes;
      grandUpd += updatedCodes;
      grandSeen += count;

      const hasNext = await goNextPage(page, pageNo);
      if (!hasNext) {
        logStep(
          `Filter "${label}" — Pagination: no next after page ${pageNo}; done with this filter.`
        );
        break;
      }
      pageNo++;
      await page.waitForSelector("#product-grid-view", { timeout: 60000 }).catch(() => {});
    }

    logStep(
      `Assignment done for "${label}": pages=${pageNo}, tilesSeen=${grandSeen}, new=${grandNew}, updated=${grandUpd}`
    );

    // Persist after each filter
    writeOutput(products);
  }

  // --------------------------------------------------
  // Run filters one-by-one with full pagination per filter
  // --------------------------------------------------
  logStep("Starting filter iteration with full pagination…");
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    try {
      await applyFilterAndCollect(f, i, filters.length);
      await sleep(300);
    } catch (e) {
      logStep(
        `⚠️  Skipping filter [${f.attr}] "${f.label}" due to error: ${String(
          e && e.message
        ).slice(0, 160)}`
      );
    }
  }

  // Final write
  logStep("Finalizing output after all filters…");
  writeOutput(products);

  logStep("All done. Closing browser.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
// wilsonart-scrape.js
// Usage:
//   node wilsonart-scrape.js
//   FILTER_LIMIT=6 node wilsonart-scrape.js
//