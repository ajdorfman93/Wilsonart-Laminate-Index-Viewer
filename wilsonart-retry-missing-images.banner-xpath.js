/**
 * wilsonart-retry-missing-images.banner-xpath.js
 * (updated: fix logStep 'undefined' printing, banner-first + XPath fallback)
 *
 * Purpose:
 *   For any records missing `texture_image_url`, visit the product page and:
 *   1) **Always** search HTML for a URL containing 'Banner' or 'banner' first; if found, use it.
 *   2) If still missing, try the provided XPath to pick an <img>:
 *        //*[@id="html-body"]/div[6]/div[2]/div[1]/div[3]/div/img[1]
 *   3) Save the chosen URL as `texture_image_url`. If it’s a banner URL, set
 *      `banner_cropped: true` and crop 93px off height in `texture_image_pixels`.
 *
 * Usage:
 *   node wilsonart-retry-missing-images.banner-xpath.js
 *   node wilsonart-retry-missing-images.banner-xpath.js --src=./wilsonart-laminate-details.json --out=./wilsonart-laminate-details.json --headless=true --limit=0 --offset=0 --batch=10
 *
 * Notes:
 *   - Writes progress every N items (batch).
 *   - Keeps any existing image fields; only fills missing `texture_image_url`.
 *   - Requires: puppeteer (npm i puppeteer)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ----------------------------- CLI -----------------------------
function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}

const SRC = path.resolve(process.cwd(), arg("src", "wilsonart-laminate-details.json"));
const OUT = path.resolve(process.cwd(), arg("out", arg("src", "wilsonart-laminate-details.json")));
const HEADLESS = /^true$/i.test(String(arg("headless", "true")));
const LIMIT = parseInt(arg("limit", "0"), 10);
const OFFSET = parseInt(arg("offset", "0"), 10);
const BATCH = parseInt(arg("batch", "10"), 10);

const XPATH_FALLBACK = '//*[@id="html-body"]/div[6]/div[2]/div[1]/div[3]/div/img[1]';

// ----------------------------- Utils -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function logStep(msg, extra) {
  const ts = new Date().toISOString();
  if (arguments.length > 1 && typeof extra !== "undefined") {
    console.log(`[${ts}] ${msg}`, extra);
  } else {
    console.log(`[${ts}] ${msg}`);
  }
}
const hasStr = (v) => typeof v === "string" && v.trim().length > 0;
const looksBanner = (u) => !!u && /banner/i.test(u);
function validSize(p) { return p && isFinite(p.width) && isFinite(p.height) && p.width > 0 && p.height > 0; }

// use existing field variants, but we only write to `texture_image_url`
function currentImageUrl(row) {
  return row.texture_image_url || row.img || row.image_url || row.image || null;
}

// Image pixel reader in page context
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
    return res && (res.width > 0 || res.height > 0) ? res : undefined;
  } catch { return undefined; }
}

function applyBannerCrop(url, p) {
  if (!validSize(p) || !looksBanner(url)) return p;
  const h = Math.max(1, Math.round(p.height - 93));
  return { width: Math.round(p.width), height: h };
}

// ----------------------------- Page helpers -----------------------------
async function waitForMain(page) {
  try { await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 }); } catch {}
  try { await page.waitForSelector("#maincontent", { timeout: 30000 }); } catch {}
  await sleep(150);
}

async function findBannerUrlsInHTML(page) {
  const urls = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const re = /https?:\/\/[^\s"'<>\)]*banner[^\s"'<>\)]*/gi; // both Banner/banner
    const arr = html.match(re) || [];
    return Array.from(new Set(arr.map((u) => u.replace(/&amp;/g, "&"))));
  }).catch(() => []);
  return urls || [];
}

async function getXPathImageSrc(page, xpath) {
  // We must resolve relative srcs against page location
  const base = page.url();
  const src = await page.evaluate((xp) => {
    try {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return null;
      const raw = el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-original") || el.getAttribute("srcset") || "";
      // If srcset, pick first candidate
      if (raw && raw.includes("srcset")) return null;
      return raw || null;
    } catch { return null; }
  }, xpath);
  if (!src) return null;
  try { return new URL(src, base).toString(); } catch { return src; }
}

// ----------------------------- Main -----------------------------
(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`Input not found: ${SRC}`);
    process.exit(1);
  }
  const arr = JSON.parse(fs.readFileSync(SRC, "utf-8"));
  if (!Array.isArray(arr)) {
    console.error(`Input must be an array: ${SRC}`);
    process.exit(1);
  }

  const targets = arr.filter((r) => !hasStr(currentImageUrl(r)) && hasStr(r["product-link"]));
  const slice = targets.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
  logStep(`Missing images: ${targets.length}; processing ${slice.length} (offset=${OFFSET}, limit=${LIMIT || "∞"})`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: { width: 1400, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

  let processed = 0;
  for (let i = 0; i < slice.length; i++) {
    const rec = slice[i];
    const code = rec.code || `row_${OFFSET + i}`;
    const url = rec["product-link"];
    logStep(`\n[${i + 1}/${slice.length}] ${code} → ${url}`);

    let chosen = null;
    let pixels = null;
    let bannerCropped = false;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForMain(page);

      // 1) Banner-first
      const bannerUrls = await findBannerUrlsInHTML(page);
      if (bannerUrls.length) {
        chosen = bannerUrls[0];
        logStep(`  • Banner URL found: ${chosen}`);
      }

      // 2) If still missing, try the provided XPath
      if (!hasStr(chosen)) {
        const xpathSrc = await getXPathImageSrc(page, XPATH_FALLBACK);
        if (hasStr(xpathSrc)) {
          chosen = xpathSrc;
          logStep(`  • XPath image used: ${chosen}`);
        }
      }

      // Pixels + banner crop metadata
      if (hasStr(chosen)) {
        const px = await getImagePixels(page, chosen).catch(() => undefined);
        if (px) {
          const cropped = applyBannerCrop(chosen, px);
          bannerCropped = looksBanner(chosen) && validSize(px) && validSize(cropped) && cropped.height !== px.height;
          pixels = cropped;
        }
      }
    } catch (e) {
      logStep(`  • Error: ${e?.message || e}`);
    }

    // Update record in main array
    if (hasStr(chosen)) {
      rec.texture_image_url = chosen;
      if (pixels && validSize(pixels)) rec.texture_image_pixels = pixels;
      if (bannerCropped) rec.banner_cropped = true;
    }

    processed++;
    if (processed % BATCH === 0) {
      fs.writeFileSync(OUT, JSON.stringify(arr, null, 2), "utf-8");
      logStep(`  • Progress saved → ${OUT}`);
    }
  }

  if (processed % BATCH !== 0) {
    fs.writeFileSync(OUT, JSON.stringify(arr, null, 2), "utf-8");
    logStep(`  • Final save → ${OUT}`);
  }

  await browser.close();
  logStep("Done.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
