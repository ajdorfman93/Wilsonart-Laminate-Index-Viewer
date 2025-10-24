// wilsonart-scrapeTFL.js
//
// Usage:
//   node wilsonart-scrapeTFL.js
//   FILTER_LIMIT=1 node wilsonart-scrapeTFL.js --missing 
//
// command line arg
// --missing 
//   Scrape only filters the specified field (default: finish).
//   Example: node wilsonart-scrapeTFL.js --missing color
//   user can add multiple --missing arguments to check for multiple fields
//   Example: --missing finish --missing color
//
// command line arg  
// --report
//   Print a report of all products missing the specified field (default: finish).
//   Example: --report finish
//   user can add multiple --report arguments to check for multiple fields
//   Example: --report color --report finish
//
// command line arg
// --check
//   Validate codes in wilsonart-laminate-index.json and auto-correct values that do not
//   satisfy the expected format (3-7 alphanumeric chars, at least two digits).
//   Example: node wilsonart-scrapeTFL.js --check
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
//    no_repeat               
//    description     
//                  

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ----------------------------------------------------
// CLI parsing
// ----------------------------------------------------
const argv = process.argv.slice(2);
const hasCheckFlag = argv.includes("--check");

function collectMulti(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.push(next);
        i++;
      } else {
        // bare flag: caller wants default for this flag (handled by caller)
        out.push("");
      }
    } else if (a.startsWith(flag + "=")) {
      out.push(a.split("=")[1] || "");
    }
  }
  return out;
}

const hasMissingFlag = argv.some((a) => a === "--missing" || a.startsWith("--missing="));
const hasReportFlag = argv.some((a) => a === "--report" || a.startsWith("--report="));

const missingRaw = collectMulti("--missing");
const reportRaw = collectMulti("--report");

function normField(f) {
  const k = String(f || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const map = {
    // basic
    code: "code",
    name: "name",
    product_link: "product-link",
    "product-link": "product-link",
    surface_group: "surface-group",
    "surface-group": "surface-group",

    // filter-backed fields
    design_groups: "design_groups",
    species: "species",
    cut: "cut",
    match: "match",
    shade: "shade",
    color: "colors",
    colors: "colors",
    finish: "finish",
    performace_enchancments: "performance_enhancements",
    performance_enhancements: "performance_enhancements",
    specality_features: "specialty_features",
    specialty_features: "specialty_features",
    design_collections: "design_collections",

    // misc that may exist in file
    no_repeat: "no_repeat",
    description: "description",
  };
  return map[k] || k;
}

// Field aliases used for reporting and merging (so we don't mis-report due to spelling/format variants)
const FIELD_ALIASES = {
  colors: ["colors", "color"],
  "product-link": ["product-link", "product_link"],
  "surface-group": ["surface-group", "surface_group"],
  performance_enhancements: ["performance_enhancements", "performace_enchancments"],
  specialty_features: ["specialty_features", "specality_features"],
};

function getFieldVariants(canonicalKey) {
  return FIELD_ALIASES[canonicalKey] || [canonicalKey];
}

let missingFields = hasMissingFlag ? missingRaw.map((v) => normField(v || "finish")) : [];
if (hasMissingFlag && missingFields.length === 0) missingFields = ["finish"]; // safety

let reportFields = hasReportFlag ? reportRaw.map((v) => normField(v || "finish")) : [];
if (hasReportFlag && reportFields.length === 0) reportFields = ["finish"]; // safety

const OUT_PATH = path.resolve(process.cwd(), "wilsonart-tfl-laminate-index.json");

// ----------------------------------------------------
// Config
// ----------------------------------------------------
const START_URL =
  "https://www.wilsonart.com/laminate/thermally-fused-laminate/design-library?product_list_mode=list";

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
  specality_features: "specialty_features", // normalize spelling
  design_collections: "design_collections",
  color_swatch: "colors", // plural, per user example
};

// Build reverse map: output field -> Set(site attrs)
const OUTPUT_TO_ATTRS = Object.entries(ATTR_TO_OUTPUT).reduce((acc, [attr, out]) => {
  (acc[out] ||= new Set()).add(attr);
  return acc;
}, {});

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanText = (t) => (t || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

function logStep(label, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) console.log(`[${ts}] ${label}`, data);
  else console.log(`[${ts}] ${label}`);
}

