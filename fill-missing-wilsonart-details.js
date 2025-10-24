// fill-missing-wilsonart-details.js
// Purpose:
//   Read wilsonart-laminate-details.json and, for every record that is missing `color`
//   (and optionally `design_groups`, `shade`, `description`), call OpenAI Vision on the
//   product's texture image to infer values, then update the JSON. Processes items in
//   batches of 5 by default.
//
// Usage:
//   OPENAI_API_KEY=sk-... node fill-missing-wilsonart-details.js
//   OPENAI_API_KEY=sk-... node fill-missing-wilsonart-details.js --in=wilsonart-laminate-details.json --out=wilsonart-laminate-details.json --model=gpt-4o-mini --batchSize=5 --overwrite=false --missing
//   OPENAI_API_KEY=sk-... node fill-missing-wilsonart-details.js --all --overwrite=true
//   Modes:
//     --missing (default)  : only infer colors for records that are missing them.
//     --all                : infer colors for every record, merging with existing colors.
//     --force              : infer colors for every record and overwrite existing colors.
//   Extras:
//     --design             : also infer design groups (multiple allowed) per processed record.
//     --description        : also infer a concise description per processed record.
//     --dry-run            : simulate without writing changes to disk or filters.js.
//
// Notes:
//   - By default only records with missing or empty `color` are selected (use --all or --force to override).
//     Color and shade are always refreshed for targeted records. Design groups and descriptions are only
//     updated when --design / --description are supplied. Existing non-empty fields are preserved unless
//     --overwrite=true or --force is used.
//   - Writes atomically via .tmp rename.
//   - Requires: `npm i openai`
//
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OpenAI = require('openai');

// Load environment variables from local files when running the script directly.
function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const ROOT_DIR = __dirname;
const FILTERS_PATH = path.join(ROOT_DIR, 'filters.js');
loadEnvFile(path.join(ROOT_DIR, '.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.local'), { override: true });

let filtersContext = loadColorSwatchMap();
let existingSwatchKeys = new Set(Object.keys(filtersContext?.map || {}));
const pendingSwatchUpdates = new Map();

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
function flag(name, def) {
  for (let i = 0; i < ARGV.length; i += 1) {
    const arg = ARGV[i];
    if (arg === `--${name}`) return true;
    if (arg === `--no-${name}`) return false;
    if (arg.startsWith(`--${name}=`)) {
      const raw = arg.slice(name.length + 3);
      if (raw === 'false') return false;
      if (raw === 'true') return true;
      if (raw === '') return '';
      const num = Number(raw);
      return Number.isNaN(num) ? raw : num;
    }
  }
  return def;
}

function coalesce() {
  for (let i = 0; i < arguments.length; i += 1) {
    if (arguments[i] !== undefined) return arguments[i];
  }
  return undefined;
}

function isFlagEnabled(raw, defaultValue = false) {
  if (raw === undefined) return defaultValue;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    if (raw.length === 0) return true;
    const low = raw.toLowerCase();
    if (low === 'false' || low === '0' || low === 'no') return false;
    return true;
  }
  return Boolean(raw);
}

const IN_PATH = path.resolve(process.cwd(), flag('in', 'wilsonart-laminate-details.json'));
const OUT_PATH = path.resolve(process.cwd(), flag('out', 'wilsonart-laminate-details.json'));
const MODEL = flag('model', 'gpt-4o-mini'); // vision-capable
const BATCH_SIZE = Math.max(1, Number(flag('batchSize', 5)));
const OVERWRITE = isFlagEnabled(flag('overwrite'), false);
const DRY_RUN = isFlagEnabled(coalesce(flag('dry-run'), flag('dryRun')), false);
const FORCE_RAW = flag('force');
const ALL_RAW = flag('all');
const MISSING_RAW = flag('missing');
const DESIGN_FLAG = isFlagEnabled(flag('design'), false);
const DESCRIPTION_FLAG = isFlagEnabled(flag('description'), false);

