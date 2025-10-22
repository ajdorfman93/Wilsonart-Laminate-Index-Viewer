"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * wilsonart-retry-missing-images.js
 *
 * Purpose:
 *   Re-scan an existing details file, retry fetching images for any records
 *   missing `texture_image_url`, update those records when found, and write a
 *   separate JSON listing codes still missing images after retries.
 *
 * Usage:
 *   node wilsonart-retry-missing-images.js
 *   node wilsonart-retry-missing-images.js --src=./wilsonart-laminate-details.json --out-updated=./wilsonart-laminate-details.retry-updated.json --out-missing=./wilsonart-missing-images-after-retry.json --limit=0 --offset=0 --batch=10
 *
 * Defaults:
 *   --src         ./wilsonart-laminate-details.json
 *   --out-updated (same as --src; overwrite in-place)
 *   --out-missing ./wilsonart-missing-images-after-retry.json
 *   --limit       0 (process all)
 *   --offset      0
 *   --batch       10 (write progress every N processed)
 */

// ----------------------------- CLI / Paths -----------------------------
function getArg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return def;
  return hit.split("=")[1];
}

const SRC_JSON = path.resolve(process.cwd(), getArg("src", "wilsonart-laminate-details.json"));
const OUT_UPDATED_JSON = path.resolve(process.cwd(), getArg("out-updated", getArg("src", "wilsonart-laminate-details.json")));
const OUT_MISSING_JSON = path.resolve(process.cwd(), getArg("out-missing", "wilsonart-missing-images-after-retry.json"));

const LIMIT = parseInt(getArg("limit", "0"), 10);
const OFFSET = parseInt(getArg("offset", "0"), 10);
const BATCH_SIZE = parseInt(getArg("batch", "10"), 10);

const MAX_FETCH_ATTEMPTS = 3;