function sanitizeFilterUrl(href) {
  try {
    const url = new URL(href, START_URL);
    ["availability", "price_designlibrary", "_"]
      .forEach((p) => url.searchParams.delete(p));
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
        `withRetry(${tag}) attempt ${i + 1}/${attempts} failed: ${msg.slice(0, 160)}`
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
  // 1) Normalize current in-memory results to plain objects
  const current = new Map();
  for (const [code, rec] of productsMap.entries()) {
    current.set(code, finalizeRecord(rec));
  }

  // 2) Read existing file (if any) and index by code
  let existingArr = [];
  try {
    if (fs.existsSync(OUT_PATH)) {
      existingArr = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
      if (!Array.isArray(existingArr)) existingArr = [];
    }
  } catch (e) {
    console.warn("Warning: failed to read existing index; proceeding with fresh write:", e && e.message ? e.message : e);
    existingArr = [];
  }
  const existing = new Map();
  for (const r of existingArr) {
    if (r && r.code) existing.set(String(r.code).toUpperCase(), r);
  }

  const limitFields = hasMissingFlag ? new Set(missingFields) : null;

  // 3) Merge per code (never erase). Keep records that weren't touched.
  const allCodes = new Set([...existing.keys(), ...current.keys()]);

  const mergedOut = [];
  for (const code of allCodes) {
    const oldRec = existing.get(code) || { code };
    let newRec = current.get(code) || { code };
    if (limitFields && newRec) {
      newRec = limitRecordToFields(newRec, limitFields, existing.has(code));
    }
    const merged = mergeRecordsNoErase(oldRec, newRec);
    mergedOut.push(merged);
  }

  // 4) Write merged output atomically
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mergedOut, null, 2), "utf-8");
  fs.renameSync(tmp, OUT_PATH);
  logStep(`writeOutput: merged ${mergedOut.length} products → ${OUT_PATH}`);
}

function finalizeRecord(rec) {
  const out = {
    code: rec.code,
    "surface-group": rec["surface-group"] || "Laminate",
  };
  if (rec.name) out.name = rec.name;
  if (rec["product-link"]) out["product-link"] = rec["product-link"];

  for (const [key, val] of Object.entries(rec)) {
    if (key === "code" || key === "name" || key === "product-link" || key === "surface-group") continue;
    if (key === "finish") {
      // Convert internal Map to stable array of {code?, name?}
      const arr = [];
      for (const v of val.values()) {
        if (v && typeof v === "object") arr.push({ code: v.code, name: v.name });
      }
      out.finish = arr;
      continue;
    }
    if (val instanceof Set) {
      out[key] = Array.from(val.values());
    }
  }
  return out;
}

function limitRecordToFields(rec, allowedFields, hasExisting) {
  if (!allowedFields || !allowedFields.size) return rec;
  const out = { code: rec.code };
  if (!out.code) return out;

  if (!hasExisting) {
    for (const baseKey of ["surface-group", "name", "product-link"]) {
      if (rec[baseKey] !== undefined) out[baseKey] = rec[baseKey];
    }
  }

  for (const field of allowedFields) {
    if (!field || field === "code") continue;
    const variants = getFieldVariants(field);
    let assigned = false;
    for (const variant of variants) {
      const value = rec[variant];
      if (variant === "finish") {
        if (Array.isArray(value) && value.length) {
          out.finish = value;
          assigned = true;
        }
      } else if (Array.isArray(value)) {
        if (value.length) {
          out[field] = value;
          assigned = true;
        }
      } else if (value !== undefined) {
        out[field] = value;
        assigned = true;
      }
      if (assigned) break;
    }
  }

  return out;
}

// Extract code from href slug tail: "...-y0385"
function extractCodeCandidate(input) {
  const str = String(input || "").replace(/\s+/g, " ").trim();
  if (!str) return null;
  const matches = str.match(/[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]+)*/g);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].toUpperCase();
}

