// fill-missing-wilsonart-details.js
// Purpose:
//   Read wilsonart-laminate-details.json and, for every record that is missing `color`
//   (and optionally `design_groups`, `shade`, `description`), call OpenAI Vision on the
//   product's texture image to infer values, then update the JSON. Processes items in
//   batches of 5 by default.
//
// Usage:
//   OPENAI_API_KEY=sk-... node fill-missing-wilsonart-details.js
//   OPENAI_API_KEY=sk-... node fill-missing-wilsonart-details.js --in=wilsonart-laminate-details.json --out=wilsonart-laminate-details.json --model=gpt-4o-mini --batchSize=5 --overwrite=false
//
// Notes:
//   - Only records with missing or empty `color` are selected. Within those, this script
//     will fill *any* of: color[], design_groups[], shade[], description if they are
//     empty. Existing non-empty fields are preserved unless --overwrite=true.
//   - Writes atomically via .tmp rename.
//   - Requires: `npm i openai`
//
'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
function flag(name, def) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const raw = hit.split('=')[1];
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

const IN_PATH = path.resolve(process.cwd(), flag('in', 'wilsonart-laminate-details.json'));
const OUT_PATH = path.resolve(process.cwd(), flag('out', 'wilsonart-laminate-details.json'));
const MODEL = flag('model', 'gpt-4o-mini'); // vision-capable
const BATCH_SIZE = Math.max(1, Number(flag('batchSize', 5)));
const OVERWRITE = Boolean(flag('overwrite', false));
const DRY_RUN = Boolean(flag('dryRun', false));

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function readJsonArray(p) {
  const txt = fs.readFileSync(p, 'utf-8');
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr)) throw new Error('Expected an array JSON file');
  return arr;
}

function writeJsonArrayAtomic(p, arr) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function isEmptyArray(v) {
  return !Array.isArray(v) || v.length === 0;
}

function normalizeOneColor(c) {
  if (!c) return null;
  let s = String(c).trim();
  if (!s) return null;
  s = s.replace(/grey/i, 'Gray');
  const cap = s[0].toUpperCase() + s.slice(1);
  // Whitelist common palette terms you use across the catalog
  const allowed = new Set([
    'White','Off-White','Black','Gray','Grey','Neutral','Beige','Brown','Tan',
    'Red','Orange','Yellow','Green','Blue','Purple','Pink','Teal','Aqua','Navy',
    'Gold','Silver','Copper','Bronze'
  ]);
  // Map common variants
  const map = {
    'grey': 'Gray',
    'dark grey': 'Gray', 'light grey': 'Gray',
    'charcoal': 'Gray', 'graphite': 'Gray',
    'off white': 'Off-White', 'offwhite': 'Off-White',
    'cream': 'Beige', 'taupe': 'Beige',
    'navy blue': 'Navy'
  };
  const low = s.toLowerCase();
  if (map[low]) return map[low];
  if (allowed.has(cap)) return cap;
  // Fallback to Title Case of first token
  return cap.split(/[\/,&]/)[0].trim();
}