// ----------------------------- Logging / Utils -----------------------------
function logStep(msg, extra) {
  const ts = new Date().toISOString();
  if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra);
  else console.log(`[${ts}] ${msg}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function validSize(obj) { return !!obj && isFinite(obj.width) && isFinite(obj.height) && obj.width > 0 && obj.height > 0; }

const pickImageUrl = (row) => {
  if (!row) return undefined;
  return row.texture_image_url || row.img || row.image_url || row.image || undefined;
};
const hasString = (val) => typeof val === "string" && val.trim().length > 0;

// ----------------------------- URL helpers -----------------------------
const hasFullSheet     = (u) => !!u && /FullSheet/i.test(u);
const hasCarouselMain  = (u) => !!u && /Carousel_Main/i.test(u);
const looksBanner      = (u) => !!u && /banner/i.test(u);
const includesFullSize = (u) => !!u && /full_size/i.test(u);

// ----------------------------- Wait / DOM helpers -----------------------------
const XPATH_ARROW = "/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div[2]/div[2]/div[2]/div[1]/div[4]";

async function waitForMain(page) {
  try { await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 }); } catch {}
  try { await page.waitForSelector("#maincontent", { timeout: 30000 }); } catch {}
  await sleep(150);
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
async function robustClickXPath(page, xpath, label) {
  const present = await waitForXPathPresence(page, xpath, 10000, 150);
  if (!present) return false;

  for (let attempt = 1; attempt <= 3; attempt++) {
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

    if (coords?.inner && coords.inner.w > 0 && coords.inner.h > 0) {
      const cx = Math.round(coords.inner.x + coords.inner.w / 2);
      const cy = Math.round(coords.inner.y + coords.inner.h / 2);
      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(2000);
        return true;
      } catch {}
    }

    if (coords?.main && coords.main.w > 0 && coords.main.h > 0) {
      const cx = Math.round(coords.main.x + coords.main.w / 2);
      const cy = Math.round(coords.main.y + coords.main.h / 2);
      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(2000);
        return true;
      } catch {}
    }

    const ok = await page.evaluate((xp) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return false;
      const inner = el.querySelector(".fotorama__arr__arr");
      if (inner && inner.click) { inner.click(); return true; }
      if (el.click) { el.click(); return true; }
      const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      return el.dispatchEvent(evt);
    }, xpath).catch(() => false);
    if (ok) { await sleep(2000); return true; }
    await sleep(200);
  }
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

/**
 * Apply banner crop rule: if URL looks like a banner, subtract 93px from height.
 * Never let height drop below 1.
 */
function applyBannerCrop(url, pixels) {
  if (!validSize(pixels)) return pixels;
  if (!looksBanner(url)) return pixels;
  const croppedHeight = Math.max(1, Math.round(pixels.height - 93));
  if (croppedHeight !== pixels.height) {
    logStep(`  • Banner detected → cropping 93px from height: ${pixels.width}×${pixels.height} → ${pixels.width}×${croppedHeight}`);
  }
  return { width: Math.round(pixels.width), height: croppedHeight };
}

// ----------------------------- Missing-image retry -----------------------------
function isMissingImage(row) {
  const url = pickImageUrl(row);
  if (!hasString(url)) return true;
  // Could add more validation, but for now treat falsy/empty as missing
  return false;
}

function maybeFlushUpdated(arr, processedCount, force = false) {
  if (force || (processedCount % BATCH_SIZE === 0)) {
    fs.writeFileSync(OUT_UPDATED_JSON, JSON.stringify(arr, null, 2), "utf-8");
    logStep(`  • Updated details saved → ${OUT_UPDATED_JSON}`);
  }
}

(async () => {
  if (!fs.existsSync(SRC_JSON)) { console.error(`Details JSON not found at ${SRC_JSON}`); process.exit(1); }
  const details = JSON.parse(fs.readFileSync(SRC_JSON, "utf-8"));
  if (!Array.isArray(details)) { console.error(`Details JSON must be an array.`); process.exit(1); }

  const todo = details.filter((r) => r && isMissingImage(r));
  const sliced = todo.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
  logStep(`Found ${todo.length} without images; processing ${sliced.length} (offset=${OFFSET}, limit=${LIMIT || "∞"})`);

  // launch browser
  const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 }, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  let processed = 0;
  for (let i = 0; i < sliced.length; i++) {
    const row = sliced[i];
    const code = String(row.code || `row_${OFFSET + i}`);
    const productUrl = row["product-link"];
    logStep(`\n[${i + 1}/${sliced.length}] Retrying image for ${code}${productUrl ? ` → ${productUrl}` : ""}`);

    if (!hasString(productUrl)) {
      logStep("  • Skipping: missing product-link");
      processed++;
      maybeFlushUpdated(details, processed, false);
      continue;
    }

    let imageUrl = null;
    let pixels = null;
    let bannerCropped = false;

    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
      logStep(`  • Attempt ${attempt}/${MAX_FETCH_ATTEMPTS}`);
      try {
        await page.goto(productUrl, { waitUntil: "domcontentloaded" });
        await waitForMain(page);
      } catch (err) {
        logStep(`  • Navigation failed: ${err?.message || err}`);
        continue;
      }

      // Try to discover a FullSheet image
      const clicked = await robustClickXPath(page, XPATH_ARROW, "Arrow (full XPath)");
      if (clicked) {
        const fullsheetUrls = await findFullSheetUrlsInHTML(page);
        imageUrl = pickBestFullSheetUrl(fullsheetUrls);
        if (imageUrl && hasCarouselMain(imageUrl)) imageUrl = null;
      }

      // Fallback to full_size
      if (!hasString(imageUrl)) {
        const fullSizeUrls = await findFullSizeUrlsInHTML(page);
        imageUrl = pickBestFullSizeUrl(fullSizeUrls);
      }

      if (hasString(imageUrl)) {
        logStep(`  • Discovered texture image URL: ${imageUrl}`);
        const fresh = await getImagePixels(page, imageUrl).catch(() => undefined);
        if (fresh) {
          const cropped = applyBannerCrop(imageUrl, fresh);
          if (looksBanner(imageUrl) && validSize(fresh) && validSize(cropped) && cropped.height !== fresh.height) {
            bannerCropped = true;
          }
          pixels = cropped;
          logStep(`  • Pixels: ${pixels.width}×${pixels.height}${bannerCropped ? " (banner-cropped)" : ""}`);
        }
        break; // stop attempts once we have a URL (regardless of pixels success)
      }
    }

    // Update the original details row if we found something
    if (hasString(imageUrl)) {
      row.texture_image_url = imageUrl;
      if (pixels && validSize(pixels)) row.texture_image_pixels = pixels;
      if (bannerCropped === true) row.banner_cropped = true;
    }

    processed++;
    maybeFlushUpdated(details, processed, false);
  }

  // Final save of updated details
  if (processed % BATCH_SIZE !== 0) maybeFlushUpdated(details, processed, true);

  await browser.close();

  // Build "still missing" list (re-check entire details array)
  const stillMissing = details
    .filter(r => r && isMissingImage(r))
    .map(r => ({
      code: r.code || null,
      name: r.name || null,
      "product-link": r["product-link"] || null
    }));

  fs.writeFileSync(OUT_MISSING_JSON, JSON.stringify(stillMissing, null, 2), "utf-8");
  logStep(`Wrote list of ${stillMissing.length} still-missing image(s) → ${OUT_MISSING_JSON}`);

  logStep("DONE.");
})();