function codeFromHref(href) {
  try {
    const url = new URL(href, START_URL);

    // Query parameters occasionally carry the SKU; prefer them if present.
    for (const key of ["sku", "product_sku", "productSku", "skuId"]) {
      const val = url.searchParams.get(key);
      const candidate = extractCodeCandidate(val);
      if (candidate) return candidate;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      let segment = parts[i] || "";
      if (!segment) continue;
      segment = segment.replace(/\.[a-z0-9]+$/i, ""); // drop extensions such as .html
      if (segment === "category" && i >= 2) {
        segment = parts[i - 2] || segment;
      }
      const hyphenIdx = segment.lastIndexOf("-");
      if (hyphenIdx !== -1 && hyphenIdx < segment.length - 1) {
        const candidate = extractCodeCandidate(segment.slice(hyphenIdx + 1));
        if (candidate) return candidate;
      }
      const plainCandidate = extractCodeCandidate(segment);
      if (plainCandidate) return plainCandidate;
    }
  } catch {}
  return null;
}

// ----------------------------------------------------
// Code validation helpers
// ----------------------------------------------------
const CODE_ALLOWED_RE = /^[A-Z0-9]+$/;

function normalizeCodeValue(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\u2026/g, "...")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function isValidCodeValue(code) {
  if (!code) return false;
  if (!CODE_ALLOWED_RE.test(code)) return false;
  if (code.length < 3 || code.length > 7) return false;
  const digitCount = (code.match(/[0-9]/g) || []).length;
  return digitCount >= 2;
}

function collectTokensFromUrl(urlLike) {
  if (!urlLike) return [];
  const tokens = [];
  const addTokens = (input) => {
    if (!input) return;
    const matches = String(input).match(/[A-Za-z0-9]+/g);
    if (matches) tokens.push(...matches);
  };
  try {
    const url = new URL(urlLike, START_URL);
    url.pathname
      .split("/")
      .filter(Boolean)
      .forEach((segment) => addTokens(segment));
    url.searchParams.forEach((val) => addTokens(val));
    if (url.hash) addTokens(url.hash);
  } catch {
    addTokens(urlLike);
  }
  return tokens;
}

function gatherCandidateCodes(product, detail) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (raw, source) => {
    const normalized = normalizeCodeValue(raw);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ code: normalized, source });
  };

  pushCandidate(product && product.code, "existing");

  const productLink = product && product["product-link"];
  if (productLink) {
    for (const token of collectTokensFromUrl(productLink)) {
      pushCandidate(token, "product-link");
    }
  }

  if (detail) {
    if (detail.code && detail.code !== product.code) {
      pushCandidate(detail.code, "detail.code");
    }
    if (detail["product-link"] && detail["product-link"] !== productLink) {
      for (const token of collectTokensFromUrl(detail["product-link"])) {
        pushCandidate(token, "detail.product-link");
      }
    }
    if (detail.texture_image_url) {
      for (const token of collectTokensFromUrl(detail.texture_image_url)) {
        pushCandidate(token, "texture_image_url");
      }
    }
  }

  return candidates;
}

function findPreferredCode(product, detail) {
  const candidates = gatherCandidateCodes(product, detail);
  for (const candidate of candidates) {
    if (isValidCodeValue(candidate.code)) return candidate;
  }
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

          const skuAttr =
            li.getAttribute("data-product-sku") ||
            li.getAttribute("data-sku") ||
            a.getAttribute("data-product-sku") ||
            "";

          // Sometimes the code is the anchor text; sometimes only in slug/img
          const codeText =
            (a.textContent || "").replace(/\s+/g, " ").trim() ||
            (li.querySelector(".product-item-sku a, .product-item-sku") || {}).textContent ||
            "";

          // name from image alt if present (fallback)
          const img = a.querySelector("img") || li.querySelector("img");
          const nameAlt = img ? (img.getAttribute("alt") || "").trim() : "";

          out.push({
            href,
            codeText: (codeText || "").trim(),
            nameAlt,
            sku: (skuAttr || "").trim(),
          });
        }
        return out;
      })
      .catch(() => [])) || [];
  return items;
}