const selectedModes = [];
if (isFlagEnabled(FORCE_RAW)) selectedModes.push('force');
if (isFlagEnabled(ALL_RAW)) selectedModes.push('all');
if (isFlagEnabled(MISSING_RAW)) selectedModes.push('missing');

if (selectedModes.length > 1) {
  console.error('Specify only one of --missing, --all, or --force.');
  process.exit(1);
}

const MODE = selectedModes[0] || 'missing';
const MODE_DESC = {
  missing: '--missing (only records without color)',
  all: '--all (merge colors with existing values)',
  force: '--force (overwrite existing colors)'
}[MODE];

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

const LOG_OK = '[ok]';
const LOG_SKIP = '[skip]';
const LOG_ERR = '[err]';

async function withRetry(fn, {
  attempts = 6,
  baseDelay = 1000,
  maxDelay = 30000,
  label = 'request'
} = {}) {
  let attempt = 0;
  while (attempt < attempts) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const status = err?.status ?? err?.statusCode ?? err?.response?.status;
      const message = err?.message || err?.error?.message || '';
      const isRateLimit = status === 429 || err?.code === 'rate_limit_exceeded' || /rate limit/i.test(message);
      const isRetryable = isRateLimit || status === 408 || (status >= 500 && status < 600);
      if (!isRetryable || attempt >= attempts) {
        throw err;
      }
      const retryAfterHeader = err?.response?.headers?.['retry-after'] ?? err?.headers?.['retry-after'];
      let delay = Number(retryAfterHeader) * 1000;
      if (!Number.isFinite(delay) || delay <= 0) {
        delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
      }
      const jitter = Math.floor(Math.random() * 250);
      const totalDelay = Math.min(maxDelay, delay + jitter);
      log(`Rate limited on ${label}; retrying in ${totalDelay}ms (attempt ${attempt}/${attempts}).`);
      await sleep(totalDelay);
    }
  }
  throw new Error(`Failed to complete ${label} after ${attempts} attempts.`);
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

function writeTextFileAtomic(p, text) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, p);
}

function loadColorSwatchMap() {
  if (!fs.existsSync(FILTERS_PATH)) return null;
  const content = fs.readFileSync(FILTERS_PATH, 'utf-8');
  const regex = /const\s+COLOR_SWATCH_MAP\s*=\s*(\{[\s\S]*?\n\s*\});/;
  const match = content.match(regex);
  if (!match) return { content, map: {}, blockStart: -1, blockEnd: -1, blockText: '' };
  const objectLiteral = match[1];
  let map = {};
  try {
    map = vm.runInNewContext(`(${objectLiteral})`);
  } catch {
    log('Warning: Unable to parse COLOR_SWATCH_MAP; proceeding with empty map.');
    map = {};
  }
  const blockStart = match.index;
  const blockEnd = match.index + match[0].length;
  return {
    content,
    map,
    blockStart,
    blockEnd,
    blockText: match[0],
  };
}

