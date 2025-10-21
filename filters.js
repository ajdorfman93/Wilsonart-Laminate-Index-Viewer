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
    'shade',
    'finish',
    'finish_code',
    'design_collections',
    'no_repeat',
  ];

  function createDefaultState() {
    const facets = Object.create(null);
    for (let i = 0; i < FACET_KEYS.length; i += 1) {
      facets[FACET_KEYS[i]] = new Set();
    }
    return {
      query: '',
      withImageOnly: false,
      facets,
    };
  }

  function applyState(nextState) {
    state.query = nextState.query;
    state.withImageOnly = nextState.withImageOnly;
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
  const textOf = (v) => (v == null ? '' : String(v)).toLowerCase();

  // Build facet value maps (value -> count) from data
  function buildFacets(data) {
    const m = {
      'surface-group': { label: 'Surface', values: new Map() },
      design_groups: { label: 'Design Groups', values: new Map() },
      color: { label: 'Color', values: new Map() },
      shade: { label: 'Shade', values: new Map() },
      finish: { label: 'Finish', values: new Map() },        // finish[].name
      finish_code: { label: 'Finish Code', values: new Map() }, // finish[].code
      design_collections: { label: 'Collections', values: new Map() },
      no_repeat: { label: 'No Repeat', values: new Map() },  // "Yes"/"No"
    };

    const bump = (map, key) => {
      if (!key && key !== false) return;
      map.set(key, (map.get(key) || 0) + 1);
    };

    for (const r of data) {
      bump(m['surface-group'].values, r['surface-group']);

      for (const v of arrify(r.design_groups)) bump(m.design_groups.values, v);
      for (const v of arrify(r.color)) bump(m.color.values, v);
      for (const v of arrify(r.shade)) bump(m.shade.values, v);
      for (const v of arrify(r.design_collections)) bump(m.design_collections.values, v);

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

    // Header row – quick toggles
    const bar = document.createElement('div');
    bar.className = 'filters-bar';

    const imgOnly = document.createElement('label');
    imgOnly.className = 'filters-toggle';
    imgOnly.innerHTML = `
      <input type="checkbox" id="filter-has-image">
      <span>Only with image</span>
    `;
    bar.appendChild(imgOnly);
    root.appendChild(bar);

    const imgOnlyInput = imgOnly.querySelector('input');
    imgOnlyInput.checked = state.withImageOnly;
    imgOnlyInput.addEventListener('change', () => {
      state.withImageOnly = imgOnlyInput.checked;
      triggerChange();
    });

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
      for (const [val, count] of meta.values.entries()) {
        const id = `facet_${facetKey}_${String(val).replace(/[^a-z0-9]+/gi, '_')}_${count}`;
        const row = document.createElement('label');
        row.className = 'facet-row';
        row.innerHTML = `
          <input type="checkbox" id="${id}" data-facet="${facetKey}" data-value="${String(val)}">
          <span class="facet-val">${String(val)}</span>
          <span class="facet-count">(${count})</span>
        `;
        const input = row.querySelector('input');
        const selectable = state.facets[facetKey];
        input.checked = !!(selectable && selectable.has(String(val)));
        input.addEventListener('change', (e) => {
          const fk = e.target.getAttribute('data-facet');
          const vv = e.target.getAttribute('data-value');
          const set = state.facets[fk] || (state.facets[fk] = new Set());
          if (e.target.checked) set.add(vv);
          else set.delete(vv);
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
    const matchesColor   = mustMatch('color', r => arrify(r.color));
    const matchesShade   = mustMatch('shade', r => arrify(r.shade));
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
    const matchesColl    = mustMatch('design_collections', r => arrify(r.design_collections));
    const matchesNR      = mustMatch('no_repeat', r => [r.no_repeat === true ? 'Yes' : (r.no_repeat === false ? 'No' : '')].filter(Boolean));

    const hasImage = !state.withImageOnly || !!row.texture_image_url;

    return matchesSurface && matchesDG && matchesColor && matchesShade &&
           matchesFinish && matchesFCode && matchesColl && matchesNR && hasImage;
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
      arrify(row.design_groups),
      arrify(row.color),
      arrify(row.shade),
      arrify(row.design_collections),
      arrify(row.performace_enchancments),
      arrify(row.species),
      arrify(row.cut),
      arrify(row.match),
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
