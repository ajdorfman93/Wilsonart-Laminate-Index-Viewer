// wilsonart-fetch-details.js (ratio rules + overwrite-all texture_scale + incremental add)
// Usage:
//   node wilsonart-fetch-details.js
//   node wilsonart-fetch-details.js --limit=10 --offset=0 --batch=5
//
// Reads : ./wilsonart-laminate-index.json
// Writes: ./wilsonart-laminate-details.json
//
// Summary of rules:
//   • Always overwrite texture_scale for every code.
//   • Only add new data for missing fields (preserve existing fields where present).
//   • If a code already exists, reuse its data; scrape only when needed (e.g., missing image URL).
//   • texture_image_pixels are (re)computed if missing.
//
// Ratio/URL rules for deciding FINAL texture_scale:
//   Terms: R(img)=texture_image_pixels.width/height (if available), R(cur)=ratio of current texture_scale
//          R(parsed)=ratio of parsed scale (from URL feet→inches; else bold inches; else No Repeat 96×48)
//          URL feet token (e.g. 4x8, 5x12, 5x8, …) → INCHES with width=max*12 and height=min*12
//
//   1) If URL includes a feet token AND R(img) ≈ R(cur), set texture_scale to the INCHES version of that token
//      (e.g., 4x8 → 96×48; 5x12 → 144×60; 5x8 → 96×60). (Orientation uses max→width.)
//   2) If URL includes a feet token but R(img) !≈ R(cur), then if R(cur) ≈ R(parsed), set texture_scale = parsed scale.
//   3) If URL does NOT include a feet token and R(img) ≈ R(cur), leave texture_scale as-is.
//   4) If URL does NOT include a feet token and R(cur) ≈ R(parsed), set texture_scale = parsed scale.
//   5) If product is No Repeat and none of the above picked a size OR the image ratio does not match any feet token
//      in the URL, set texture_scale by assuming WIDTH=60 inches and HEIGHT = 60 / R(img). (Keep width=60.)
//
// Notes: headless=false (interactive where needed), verbose logs, no image file downloads.

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ----------------------------- CLI / Paths -----------------------------
const INDEX_JSON = path.resolve(process.cwd(), "wilsonart-laminate-index.json");
const OUT_JSON   = path.resolve(process.cwd(), "wilsonart-laminate-details.json");

const LIMIT = parseInt(
  process.env.LIMIT ??
    (process.argv.find(a => a.startsWith("--limit=")) || "").split("=")[1] ??
    "0",
  10
); // 0 = unlimited

const OFFSET = parseInt(
  process.env.OFFSET ??
    (process.argv.find(a => a.startsWith("--offset=")) || "").split("=")[1] ??
    "0",
  10
);

const BATCH_SIZE = parseInt(
  process.env.BATCH ??
    (process.argv.find(a => a.startsWith("--batch=")) || "").split("=")[1] ??
    "5",
  10
);
const MAX_FETCH_ATTEMPTS = 3;

// ----------------------------- Logging / Utils -----------------------------
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
  return Math.abs(a - b) <= tol; // strict “same ratio” notion
}

// Prefer width to be the larger side
function orientMaxAsWidth(s) {
  if (!validSize(s)) return s;
  return (s.width >= s.height) ? { width: +s.width, height: +s.height } : { width: +s.height, height: +s.width };
}

const pickImageUrl = (row) => {
  if (!row) return undefined;
  return row.texture_image_url || row.img || row.image_url || row.image || undefined;
};
const hasString = (val) => typeof val === "string" && val.trim().length > 0;
const hasImageData = (row) => hasString(pickImageUrl(row));
const hasDescriptionData = (row) => hasString(row?.description);

// ----------------------------- URL helpers -----------------------------
const hasFullSheet     = (u) => !!u && /FullSheet/i.test(u);
const hasCarouselMain  = (u) => !!u && /Carousel_Main/i.test(u);
const looksBanner      = (u) => !!u && /banner/i.test(u);
const includesFullSize = (u) => !!u && /full_size/i.test(u);

