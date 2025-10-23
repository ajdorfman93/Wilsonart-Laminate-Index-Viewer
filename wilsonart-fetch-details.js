// wilsonart-fetch-details.js
// 
//      node wilsonart-fetch-details.js 
//
// --missing 
//   Scrape only products missing the specified field (default: texture_image_url).
//   Example: --missing texture_image_url
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
const HEADLESS = (process.env.HEADLESS ?? "false") !== "false";

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

function validSize(obj) { return !!obj && isFinite(obj.width) && isFinite(obj.height) && obj.width > 0 && obj.height > 0; }
function ratioOf(obj)   { return validSize(obj) ? (obj.width / obj.height) : undefined; }
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

// Prefer width token "5x12" → inches (width = max*12)
function parseUrlFeetSize(url) {
  if (!url) return undefined;
  const m = url.match(/(^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9])/);
  if (!m) return undefined;
  const a = parseFloat(m[2]); const b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return undefined;
  return orientMaxAsWidth({ width: Math.max(a, b) * 12, height: Math.min(a, b) * 12 });
}

// -------------------- URL helpers --------------------
const hasFullSheet     = (u) => !!u && /FullSheet/i.test(u);
const hasCarouselMain  = (u) => !!u && /Carousel_Main/i.test(u);
const looksBanner      = (u) => !!u && /banner/i.test(u);
const includesFullSize = (u) => !!u && /full_size/i.test(u);

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

function pickBestFullSheetUrl(urls) {
  if (!urls.length) return null;
  const cands = urls.filter(u => hasFullSheet(u) && !hasCarouselMain(u));
  if (!cands.length) return null;
  const scored = cands.map(u => {
    const m = u.match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
    const a = m ? parseFloat(m[1]) : 0;
    const b = m ? parseFloat(m[2]) : 0;
    const areaFeet = (isFinite(a) && isFinite(b)) ? (a * b) : 0;
    const has150dpi = /150dpi/i.test(u) ? 1 : 0;
    return { u, areaFeet, has150dpi, len: u.length };
  });
  scored.sort((A, B) => ((B.areaFeet - A.areaFeet) || (B.has150dpi - A.has150dpi) || (B.len - A.len)));
  return scored[0].u;
}
function pickBestFullSizeUrl(urls) {
  if (!urls.length) return null;
  const nonBanner = urls.filter(u => includesFullSize(u) && !looksBanner(u));
  const banner    = urls.filter(u => includesFullSize(u) && looksBanner(u));
  const pickFrom = nonBanner.length ? nonBanner : banner;
  if (!pickFrom.length) return null;
  const scored = pickFrom.map(u => {
    const m = u.match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
    const a = m ? parseFloat(m[1]) : 0;
    const b = m ? parseFloat(m[2]) : 0;
    const areaFeet = (isFinite(a) && isFinite(b)) ? (a * b) : 0;
    const has150dpi = /150dpi/i.test(u) ? 1 : 0;
    return { u, areaFeet, has150dpi, len: u.length };
  });
  scored.sort((A, B) => ((B.areaFeet - A.areaFeet) || (B.has150dpi - A.has150dpi) || (B.len - A.len)));
  return scored[0].u;
}

// -------------------- Selectors --------------------
const XPATH_ARROW =
  "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[4]";

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
      if (!page.__bannerOverrideUrl) {
        page.__bannerOverrideUrl = banners[0];
        logStep(`  • Banner URL discovered: ${page.__bannerOverrideUrl}`);
      }
    }
  } catch {}
}