// Check if another pagination step is available
async function hasNextPage(page) {
  return page
    .evaluate(() => {
      const next = document.querySelector(
        "#product-grid-view .category-pager .pages .pages-item-next a"
      );
      if (!next) return false;
      const disabled =
        next.classList.contains("disabled") ||
        next.hasAttribute("disabled") ||
        next.getAttribute("aria-disabled") === "true";
      return !disabled;
    })
    .catch(() => false);
}

// ----------------------------------------------------
// Reporting (can be called standalone)
// ----------------------------------------------------
function hasField(rec, field) {
  // Check canonical + aliases so we don't mis-report when the file uses variant keys
  const keysToCheck = getFieldVariants(field);
  for (const k of keysToCheck) {
    const v = rec[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) return true;
      continue;
    }
    if (typeof v === "object") {
      if (Object.keys(v).length > 0) return true;
      continue;
    }
    if (typeof v === "string") {
      if (v.trim().length > 0) return true;
      continue;
    }
    return true; // numbers/booleans etc.
  }
  return false;
}

function doReport(records, fields) {
  for (const f of fields) {
    const miss = records.filter((r) => !hasField(r, f)).map((r) => r.code);
    console.log("\n============================================");
    console.log(`Report: products missing \"${f}\" → ${miss.length}`);
    console.log("--------------------------------------------");
    for (const c of miss) console.log(c);
  }
  console.log("\n");
}

function runCodeCheckAndExit() {
  try {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`[--check] No ${OUT_PATH} found. Run the scraper first.`);
      process.exit(2);
    }

    const raw = fs.readFileSync(OUT_PATH, "utf-8");
    let records;
    try {
      records = JSON.parse(raw);
    } catch (err) {
      console.error(
        `[--check] Failed to parse ${OUT_PATH}: ${err && err.message ? err.message : err}`
      );
      process.exit(3);
    }

    if (!Array.isArray(records)) {
      console.error("[--check] Expected laminate index to be an array.");
      process.exit(3);
    }

    const detailPath = path.resolve(process.cwd(), "wilsonart-tfl-laminate-details.json");
    const detailByLink = new Map();
    const detailByName = new Map();
    if (fs.existsSync(detailPath)) {
      try {
        const detailRaw = fs.readFileSync(detailPath, "utf-8");
        const detailArr = JSON.parse(detailRaw);
        if (Array.isArray(detailArr)) {
          for (const entry of detailArr) {
            if (!entry || typeof entry !== "object") continue;
            const link = entry["product-link"];
            const name = entry.name;
            if (link && !detailByLink.has(link)) detailByLink.set(link, entry);
            if (name && !detailByName.has(name)) detailByName.set(name, entry);
          }
        }
      } catch (err) {
        console.warn(
          `[--check] Warning: unable to read ${detailPath}: ${err && err.message ? err.message : err}`
        );
      }
    }

    let normalizedCount = 0;
    let correctedCount = 0;
    const correctionSources = new Set();
    const unresolved = [];

    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const originalRaw = rec.code;
      const originalHasValue = originalRaw != null && String(originalRaw).trim() !== "";
      const normalized = normalizeCodeValue(originalRaw);
      if (originalHasValue) {
        const baseline = String(originalRaw).trim().toUpperCase();
        if (normalized !== baseline) normalizedCount++;
        rec.code = normalized;
      } else if (normalized) {
        rec.code = normalized;
      }

      const detail =
        detailByLink.get(rec["product-link"]) ||
        (rec.name ? detailByName.get(rec.name) : undefined);

      if (!isValidCodeValue(rec.code)) {
        const candidate = findPreferredCode(rec, detail);
        if (candidate && candidate.code !== rec.code) {
          rec.code = candidate.code;
          correctedCount++;
          correctionSources.add(candidate.source);
        }
      }

      if (!isValidCodeValue(rec.code)) {
        unresolved.push({
          name: rec.name || "",
          link: rec["product-link"] || "",
          code: rec.code || "",
        });
      }
    }

    const mergedRecords = [];
    const indexByCode = new Map();
    const duplicateCounts = new Map();
    let duplicatesMerged = 0;

    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const code = rec.code;
      if (!code) {
        mergedRecords.push(rec);
        continue;
      }

      if (indexByCode.has(code)) {
        const idx = indexByCode.get(code);
        const merged = mergeRecordsNoErase(mergedRecords[idx], rec);
        mergedRecords[idx] = merged;
        duplicatesMerged++;
        duplicateCounts.set(code, (duplicateCounts.get(code) || 1) + 1);
      } else {
        indexByCode.set(code, mergedRecords.length);
        duplicateCounts.set(code, 1);
        mergedRecords.push(rec);
      }
    }

    const outputJson = JSON.stringify(mergedRecords, null, 2);

    const normalizedRaw = raw.replace(/\r\n/g, "\n").trimEnd();
    const normalizedOut = outputJson.replace(/\r\n/g, "\n");
    const requiresWrite =
      normalizedOut !== normalizedRaw ||
      normalizedCount > 0 ||
      correctedCount > 0 ||
      duplicatesMerged > 0;

    if (requiresWrite) {
      const newline = raw.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(OUT_PATH, outputJson + newline, "utf-8");
    }

    console.log(`[--check] Reviewed ${records.length} record(s).`);
    if (normalizedCount) {
      console.log(`[--check] Normalized ${normalizedCount} code(s) for casing and spacing.`);
    }
    if (correctedCount) {
      console.log(`[--check] Corrected ${correctedCount} code(s) using alternate data sources.`);
    }
    if (duplicatesMerged) {
      const dupList = [...duplicateCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([code, count]) => `${code}×${count}`);
      const preview = dupList.slice(0, 10).join(", ");
      console.log(
        `[--check] Merged ${duplicatesMerged} duplicate record(s) by code${
          dupList.length ? ` (${preview}${dupList.length > 10 ? ", ..." : ""})` : ""
        }.`
      );
    }
    if (!normalizedCount && !correctedCount && !duplicatesMerged) {
      console.log("[--check] No changes required.");
    } else if (!requiresWrite) {
      console.log("[--check] Detected issues but no file rewrite was necessary.");
    }
    if (correctionSources.size) {
      console.log(
        `[--check] Correction sources consulted: ${Array.from(correctionSources).join(", ")}.`
      );
    }

    if (unresolved.length) {
      console.warn(`[--check] Unable to derive valid codes for ${unresolved.length} record(s).`);
      for (const issue of unresolved.slice(0, 10)) {
        console.warn(`  - name="${issue.name}", code="${issue.code}", link=${issue.link}`);
      }
      if (unresolved.length > 10) {
        console.warn("  - ...");
      }
      console.warn("[--check] Please review the entries above manually.");
    }

    process.exit(unresolved.length ? 4 : 0);
  } catch (err) {
    console.error("[--check] Failed:", err && err.message ? err.message : err);
    process.exit(3);
  }
}

