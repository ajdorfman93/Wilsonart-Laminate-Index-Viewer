// wilsonart-fetch-details.js
// 
//      node wilsonart-fetch-details.js --offset=26 --limit=1
//   node wilsonart-fetch-details.js  --offset=22 --limit=1 --batch=1 --headless=true --max-attempts=5
//
// --missing 
//   Scrape only products missing the specified field (default: texture_image_url).
//   Example: node wilsonart-fetch-details.js --missing texture_image_url
//
// --remaining
//   Scrape only products missing from wilsonart-laminate-details.json
//   Example: --remaining
//
// --update
//   Update wilsonart-laminate-details.json in place with any data found in wilsonart-laminate-index.json but missing from wilsonart-laminate-details.json
//
// --report
//   Generate a report of all products missing the specified field (default: texture_image_url).
//   Example: --report texture_image_url
//
// List of possible headers or data contained in wilsonart-laminate-details.json that can be used with --missing or --report:
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


const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// -------------------- Paths --------------------
const INDEX_JSON = path.resolve(process.cwd(), "wilsonart-laminate-index.json");
const OUT_JSON   = path.resolve(process.cwd(), "wilsonart-laminate-details.json");

// -- CLI helpers (accept both "--name value" and "--name=value") --
function getArgPair(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return { present: true, value: eq.split("=")[1] };
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return { present: true, value: next };
    return { present: true, value: undefined };
  }
  return { present: false, value: undefined };
}

// read flags/values
const { present: FLAG_MISSING,  value: MISSING_VALUE } = getArgPair("missing");
const { present: FLAG_REMAINING } = getArgPair("remaining");
const { present: FLAG_UPDATE }    = getArgPair("update");
const { present: FLAG_REPORT,   value: REPORT_VALUE }  = getArgPair("report");

const LIMIT = parseInt(
  process.env.LIMIT ??
  (process.argv.find(a => a.startsWith("--limit=")) || "").split("=")[1] ??
  "0", 10
);
const OFFSET = parseInt(
  process.env.OFFSET ??
  (process.argv.find(a => a.startsWith("--offset=")) || "").split("=")[1] ??
  "0", 10
);
const BATCH_SIZE = parseInt(
  process.env.BATCH ??
  (process.argv.find(a => a.startsWith("--batch=")) || "").split("=")[1] ??
  "5", 10
);
const HEADLESS = (process.env.HEADLESS ?? "true") !== "true";

// How many times to retry scraping a product before giving up
const MAX_FETCH_ATTEMPTS = parseInt(
  process.env.MAX_FETCH_ATTEMPTS ??
  (process.argv.find(a => a.startsWith("--max-attempts=")) || "").split("=")[1] ??
  "3",
  10
);


const MISSING_FIELD = FLAG_MISSING ? (MISSING_VALUE || "texture_image_url") : undefined;
const REPORT_FIELD  = FLAG_REPORT  ? (REPORT_VALUE  || "texture_image_url") : undefined;

// -------------------- Logging / Utils --------------------
function logStep(msg, extra) {
  const ts = new Date().toISOString();
  if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra);
  else console.log(`[${ts}] ${msg}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SHEET_SIZE_ALLOWED_RE = /^\d+' x \d+'$/;

function collectValidSheetSizes(values) {
  const seenValid = new Set();
  const invalid = [];
  const valid = [];
  if (!Array.isArray(values)) return { valid, invalid };
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i];
    if (typeof raw !== "string") continue;
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    if (!SHEET_SIZE_ALLOWED_RE.test(normalized)) {
      if (!invalid.includes(normalized)) invalid.push(normalized);
      continue;
    }
    if (seenValid.has(normalized)) continue;
    seenValid.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid };
}

const SHEET_SIZE_PARSE_RE = /^(\d+)' x (\d+)'$/;

function parseSheetSizeLabel(label) {
  if (typeof label !== "string") return undefined;
  const match = SHEET_SIZE_PARSE_RE.exec(label.trim());
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return undefined;
  const longFeet = Math.max(a, b);
  const shortFeet = Math.min(a, b);
  const inchesScale = orientMaxAsWidth({ width: longFeet * 12, height: shortFeet * 12 });
  const ratio = ratioOf(inchesScale);
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    width: round2(inchesScale.width),
    height: round2(inchesScale.height),
    ratio: +ratio.toFixed(4),
    label
  };
}

function parseSheetSizes(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const parsed = [];
  for (let i = 0; i < values.length; i += 1) {
    const parsedScale = parseSheetSizeLabel(values[i]);
    if (!parsedScale) continue;
    const key = `${parsedScale.width}x${parsedScale.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(parsedScale);
  }
  return parsed;
}

function validSize(obj) { return !!obj && isFinite(obj.width) && isFinite(obj.height) && obj.width > 0 && obj.height > 0; }
function ratioOf(obj)   { return validSize(obj) ? (obj.width / obj.height) : undefined; }
function scaleRatio(obj) {
  if (!obj) return undefined;
  if (Number.isFinite(obj.ratio) && obj.ratio > 0) return Number(obj.ratio);
  return ratioOf(obj);
}
function enforceScaleMatchesPixels(scale, pixels) {
  if (!validSize(scale) || !validSize(pixels)) return scale;
  const Rimg = ratioOf(pixels);
  const Rscale = ratioOf(scale);
  if (!isFinite(Rimg) || Rimg <= 0) return scale;
  if (isFinite(Rscale) && approxEq(Rscale, Rimg, 1e-3)) return scale;
  const round2 = (n) => Math.round(n * 100) / 100;
  const primary = Math.max(scale.width, scale.height);
  if (!isFinite(primary) || primary <= 0) return scale;
  let adjusted;
  if (Rimg >= 1) {
    adjusted = { width: round2(primary), height: round2(primary / Rimg) };
  } else {
    adjusted = { width: round2(primary * Rimg), height: round2(primary) };
  }
  if (!validSize(adjusted) || !approxEq(ratioOf(adjusted), Rimg, 1e-3)) {
    const width = scale.width;
    const height = scale.height;
    if (isFinite(width) && width > 0) {
      adjusted = { width: round2(width), height: round2(width / Rimg) };
    } else if (isFinite(height) && height > 0) {
      adjusted = { width: round2(height * Rimg), height: round2(height) };
    }
  }
  if (!validSize(adjusted) || !approxEq(ratioOf(adjusted), Rimg, 1e-3)) return scale;
  logStep(`  Ratio align: adjusted to ${adjusted.width}"x${adjusted.height}" for pixels ${pixels.width}x${pixels.height}`);
  return adjusted;
}
function approxEq(a, b, tol = 0.02) {
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= tol;
}
function orientMaxAsWidth(s) {
  if (!validSize(s)) return s;
  return (s.width >= s.height) ? { width: +s.width, height: +s.height } : { width: +s.height, height: +s.width };
}
const hasString = (v) => typeof v === "string" && v.trim().length > 0;