// Robust click using element center coords; tries inner .fotorama__arr__arr too
async function robustClickXPath(page, xpath, label) {
  logStep(`  • Waiting for ${label}…`);
  const present = await waitForXPathPresence(page, xpath, 10000, 150);
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
function chooseFinalScale({ imageUrl, pixels, currentScale, parsedScale, noRepeat }) {
  const urlFeet = parseUrlFeetSize(imageUrl || "");
  const urlFeetOriented = orientMaxAsWidth(urlFeet || {});
  const Rimg    = ratioOf(pixels);
  const Rcur    = ratioOf(currentScale);
  const Rparsed = ratioOf(parsedScale);

  const useUrlInches = () => (validSize(urlFeetOriented) ? urlFeetOriented : undefined);

  // 1) URL token present + R(img) ≈ R(cur) → use URL inches
  if (validSize(urlFeetOriented) && approxEq(Rimg, Rcur)) {
    const s = useUrlInches(); if (s) { logStep(`  • Rule#1: URL feet & R(img)≈R(cur) → ${s.width}×${s.height}`); return s; }
  }
  // 2) URL token present + R(img) !≈ R(cur) but R(cur) ≈ R(parsed) → parsed
  if (validSize(urlFeetOriented) && !approxEq(Rimg, Rcur) && approxEq(Rcur, Rparsed)) {
    if (validSize(parsedScale)) { logStep(`  • Rule#2: R(cur)≈R(parsed) → ${parsedScale.width}×${parsedScale.height}`); return parsedScale; }
  }
  // 3) No URL feet + R(img) ≈ R(cur) → keep current
  if (!validSize(urlFeetOriented) && approxEq(Rimg, Rcur) && validSize(currentScale)) {
    logStep("  • Rule#3: keep current scale");
    return currentScale;
  }
  // 4) No URL feet + R(cur) ≈ R(parsed) → parsed
  if (!validSize(urlFeetOriented) && approxEq(Rcur, Rparsed) && validSize(parsedScale)) {
    logStep("  • Rule#4: use parsed scale");
    return parsedScale;
  }
  // 5) No-Repeat fallback based on image ratio
  if (noRepeat && isFinite(Rimg) && Rimg > 0) {
    const width = 60; const height = +(60 / Rimg).toFixed(2);
    logStep(`  • Rule#5 (No-Repeat): ${width}×${height}`);
    return { width, height };
  }
  // Last resort: parsed if valid, else current
  if (validSize(parsedScale)) return parsedScale;
  return currentScale && validSize(currentScale) ? currentScale : undefined;
}

async function computeParsedScale(page, isNoRepeat, imageUrl) {
  const urlFeet = parseUrlFeetSize(imageUrl || "");
  if (validSize(urlFeet)) { logStep(`  • Parsed (URL feet→in): ${urlFeet.width}×${urlFeet.height}`); return orientMaxAsWidth(urlFeet); }
  if (isNoRepeat)         { logStep("  • Parsed (No Repeat default): 96×48"); return { width: 96, height: 48 }; }
  const bold = await page?.$eval?.(SEL_REPEAT_BOLD, el => (el.textContent || "").trim()).catch(() => null);
  if (bold) {
    const m = bold.match(/(\d+(?:\.\d+)?)\s*\"?\s*[x×]\s*(\d+(?:\.\d+)?)/);
    if (m) {
      const a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (isFinite(a) && isFinite(b)) {
        const s = orientMaxAsWidth({ width: a, height: b });
        logStep(`  • Parsed (bold inches): ${s.width}×${s.height}`);
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
async function scrapeOne(page, code, productLink, existingRow = {}) {
  logStep(`[${code}] → ${productLink}`);
  await page.goto(productLink, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await waitForMain(page);

  // Try carousel next arrow a couple of times to surface more URLs
  for (let k = 0; k < 2; k++) {
    await robustClickXPath(page, XPATH_ARROW, "Carousel → Next");
  }
  // Always check again after interactions
  await afterStepCheckForBanner(page);

  // 1) If banner URL was ever seen during steps, prefer it
  let chosenUrl = page.__bannerOverrideUrl || null;

  // 2) Otherwise fall back to FullSheet / full_size discovery
  if (!chosenUrl) {
    const fullSheets = await findFullSheetUrlsInHTML(page);
    chosenUrl = pickBestFullSheetUrl(fullSheets) || null;
  }
  if (!chosenUrl) {
    const fullSize = await findFullSizeUrlsInHTML(page);
    chosenUrl = pickBestFullSizeUrl(fullSize) || null;
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

  const no_repeat   = await detectNoRepeat(page);
  const parsedScale = await computeParsedScale(page, no_repeat, chosenUrl || "");
  const currentScale = orientMaxAsWidth(existingRow?.texture_scale || parsedScale || { width: 144, height: 60 });
  const finalScale = chooseFinalScale({
    imageUrl: chosenUrl, pixels: texture_image_pixels,
    currentScale, parsedScale, noRepeat: no_repeat
  }) || currentScale;

  const description = hasString(existingRow?.description) ? existingRow.description : (await extractDescription(page));

  // Preserve existing fields; only fill missing ones; always update texture_scale to final decision
  const out = { ...(existingRow || {}), code };
  if (chosenUrl) out.texture_image_url = chosenUrl;
  if (validSize(texture_image_pixels)) out.texture_image_pixels = texture_image_pixels;
  if (no_repeat !== undefined) out.no_repeat = !!no_repeat;
  if (hasString(description)) out.description = description;
  if (banner_cropped) out.banner_cropped = true;
  out.texture_scale = finalScale; // per your rules: always overwrite

  return out;
}

// -------------------- Main --------------------
async function main() {
  const indexArr   = readJsonSafe(INDEX_JSON);
  const detailsArr = readJsonSafe(OUT_JSON);

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
    const set = new Set(missing);
    codesToProcess = codesToProcess.filter(c => set.has(c));
  }

  // Apply OFFSET/LIMIT
  if (OFFSET > 0) codesToProcess = codesToProcess.slice(OFFSET);
  if (LIMIT > 0) codesToProcess = codesToProcess.slice(0, LIMIT);

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
            scraped = await scrapeOne(page, code, link, outMap.get(code));
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
