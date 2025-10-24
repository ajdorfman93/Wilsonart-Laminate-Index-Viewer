/* filters.js
   Builds faceted filters + search and applies them to your dataset.
   Usage:
     Filters.init({
       data,                 // array of records
       containerId: 'filters',
       queryInput: document.getElementById('q'),
       onChange: (state) => {
         renderTable(Filters.apply(data));
       }
     });
*/

(function (global) {
  const FACET_KEYS = [
    'surface-group',
    'design_groups',
    'color',
    'species',
    'cut',
    'match',
    'shade',
    'finish',
    'finish_code',
    'design_collections',
    'specialty_features',
    'performance_enhancements',
    'no_repeat',
  ];

  const COLOR_SWATCH_MAP = {
    black: '#111827',
    blue: '#3b82f6',
    brown: '#8b5e3c',
    gray: '#6b7280',
    green: '#22c55e',
    multicolor: 'linear-gradient(135deg, #f472b6 0%, #f97316 32%, #22d3ee 64%, #a855f7 100%)',
    neutral: '#d1d5db',
    orange: '#f97316',
    purple: '#a855f7',
    red: '#ef4444',
    taupe: '#b0916e',
    white: '#f9fafb',
    yellow: '#facc15',
  };

  function resolveColorSwatch(value) {
    if (!value) return '#94a3b8';
    const key = String(value).trim().toLowerCase();
    return COLOR_SWATCH_MAP[key] || '#94a3b8';
  }

  function createDefaultState() {
    const facets = Object.create(null);
    for (let i = 0; i < FACET_KEYS.length; i += 1) {
      facets[FACET_KEYS[i]] = new Set();
    }
    return {
      query: '',
      withImageOnly: false,
      withoutImageOnly: false,
      facets,
    };
  }

  function applyState(nextState) {
    state.query = nextState.query;
    state.withImageOnly = !!nextState.withImageOnly;
    state.withoutImageOnly = !!nextState.withoutImageOnly;
    if (state.withImageOnly && state.withoutImageOnly) {
      state.withoutImageOnly = false;
    }
    const freshFacets = Object.create(null);
    for (let i = 0; i < FACET_KEYS.length; i += 1) {
      const key = FACET_KEYS[i];
      const source = nextState.facets[key];
      if (source instanceof Set) {
        freshFacets[key] = new Set(source);
      } else if (source && typeof source.forEach === 'function') {
        const copy = new Set();
        source.forEach((value) => copy.add(value));
        freshFacets[key] = copy;
      } else if (Array.isArray(source)) {
        freshFacets[key] = new Set(source);
      } else {
        freshFacets[key] = new Set();
      }
    }
    state.facets = freshFacets;
  }

  function resetFacetMeta(newMeta) {
    const existingKeys = Object.keys(facetMeta);
    for (let i = 0; i < existingKeys.length; i += 1) {
      delete facetMeta[existingKeys[i]];
    }
    Object.assign(facetMeta, newMeta);
  }

  const state = createDefaultState();
  const facetMeta = {}; // { facetKey: {label, values: Map(value -> count)} }

  let _opts = {};
  let _debTimer = null;
  let _hideImageToggles = false;

  function debounce(fn, ms = 160) {
    clearTimeout(_debTimer);
    _debTimer = setTimeout(fn, ms);
  }

  function triggerChange() {
    if (typeof _opts.onChange === 'function') {
      _opts.onChange(state);
    }
  }

  // --------- Helpers ----------
  const arrify = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);

  function collectFacetValues(record, keys) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < keys.length; i += 1) {
      const raw = record ? record[keys[i]] : undefined;
      const values = arrify(raw);
      for (let j = 0; j < values.length; j += 1) {
        const candidate = values[j];
        if (candidate == null) continue;
        if (typeof candidate === 'string') {
          const trimmed = candidate.trim();
          if (!trimmed) continue;
          const dedupeKey = trimmed.toLowerCase();
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          out.push(trimmed);
        } else {
          const dedupeKey = JSON.stringify(candidate);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          out.push(candidate);
        }
      }
    }
    return out;
  }

  // Build facet value maps (value -> count) from data
  function buildFacets(data) {
    const m = {
      'surface-group': { label: 'Surface', values: new Map() },
      design_groups: { label: 'Design Groups', values: new Map() },
      color: { label: 'Color', values: new Map() },
      species: { label: 'Species', values: new Map() },
      cut: { label: 'Cut', values: new Map() },
      match: { label: 'Match', values: new Map() },
      shade: { label: 'Shade', values: new Map() },
      finish: { label: 'Finish', values: new Map() },        // finish[].name
      finish_code: { label: 'Finish Code', values: new Map() }, // finish[].code
      design_collections: { label: 'Collections', values: new Map() },
      specialty_features: { label: 'Specialty Features', values: new Map() },
      performance_enhancements: { label: 'Performance Enhancements', values: new Map() },
      no_repeat: { label: 'No Repeat', values: new Map() },  // "Yes"/"No"
    };

    const bump = (map, key) => {
      if (!key && key !== false) return;
      map.set(key, (map.get(key) || 0) + 1);
    };

    for (const r of data) {
      bump(m['surface-group'].values, r['surface-group']);

      for (const v of collectFacetValues(r, ['design_groups'])) bump(m.design_groups.values, v);
      for (const v of collectFacetValues(r, ['colors', 'color'])) bump(m.color.values, v);
      for (const v of collectFacetValues(r, ['species'])) bump(m.species.values, v);
      for (const v of collectFacetValues(r, ['cut'])) bump(m.cut.values, v);
      for (const v of collectFacetValues(r, ['match'])) bump(m.match.values, v);
      for (const v of collectFacetValues(r, ['shade'])) bump(m.shade.values, v);
      for (const v of collectFacetValues(r, ['design_collections'])) bump(m.design_collections.values, v);
      for (const v of collectFacetValues(r, ['specialty_features', 'specality_features'])) bump(m.specialty_features.values, v);
      for (const v of collectFacetValues(r, ['performance_enhancements', 'performace_enchancments'])) bump(m.performance_enhancements.values, v);

      if (Array.isArray(r.finish)) {
        for (let i = 0; i < r.finish.length; i += 1) {
          const f = r.finish[i];
          if (f && f.name) bump(m.finish.values, f.name);
          if (f && f.code) bump(m.finish_code.values, f.code);
        }
      }

      const yn = r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : null);
      if (yn) bump(m.no_repeat.values, yn);
    }

    // sort facet values alpha
    for (const k of Object.keys(m)) {
      const sorted = [...m[k].values.entries()].sort((a, b) =>
        String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: 'base' })
      );
      m[k].values = new Map(sorted);
    }
    return m;
  }

  // Build UI
  function renderUI() {
    const root = document.getElementById(_opts.containerId);
    if (!root) return;
    root.innerHTML = '';

    // Header row - quick toggles
    if (!_hideImageToggles) {
      const bar = document.createElement('div');
      bar.className = 'filters-bar';

      const imgOnly = document.createElement('label');
      imgOnly.className = 'filters-toggle';
      imgOnly.innerHTML = `
        <input type="checkbox" id="filter-has-image">
        <span>Only with image</span>
      `;
      bar.appendChild(imgOnly);

      const noImg = document.createElement('label');
      noImg.className = 'filters-toggle';
      noImg.innerHTML = `
        <input type="checkbox" id="filter-no-image">
        <span>Only without image</span>
      `;
      bar.appendChild(noImg);

      root.appendChild(bar);

      const imgOnlyInput = imgOnly.querySelector('input');
      const noImgInput = noImg.querySelector('input');
      imgOnlyInput.checked = !!state.withImageOnly;
      noImgInput.checked = !!state.withoutImageOnly;
      imgOnlyInput.addEventListener('change', () => {
        const checked = !!imgOnlyInput.checked;
        state.withImageOnly = checked;
        if (checked) {
          state.withoutImageOnly = false;
          noImgInput.checked = false;
        }
        triggerChange();
      });
      noImgInput.addEventListener('change', () => {
        const checked = !!noImgInput.checked;
        state.withoutImageOnly = checked;
        if (checked) {
          state.withImageOnly = false;
          imgOnlyInput.checked = false;
        }
        triggerChange();
      });
    }

    // Facet groups
    const groupsWrap = document.createElement('div');
    groupsWrap.className = 'filters-groups';
    root.appendChild(groupsWrap);

    for (const [facetKey, meta] of Object.entries(facetMeta)) {
      if (!meta.values.size) continue;
      const section = document.createElement('details');
      section.open = ['design_groups', 'color', 'finish'].includes(facetKey); // expand a few by default
      section.className = 'facet';

      const sum = document.createElement('summary');
      sum.textContent = meta.label;
      section.appendChild(sum);

      const list = document.createElement('div');
      list.className = 'facet-body';
      if (facetKey === 'color') list.classList.add('facet-body-color');
      for (const [val, count] of meta.values.entries()) {
        const valueStr = String(val);
        const id = `facet_${facetKey}_${valueStr.replace(/[^a-z0-9]+/gi, '_')}_${count}`;
        const row = document.createElement('label');
        let input = null;

        if (facetKey === 'color') {
          row.className = 'color-swatch';
          row.setAttribute('title', `${valueStr} (${count})`);

          input = document.createElement('input');
          input.type = 'checkbox';
          input.id = id;
          input.setAttribute('data-facet', facetKey);
          input.setAttribute('data-value', valueStr);
          row.appendChild(input);

          const swatch = document.createElement('span');
          swatch.className = 'swatch';
          swatch.style.setProperty('--swatch-color', resolveColorSwatch(valueStr));
          row.appendChild(swatch);

          const metaWrap = document.createElement('span');
          metaWrap.className = 'color-meta';

          const nameEl = document.createElement('span');
          nameEl.className = 'color-name';
          nameEl.textContent = valueStr;
          metaWrap.appendChild(nameEl);

          const countEl = document.createElement('span');
          countEl.className = 'facet-count';
          countEl.textContent = `(${count})`;
          metaWrap.appendChild(countEl);

          row.appendChild(metaWrap);
        } else {
          row.className = 'facet-row';
          row.innerHTML = `
            <input type="checkbox" id="${id}" data-facet="${facetKey}" data-value="${valueStr}">
            <span class="facet-val">${valueStr}</span>
            <span class="facet-count">(${count})</span>
          `;
          input = row.querySelector('input');
        }

        if (!input) continue;
        const selectable = state.facets[facetKey];
        input.checked = !!(selectable && selectable.has(valueStr));
        if (facetKey === 'color') {
          row.classList.toggle('is-active', input.checked);
        }
        input.addEventListener('change', (e) => {
          const fk = e.target.getAttribute('data-facet');
          const vv = e.target.getAttribute('data-value');
          const set = state.facets[fk] || (state.facets[fk] = new Set());
          if (e.target.checked) set.add(vv);
          else set.delete(vv);
          if (facetKey === 'color') {
            row.classList.toggle('is-active', e.target.checked);
          }
          triggerChange();
        });
        list.appendChild(row);
      }
      section.appendChild(list);
      groupsWrap.appendChild(section);
    }

    // Wire search input if provided
    if (_opts.queryInput) {
      _opts.queryInput.value = state.query;
      _opts.queryInput.addEventListener('input', () =>
        debounce(() => {
          state.query = _opts.queryInput.value || '';
          triggerChange();
        }, 120)
      );
    }
  }

  // Core matcher for a row against current selections
  function matchesFacets(row) {
    // each facet: if selections exist, row must match at least one
    const mustMatch = (facetKey, getValues) => {
      const picked = state.facets[facetKey];
      if (!picked || picked.size === 0) return true;
      const rowVals = getValues(row).map(v => String(v));
      for (const v of picked) {
        if (rowVals.includes(v)) return true;
      }
      return false;
    };

    const matchesSurface = mustMatch('surface-group', r => arrify(r['surface-group']));
    const matchesDG      = mustMatch('design_groups', r => arrify(r.design_groups));
    const matchesColor   = mustMatch('color', r => collectFacetValues(r, ['colors', 'color']));
    const matchesSpecies = mustMatch('species', r => collectFacetValues(r, ['species']));
    const matchesCut     = mustMatch('cut', r => collectFacetValues(r, ['cut']));
    const matchesMatch   = mustMatch('match', r => collectFacetValues(r, ['match']));
    const matchesShade   = mustMatch('shade', r => collectFacetValues(r, ['shade']));
    const matchesFinish = mustMatch('finish', (record) => {
      if (!Array.isArray(record.finish)) return [];
      const values = [];
      for (let i = 0; i < record.finish.length; i += 1) {
        const entry = record.finish[i];
        if (entry && entry.name) values.push(entry.name);
      }
      return values;
    });

    const matchesFCode = mustMatch('finish_code', (record) => {
      if (!Array.isArray(record.finish)) return [];
      const values = [];
      for (let i = 0; i < record.finish.length; i += 1) {
        const entry = record.finish[i];
        if (entry && entry.code) values.push(entry.code);
      }
      return values;
    });
    const matchesColl    = mustMatch('design_collections', r => collectFacetValues(r, ['design_collections']));
    const matchesSpecFeat = mustMatch('specialty_features', r => collectFacetValues(r, ['specialty_features', 'specality_features']));
    const matchesPerf    = mustMatch('performance_enhancements', r => collectFacetValues(r, ['performance_enhancements', 'performace_enchancments']));
    const matchesNR      = mustMatch('no_repeat', r => [r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : '')].filter(Boolean));

    const hasImage = !!row.texture_image_url;
    let imageToggleOk = true;
    if (state.withImageOnly) imageToggleOk = hasImage;
    else if (state.withoutImageOnly) imageToggleOk = !hasImage;

    return matchesSurface && matchesDG && matchesColor && matchesSpecies &&
           matchesCut && matchesMatch && matchesShade &&
           matchesFinish && matchesFCode && matchesColl &&
           matchesSpecFeat && matchesPerf && matchesNR && imageToggleOk;
  }

  // Search across common text fields
  function matchesQuery(row) {
    const q = (state.query || '').trim().toLowerCase();
    if (!q) return true;
    const haystack = [];

    const scalarFields = [
      row.code,
      row.name,
      row['surface-group'],
      row.description,
      row.texture_image_url,
    ];

    for (let i = 0; i < scalarFields.length; i += 1) {
      const value = scalarFields[i];
      if (value) haystack.push(value);
    }

    const arrayFields = [
      collectFacetValues(row, ['design_groups']),
      collectFacetValues(row, ['colors', 'color']),
      collectFacetValues(row, ['shade']),
      collectFacetValues(row, ['design_collections']),
      collectFacetValues(row, ['performance_enhancements', 'performace_enchancments']),
      collectFacetValues(row, ['specialty_features', 'specality_features']),
      collectFacetValues(row, ['species']),
      collectFacetValues(row, ['cut']),
      collectFacetValues(row, ['match']),
    ];

    for (let i = 0; i < arrayFields.length; i += 1) {
      const collection = arrayFields[i];
      for (let j = 0; j < collection.length; j += 1) {
        if (collection[j]) haystack.push(collection[j]);
      }
    }

    if (Array.isArray(row.finish)) {
      for (let i = 0; i < row.finish.length; i += 1) {
        const finishEntry = row.finish[i];
        if (!finishEntry) continue;
        if (finishEntry.code) haystack.push(finishEntry.code);
        if (finishEntry.name) haystack.push(finishEntry.name);
      }
    }

    for (let i = 0; i < haystack.length; i += 1) {
      const needle = String(haystack[i]).toLowerCase();
      if (needle.includes(q)) return true;
    }
    return false;
  }

  // Public API
  const Filters = {
    init(opts) {
      _opts = opts || {};
      applyState(createDefaultState());
      const sourceData = Array.isArray(_opts.data) ? _opts.data : [];
      _hideImageToggles = sourceData.length > 0 && sourceData.every((record) => !!(record && record.texture_image_url));
      if (_hideImageToggles) {
        state.withImageOnly = false;
        state.withoutImageOnly = false;
      }
      resetFacetMeta(buildFacets(sourceData));
      renderUI();
      triggerChange();
      return this;
    },
    apply(data) {
      const source = Array.isArray(data) ? data : [];
      return source.filter(r => matchesFacets(r) && matchesQuery(r));
    },
    selections() { return state; },
    reset() {
      applyState(createDefaultState());
      renderUI();
      triggerChange();
    }
  };

  global.Filters = Filters;
})(window);