function isEmptyField(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === "string") return val.trim().length === 0;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === "object") return Object.keys(val).length === 0;
  return false;
}

async function ensureFeaturesExpanded(page) {
  if (!page) return;
  const selectors = [
    'a.custom_btn[href="#pa_features"]',
    'a[href="#pa_features"]',
    'button[href="#pa_features"]',
    '[data-target="#pa_features"]'
  ];

  for (let s = 0; s < selectors.length; s += 1) {
    const selector = selectors[s];
    let handle = null;
    try {
      handle = await page.$(selector);
    } catch {
      handle = null;
    }
    if (!handle) continue;

    try {
      await page.evaluate((el) => {
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", behavior: "instant" });
        }
      }, handle);
    } catch {
      // ignore scroll failures
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let expanded = false;
      try {
        expanded = await page.evaluate((el) => {
          if (!el) return false;
          const href = el.getAttribute("href") || el.getAttribute("data-target") || "";
          const target = href && href.startsWith("#") ? document.querySelector(href) : null;
          const ariaExpanded = el.getAttribute("aria-expanded");
          if (ariaExpanded === "true") return true;
          if (target) {
            const hidden = target.getAttribute("aria-hidden") === "true";
            const collapsed = target.classList.contains("collapsed");
            if (!hidden && !collapsed && target.offsetHeight > 0) return true;
          }
          return false;
        }, handle);
      } catch {
        expanded = false;
      }

      if (expanded) {
        let hasSizes = false;
        try {
          hasSizes = await page.evaluate(
            () => document.querySelectorAll(".size_group span").length > 0
          );
        } catch {
          hasSizes = false;
        }
        if (hasSizes) {
          return;
        }
      }

      try {
        await handle.click({ delay: 20 });
      } catch {
        try {
          await page.evaluate((el) => {
            if (!el) return;
            if (typeof el.click === "function") el.click();
            else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }, handle);
        } catch {
          // ignore click failure, try next selector
        }
      }

      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(500);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      let hasSizesAfterClick = false;
      try {
        hasSizesAfterClick = await page.evaluate(
          () => document.querySelectorAll(".size_group span").length > 0
        );
      } catch {
        hasSizesAfterClick = false;
      }
      if (hasSizesAfterClick) return;
    }
  }
}

async function fetchSheetSizesFromApi(page, code, surfaceGroup) {
  if (!code) return { valid: [], invalid: [] };
  const base = "https://www.wilsonart.com/ProductPatterns/productpatterns/padata/";
  const params = new URLSearchParams();
  const normalizedGroup = typeof surfaceGroup === "string" ? surfaceGroup.trim() : "";
  let attrSetTitle = "Wilsonart Laminate";
  if (normalizedGroup) {
    if (/wilsonart/i.test(normalizedGroup)) attrSetTitle = normalizedGroup;
    else attrSetTitle = `Wilsonart ${normalizedGroup}`.trim();
  }
  params.set("attrSetTitle", attrSetTitle);
  params.set("product_sku", code);
  params.set("current_category", "Design Library");

  try {
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const markup = data && typeof data.output === "string" ? data.output : "";
    if (!markup) return { valid: [], invalid: [] };

    const parsed = await page.evaluate((html) => {
      const temp = document.createElement("div");
      temp.innerHTML = html;
      const spans = temp.querySelectorAll(".size_group span");
      const values = [];
      spans.forEach((node) => {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text) values.push(text);
      });
      return values;
    }, markup);

    const collected = collectValidSheetSizes(Array.isArray(parsed) ? parsed : []);
    return collected;
  } catch (err) {
    logStep(`  • Sheet sizes fetch error: ${err && err.message ? err.message : err}`);
    return { valid: [], invalid: [] };
  }
}

async function extractSheetSizes(page, code, surfaceGroup) {
  try {
    await ensureFeaturesExpanded(page);
    await page.waitForSelector(".size_group", { timeout: 2000 }).catch(() => {});
    await page
      .waitForFunction(
        () => document.querySelectorAll(".size_group span").length > 0,
        { timeout: 3500 }
      )
      .catch(() => {});
    const sizes = await page.$$eval(".size_group span", (nodes) => {
      const out = [];
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node) continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text) out.push(text);
      }
      return out;
    });
    const { valid: pageValid, invalid: pageInvalid } = collectValidSheetSizes(sizes);

    if (pageValid.length) {
      logStep(`  • Sheet sizes found: ${pageValid.join(", ")}`);
      return pageValid;
    }

    if (Array.isArray(sizes) && sizes.length === 0) {
      logStep("  • Sheet sizes found: none");
      const preview = await page.evaluate(() => {
        const section = document.querySelector("#pa_features");
        if (!section) return null;
        const text = section.textContent || "";
        return text.replace(/\s+/g, " ").trim().slice(0, 160);
      }).catch(() => null);
      if (preview) logStep(`  • #pa_features preview: ${preview}`);
    } else if (pageInvalid.length) {
      logStep(`  • Sheet sizes discarded (invalid format): ${pageInvalid.join(", ")}`);
    } else {
      logStep("  • Sheet sizes found: none");
    }

    const { valid: apiValid = [], invalid: apiInvalid = [] } = await fetchSheetSizesFromApi(page, code, surfaceGroup);
    if (apiValid.length) {
      logStep(`  • Sheet sizes fetched via API: ${apiValid.join(", ")}`);
      return apiValid;
    }
    if (apiInvalid.length) {
      logStep(`  • API sheet sizes discarded (invalid format): ${apiInvalid.join(", ")}`);
    }
    return [];
  } catch {
    return [];
  }
}

