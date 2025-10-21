// wilsonart-fetch-details.js (skip-existing + aspect-match)
// Usage:
//   node wilsonart-fetch-details.js
//   node wilsonart-fetch-details.js --limit=10 --offset=0 --batch=5
//
// Reads : ./wilsonart-laminate-index.json
// Writes: ./wilsonart-laminate-details.json
//
// Flow (high level):
//   1) If an existing wilsonart-laminate-details.json is present, build a map by `code`.
//      • Skip any `code` that already exists AND already has an image URL
//        (texture_image_url | img | image_url | image). Keep the existing entry as-is.
//      • Otherwise, (new or missing image) scrape as usual to obtain image + metadata.
//   2) Try clicking the gallery arrow; if present, scan HTML for "FullSheet" URLs (never pick Carousel_Main).
//      Otherwise, scan for "full_size" URLs; if chosen URL includes "banner", add crop hint (bottom=93px).
//   3) Detect No Repeat; derive initial "parsed" texture scale (inches) from:
//        URL token (feet → inches)  >  No Repeat fixed 96×48  >  Bold inches in description.
//   4) Load the final image URL in-page to get actual pixel dimensions (naturalWidth × naturalHeight).
//   5) Choose the FINAL texture_scale by aspect-ratio match between: (a) parsed scale vs (b) 144×60,
//      picking whichever is closer to the image pixel aspect (considering orientation).
//   6) Batch-write JSON every N rows and on completion.
//
// Notes: headless=false (interactive for robustness), verbose logs, no image downloads.

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