function serializeColorSwatchMap(map) {
  const entries = Object.entries(map || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = entries.map(([key, value]) => {
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
    const safeValue = `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `  ${safeKey}: ${safeValue},`;
  });
  return `  const COLOR_SWATCH_MAP = {\n${lines.join('\n')}\n  };`;
}

function colorKeyFromValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return null;
  const key = String(value).trim().toLowerCase();
  return key || null;
}

function hslToHex(h, s, l) {
  const _s = s / 100;
  const _l = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = _s * Math.min(_l, 1 - _l);
  const f = (n) => _l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function defaultSwatchForKey(key) {
  if (!key) return '#94a3b8';
  const presets = {
    aqua: '#34d3eb',
    beige: '#f5deb3',
    black: '#111827',
    blue: '#3b82f6',
    bronze: '#cd7f32',
    brown: '#8b5e3c',
    copper: '#b87333',
    gold: '#fbbf24',
    gray: '#6b7280',
    green: '#22c55e',
    multicolor: 'linear-gradient(135deg, #f472b6 0%, #f97316 32%, #22d3ee 64%, #a855f7 100%)',
    navy: '#1d3557',
    neutral: '#d1d5db',
    'off-white': '#f2f4f7',
    orange: '#f97316',
    pink: '#f472b6',
    purple: '#a855f7',
    red: '#ef4444',
    silver: '#c0c0c0',
    tan: '#d2b48c',
    taupe: '#b0916e',
    teal: '#14b8a6',
    white: '#f9fafb',
    yellow: '#facc15',
  };
  if (presets[key]) return presets[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const normalized = (hash >>> 0);
  const hue = normalized % 360;
  const saturation = 55 + (normalized % 15);
  const lightness = 48 + (normalized % 10);
  return hslToHex(hue, saturation, lightness);
}

function ensureSwatchForColors(values) {
  const list = Array.isArray(values) ? values : [values];
  for (const raw of list) {
    const key = colorKeyFromValue(raw);
    if (!key) continue;
    if (existingSwatchKeys.has(key)) continue;
    const swatch = defaultSwatchForKey(key);
    pendingSwatchUpdates.set(key, swatch);
    existingSwatchKeys.add(key);
  }
}

function syncColorSwatchesIfNeeded() {
  if (DRY_RUN) {
    if (pendingSwatchUpdates.size) {
      log(`[dryRun] Skipping swatch sync for ${pendingSwatchUpdates.size} color key${pendingSwatchUpdates.size === 1 ? '' : 's'}.`);
      pendingSwatchUpdates.clear();
    }
    return;
  }
  if (!pendingSwatchUpdates.size) return;
  if (!filtersContext || filtersContext.blockStart === -1) {
    log('Warning: Could not locate COLOR_SWATCH_MAP block; skipping swatch sync.');
    pendingSwatchUpdates.clear();
    return;
  }
  const merged = Object.assign({}, filtersContext.map);
  let added = 0;
  for (const [key, value] of pendingSwatchUpdates) {
    if (merged[key] === value) continue;
    merged[key] = value;
    added += 1;
  }
  if (!added) {
    pendingSwatchUpdates.clear();
    return;
  }
  const newBlock = serializeColorSwatchMap(merged);
  const newContent = `${filtersContext.content.slice(0, filtersContext.blockStart)}${newBlock}${filtersContext.content.slice(filtersContext.blockEnd)}`;
  writeTextFileAtomic(FILTERS_PATH, newContent);
  filtersContext = loadColorSwatchMap();
  existingSwatchKeys = new Set(Object.keys(filtersContext?.map || {}));
  pendingSwatchUpdates.clear();
  log(`Synced ${added} new color swatch${added === 1 ? '' : 'es'} to filters.js.`);
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

function mergeColorLists(existing, additions) {
  const base = normalizeColors(existing);
  const extra = normalizeColors(additions);
  for (const color of extra) {
    if (!base.includes(color)) base.push(color);
  }
  return base;
}

function mergeDesignGroups(existing, additions) {
  const base = normalizeDesignGroups(existing);
  const extra = normalizeDesignGroups(additions);
  for (const group of extra) {
    if (!base.includes(group)) base.push(group);
  }
  return base;
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

  const resp = await withRetry(
    () => client.chat.completions.create({
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
    }),
    { label: `chat:${item.code}` }
  );

  const text = resp.choices?.[0]?.message?.content || '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Model did not return valid JSON');

  const out = {
    color: normalizeColors(parsed.color || []),
    design_groups: normalizeDesignGroups(parsed.design_groups || []),
    shade: normalizeShade(parsed.shade || []),
    description: String(parsed.description || '').trim()
  };
  ensureSwatchForColors(out.color);
  return out;
}

// ---------- Main ----------
(async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY environment variable.');
    process.exit(1);
  }

  log(`Options: mode=${MODE} design=${DESIGN_FLAG} description=${DESCRIPTION_FLAG} overwrite=${OVERWRITE} dryRun=${DRY_RUN} batchSize=${BATCH_SIZE}`);
  log('Reading', IN_PATH);
  const data = readJsonArray(IN_PATH);

  for (const record of data) {
    ensureSwatchForColors(record?.color);
    ensureSwatchForColors(record?.colors);
  }
  syncColorSwatchesIfNeeded();

  // Select targets: missing color
  const targets = data.filter((record) => {
    if (!record || !record.texture_image_url) return false;
    if (MODE === 'missing') return isEmptyArray(record.color);
    return true;
  });
  if (!targets.length) {
    log(`No records matched the ${MODE_DESC} criteria. Nothing to do.`);
    process.exit(0);
  }
  log(`Found ${targets.length} records to process (${MODE_DESC}). Processing in batches of ${BATCH_SIZE}.`);

  // Process batches
  let processed = 0, updated = 0, errors = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);

    log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: items ${i + 1}-${i + batch.length}`);

    // Run each item in the batch sequentially to keep output stable; you can
    // change to parallel if your rate limits allow.
    for (const item of batch) {
      processed++;
      try {
        const inference = await analyzeOne(item);

        const idx = data.findIndex(x => x.code === item.code);
        if (idx !== -1) {
          const rec = data[idx];
          const prev = {
            color: JSON.stringify(rec.color ?? null),
            design: JSON.stringify(rec.design_groups ?? null),
            shade: JSON.stringify(rec.shade ?? null),
            description: rec.description ?? ''
          };

          if (MODE === 'force') {
            rec.color = inference.color;
          } else if (MODE === 'all') {
            rec.color = mergeColorLists(rec.color, inference.color);
          } else if (isEmptyArray(rec.color)) {
            rec.color = inference.color;
          }
          ensureSwatchForColors(rec.color);

          if (MODE === 'force') {
            rec.shade = inference.shade;
          } else if (OVERWRITE || isEmptyArray(rec.shade)) {
            rec.shade = inference.shade;
          }

          if (DESIGN_FLAG) {
            if (MODE === 'force' || OVERWRITE) {
              rec.design_groups = normalizeDesignGroups(inference.design_groups);
            } else if (MODE === 'all') {
              rec.design_groups = mergeDesignGroups(rec.design_groups, inference.design_groups);
            } else if (isEmptyArray(rec.design_groups)) {
              rec.design_groups = normalizeDesignGroups(inference.design_groups);
            }
          }

          if (DESCRIPTION_FLAG) {
            if (MODE === 'force' || OVERWRITE || !rec.description) {
              rec.description = inference.description;
            }
          }

          const next = {
            color: JSON.stringify(rec.color ?? null),
            design: JSON.stringify(rec.design_groups ?? null),
            shade: JSON.stringify(rec.shade ?? null),
            description: rec.description ?? ''
          };

          const changed = prev.color !== next.color ||
            prev.design !== next.design ||
            prev.shade !== next.shade ||
            prev.description !== next.description;

          if (changed) {
            updated++;
            const parts = [
              `color=${JSON.stringify(rec.color || [])}`,
              `shade=${JSON.stringify(rec.shade || [])}`
            ];
            if (DESIGN_FLAG) parts.push(`design_groups=${JSON.stringify(rec.design_groups || [])}`);
            if (DESCRIPTION_FLAG) parts.push(`description="${rec.description || ''}"`);
            log(`${LOG_OK} ${rec.code}: ${parts.join(' ')}`);
          } else {
            log(`${LOG_SKIP} ${rec.code}: no changes needed.`);
          }
        }

        // Small delay to be gentle to the API
        await sleep(200);
      } catch (e) {
        errors++;
        log(`${LOG_ERR} ${item.code}: ${e.message}`);
      }
    }
    // After each batch, write to disk
    if (!DRY_RUN) {
      writeJsonArrayAtomic(OUT_PATH, data);
      log(`Wrote progress to ${OUT_PATH}`);
    } else {
      log('[dryRun] Skipped writing output.');
    }
    syncColorSwatchesIfNeeded();

    // Friendly pause between batches
    await sleep(500);
  }

  log(`Done. Processed=${processed}, Updated=${updated}, Errors=${errors}`);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