const FEET_SIZE_TOKEN_RE = /(^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*[xX\u00D7]\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9])/;

// Prefer width token "5x12" → inches (width = max*12)
function parseUrlFeetSize(url) {
  if (!url) return undefined;
  const m = url.match(FEET_SIZE_TOKEN_RE);
  if (!m) return undefined;
  const a = parseFloat(m[2]); const b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return undefined;
  return orientMaxAsWidth({ width: Math.max(a, b) * 12, height: Math.min(a, b) * 12 });
}

function extractUrlFeetToken(url) {
  if (!url) return undefined;
  const m = url.match(FEET_SIZE_TOKEN_RE);
  if (!m) return undefined;
  const a = parseFloat(m[2]); const b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return undefined;
  const short = Math.min(a, b);
  const long = Math.max(a, b);
  return `${short}x${long}`;
}

const ALLOWED_TEXTURE_HOSTS = [
  "assetlibrary.wilsonart.com",
  "images.wilsonart.com"
];
const FORBIDDEN_TEXTURE_SUBSTRINGS = [
  "webfullsheet",
  "mightalsolike",
  "hero",
  "thumbnail",
  "io=transform"
];

function getHostname(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedTextureHost(url) {
  const host = getHostname(url);
  return host && ALLOWED_TEXTURE_HOSTS.includes(host);
}

// -------------------- URL helpers --------------------
const looksBanner      = (u) => !!u && /banner/i.test(u);

// HTML scanners
async function findUrlsMatching(page, re) {
  const matches = await page.evaluate((pattern) => {
    const html = document.documentElement.innerHTML;
    const rx = new RegExp(pattern, "gi");
    const arr = html.match(rx) || [];
    return Array.from(new Set(arr.map(u => u.replace(/&amp;/g, "&"))));
  }, re.source).catch(() => []);
  return matches || [];
}
async function findFullSheetUrlsInHTML(page) {
  return await findUrlsMatching(page, /https?:\/\/[^\s"'<>\)]*FullSheet[^\s"'<>\)]*/g);
}
async function findFullSizeUrlsInHTML(page) {
  return await findUrlsMatching(page, /https?:\/\/[^\s"'<>\)]*full_size[^\s"'<>\)]*/g);
}
async function findBannerUrlsInHTML(page) {
  return await findUrlsMatching(page, /https?:\/\/[^\s"'<>\)]*banner[^\s"'<>\)]*/g);
}
async function findAssetLibraryUrlsInHTML(page) {
  return await findUrlsMatching(page, /https?:\/\/assetlibrary\.wilsonart\.com[^\s"'<>\)]*/g);
}

function hasSizeToken(url) {
  if (!url) return false;
  return FEET_SIZE_TOKEN_RE.test(url);
}

function isForbiddenTextureUrl(url, options = {}) {
  if (!url) return true;
  const lower = url.toLowerCase();

  if (lower.includes("carousel")) {
    const isMain = /carousel_main/.test(lower);
    const isThumbnail = /thumbnail/.test(lower);
    const allowMain = options.allowCarouselMain && isMain && !isThumbnail;
    if (!allowMain) return true;
  }

  return FORBIDDEN_TEXTURE_SUBSTRINGS.some(token => lower.includes(token));
}

const hasFullSizeViewToken = (url) => /fullsizeview|full_size_view/i.test(url || "");

function isValidTextureUrl(url, tokens = [], options = {}) {
  if (!url) return false;
  const lower = url.toLowerCase();
  const host = getHostname(url);
  if (!isAllowedTextureHost(url)) return false;
  if (isForbiddenTextureUrl(url, options)) return false;

  const hasBannerKeyword = /banner/i.test(url);
  const hasFullSizeView = hasFullSizeViewToken(url);
  const hasFullSheetToken = /FullSheet/.test(url);
  const hasSizeTokenMatch = hasSizeToken(url);
  const hasProductToken = tokens.some(token => token && lower.includes(token));

  if (host === "images.wilsonart.com") {
    if (!(hasFullSizeView && hasProductToken)) return false;
  }

  return hasBannerKeyword || hasFullSizeView || hasSizeTokenMatch || hasProductToken || hasFullSheetToken;
}

function computeTextureUrlScore(url, tokens = []) {
  let score = 1;
  const lower = url.toLowerCase();

  if (/banner/i.test(url)) score += 10;
  if (hasFullSizeViewToken(url)) score += 8;
  if (hasSizeToken(url)) score += 6;
  tokens.forEach((token, idx) => {
    if (!token || !lower.includes(token)) return;
    score += Math.max(4 - idx, 1);
  });
  if (/150dpi/i.test(url)) score += 1;
  if (/fullsheet/i.test(lower)) score += 1;
  return score;
}

function normalizeProductTokens(code, productLink) {
  const tokens = [];
  const push = (value) => {
    if (!value) return;
    const lower = value.toLowerCase();
    if (lower && !tokens.includes(lower)) tokens.push(lower);
  };
  if (code) {
    const raw = String(code).trim();
    if (raw) {
      push(raw);
      const compact = raw.replace(/[^A-Za-z0-9]/g, "");
      if (compact && compact !== raw) push(compact);
    }
  }
  if (productLink) {
    const slug = String(productLink).split("/").filter(Boolean).pop() || "";
    if (slug) {
      push(slug);
      const compact = slug.replace(/[^A-Za-z0-9]/g, "");
      if (compact && compact !== slug) push(compact);
    }
  }
  return tokens;
}

function listBannerCandidates(page) {
  const seen = new Set();
  const out = [];
  const candidates = page.__bannerCandidates instanceof Set ? Array.from(page.__bannerCandidates) : [];
  for (const url of candidates) {
    if (!seen.has(url)) { out.push(url); seen.add(url); }
  }
  if (page.__bannerOverrideUrl && !seen.has(page.__bannerOverrideUrl)) {
    out.unshift(page.__bannerOverrideUrl);
  }
  return out;
}

async function resolveTextureImageUrl(page, code, productLink, tokens, options = {}) {
  const searchTokens = Array.isArray(tokens) && tokens.length ? tokens : normalizeProductTokens(code, productLink);
  const combined = new Set();
  const addAll = (arr = []) => {
    for (const item of arr) {
      if (typeof item === "string" && item.trim()) {
        combined.add(item.trim());
      }
    }
  };

  addAll(listBannerCandidates(page));
  addAll(await findFullSheetUrlsInHTML(page));
  addAll(await findFullSizeUrlsInHTML(page));
  addAll(await findAssetLibraryUrlsInHTML(page));

  const allCandidates = [...combined];
  const validCandidates = allCandidates.filter(url => isValidTextureUrl(url, searchTokens, options));
  if (!validCandidates.length) {
    if (allCandidates.length) {
      const forbiddenSample = allCandidates.find(url => isForbiddenTextureUrl(url, options));
      const sample = forbiddenSample || allCandidates[0];
      logStep(`[${code}] Skipping texture image candidate`, sample);
    }
    return null;
  }

  const scored = validCandidates.map(url => ({
    url,
    score: computeTextureUrlScore(url, searchTokens)
  }));
  scored.sort((A, B) => (B.score - A.score) || (B.url.length - A.url.length));
  return scored[0].url;
}

// -------------------- Selectors --------------------
const XPATH_ARROW =
  "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[4]";
const SECOND_IMAGE_XPATHS = [
  '//*[@id="maincontent"]/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[3]/div[1]',
  '//*[@id="maincontent"]//div[contains(@class,"fotorama__nav__frame")][2]'
];
const LAST_RESORT_XPATHS = [
  "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[3]/div",
  "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[3]/div[1]"
];

const SEL_NO_REPEAT_B =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div > div.qkView_description > div:nth-child(7) > ul > li > p > b";
const SEL_REPEAT_BOLD =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div > div.qkView_description > ul > li > p > b";
const SEL_DESC_P2 =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div.wa_product_title > div.qkView_description > p:nth-child(2)";

// -------------------- Wait helpers --------------------
async function waitForMain(page) {
  logStep("  • waitForSettled: waiting for document ready");
  try { await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 }); } catch {}
  try { await page.waitForSelector("#maincontent", { timeout: 30000 }); } catch {}
  await sleep(150);
  await afterStepCheckForBanner(page); // <— NEW: check after step
  logStep("  • waitForSettled: done");
}
async function waitForXPathPresence(page, xpath, timeout = 8000, poll = 150) {
  return page
    .waitForFunction(
      (xp) => !!document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
      { timeout, polling: poll }, xpath
    )
    .then(() => true)
    .catch(() => false);
}

// -------------------- After-step banner hook --------------------
/**
 * Stores the last banner URL (if any) in page.__bannerOverrideUrl
 * We run this after every “step”: goto, waits, clicks, etc.
 */
async function afterStepCheckForBanner(page) {
  try {
    const banners = await findBannerUrlsInHTML(page);
    if (banners && banners.length) {
      if (!(page.__bannerCandidates instanceof Set)) {
        page.__bannerCandidates = new Set();
      }
      let newCount = 0;
      for (const url of banners) {
        if (!page.__bannerCandidates.has(url)) {
          page.__bannerCandidates.add(url);
          newCount++;
        }
      }
      if (!page.__bannerOverrideUrl && banners[0]) {
        page.__bannerOverrideUrl = banners[0];
      }
      if (newCount) {
        const sample = banners[0];
        logStep(`  [banner] captured ${newCount} candidate${newCount > 1 ? "s" : ""}${sample ? ` (e.g. ${sample})` : ""}`);
      }
    }
  } catch {}
}

// Robust click using element center coords; tries inner .fotorama__arr__arr too
async function robustClickXPath(page, xpath, label, options = {}) {
  logStep(`  • Waiting for ${label}…`);
  const waitTimeout = ("waitTimeout" in options) ? options.waitTimeout : 10000;
  const waitPolling = ("waitPolling" in options) ? options.waitPolling : 150;
  const present = await waitForXPathPresence(page, xpath, waitTimeout, waitPolling);
  if (!present) { logStep(`  • ${label}: not found`); return false; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    logStep(`  • ${label}: click attempt ${attempt}…`);
    const coords = await page.evaluate((xp) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const inner = el.querySelector(".fotorama__arr__arr");
      const ri = inner ? inner.getBoundingClientRect() : null;
      return {
        main: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
        inner: ri ? { x: ri.left + window.scrollX, y: ri.top + window.scrollY, w: ri.width, h: ri.height } : null
      };
    }, xpath).catch(() => null);

    // 1) Mouse click inner arrow if present
    if (coords?.inner && coords.inner.w > 0 && coords.inner.h > 0) {
      const cx = Math.round(coords.inner.x + coords.inner.w / 2);
      const cy = Math.round(coords.inner.y + coords.inner.h / 2);
      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down(); await page.mouse.up();
        logStep(`  • ${label}: clicked inner arrow at ${cx},${cy}`);
        await sleep(1200);
        await afterStepCheckForBanner(page); // <— NEW
        return true;
      } catch (e) { logStep(`  • ${label}: inner mouse click failed: ${e.message || e}`); }
    }

    // 2) Mouse click main element center
    if (coords?.main && coords.main.w > 0 && coords.main.h > 0) {
      const cx = Math.round(coords.main.x + coords.main.w / 2);
      const cy = Math.round(coords.main.y + coords.main.h / 2);
      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down(); await page.mouse.up();
        logStep(`  • ${label}: clicked main box at ${cx},${cy}`);
        await sleep(1200);
        await afterStepCheckForBanner(page); // <— NEW
        return true;
      } catch (e) { logStep(`  • ${label}: main mouse click failed: ${e.message || e}`); }
    }

    // 3) JS click fallback
    const ok = await page.evaluate((xp) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return false;
      const inner = el.querySelector(".fotorama__arr__arr");
      if (inner && inner.click) { inner.click(); return true; }
      if (el.click) { el.click(); return true; }
      const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      return el.dispatchEvent(evt);
    }, xpath).catch(() => false);

    if (ok) {
      logStep(`  • ${label}: JS click dispatched`);
      await sleep(1200);
      await afterStepCheckForBanner(page); // <— NEW
      return true;
    }
    await sleep(200);
  }

  logStep(`  • ${label}: all click attempts failed`);
  return false;
}

async function clickSecondCarouselImage(page, attemptLabel = "") {
  let frameCount = 0;
  try {
    frameCount = await page.evaluate(() => {
      const frames = document.querySelectorAll("#maincontent .fotorama__nav__frame");
      return frames ? frames.length : 0;
    });
  } catch {}

  if (frameCount < 2) {
    logStep(`  • Second carousel image unavailable (${frameCount} frame${frameCount === 1 ? "" : "s"})`);
    return false;
  }

  const suffix = attemptLabel ? ` (${attemptLabel})` : "";
  for (let idx = 0; idx < SECOND_IMAGE_XPATHS.length; idx++) {
    const xpath = SECOND_IMAGE_XPATHS[idx];
    const label = `Carousel Thumb #2${suffix} [${idx + 1}]`;
    const clicked = await robustClickXPath(page, xpath, label, { waitTimeout: 6000, waitPolling: 200 });
    if (clicked) return true;
  }

  logStep(`  • Second carousel image click attempts failed${suffix}`);
  return false;
}

async function clickLastResortTextureTrigger(page, xpath, idx) {
  const suffix = LAST_RESORT_XPATHS.length > 1 ? ` [${idx + 1}]` : "";
  return robustClickXPath(page, xpath, `Last-resort texture trigger${suffix}`, { waitTimeout: 6000, waitPolling: 200 });
}

async function attemptLastResortClicks(page, code, productLink, productTokens, { reload = false, stage = "Last-resort" } = {}) {
  try {
    if (reload) {
      page.__bannerOverrideUrl = null;
      page.__bannerCandidates = new Set();
      logStep(`[${code}] Reloading product page before last-resort clicks`);
      await page.goto(productLink, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await waitForMain(page);
    } else {
      logStep(`[${code}] ${stage} last-resort attempt (no reload)`);
    }

    await afterStepCheckForBanner(page);

    let chosenUrl = null;
    let attempted = false;
    for (let idx = 0; idx < LAST_RESORT_XPATHS.length; idx += 1) {
      const xpath = LAST_RESORT_XPATHS[idx];
      attempted = true;
      const lastResortClick = await clickLastResortTextureTrigger(page, xpath, idx);
      if (!lastResortClick) continue;
      await afterStepCheckForBanner(page);
      chosenUrl = await resolveTextureImageUrl(page, code, productLink, productTokens);
      if (chosenUrl) return { chosenUrl, attempted: true };
    }

    if (attempted) {
      await afterStepCheckForBanner(page);
      const sweepLabel = reload ? "(post-reload)" : "(initial pass)";
      logStep(`[${code}] Last-resort HTML sweep ${sweepLabel}`);
      chosenUrl = await resolveTextureImageUrl(page, code, productLink, productTokens);
      if (chosenUrl) return { chosenUrl, attempted: true };
    }

    return { chosenUrl: null, attempted };
  } catch (err) {
    logStep(`[${code}] ${stage} last-resort error: ${err.message || err}`);
    return { chosenUrl: null, attempted: false };
  }
}

// -------------------- Metadata extractors --------------------
async function detectNoRepeat(page) {
  logStep("  • Checking 'No Repeat'…");
  const exact = await page.$eval(SEL_NO_REPEAT_B, el => (el.textContent || "").trim().toLowerCase()).catch(() => null);
  if (exact && exact.includes("no repeat")) { logStep("  • No Repeat? YES"); return true; }
  const list = await page.$$eval(".qkView_description b", ns => ns.map(n => (n.textContent || "").trim().toLowerCase())).catch(() => []);
  const found = list.some(t => t.includes("no repeat"));
  logStep(`  • No Repeat? ${found ? "YES (fallback)" : "NO"}`);
  return found;
}
async function extractDescription(page) {
  const exact = await page.$eval(SEL_DESC_P2, el => (el.textContent || "").trim()).catch(() => null);
  if (exact) return exact;
  const list = await page.$$eval(".qkView_description p", ps => ps.map(p => (p.textContent || "").trim())).catch(() => []);
  return (list[1] || list[0] || undefined);
}

// ------------------ Image pixels & banner crop ------------------
async function getImagePixels(page, url, timeoutMs = 15000) {
  if (!url) return undefined;
  try {
    const res = await page.evaluate(async (src, timeout) => {
      return await new Promise((resolve) => {
        try {
          const img = new Image();
          let done = false;
          const finish = (val) => { if (!done) { done = true; resolve(val); } };
          const t = setTimeout(() => finish(undefined), timeout);
          img.onload = () => { clearTimeout(t); finish({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 }); };
          img.onerror = () => { clearTimeout(t); finish(undefined); };
          img.src = src;
        } catch { resolve(undefined); }
      });
    }, url, timeoutMs);
    return (res && (res.width > 0 || res.height > 0)) ? res : undefined;
  } catch { return undefined; }
}
function applyBannerCrop(url, pixels) {
  if (!validSize(pixels)) return pixels;
  if (!looksBanner(url)) return pixels;
  const croppedHeight = Math.max(1, Math.round(pixels.height - 93));
  if (croppedHeight !== pixels.height) {
    logStep(`  • Banner detected → cropping 93px: ${pixels.width}×${pixels.height} → ${pixels.width}×${croppedHeight}`);
  }
  return { width: Math.round(pixels.width), height: croppedHeight };
}

// -------------------- Scale decision --------------------
function chooseFinalScale({ imageUrl, pixels, currentScale, parsedScale, noRepeat, existingNoRepeatScale, sheetSizeScales }) {
  const urlToken = extractUrlFeetToken(imageUrl || "");
  const urlScale = orientMaxAsWidth(parseUrlFeetSize(imageUrl || "") || {});
  const normalizedCurrent = orientMaxAsWidth(currentScale || {});
  const normalizedParsed = orientMaxAsWidth(parsedScale || {});

  const incomingNoRepeat = (existingNoRepeatScale && validSize(existingNoRepeatScale))
    ? { width: +existingNoRepeatScale.width, height: +existingNoRepeatScale.height }
    : undefined;

  const hasUrlSize = validSize(urlScale);
  const hasCurrent = validSize(normalizedCurrent);
  const hasParsed = validSize(normalizedParsed);

  const sheetOptions = Array.isArray(sheetSizeScales)
    ? sheetSizeScales.filter((opt) => validSize(opt))
    : [];
  const hasSheetOptions = sheetOptions.length > 0;

  const pixelRatio = ratioOf(pixels);
  const pixelRatioValid = isFinite(pixelRatio) && pixelRatio > 0;
  const ratioMatches = (target, tol = 0.05) => pixelRatioValid && approxEq(pixelRatio, target, tol);
  const round2 = (n) => Math.round(n * 100) / 100;

  let noRepeatScale = undefined;
  if (incomingNoRepeat) {
    noRepeatScale = { width: round2(incomingNoRepeat.width), height: round2(incomingNoRepeat.height) };
  } else if (noRepeat && pixelRatioValid) {
    noRepeatScale = { width: 60, height: round2(60 / pixelRatio) };
  }

  const noRepeatRatio = scaleRatio(noRepeatScale);
  const FOUR_BY_EIGHT_RATIO = 96 / 48;
  const FIVE_BY_TWELVE_RATIO = 144 / 60;

  let chosen = undefined;
  const reasons = [];

  if (hasSheetOptions && pixelRatioValid) {
    let best = null;
    for (let i = 0; i < sheetOptions.length; i += 1) {
      const option = sheetOptions[i];
      const optionRatio = scaleRatio(option);
      if (!isFinite(optionRatio) || optionRatio <= 0) continue;
      const diff = Math.abs(optionRatio - pixelRatio);
      if (!best || diff < best.diff) {
        best = { scale: option, diff };
      }
    }
    if (best) {
      chosen = { width: round2(best.scale.width), height: round2(best.scale.height) };
      const label = best.scale.label || `${chosen.width}"x${chosen.height}"`;
      reasons.push(`Pixels ratio ~${label}`);
    }
  }

  if (!chosen && !hasSheetOptions && ratioMatches(FOUR_BY_EIGHT_RATIO)) {
    chosen = { width: 96, height: 48 };
    reasons.push('Pixels ratio ~4x8');
  } else if (!chosen && !hasSheetOptions && ratioMatches(FIVE_BY_TWELVE_RATIO)) {
    chosen = { width: 144, height: 60 };
    reasons.push('Pixels ratio ~5x12');
  }

  if (!chosen && noRepeatScale && pixelRatioValid && approxEq(noRepeatRatio, pixelRatio, 0.02)) {
    chosen = { ...noRepeatScale };
    reasons.push('No-repeat scale aligns with pixels');
  }

  if (!chosen && !noRepeatScale && !hasUrlSize && pixelRatioValid) {
    chosen = { width: 60, height: round2(60 / pixelRatio) };
    reasons.push('Pixels fallback width=60');
  }

  if (!chosen && hasUrlSize) {
    chosen = { ...urlScale };
    reasons.push(urlToken ? `URL token ${urlToken}` : 'URL scale fallback');
  }

  if (!chosen && hasParsed) {
    chosen = { ...normalizedParsed };
    reasons.push('Parsed fallback');
  }

  if (!chosen && hasCurrent) {
    chosen = { ...normalizedCurrent };
    reasons.push('Existing fallback');
  }

  if (chosen && pixelRatioValid) {
    const adjusted = enforceScaleMatchesPixels(chosen, pixels);
    if (adjusted && validSize(adjusted)) {
      if (!approxEq(ratioOf(adjusted), ratioOf(chosen), 1e-3)) {
        reasons.push('Ratio aligned');
      }
      chosen = adjusted;
    }
    chosen = pixelRatio >= 1
      ? orientMaxAsWidth(chosen)
      : { width: round2(chosen.width), height: round2(chosen.height) };
  } else if (chosen) {
    chosen = orientMaxAsWidth(chosen);
  }

  if (chosen) {
    chosen = { width: round2(chosen.width), height: round2(chosen.height) };
    logStep(`  Scale choice: ${chosen.width}"x${chosen.height}"${reasons.length ? ` [${reasons.join('; ')}]` : ""}`);
  } else {
    logStep("  Scale choice: undefined (no valid scale information)");
  }

  const finalNoRepeat = noRepeatScale
    ? { width: round2(noRepeatScale.width), height: round2(noRepeatScale.height) }
    : undefined;

  return { scale: chosen, reason: reasons.join("; "), noRepeatScale: finalNoRepeat };
}

async function computeParsedScale(page, isNoRepeat, imageUrl) {
  const urlFeet = parseUrlFeetSize(imageUrl || "");
  if (validSize(urlFeet)) { logStep(`  Parsed scale (URL feet->inches): ${urlFeet.width}"x${urlFeet.height}"`); return orientMaxAsWidth(urlFeet); }
  if (isNoRepeat)         { logStep('  Parsed scale (No Repeat default): 96"x48"'); return { width: 96, height: 48 }; }
  const bold = await page?.$eval?.(SEL_REPEAT_BOLD, el => (el.textContent || "").trim()).catch(() => null);
  if (bold) {
    const m = bold.match(/(\d+(?:\.\d+)?)\s*"?\s*[xX\u00D7-]\s*(\d+(?:\.\d+)?)/);
    if (m) {
      const a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (isFinite(a) && isFinite(b)) {
        const s = orientMaxAsWidth({ width: a, height: b });
        logStep(`  Parsed scale (bold inches): ${s.width}"x${s.height}"`);
        return s;
      }
    }
  }
  return undefined;
}

// -------------------- IO helpers --------------------
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return []; }
}
function writeJsonPretty(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

// -------------------- Merge/update --------------------
function byCodeMap(arr) {
  const map = new Map();
  for (const row of (arr || [])) if (row && row.code) map.set(String(row.code), row);
  return map;
}
function copyMissingFields(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (k === "code") continue;
    if (!(k in dst) || isEmptyField(dst[k])) dst[k] = v;
  }
  return dst;
}
function updateDetailsInPlaceFromIndex(indexArr, detailsArr) {
  const idx = byCodeMap(indexArr);
  const out = Array.isArray(detailsArr) ? [...detailsArr] : [];
  const dmap = byCodeMap(out);

  // Update existing rows
  for (const [code, drow] of dmap.entries()) {
    const s = idx.get(code);
    if (s) copyMissingFields(drow, s);
  }
  // Add brand-new rows that were missing entirely
  for (const [code, s] of idx.entries()) {
    if (!dmap.has(code)) out.push({ code, ...s });
  }
  return out;
}

function clearCarouselTextureUrls(detailsArr) {
  const cleared = [];
  if (!Array.isArray(detailsArr)) return cleared;
  for (const row of detailsArr) {
    if (!row || typeof row !== "object") continue;
    const url = typeof row.texture_image_url === "string" ? row.texture_image_url : "";
    if (!url || !/carousel/i.test(url)) continue;
    if ("texture_image_url" in row) delete row.texture_image_url;
    if ("texture_image_pixels" in row) delete row.texture_image_pixels;
    if (row.code) cleared.push(String(row.code));
  }
  return cleared;
}

// -------------------- Filters for scraping --------------------
function filterCodesForMissingField(detailsArr, field) {
  const dmap = byCodeMap(detailsArr);
  const missing = [];
  for (const [code, row] of dmap.entries()) {
    if (!(field in row) || isEmptyField(row[field])) missing.push(code);
  }
  return { missing, present: [...dmap.keys()].filter(c => !missing.includes(c)) };
}
function codesMissingFromDetails(indexArr, detailsArr) {
  const idxCodes = new Set((indexArr || []).map(r => String(r.code)));
  const detCodes = new Set((detailsArr || []).map(r => String(r.code)));
  const missing = [...idxCodes].filter(c => !detCodes.has(c));
  return { missing, present: [...detCodes] };
}

// -------------------- Scrape one product --------------------
async function scrapeOne(page, code, productLink, existingRow = {}, indexRow = {}) {
  logStep(`[${code}] → ${productLink}`);
  const productTokens = normalizeProductTokens(code, productLink);
  page.__bannerOverrideUrl = null;
  page.__bannerCandidates = new Set();
  await page.goto(productLink, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await waitForMain(page);

  let chosenUrl = null;
  const runLastResortFirst = Boolean(MISSING_FIELD);
  if (runLastResortFirst) {
    const earlyResult = await attemptLastResortClicks(page, code, productLink, productTokens, { reload: false, stage: "Early" });
    if (earlyResult.chosenUrl) {
      chosenUrl = earlyResult.chosenUrl;
    } else if (earlyResult.attempted) {
      page.__bannerOverrideUrl = null;
      page.__bannerCandidates = new Set();
      logStep(`[${code}] Reloading product page after early last-resort attempt`);
      await page.goto(productLink, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await waitForMain(page);
    }
  }

  if (!chosenUrl) {
    for (let k = 0; k < 2; k++) {
      await robustClickXPath(page, XPATH_ARROW, "Carousel → Next");
    }
    await clickSecondCarouselImage(page, "initial");
    await afterStepCheckForBanner(page);

    chosenUrl = await resolveTextureImageUrl(page, code, productLink, productTokens);
    if (!chosenUrl) {
      const retryClick = await clickSecondCarouselImage(page, "retry");
      if (retryClick) {
        await afterStepCheckForBanner(page);
        chosenUrl = await resolveTextureImageUrl(page, code, productLink, productTokens);
      }
    }
  }

  if (!chosenUrl) {
    const finalResult = await attemptLastResortClicks(page, code, productLink, productTokens, { reload: true, stage: "Final" });
    if (finalResult.chosenUrl) {
      chosenUrl = finalResult.chosenUrl;
    }
  }

  if (chosenUrl && !isValidTextureUrl(chosenUrl, productTokens)) {
    logStep(`[${code}] Rejected candidate texture image URL`, chosenUrl);
    chosenUrl = null;
  }

  if (!chosenUrl) {
    logStep(`[${code}] ERROR: No valid texture_image_url found`);
  }

  let banner_cropped = false;
  let texture_image_pixels;
  if (chosenUrl) {
    texture_image_pixels = await getImagePixels(page, chosenUrl);
    if (looksBanner(chosenUrl)) {
      banner_cropped = true;
      texture_image_pixels = applyBannerCrop(chosenUrl, texture_image_pixels);
    }
  }

  if (texture_image_pixels) {
    const width = Number(texture_image_pixels.width);
    const height = Number(texture_image_pixels.height);
    const normalizedPixels = {
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0
    };
    if (normalizedPixels.width > 0 && normalizedPixels.height > 0) {
      normalizedPixels.ratio = +(normalizedPixels.width / normalizedPixels.height).toFixed(4);
    }
    texture_image_pixels = normalizedPixels;
  }

  const surfaceGroup = hasString(existingRow?.["surface-group"])
    ? existingRow["surface-group"]
    : (hasString(indexRow?.["surface-group"]) ? indexRow["surface-group"] : undefined);
  const sheetSizes = await extractSheetSizes(page, code, surfaceGroup);
  const sheetSizeScales = parseSheetSizes(sheetSizes);

  const no_repeat   = await detectNoRepeat(page);
  const parsedScale = await computeParsedScale(page, no_repeat, chosenUrl || "");
  const currentScale = orientMaxAsWidth(existingRow?.texture_scale || parsedScale || { width: 144, height: 60 });
  const { scale: chosenScale, noRepeatScale } = chooseFinalScale({
    imageUrl: chosenUrl, pixels: texture_image_pixels,
    currentScale, parsedScale, noRepeat: no_repeat,
    existingNoRepeatScale: existingRow?.no_repeat_texture_scale,
    sheetSizeScales
  }) || {};
  const finalScale = chosenScale || currentScale;

  const description = hasString(existingRow?.description) ? existingRow.description : (await extractDescription(page));

  // Preserve existing fields; only fill missing ones; always update texture_scale to final decision
  const out = { ...(existingRow || {}), code };
  if (chosenUrl) out.texture_image_url = chosenUrl;
  if (texture_image_pixels) out.texture_image_pixels = texture_image_pixels;
  if (no_repeat !== undefined) out.no_repeat = !!no_repeat;
  if (hasString(description)) out.description = description;
  if (Array.isArray(sheetSizes)) out.sheet_sizes = sheetSizes;
  if (noRepeatScale) out.no_repeat_texture_scale = noRepeatScale;
  else if ("no_repeat_texture_scale" in out) delete out.no_repeat_texture_scale;
  if (banner_cropped) out.banner_cropped = true;
  out.texture_scale = finalScale; // per your rules: always overwrite

  return out;
}

// -------------------- Main --------------------
async function main() {
  const indexArr   = readJsonSafe(INDEX_JSON);
  const detailsArr = readJsonSafe(OUT_JSON);
  const clearedCarouselCodes = clearCarouselTextureUrls(detailsArr);
  if (clearedCarouselCodes.length) {
    logStep(`[precheck] Cleared carousel texture_image_url for ${clearedCarouselCodes.length} product(s)`, clearedCarouselCodes.slice(0, 5));
  }

  // Handle --report early
  if (FLAG_REPORT) {
    const field = REPORT_FIELD;
    const missing = filterCodesForMissingField(detailsArr, field).missing;
    if (!missing.length) {
      console.log(`[report] No products missing "${field}".`);
    } else {
      console.log(`[report] Missing "${field}" (${missing.length}):`);
      for (const c of missing) console.log(c);
    }
    return;
  }

  // Handle --update early (in place, no scraping)
  if (FLAG_UPDATE) {
    const updated = updateDetailsInPlaceFromIndex(indexArr, detailsArr);
    writeJsonPretty(OUT_JSON, updated);
    console.log(`[update] Updated ${path.basename(OUT_JSON)} with missing fields from ${path.basename(INDEX_JSON)}.`);
    return;
  }

  // Determine codes to process
  let codesToProcess = indexArr.map(r => String(r.code));

  // --remaining: only codes missing entirely from details
  if (FLAG_REMAINING) {
    const { missing } = codesMissingFromDetails(indexArr, detailsArr);
    codesToProcess = missing;
  }

  // --missing=<field>: intersect with codes whose field is missing/empty
  if (MISSING_FIELD) {
    const { missing } = filterCodesForMissingField(detailsArr, MISSING_FIELD);
    const { missing: missingEntries } = codesMissingFromDetails(indexArr, detailsArr);
    const set = new Set(missing);
    for (const code of missingEntries) set.add(code);
    codesToProcess = codesToProcess.filter(c => set.has(c));
  }

  // Apply OFFSET/LIMIT
  if (OFFSET > 0) codesToProcess = codesToProcess.slice(OFFSET);
  if (LIMIT > 0) codesToProcess = codesToProcess.slice(0, LIMIT);

  if (!codesToProcess.length && clearedCarouselCodes.length) {
    writeJsonPretty(OUT_JSON, detailsArr);
    logStep(`[precheck] Persisted carousel clears to ${OUT_JSON}`);
  }

  console.log(`[plan] ${codesToProcess.length} code(s) to process.`);

  // Build quick lookups
  const dmap = byCodeMap(detailsArr);
  const imap = byCodeMap(indexArr);

  // Launch Puppeteer
  const browser = await puppeteer.launch({ headless: HEADLESS });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const outRows = [...detailsArr]; // start from existing
    const outMap  = byCodeMap(outRows);

    for (let i = 0; i < codesToProcess.length; i += BATCH_SIZE) {
      const batch = codesToProcess.slice(i, i + BATCH_SIZE);

      for (const code of batch) {
        const idxRow = imap.get(code);
        const link = idxRow?.["product-link"];
        if (!hasString(link)) { logStep(`[${code}] Missing product-link in index; skipping`); continue; }

        let attempts = 0, scraped = null;
        while (attempts < MAX_FETCH_ATTEMPTS && !scraped) {
          attempts++;
          try {
            scraped = await scrapeOne(page, code, link, outMap.get(code), idxRow);
          } catch (e) {
            logStep(`[${code}] attempt ${attempts} failed: ${e.message || e}`);
            await sleep(1000);
          }
        }
        if (!scraped) { logStep(`[${code}] FAILED after ${MAX_FETCH_ATTEMPTS} attempts`); continue; }

        // Merge into out map (preserve, add missing; texture_scale overwritten in scrapeOne)
        if (outMap.has(code)) {
          const merged = { ...outMap.get(code), ...scraped };
          outMap.set(code, merged);
        } else {
          outMap.set(code, { ...idxRow, ...scraped });
        }
      }

      // Flush to disk after each batch
      writeJsonPretty(OUT_JSON, [...outMap.values()]);
      logStep(`[flush] Wrote ${OUT_JSON}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("Done.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