// Parse the FIRST feet token in URL → inches (width=max*12, height=min*12)
function parseUrlFeetSize(url) {
  if (!url) return undefined;
  const m = url.match(/(^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9])/);
  if (!m) return undefined;
  const a = parseFloat(m[2]);
  const b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return undefined;
  const W = Math.max(a, b) * 12;
  const H = Math.min(a, b) * 12;
  return { width: W, height: H };
}

// ----------------------------- Selectors / XPaths -----------------------------
const XPATH_ARROW = "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[4]";

const SEL_NO_REPEAT_B =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div > div.qkView_description > div:nth-child(7) > ul > li > p > b";
const SEL_REPEAT_BOLD =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div > div.qkView_description > ul > li > p > b";
const SEL_DESC_P2 =
  "#maincontent > div.columns > div > div.product_detailed_info_main > div.product-info-main > div.product-info-price > div > div.wa_product_title > div.qkView_description > p:nth-child(2)";

// ----------------------------- Wait helpers -----------------------------
async function waitForMain(page) {
  logStep("  • waitForSettled: waiting for document ready");
  try { await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 }); } catch {}
  try { await page.waitForSelector("#maincontent", { timeout: 30000 }); } catch {}
  await sleep(150);
  logStep("  • waitForSettled: done");
}
async function waitForXPathPresence(page, xpath, timeout = 8000, poll = 150) {
  return page
    .waitForFunction(
      (xp) => !!document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
      { timeout, polling: poll },
      xpath
    )
    .then(() => true)
    .catch(() => false);
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
        await page.mouse.down();
        await page.mouse.up();
        logStep(`  • ${label}: clicked inner arrow at ${cx},${cy}`);
        await sleep(2000);
        return true;
      } catch (e) { logStep(`  • ${label}: inner mouse click failed: ${e.message || e}`); }
    }

    // 2) Mouse click main element center
    if (coords?.main && coords.main.w > 0 && coords.main.h > 0) {
      const cx = Math.round(coords.main.x + coords.main.w / 2);
      const cy = Math.round(coords.main.y + coords.main.h / 2);
      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.up();
        logStep(`  • ${label}: clicked main box at ${cx},${cy}`);
        await sleep(2000);
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

    if (ok) { logStep(`  • ${label}: JS click dispatched`); await sleep(2000); return true; }
    await sleep(200);
  }

  logStep(`  • ${label}: all click attempts failed`);
  return false;
}

// ----------------------------- URL discovery -----------------------------
async function findFullSheetUrlsInHTML(page) {
  const matches = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const re = /https?:\/\/[^\s"'<>\)]*FullSheet[^\s"'<>\)]*/gi;
    const arr = html.match(re) || [];
    const cleaned = Array.from(new Set(arr.map(u => u.replace(/&amp;/g, "&"))));
    return cleaned;
  }).catch(() => []);
  return matches || [];
}
async function findFullSizeUrlsInHTML(page) {
  const matches = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const re = /https?:\/\/[^\s"'<>\)]*full_size[^\s"'<>\)]*/gi;
    const arr = html.match(re) || [];
    const cleaned = Array.from(new Set(arr.map(u => u.replace(/&amp;/g, "&"))));
    return cleaned;
  }).catch(() => []);
  return matches || [];
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

// ----------------------------- Metadata extractors -----------------------------
async function detectNoRepeat(page) {
  logStep("  • Checking 'No Repeat'…");
  const exact = await page.$eval(SEL_NO_REPEAT_B, el => (el.textContent || "").trim().toLowerCase()).catch(() => null);
  if (exact && exact.includes("no repeat")) { logStep("  • No Repeat? YES"); return true; }
  const list = await page.$$eval(".qkView_description b", ns => ns.map(n => (n.textContent || "").trim().toLowerCase())).catch(() => []);
  const found = list.some(t => t.includes("no repeat"));
  logStep(`  • No Repeat? ${found ? "YES (fallback)" : "NO"}`);
  return found;
}

