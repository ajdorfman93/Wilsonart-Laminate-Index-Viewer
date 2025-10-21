/* filters.js
   Builds faceted filters + search and applies them to your dataset.
   Usage:
     Filters.init({
       data,                 // array of records
       containerId: 'filters',
       queryInput: document.getElementById('q'),
       onChange: (state) => { /* re-render table here with Filters.apply(data) */ }
     })
*/

(function (global) {
  const DEFAULT_STATE = {
    query: '',
    withImageOnly: false,
    // facet selections are Sets of strings/booleans
    facets: {
      'surface-group': new Set(),
      design_groups: new Set(),
      color: new Set(),
      shade: new Set(),
      finish: new Set(),       // finish[].name
      finish_code: new Set(),  // finish[].code
      design_collections: new Set(),
      no_repeat: new Set(),    // 'Yes' | 'No'
    }
  };

  const state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  const facetMeta = {}; // { facetKey: {label, values: Map(value -> count)} }

  let _opts = null;
  let _debTimer = null;

  function debounce(fn, ms = 160) {
    clearTimeout(_debTimer);
    _debTimer = setTimeout(fn, ms);
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
        for (const f of r.finish) {
          if (f?.name) bump(m.finish.values, f.name);
          if (f?.code) bump(m.finish_code.values, f.code);
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
      _opts.onChange?.(state);
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
        input.checked = state.facets[facetKey]?.has?.(String(val)) || false;
        input.addEventListener('change', (e) => {
          const fk = e.target.getAttribute('data-facet');
          const vv = e.target.getAttribute('data-value');
          const set = state.facets[fk] || (state.facets[fk] = new Set());
          if (e.target.checked) set.add(vv);
          else set.delete(vv);
          _opts.onChange?.(state);
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
          _opts.onChange?.(state);
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
    const matchesFinish  = mustMatch('finish', r => (Array.isArray(r.finish) ? r.finish.map(f => f?.name).filter(Boolean) : []));
    const matchesFCode   = mustMatch('finish_code', r => (Array.isArray(r.finish) ? r.finish.map(f => f?.code).filter(Boolean) : []));
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
    const hay = [
      row.code, row.name, row['surface-group'], row.description, row.texture_image_url,
      ...(arrify(row.design_groups)), ...(arrify(row.color)), ...(arrify(row.shade)),
      ...(arrify(row.design_collections)), ...(arrify(row.performace_enchancments)),
      ...(arrify(row.species)), ...(arrify(row.cut)), ...(arrify(row.match)),
      ...(Array.isArray(row.finish) ? row.finish.flatMap(f => [f?.code, f?.name]) : [])
    ].filter(Boolean).map(s => String(s).toLowerCase());
    return hay.some(s => s.includes(q));
  }

  // Public API
  const Filters = {
    init(opts) {
      _opts = opts || {};
      Object.assign(state, DEFAULT_STATE);
      Object.setPrototypeOf(state.facets, null);

      // build facet dictionary
      Object.assign(facetMeta, buildFacets(_opts.data));
      renderUI();
      _opts.onChange?.(state);
      return this;
    },
    apply(data) {
      return (data || []).filter(r => matchesFacets(r) && matchesQuery(r));
    },
    selections() { return state; },
    reset() {
      Object.assign(state, JSON.parse(JSON.stringify(DEFAULT_STATE)));
      renderUI();
      _opts.onChange?.(state);
    }
  };

  global.Filters = Filters;
})(window);
