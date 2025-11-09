(function () {
  const SELECTED_ROW_CLASS = 'is-compared';
  const COMPARE_HEADER_CLASS = 'compare-col';
  const COMPARE_CELL_CLASS = 'compare-cell';
  const COMPARE_BUTTON_CLASS = 'compare-btn';
  const COMPARE_OPEN_CLASS = 'is-compare-open';
  const COMPARE_FOCUS_CLASS = 'compare-focus';

  const selectedProducts = new Map();

  function init() {
    const headRow = document.getElementById('head-row');
    const bodyRows = document.getElementById('body-rows');
    if (!headRow || !bodyRows) return;

    const sidebar = createSidebar();

    const closeBtn = sidebar.container.querySelector('.compare-close');
    if (closeBtn && !closeBtn.dataset.compareBound) {
      closeBtn.dataset.compareBound = '1';
      closeBtn.addEventListener('click', () => {
        clearSelections();
      });
    }

    const bodyObserver = new MutationObserver(() => {
      ensureHeader();
      renderAllRows();
      updateSidebar();
    });

    const headerObserver = new MutationObserver(() => {
      ensureHeader();
    });

    ensureHeader();
    renderAllRows();
    updateSidebar();

    bodyObserver.observe(bodyRows, { childList: true });
    headerObserver.observe(headRow, { childList: true });

    function ensureHeader() {
      let th = headRow.querySelector(`th.${COMPARE_HEADER_CLASS}`);
      if (!th) {
        th = document.createElement('th');
        th.scope = 'col';
        th.className = COMPARE_HEADER_CLASS;
        th.textContent = 'Compare';
      }
      if (headRow.children[1] !== th) {
        headRow.insertBefore(th, headRow.children[1] || null);
      }
    }

    function renderAllRows() {
      const rows = bodyRows.querySelectorAll('tr');
      rows.forEach(prepareRow);
      updateRowStates();
    }

    function prepareRow(tr) {
      const data = extractRowData(tr);
      if (!data) return;

      tr.dataset.compareKey = data.key;
      tr.dataset.compareAnchor = data.anchorId;

      if (selectedProducts.has(data.key)) {
        selectedProducts.set(data.key, { ...selectedProducts.get(data.key), ...data });
      }

      let cell = tr.querySelector(`td.${COMPARE_CELL_CLASS}`);
      let button = cell ? cell.querySelector(`button.${COMPARE_BUTTON_CLASS}`) : null;

      if (!cell) {
        cell = document.createElement('td');
        cell.className = COMPARE_CELL_CLASS;

        button = document.createElement('button');
        button.type = 'button';
        button.className = COMPARE_BUTTON_CLASS;
        button.textContent = 'Compare';
        button.setAttribute('aria-pressed', 'false');

        cell.appendChild(button);
        tr.appendChild(cell);

        button.addEventListener('click', () => {
          const latest = extractRowData(tr);
          if (!latest) return;
          if (selectedProducts.has(latest.key)) {
            selectedProducts.delete(latest.key);
          } else {
            selectedProducts.set(latest.key, latest);
          }
          updateRowStates();
          updateSidebar();
        });
      }

      if (!button) return;

      if (tr.children[1] !== cell) {
        tr.insertBefore(cell, tr.children[1] || null);
      }

      updateRowState(tr, button);
    }

    function updateRowState(tr, button) {
      const key = tr.dataset.compareKey;
      const isSelected = key ? selectedProducts.has(key) : false;
      if (isSelected) {
        tr.classList.add(SELECTED_ROW_CLASS);
        button.textContent = 'Selected';
        button.setAttribute('aria-pressed', 'true');
      } else {
        tr.classList.remove(SELECTED_ROW_CLASS);
        button.textContent = 'Compare';
        button.setAttribute('aria-pressed', 'false');
      }
    }

    function updateRowStates() {
      bodyRows.querySelectorAll('tr').forEach((tr) => {
        const cell = tr.querySelector(`td.${COMPARE_CELL_CLASS}`);
        const button = cell ? cell.querySelector(`button.${COMPARE_BUTTON_CLASS}`) : null;
        if (!button) return;
        updateRowState(tr, button);
      });
    }

    function updateSidebar() {
      const count = selectedProducts.size;
      const { container, message, products } = sidebar;

      if (!count) {
        container.classList.add('is-hidden');
        document.body.classList.remove(COMPARE_OPEN_CLASS);
        message.textContent = '';
        products.innerHTML = '';
        return;
      }

      container.classList.remove('is-hidden');
      document.body.classList.add(COMPARE_OPEN_CLASS);

      products.innerHTML = '';
      selectedProducts.forEach((product) => {
        products.appendChild(renderProductCard(product));
      });

      message.textContent = count === 1 ? 'Select more products to compare.' : '';
    }

    function renderProductCard(product) {
      const card = document.createElement('div');
      card.className = 'compare-card';
      card.dataset.anchor = product.anchorId || '';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'compare-card__remove';
      closeBtn.setAttribute('aria-label', `Remove ${product.code || product.name || 'selection'} from compare`);
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (product.key && selectedProducts.has(product.key)) {
          selectedProducts.delete(product.key);
          updateRowStates();
          updateSidebar();
        }
      });

      const link = document.createElement('a');
      link.className = 'compare-card__link';
      link.href = product.anchorId ? `#${product.anchorId}` : '#';
      link.tabIndex = 0;

      const media = document.createElement('div');
      media.className = 'compare-card__media';

      if (product.imageUrl) {
        const img = document.createElement('img');
        img.src = product.imageUrl;
        img.alt = product.imageAlt || `${product.code || ''} ${product.name || ''}`.trim();
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        media.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'compare-card__placeholder';
        placeholder.textContent = 'No image';
        media.appendChild(placeholder);
      }

      const meta = document.createElement('div');
      meta.className = 'compare-card__meta';

      if (product.code) {
        const codeEl = document.createElement('div');
        codeEl.className = 'compare-card__code';
        codeEl.textContent = product.code;
        meta.appendChild(codeEl);
      }

      if (product.name) {
        const nameEl = document.createElement('div');
        nameEl.className = 'compare-card__name';
        nameEl.textContent = product.name;
        meta.appendChild(nameEl);
      }

      link.appendChild(media);
      link.appendChild(meta);

      if (product.anchorId) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          focusRow(product.anchorId);
        });
        link.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Space' || event.key === 'Spacebar') {
            event.preventDefault();
            focusRow(product.anchorId);
          }
        });
      }

      card.appendChild(closeBtn);
      card.appendChild(link);
      return card;
    }

    function focusRow(anchorId) {
      const row = anchorId ? document.getElementById(anchorId) : null;
      if (!row) return;
      row.classList.add(COMPARE_FOCUS_CLASS);
      try {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        row.scrollIntoView();
      }
      if (!row.hasAttribute('tabindex')) {
        row.setAttribute('tabindex', '-1');
      }
      try {
        row.focus({ preventScroll: true });
      } catch (err) {
        if (typeof row.focus === 'function') {
          row.focus();
        }
      }
      if (typeof window !== 'undefined') {
        try {
          if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState(null, '', `#${anchorId}`);
          } else if (window.location) {
            window.location.hash = anchorId;
          }
        } catch (err) {
          // ignore hash navigation issues
        }
      }
      window.setTimeout(() => {
        row.classList.remove(COMPARE_FOCUS_CLASS);
      }, 1200);
    }

    function clearSelections() {
      if (!selectedProducts.size) return;
      selectedProducts.clear();
      updateRowStates();
      updateSidebar();
    }

    function extractRowData(tr) {
      if (!tr || tr.nodeName !== 'TR') return null;
      const codeCell = tr.querySelector('td.col-code');
      const nameCell = tr.querySelector('td.col-name');
      const typeCell = tr.querySelector('td.col-type');
      const imageButton = tr.querySelector('td.col-texture_image_url .thumb');

      const code = textContent(codeCell);
      const name = textContent(nameCell);
      const type = textContent(typeCell);
      const imageUrl = imageButton ? imageButton.getAttribute('data-full') || '' : '';
      const imageAlt = imageButton ? imageButton.getAttribute('data-alt') || '' : '';

      const keyParts = [type, code, name].filter(Boolean);
      if (!keyParts.length) return null;
      const key = keyParts.join('::');
      const rowNumber = getRowNumber(tr);
      const anchorId = ensureRowAnchor(tr, rowNumber, key);

      return {
        key,
        code,
        name,
        type,
        imageUrl,
        imageAlt,
        rowNumber,
        anchorId,
      };
    }
  }

  function textContent(node) {
    return node ? node.textContent.trim() : '';
  }

  function getRowNumber(tr) {
    const indexCell = tr ? tr.querySelector('td.col-index') : null;
    if (!indexCell) return NaN;
    const match = indexCell.textContent.match(/\d+/);
    return match ? parseInt(match[0], 10) : NaN;
  }

  function sanitizeKey(key) {
    return typeof key === 'string'
      ? key.replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
      : '';
  }

  function ensureRowAnchor(tr, rowNumber, key) {
    if (!tr) return '';
    let anchor = tr.dataset.compareAnchor || '';
    if (!anchor) {
      const safeKey = sanitizeKey(key);
      const base = safeKey || (Number.isFinite(rowNumber) ? `row-${rowNumber}` : `row-${Math.random().toString(36).slice(2, 8)}`);
      anchor = `compare-${base}`;
    }
    tr.dataset.compareAnchor = anchor;
    tr.id = anchor;
    if (!tr.hasAttribute('tabindex')) {
      tr.setAttribute('tabindex', '-1');
    }
    return anchor;
  }

  function createSidebar() {
    let container = document.getElementById('compare-sidebar');
    if (!container) {
      container = document.createElement('aside');
      container.id = 'compare-sidebar';
      container.className = 'compare-sidebar is-hidden';
      container.innerHTML = `
        <div class="compare-header">
          <h2>Compare</h2>
          <button type="button" class="compare-close" aria-label="Close compare sidebar">&times;</button>
        </div>
        <div class="compare-message"></div>
        <div class="compare-products"></div>
      `;
      document.body.appendChild(container);
    }

    const message = container.querySelector('.compare-message');
    const products = container.querySelector('.compare-products');

    return {
      container,
      message,
      products,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