// ----------------------------- Logging / Utils -----------------------------
function logStep(msg, extra) {
  const ts = new Date().toISOString();
  if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra);
  else console.log(`[${ts}] ${msg}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function validSize(obj) {
  return !!obj && isFinite(obj.width) && isFinite(obj.height) && obj.width > 0 && obj.height > 0;
}

function aspect(obj) {
  if (!validSize(obj)) return undefined;
  return obj.width / obj.height;
}

function aspectDistance(candidateRatio, imageRatio) {
  // Consider both orientations: r and 1/r (swapped W×H)
  if (!isFinite(candidateRatio) || !isFinite(imageRatio) || candidateRatio <= 0 || imageRatio <= 0) return Number.POSITIVE_INFINITY;
  const inv = 1 / candidateRatio;
  return Math.min(Math.abs(candidateRatio - imageRatio), Math.abs(inv - imageRatio));
}

function hasImage(obj) {
  return !!(obj && (obj.texture_image_url || obj.img || obj.image_url || obj.image));
}

// ----------------------------- URL helpers -----------------------------
const hasFullSheet     = (u) => !!u && /FullSheet/i.test(u);
const hasCarouselMain  = (u) => !!u && /Carousel_Main/i.test(u);
const looksBanner      = (u) => !!u && /banner/i.test(u);
const includesFullSize = (u) => !!u && /full_size/i.test(u);

// Feet token in URL → inches (e.g. "-5x12_150dpi" => { width: 144, height: 60 })
function parseUrlFeetSize(url) {
  if (!url) return undefined;
  const m = url.match(/(^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9])/);
  if (!m) return undefined;
  const a = parseFloat(m[2]);
  const b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return undefined;
  const max = Math.max(a, b);
  const min = Math.min(a, b);
  return { width: max * 12, height: min * 12 };
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
        await sleep(2000); // required pause
        return true;
      } catch (e) {
        logStep(`  • ${label}: inner mouse click failed: ${e.message || e}`);
      }
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
        await sleep(2000); // required pause
        return true;
      } catch (e) {
        logStep(`  • ${label}: main mouse click failed: ${e.message || e}`);
      }
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
      await sleep(2000); // required pause
      return true;
    }

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

  scored.sort((A, B) => (
    (B.areaFeet - A.areaFeet) ||
    (B.has150dpi - A.has150dpi) ||
    (B.len - A.len)
  ));
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

  scored.sort((A, B) => (
    (B.areaFeet - A.areaFeet) ||
    (B.has150dpi - A.has150dpi) ||
    (B.len - A.len)
  ));
  return scored[0].u;
}

// ----------------------------- Metadata extractors -----------------------------
async function detectNoRepeat(page) {
  logStep("  • Checking 'No Repeat'…");
  const exact = await page.$eval(SEL_NO_REPEAT_B, el => (el.textContent || "").trim().toLowerCase()).catch(() => null);
  if (exact && exact.includes("no repeat")) {
    logStep("  • No Repeat? YES");
    return true;
  }
  const list = await page.$$eval(".qkView_description b", ns => ns.map(n => (n.textContent || "").trim().toLowerCase())).catch(() => []);
  const found = list.some(t => t.includes("no repeat"));
  logStep(`  • No Repeat? ${found ? "YES (fallback)" : "NO"}`);
  return found;
}

async function computeInitialScale(page, isNoRepeat, imageUrl) {
  // 1) URL token override wins (feet → inches)
  const token = parseUrlFeetSize(imageUrl || "");
  if (token) { logStep(`  • URL token override → ${token.width} × ${token.height} in`); return token; }

  // 2) No Repeat fixed size
  if (isNoRepeat) { logStep("  • No Repeat → fixed 96 × 48 in"); return { width: 96, height: 48 }; }

  // 3) Parse bold inches like: 62.205" X 49.213"
  logStep("  • Parsing bold WxH inches…");
  const bold = await page.$eval(SEL_REPEAT_BOLD, el => (el.textContent || "").trim()).catch(() => null);
  if (bold) {
    const m = bold.match(/(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*(\d+(?:\.\d+)?)\s*"?/i);
    if (m) {
      const scale = { width: parseFloat(m[1]), height: parseFloat(m[2]) };
      logStep(`  • Parsed scale: ${scale.width} × ${scale.height} in`);
      return scale;
    }
    logStep("  • Bold present but unparsable.");
  } else {
    logStep("  • Bold not found.");
  }
  return undefined;
}

function selectScaleByAspect(initialScale, imagePixels) {
  const fallback = { width: 144, height: 60 }; // 12' × 5' (inches)

  if (!validSize(initialScale) && !validSize(fallback)) return undefined;
  if (!validSize(imagePixels)) {
    return validSize(initialScale) ? initialScale : fallback;
  }

  const imgR = aspect(imagePixels);
  const candidates = [
    { name: "parsed",   ord: 0, scale: initialScale, r: aspect(initialScale) },
    { name: "144x60",   ord: 1, scale: fallback,     r: aspect(fallback) },
  ].filter(c => isFinite(c.r) && c.r > 0);

  if (!candidates.length) return fallback;

  const ranked = candidates
    .map(c => ({ ...c, d: aspectDistance(c.r, imgR) }))
    .sort((a, b) => (a.d - b.d) || (a.ord - b.ord)); // tie-breaker: prefer parsed

  const top = ranked[0];
  logStep(`  • Aspect match → imgR=${imgR?.toFixed(4)} parsedR=${(candidates[0]?.r)?.toFixed?.(4)} fallbackR=${(candidates[1]?.r)?.toFixed?.(4)} → choose ${top.name}`);
  return top.scale;
}

async function extractDescription(page) {
  logStep("  • Extracting description…");
  const exact = await page.$eval(SEL_DESC_P2, el => (el.textContent || "").trim()).catch(() => null);
  if (exact) {
    logStep("  • Description found");
    return exact;
  }
  const list = await page.$$eval(".qkView_description p", ps => ps.map(p => (p.textContent || "").trim())).catch(() => []);
  const text = list[1] || list[0] || null;
  logStep(`  • Fallback description ${text ? "found" : "missing"}`);
  return text || undefined;
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
        } catch {
          resolve(undefined);
        }
      });
    }, url, timeoutMs);
    if (res && (res.width > 0 || res.height > 0)) return res;
    return undefined;
  } catch {
    return undefined;
  }
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
  if (!fs.existsSync(INDEX_JSON)) {
    console.error(`Index JSON not found at ${INDEX_JSON}`);
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(INDEX_JSON, "utf-8"));
  if (!Array.isArray(base)) {
    console.error(`Index JSON must be an array.`);
    process.exit(1);
  }

  // Load existing details (if present) and map by code
  let existing = [];
  try {
    if (fs.existsSync(OUT_JSON)) {
      const raw = JSON.parse(fs.readFileSync(OUT_JSON, "utf-8"));
      if (Array.isArray(raw)) existing = raw; else logStep("  • Existing details file present but not an array; ignoring.");
    }
  } catch (e) {
    logStep(`  • Failed reading existing details: ${e?.message || e}`);
  }
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
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1400, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  const out = [];
  let processed = 0;

  for (let i = 0; i < sliced.length; i++) {
    const rec = sliced[i];
    const code = String(rec.code || `row_${OFFSET + i}`);
    const url  = rec["product-link"];
    logStep(`\n[${i + 1}/${sliced.length}] ${code} → ${url}`);

    // If exists and already has an image, skip and keep existing
    const prior = existingByCode.get(code);
    if (prior && hasImage(prior)) {
      logStep("  • Skipping (already present with image)");
      out.push(prior);
      processed++;
      maybeFlush(out, processed, false);
      continue;
    }

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForMain(page);

      // Try clicking arrow; if clicked we will attempt FullSheet route, else full_size route
      const clicked = await robustClickXPath(page, XPATH_ARROW, "Arrow (full XPath)");
      let imageUrl = null;
      let cropBottom = null;

      if (clicked) {
        // FULLSHEET path
        logStep("  • Arrow clicked – scanning HTML for 'FullSheet' URLs...");
        const fullsheetUrls = await findFullSheetUrlsInHTML(page);
        logStep(`  • Found ${fullsheetUrls.length} 'FullSheet' candidate(s)`);
        imageUrl = pickBestFullSheetUrl(fullsheetUrls);

        if (!imageUrl) {
          logStep("  • No acceptable FullSheet URL found (or only Carousel_Main).");
        } else if (hasCarouselMain(imageUrl)) {
          logStep("  • Discarding Carousel_Main URL (guard).");
          imageUrl = null;
        }

      } else {
        // FULL_SIZE fallback
        logStep("  • Arrow not found – scanning HTML for 'full_size' URLs...");
        const fullSizeUrls = await findFullSizeUrlsInHTML(page);
        logStep(`  • Found ${fullSizeUrls.length} 'full_size' candidate(s)`);
        imageUrl = pickBestFullSizeUrl(fullSizeUrls);

        if (imageUrl && looksBanner(imageUrl)) {
          cropBottom = 93; // crop hint for banner
          logStep("  • 'full_size' URL contains 'banner' → will set crop bottom = 93px");
        }
      }

      logStep(`  • Final texture image URL: ${imageUrl || "(none)"}`);

      // Detect No Repeat, compute initial (parsed) scale, description, and image pixel size
      const noRepeat = await detectNoRepeat(page);
      const parsed   = await computeInitialScale(page, noRepeat, imageUrl);
      const desc     = await extractDescription(page);
      const pixels   = imageUrl ? await getImagePixels(page, imageUrl) : undefined;
      if (validSize(pixels)) logStep(`  • Image pixels: ${pixels.width} × ${pixels.height}`);

      // Choose final scale by aspect match between parsed vs 144×60
      const chosenScale = selectScaleByAspect(parsed, pixels);

      const merged = {
        ...rec,
        code,
        no_repeat: noRepeat,
        texture_image_url: imageUrl || undefined,
        texture_image_pixels: validSize(pixels) ? pixels : undefined,
        texture_scale: chosenScale || undefined,
        description: desc || undefined,
      };
      if (cropBottom) merged.texture_image_crop_px = { bottom: cropBottom };

      out.push(merged);
      processed++;
      maybeFlush(out, processed, false);

    } catch (err) {
      logStep(`  • ERROR on ${code}: ${String(err && err.message || err).slice(0,180)}`);
      const errorRow = { ...rec, code, _error: String(err && err.message || err) };
      out.push(errorRow);
      processed++;
      maybeFlush(out, processed, false);
    }
  }

  // Final flush (in case the last batch < BATCH_SIZE)
  if (processed % BATCH_SIZE !== 0) {
    maybeFlush(out, processed, true);
  }

  await browser.close();
  logStep(`\nDONE. Processed ${processed} item(s). Details written to: ${OUT_JSON}`);
})();