// Parsed scale (priority): URL feet→inches  >  No Repeat 96×48  >  bold inches
async function computeParsedScale(page, isNoRepeat, imageUrl) {
  const urlFeet = parseUrlFeetSize(imageUrl || "");
  if (validSize(urlFeet)) { logStep(`  • Parsed (URL feet→in): ${urlFeet.width}×${urlFeet.height}`); return orientMaxAsWidth(urlFeet); }
  if (isNoRepeat)         { logStep("  • Parsed (No Repeat default): 96×48"); return { width: 96, height: 48 }; }
  // Bold inches (best effort)
  const bold = await page?.$eval?.(SEL_REPEAT_BOLD, el => (el.textContent || "").trim()).catch(() => null);
  if (bold) {
    const m = bold.match(/(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*(\d+(?:\.\d+)?)\s*"?/i);
    if (m) {
      const s = { width: parseFloat(m[1]), height: parseFloat(m[2]) };
      if (validSize(s)) { logStep(`  • Parsed (bold inches): ${s.width}×${s.height}`); return orientMaxAsWidth(s); }
    }
  }
  return undefined;
}

async function extractDescription(page) {
  const exact = await page.$eval(SEL_DESC_P2, el => (el.textContent || "").trim()).catch(() => null);
  if (exact) return exact;
  const list = await page.$$eval(".qkView_description p", ps => ps.map(p => (p.textContent || "").trim())).catch(() => []);
  return (list[1] || list[0] || undefined);
}

// -------------------------- Actual pixel size reader --------------------------
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

// ----------------------------- Decision: FINAL texture_scale -----------------------------
function chooseFinalScale({ imageUrl, pixels, currentScale, parsedScale, noRepeat }) {
  const urlFeet = parseUrlFeetSize(imageUrl || ""); // inches w=max*12
  const urlFeetOriented = orientMaxAsWidth(urlFeet || {});
  const Rimg    = ratioOf(pixels);
  const Rcur    = ratioOf(currentScale);
  const Rparsed = ratioOf(parsedScale);

  // Helper: set to URL feet inches
  const useUrlInches = () => (validSize(urlFeetOriented) ? urlFeetOriented : undefined);

  // 1) URL token present + R(img) ≈ R(cur) → use URL inches
  if (validSize(urlFeetOriented) && approxEq(Rimg, Rcur)) {
    const s = useUrlInches();
    if (s) { logStep(`  • Rule#1: URL feet & R(img)≈R(cur) → ${s.width}×${s.height}`); return s; }
  }

  // 2) URL token present + R(img) !≈ R(cur) + R(cur) ≈ R(parsed) → use parsed scale
  if (validSize(urlFeetOriented) && !approxEq(Rimg, Rcur) && approxEq(Rcur, Rparsed) && validSize(parsedScale)) {
    const s = orientMaxAsWidth(parsedScale);
    logStep(`  • Rule#2: URL feet & R(cur)≈R(parsed) (but not img) → ${s.width}×${s.height}`);
    return s;
  }

  // 3) No URL token + R(img) ≈ R(cur) → keep current
  if (!validSize(urlFeetOriented) && approxEq(Rimg, Rcur) && validSize(currentScale)) {
    const s = orientMaxAsWidth(currentScale);
    logStep(`  • Rule#3: no URL feet & R(img)≈R(cur) → keep ${s.width}×${s.height}`);
    return s;
  }

  // 4) No URL token + R(cur) ≈ R(parsed) → parsed
  if (!validSize(urlFeetOriented) && approxEq(Rcur, Rparsed) && validSize(parsedScale)) {
    const s = orientMaxAsWidth(parsedScale);
    logStep(`  • Rule#4: no URL feet & R(cur)≈R(parsed) → ${s.width}×${s.height}`);
    return s;
  }

  // 5) No Repeat fallback (width=60, height=60/Rimg) when no match to URL feet or none present
  if (noRepeat && isFinite(Rimg) && Rimg > 0) {
    const s = { width: 60, height: +(60 / Rimg).toFixed(3) };
    logStep(`  • Rule#5: No Repeat fallback using image ratio → ${s.width}×${s.height}`);
    return s;
  }

  // Fallbacks
  if (validSize(parsedScale)) { const s = orientMaxAsWidth(parsedScale); logStep(`  • Fallback: parsed → ${s.width}×${s.height}`); return s; }
  if (validSize(currentScale)) { const s = orientMaxAsWidth(currentScale); logStep(`  • Fallback: current → ${s.width}×${s.height}`); return s; }
  if (validSize(urlFeetOriented)) { const s = urlFeetOriented; logStep(`  • Fallback: url feet → ${s.width}×${s.height}`); return s; }
  logStep("  • Fallback: default 96×48");
  return { width: 96, height: 48 };
}

// ----------------------------- Batched writer -----------------------------
function maybeFlush(out, processedCount, force = false) {
  if (force || (processedCount % BATCH_SIZE === 0)) {
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf-8");
    logStep(`  • Progress saved (batch of ${BATCH_SIZE} or final) → ${OUT_JSON}`);
  } else {
    logStep(`  • (batched) not writing yet – processed ${processedCount} / batch=${BATCH_SIZE}`);
  }
}

// ----------------------------- Main -----------------------------
(async () => {
  // Load index
  if (!fs.existsSync(INDEX_JSON)) { console.error(`Index JSON not found at ${INDEX_JSON}`); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(INDEX_JSON, "utf-8"));
  if (!Array.isArray(base)) { console.error(`Index JSON must be an array.`); process.exit(1); }

  // Load existing details (if any), map by code
  let existing = [];
  try {
    if (fs.existsSync(OUT_JSON)) {
      const raw = JSON.parse(fs.readFileSync(OUT_JSON, "utf-8"));
      if (Array.isArray(raw)) existing = raw; else logStep("  • Existing details present but not an array; ignoring.");
    }
  } catch (e) { logStep(`  • Failed reading existing details: ${e?.message || e}`); }
  const existingByCode = new Map();
  for (const row of existing) {
    const key = row && (row.code || row.Code || row["laminate_code"] || row["Laminate Code"]);
    if (key) existingByCode.set(String(key), row);
  }

  const items = base.filter(r => r && r["product-link"]);
  logStep(`Total records with product-link: ${items.length}`);

  const sliced = items.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
  logStep(`Processing ${sliced.length} records (offset=${OFFSET}, limit=${LIMIT || "∞"}, batch=${BATCH_SIZE})`);

  // Launch
  logStep("Launching Chromium…");
  const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 }, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  const out = [];
  let processed = 0;

  for (let i = 0; i < sliced.length; i++) {
    const rec = sliced[i];
    const code = String(rec.code || `row_${OFFSET + i}`);
    const productUrl = rec["product-link"];
    logStep(`\n[${i + 1}/${sliced.length}] ${code} → ${productUrl}`);

    // Start from existing or base
    const prior = existingByCode.get(code) || {};
    const mergedStart = { ...rec, ...prior, code };

    if (existingByCode.has(code) && hasImageData(prior) && hasDescriptionData(prior)) {
      logStep("  • Skipping (image & description already present).");
      out.push({ ...mergedStart });
      processed++;
      maybeFlush(out, processed, false);
      continue;
    }

    // Try to reuse what we can without navigating
    let imageUrl = pickImageUrl(mergedStart) || null;
    let pixels   = validSize(mergedStart.texture_image_pixels) ? mergedStart.texture_image_pixels : undefined;
    let noRepeat = (typeof mergedStart.no_repeat === "boolean") ? mergedStart.no_repeat : undefined;
    let desc     = hasString(mergedStart.description) ? mergedStart.description : undefined;

    // If we have an image URL but no pixels, we can still load pixels without visiting product page
    if (imageUrl && !pixels) {
      pixels = await getImagePixels(page, imageUrl).catch(() => undefined);
      if (pixels) logStep(`  • Filled missing pixels from image URL ?+' ${pixels.width}A-${pixels.height}`);
    }

    let parsedScale;
    let needsImage = !hasString(imageUrl);
    let needsDesc  = !hasString(desc);
    let needsNoRepeat = (noRepeat === undefined);
    if (needsImage || needsDesc || needsNoRepeat) {
      for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
        logStep(`  • Attempt ${attempt}/${MAX_FETCH_ATTEMPTS} to fetch missing details`);
        try {
          await page.goto(productUrl, { waitUntil: "domcontentloaded" });
          await waitForMain(page);
        } catch (err) {
          logStep(`  • Navigation attempt ${attempt} failed: ${err?.message || err}`);
          continue;
        }

        if (needsImage && !hasString(imageUrl)) {
          const clicked = await robustClickXPath(page, XPATH_ARROW, "Arrow (full XPath)");
          if (clicked) {
            const fullsheetUrls = await findFullSheetUrlsInHTML(page);
            imageUrl = pickBestFullSheetUrl(fullsheetUrls);
            if (imageUrl && hasCarouselMain(imageUrl)) imageUrl = null;
          }
          if (!hasString(imageUrl)) {
            const fullSizeUrls = await findFullSizeUrlsInHTML(page);
            imageUrl = pickBestFullSizeUrl(fullSizeUrls);
          }
          if (hasString(imageUrl)) logStep(`  • Discovered texture image URL: ${imageUrl}`);
        }

        if (imageUrl && !pixels) {
          pixels = await getImagePixels(page, imageUrl).catch(() => undefined);
          if (pixels) logStep(`  • Pixels from discovered URL ?+' ${pixels.width}A-${pixels.height}`);
        }

        if (needsNoRepeat && noRepeat === undefined) {
          noRepeat = await detectNoRepeat(page);
        }
        if (needsDesc && !hasString(desc)) {
          desc = await extractDescription(page);
        }
        parsedScale = await computeParsedScale(page, !!noRepeat, imageUrl);

        needsImage = !hasString(imageUrl);
        needsDesc = !hasString(desc);
        needsNoRepeat = (noRepeat === undefined);
        if (!needsImage && !needsDesc && !needsNoRepeat) break;
      }
      if (needsImage) logStep(`  • Unable to locate texture image after ${MAX_FETCH_ATTEMPTS} attempts.`);
      if (needsDesc) logStep(`  • Unable to capture description after ${MAX_FETCH_ATTEMPTS} attempts.`);
    }
    if (!parsedScale) {
      parsedScale = await computeParsedScale(null, !!noRepeat, imageUrl);
    }

    // Current scale BEFORE rewrite (from existing or immediate parsed)
    const currentScale = validSize(prior.texture_scale) ? prior.texture_scale : (validSize(parsedScale) ? parsedScale : undefined);

    // Decide FINAL texture_scale via ratio rules
    const finalScale = chooseFinalScale({ imageUrl, pixels, currentScale, parsedScale, noRepeat });

    const outRow = {
      ...mergedStart,
      texture_image_url: imageUrl || mergedStart.texture_image_url || undefined,
      texture_image_pixels: validSize(pixels) ? pixels : mergedStart.texture_image_pixels,
      no_repeat: (typeof noRepeat === 'boolean') ? noRepeat : mergedStart.no_repeat,
      description: desc || mergedStart.description,
      texture_scale: finalScale, // ALWAYS overwrite
    };

    out.push(outRow);
    processed++;
    maybeFlush(out, processed, false);
  }

  if (processed % BATCH_SIZE !== 0) maybeFlush(out, processed, true);
  await browser.close();
  logStep(`\nDONE. Processed ${processed} item(s). Details written to: ${OUT_JSON}`);
})();