function runReportAndExit() {
  try {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`No ${OUT_PATH} found. Run the scraper first.`);
      process.exit(2);
    }
    const arr = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
    doReport(arr, reportFields.length ? reportFields : ["finish"]);
    process.exit(0);
  } catch (e) {
    console.error("Report failed:", e && e.message ? e.message : e);
    process.exit(3);
  }
}

// ----------------------------------------------------
// Merge helpers – ensure we only add/append, never erase
// ----------------------------------------------------
function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function normalizeFinishArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((it) => {
        if (it && typeof it === "object") {
          return { code: it.code, name: it.name };
        }
        if (typeof it === "string") {
          return { code: undefined, name: it };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (isPlainObject(v)) {
    // Some older files might store a map-like object; convert values to array
    return Object.values(v)
      .map((it) => (isPlainObject(it) ? { code: it.code, name: it.name } : null))
      .filter(Boolean);
  }
  if (typeof v === "string") return [{ code: undefined, name: v }];
  return [];
}

function unionFinish(aArr, bArr) {
  const seen = new Set();
  const out = [];
  function key(it) {
    const c = it && it.code ? String(it.code).trim() : "";
    const n = it && it.name ? String(it.name).trim().toLowerCase() : "";
    return `${c}|${n}`;
  }
  for (const it of [...aArr, ...bArr]) {
    if (!it) continue;
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ code: it.code, name: it.name });
  }
  return out;
}

