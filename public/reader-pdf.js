// PDF reader: pdf.js (bundled locally) rendering every page into a continuous
// scrolling column, with zoom and per-page lazy rendering.
const pdfjsLib = await import('/vendor/pdfjs/pdf.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

export async function mount(container, { book, savePosition }) {
  const position = book.position || {};
  const startPage = Math.max(1, Number(position.page) || 1);

  container.innerHTML = `
    <div class="reader">
      <div class="reader-bar">
        <a class="btn" href="#/book/${book.id}" style="border:0;background:transparent;color:#ddd">← Scheda</a>
        <span class="title">${escapeHtml(book.title || 'PDF')}</span>
        <span class="spacer"></span>
        <button type="button" data-act="prev" title="Pagina precedente">◀</button>
        <input class="page-input" type="text" inputmode="numeric" value="${startPage}" aria-label="Pagina">
        <span class="page-total">/ —</span>
        <button type="button" data-act="next" title="Pagina successiva">▶</button>
        <button type="button" data-act="zoom-out" title="Riduci">−</button>
        <span class="zoom-label">100%</span>
        <button type="button" data-act="zoom-in" title="Ingrandisci">+</button>
        <button type="button" data-act="fit" title="Adatta alla larghezza">Adatta</button>
      </div>
      <div class="pdf-scroll" id="pdf-scroll"><div class="reader-loading">Caricamento del PDF…</div></div>
    </div>`;

  const scrollEl = container.querySelector('#pdf-scroll');
  const pageInput = container.querySelector('.page-input');
  const pageTotal = container.querySelector('.page-total');
  const zoomLabel = container.querySelector('.zoom-label');

  const state = {
    doc: null,
    entries: [],
    zoom: 1,
    currentPage: startPage,
    rendered: false,
    destroyed: false,
    saveTimer: null,
    scrollTimer: null,
    baseWidth: 612,
    baseHeight: 792,
  };

  const doc = await pdfjsLib.getDocument({
    url: `/api/books/${book.id}/file`,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
  }).promise;
  state.doc = doc;
  if (state.destroyed) return () => {};

  const firstPage = await doc.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  state.baseWidth = firstViewport.width;
  state.baseHeight = firstViewport.height;
  pageTotal.textContent = `/ ${doc.numPages}`;

  scrollEl.innerHTML = '';
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const target = state.entries.find((item) => item.wrapper === entry.target);
          if (target) renderPage(target);
        }
      }
    },
    { root: scrollEl, rootMargin: '900px 0px' },
  );

  for (let num = 1; num <= doc.numPages; num += 1) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = String(num);
    wrapper.innerHTML = `<div class="ph">pagina ${num}</div>`;
    scrollEl.appendChild(wrapper);
    const item = { num, wrapper, rendered: false, rendering: false, scale: 1 };
    state.entries.push(item);
    observer.observe(wrapper);
  }

  function applyLayout() {
    const available = Math.max(scrollEl.clientWidth - 40, 240);
    const fitScale = Math.min(available / state.baseWidth, 3);
    for (const item of state.entries) {
      const scale = fitScale * state.zoom;
      const width = Math.round(state.baseWidth * scale);
      const height = Math.round(state.baseHeight * scale);
      if (item.scale !== scale) {
        item.scale = scale;
        item.rendered = false;
        item.wrapper.innerHTML = `<div class="ph">pagina ${item.num}</div>`;
      }
      item.wrapper.style.width = `${width}px`;
      item.wrapper.style.height = `${height}px`;
    }
    zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    // Re-render whatever is on screen after a zoom change.
    requestAnimationFrame(() => renderVisible());
  }

  async function renderPage(item) {
    if (item.rendered || item.rendering || state.destroyed) return;
    item.rendering = true;
    try {
      const page = await doc.getPage(item.num);
      if (state.destroyed || item.rendered) return;
      const viewport = page.getViewport({ scale: item.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      item.wrapper.innerHTML = '';
      item.wrapper.appendChild(canvas);
      item.wrapper.style.width = canvas.style.width;
      item.wrapper.style.height = canvas.style.height;
      item.rendered = true;
      page.cleanup();
    } catch (err) {
      if (!state.destroyed) console.warn(`page ${item.num} failed`, err);
    } finally {
      item.rendering = false;
    }
  }

  function renderVisible() {
    const top = scrollEl.scrollTop - 900;
    const bottom = scrollEl.scrollTop + scrollEl.clientHeight + 900;
    for (const item of state.entries) {
      const itemTop = item.wrapper.offsetTop;
      const itemBottom = itemTop + item.wrapper.offsetHeight;
      if (itemBottom >= top && itemTop <= bottom) renderPage(item);
    }
  }

  function currentPageFromScroll() {
    const probe = scrollEl.scrollTop + 80;
    let page = 1;
    for (const item of state.entries) {
      if (item.wrapper.offsetTop <= probe) page = item.num;
      else break;
    }
    return page;
  }

  function saveNow() {
    const page = currentPageFromScroll();
    const item = state.entries[page - 1];
    let offsetRatio = 0;
    if (item && item.wrapper.offsetHeight) {
      offsetRatio = Math.min(Math.max((scrollEl.scrollTop - item.wrapper.offsetTop) / item.wrapper.offsetHeight, 0), 1);
    }
    const progress = Math.min(Math.max((page - 1 + offsetRatio) / doc.numPages, 0), 1);
    savePosition({ page, offsetRatio: Number(offsetRatio.toFixed(3)), numPages: doc.numPages }, progress);
  }

  function goToPage(num) {
    const target = Math.min(Math.max(Math.round(num), 1), doc.numPages);
    const item = state.entries[target - 1];
    if (!item) return;
    scrollEl.scrollTop = item.wrapper.offsetTop;
    pageInput.value = String(target);
    state.currentPage = target;
    requestAnimationFrame(() => renderVisible());
  }

  scrollEl.addEventListener(
    'scroll',
    () => {
      const page = currentPageFromScroll();
      if (page !== state.currentPage) {
        state.currentPage = page;
        pageInput.value = String(page);
      }
      clearTimeout(state.scrollTimer);
      state.scrollTimer = setTimeout(saveNow, 700);
    },
    { passive: true },
  );

  container.querySelector('.reader-bar').addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.act;
    if (!action) return;
    if (action === 'prev') goToPage(state.currentPage - 1);
    if (action === 'next') goToPage(state.currentPage + 1);
    if (action === 'zoom-in') { state.zoom = Math.min(state.zoom * 1.2, MAX_ZOOM); applyLayout(); }
    if (action === 'zoom-out') { state.zoom = Math.max(state.zoom / 1.2, MIN_ZOOM); applyLayout(); }
    if (action === 'fit') { state.zoom = 1; applyLayout(); }
  });

  pageInput.addEventListener('change', () => goToPage(Number(pageInput.value) || 1));
  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); goToPage(Number(pageInput.value) || 1); }
  });

  const onKey = (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goToPage(state.currentPage + 1); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goToPage(state.currentPage - 1); }
    if (event.key === '+' || event.key === '=') { state.zoom = Math.min(state.zoom * 1.2, MAX_ZOOM); applyLayout(); }
    if (event.key === '-') { state.zoom = Math.max(state.zoom / 1.2, MIN_ZOOM); applyLayout(); }
  };
  window.addEventListener('keydown', onKey);

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const anchor = currentPageFromScroll();
      applyLayout();
      requestAnimationFrame(() => {
        const item = state.entries[anchor - 1];
        if (item) scrollEl.scrollTop = item.wrapper.offsetTop;
      });
    }, 200);
  };
  window.addEventListener('resize', onResize);

  const onUnload = () => saveNow();
  window.addEventListener('beforeunload', onUnload);

  applyLayout();
  // Restore the reading position once the page boxes have their final size.
  requestAnimationFrame(() => {
    const item = state.entries[startPage - 1];
    if (item) {
      const offsetRatio = Number(position.offsetRatio) || 0;
      scrollEl.scrollTop = item.wrapper.offsetTop + offsetRatio * item.wrapper.offsetHeight;
    }
    renderVisible();
    state.rendered = true;
  });

  return () => {
    state.destroyed = true;
    clearTimeout(state.saveTimer);
    clearTimeout(state.scrollTimer);
    clearTimeout(resizeTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', onUnload);
    observer.disconnect();
    try { doc.destroy(); } catch { /* ignore */ }
  };
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