function normalizeColors(list) {
  const out = [];
  for (const c of (Array.isArray(list) ? list : [list]).filter(Boolean)) {
    const n = normalizeOneColor(c);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function normalizeDesignGroups(list) {
  const canonical = [
    'Abstracts & Patterns',
    'Solid Colors',
    'Woodgrains',
    'Stones',
    'Marbles & Quartzites',
    'Concretes & Industrials',
    'Textiles & Weaves',
    'Metals & Metallics'
  ];
  const map = new Map(canonical.map(x => [x.toLowerCase(), x]));
  const out = [];
  for (const v of (Array.isArray(list) ? list : [list]).filter(Boolean)) {
    const key = String(v).toLowerCase();
    // fuzzy contains
    const hit = canonical.find(c => key.includes(c.toLowerCase().split(' ')[0]));
    if (hit && !out.includes(hit)) out.push(hit);
    else if (map.has(key) && !out.includes(map.get(key))) out.push(map.get(key));
  }
  return out;
}

function normalizeShade(list) {
  const opts = ['Light', 'Medium', 'Dark'];
  const out = [];
  for (const v of (Array.isArray(list) ? list : [list]).filter(Boolean)) {
    const s = String(v).toLowerCase();
    if (s.includes('light') && !out.includes('Light')) out.push('Light');
    else if (s.includes('dark') && !out.includes('Dark')) out.push('Dark');
    else if (!out.includes('Medium')) out.push('Medium');
  }
  return out.length ? out : ['Medium'];
}

// Robust JSON grabber from model output
function extractJson(text) {
  if (typeof text !== 'string') return null;
  // Prefer fenced blocks
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1] : text;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = body.slice(first, last + 1);
  try { return JSON.parse(slice); } catch {}
  return null;
}

// ---------- OpenAI ----------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You are a product surface and décor classification assistant for Wilsonart laminates.
You will receive an image URL and sparse metadata (name, code). Infer the following strictly:
- "color": array of 1–3 high-level color families (e.g., "White","Neutral","Black","Gray","Beige","Brown","Red","Orange","Yellow","Green","Blue","Purple","Pink","Teal","Aqua","Navy","Gold","Silver","Copper","Bronze").
- "design_groups": choose 1–2 from: "Abstracts & Patterns","Solid Colors","Woodgrains","Stones","Marbles & Quartzites","Concretes & Industrials","Textiles & Weaves","Metals & Metallics".
- "shade": array with one of "Light","Medium","Dark" (optionally include a second if borderline).
- "description": short, plain-English, 10–25 words, describing pattern scale, directionality, and color mood (avoid marketing fluff).

Return ONLY JSON with keys: color, design_groups, shade, description.`;

async function analyzeOne(item) {
  const imgUrl = item.texture_image_url;
  if (!imgUrl) throw new Error('Missing texture_image_url');

  const userPrompt = [
    `Name: ${item.name || ''}`,
    `Code: ${item.code || ''}`,
    `Task: Classify this laminate image.`,
    `Important: If the image is a narrow banner, still infer color and shade from visible area.`
  ].join('\n');

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          // Vision payload uses an image_url content block
          { type: 'image_url', image_url: { url: imgUrl } }
        ]
      }
    ]
  });

  const text = resp.choices?.[0]?.message?.content || '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Model did not return valid JSON');

  const out = {
    color: normalizeColors(parsed.color || []),
    design_groups: normalizeDesignGroups(parsed.design_groups || []),
    shade: normalizeShade(parsed.shade || []),
    description: String(parsed.description || '').trim()
  };
  return out;
}

// ---------- Main ----------
(async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY environment variable.');
    process.exit(1);
  }

  log('Reading', IN_PATH);
  const data = readJsonArray(IN_PATH);

  // Select targets: missing color
  const targets = data.filter(r => isEmptyArray(r.color) && r.texture_image_url);
  if (!targets.length) {
    log('No records with missing `color` found. Nothing to do.');
    process.exit(0);
  }
  log(`Found ${targets.length} records with missing color. Processing in batches of ${BATCH_SIZE}.`);

  // Process batches
  let processed = 0, updated = 0, errors = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);

    log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: items ${i + 1}–${i + batch.length}`);

    // Run each item in the batch sequentially to keep output stable; you can
    // change to parallel if your rate limits allow.
    for (const item of batch) {
      processed++;
      try {
        const inference = await analyzeOne(item);

        // Find the original record in data and mutate in place
        const idx = data.findIndex(x => x.code === item.code);
        if (idx !== -1) {
          const rec = data[idx];

          // Only set if empty or OVERWRITE is true
          if (OVERWRITE || isEmptyArray(rec.color)) rec.color = inference.color;
          if (OVERWRITE || isEmptyArray(rec.design_groups)) rec.design_groups = inference.design_groups;
          if (OVERWRITE || isEmptyArray(rec.shade)) rec.shade = inference.shade;
          if (OVERWRITE || !rec.description) rec.description = inference.description;

          updated++;
          log(`✓ ${rec.code}: color=${JSON.stringify(rec.color)} groups=${JSON.stringify(rec.design_groups)} shade=${JSON.stringify(rec.shade)}`);
        }
        // Small delay to be gentle to the API
        await sleep(200);
      } catch (e) {
        errors++;
        log(`✗ ${item.code}: ${e.message}`);
      }
    }

    // After each batch, write to disk
    if (!DRY_RUN) {
      writeJsonArrayAtomic(OUT_PATH, data);
      log(`Wrote progress to ${OUT_PATH}`);
    } else {
      log('[dryRun] Skipped writing output.');
    }

    // Friendly pause between batches
    await sleep(500);
  }

  log(`Done. Processed=${processed}, Updated=${updated}, Errors=${errors}`);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