function unionArraysGeneric(a, b) {
  const A = Array.isArray(a) ? a : a == null ? [] : [a];
  const B = Array.isArray(b) ? b : b == null ? [] : [b];
  const out = [];
  const seen = new Set();
  const push = (val) => {
    const k = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(val);
  };
  for (const v of A) push(v);
  for (const v of B) push(v);
  return out;
}

function collectArrayFromVariants(rec, canonicalKey) {
  const keys = getFieldVariants(canonicalKey);
  const acc = [];
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) acc.push(...v);
    else if (typeof v === "string") acc.push(v);
  }
  return acc;
}

function mergeRecordsNoErase(oldRec, newRec) {
  // Start from old; only add/append from new
  const out = JSON.parse(JSON.stringify(oldRec || {}));

  // Always keep the canonical code (uppercase)
  const code = String((newRec.code || oldRec.code || "")).toUpperCase();
  if (code) out.code = code;

  // Scalars: only set if missing/empty
  for (const k of ["name", "product-link", "surface-group", "description", "no_repeat"]) {
    const variants = getFieldVariants(k);
    const hasAny = variants.some((key) => out[key] != null && String(out[key]).trim() !== "");
    if (!hasAny && newRec[k] != null && String(newRec[k]).trim() !== "") {
      out[k] = newRec[k];
    }
  }

  // Canonical array buckets – union (including alias variants from BOTH records)
  const ARRAY_FIELDS = [
    "design_groups",
    "species",
    "cut",
    "match",
    "shade",
    "colors",
    "design_collections",
    "performance_enhancements",
    "specialty_features",
  ];
  for (const key of ARRAY_FIELDS) {
    const fromOld = collectArrayFromVariants(out, key);
    const fromNew = collectArrayFromVariants(newRec, key);
    const merged = Array.from(new Set([...fromOld, ...fromNew].filter((x) => x != null && `${x}`.trim() !== "")));
    if (merged.length) out[key] = merged;
  }

  // Finish: union array of {code?, name?}
  const oldFin = normalizeFinishArray(out.finish);
  const newFin = normalizeFinishArray(newRec.finish);
  const finMerged = unionFinish(oldFin, newFin);
  if (finMerged.length) out.finish = finMerged;

  // Any other keys in newRec:
  for (const [k, v] of Object.entries(newRec)) {
    if (k === "code") continue;
    if (k in out) {
      // Try to merge types sensibly
      const existing = out[k];
      if (Array.isArray(existing) || Array.isArray(v)) {
        out[k] = unionArraysGeneric(existing, v);
      } else if (isPlainObject(existing) && isPlainObject(v)) {
        // Shallow fill – keep existing keys, add only missing keys from new
        out[k] = { ...v, ...existing };
      } else {
        // Scalar – keep existing if truthy, else take new
        if (existing == null || String(existing).trim() === "") out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }

  // Ensure canonical mirrors aliases if only alias exists
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (canonical in out) continue;
    for (const a of aliases) {
      if (a in out) {
        out[canonical] = out[a];
        break;
      }
    }
  }

  return out;
}

// ----------------------------------------------------
// Main
// ----------------------------------------------------
if (hasCheckFlag) {
  runCodeCheckAndExit();
}

// If the user only asked for a report (and not scraping), do that quickly and exit.
if (hasReportFlag && !hasMissingFlag) {
  runReportAndExit();
}

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

  // If --missing was supplied, limit to those attribute buckets only
  if (hasMissingFlag) {
    const allowAttrs = new Set();
    for (const fld of missingFields) {
      const attrs = OUTPUT_TO_ATTRS[fld];
      if (attrs && attrs.size) attrs.forEach((a) => allowAttrs.add(a));
      else logStep(`Note: field \"${fld}\" does not map to a browseable filter; skipping.`);
    }
    filters = filters.filter((f) => allowAttrs.has(f.attr));
    logStep(`--missing active → limiting to ${filters.length} matching filter options.`);
  }

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

    let skippedMissingCode = 0;
    const missingSamples = [];

    for (const it of items) {
      const href = it.href;
      let code = codeFromHref(href);
      if (!code && it.sku) code = extractCodeCandidate(it.sku);
      if (!code && it.codeText) code = extractCodeCandidate(it.codeText);
      if (!code) {
        skippedMissingCode++;
        if (missingSamples.length < 5) {
          const hint = it.codeText || it.sku || href;
          missingSamples.push(typeof hint === "string" ? hint : String(hint || "?"));
        }
        continue;
      }

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

    if (skippedMissingCode) {
      const sampleText = missingSamples.length
        ? ` (examples: ${missingSamples.join(", ")})`
        : "";
      logStep(
        `Warning: skipped ${skippedMissingCode} tiles that lacked detectable codes while processing "${label}"${sampleText}.`
      );
    }

    const signature = items
      .slice(0, 8)
      .map((it) => it.href || it.sku || it.codeText || "")
      .join("||");

    return { newCodes, updatedCodes, count: items.length, signature };
  }

  async function applyFilterAndCollect(filter, index, total) {
    const url = sanitizeFilterUrl(filter.href);
    const bucket = ATTR_TO_OUTPUT[filter.attr];

    logStep(
      `\n[${index + 1}/${total}] Applying filter → attr="${filter.attr}" label="${filter.label}"`
    );
    logStep(`Navigate to: ${url}`);
    const baseUrl = new URL(url, START_URL);
    baseUrl.searchParams.delete("p");
    baseUrl.searchParams.set("product_list_mode", "list");
    await page.goto(baseUrl.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#product-grid-view", { timeout: 60000 }).catch(() => {});
    await waitForSettled(page, { needFilters: false });

    if (!bucket) {
      logStep(`Attribute "${filter.attr}" not mapped → skipping assignment bucket.`);
      return;
    }

    const label = cleanText(filter.label);
    let pageNo = 1;
    let grandNew = 0;
    let grandUpd = 0;
    let grandSeen = 0;
    const seenSignatures = new Set();

    while (true) {
      logStep(`Filter "${label}" — Page ${pageNo}: collecting…`);
      const { newCodes, updatedCodes, count, signature } = await extractGridAndAssign(
        bucket,
        label
      );

      if (signature) {
        if (seenSignatures.has(signature)) {
          logStep(
            `Pagination warning: page signature repeated on page ${pageNo}; assuming end of results.`
          );
          break;
        }
        seenSignatures.add(signature);
      }

      if (!count) {
        logStep(`Filter "${label}" — Page ${pageNo}: no tiles detected; stopping pagination.`);
        break;
      }

      logStep(
        `Filter "${label}" — Page ${pageNo}: tiles=${count}, new=${newCodes}, updated=${updatedCodes}`
      );
      grandNew += newCodes;
      grandUpd += updatedCodes;
      grandSeen += count;

      const nextExists = await hasNextPage(page);
      if (!nextExists) {
        logStep(
          `Filter "${label}" — Pagination: no next after page ${pageNo}; done with this filter.`
        );
        break;
      }
      pageNo++;
      const nextUrl = new URL(baseUrl.toString());
      nextUrl.searchParams.set("p", String(pageNo));
      logStep(`Filter "${label}" — Navigate to page ${pageNo}: ${nextUrl.toString()}`);
      await page.goto(nextUrl.toString(), { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#product-grid-view", { timeout: 60000 }).catch(() => {});
      await waitForSettled(page, { needFilters: false });
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
  if (!filters.length) {
    logStep("No matching filters found to scrape (check --missing fields). Exiting.");
    await browser.close();
    // If user also asked for a report, run it against whatever file exists.
    if (hasReportFlag) runReportAndExit();
    process.exit(0);
  }

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

  // Optional report after scraping
  if (hasReportFlag) {
    try {
      const arr = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
      doReport(arr, reportFields.length ? reportFields : ["finish"]);
    } catch (e) {
      console.error("Post-scrape report failed:", e && e.message ? e.message : e);
    }
  }

  logStep("All done. Closing browser.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// wilsonart-scrapeTFL.js
// Usage:
//   node wilsonart-scrapeTFL.js
//   FILTER_LIMIT=6 node wilsonart-scrapeTFL.js
