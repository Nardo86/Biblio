// EPUB reader: chapters are served by the app and rendered in a sandboxed
// same-origin iframe, with font-size / zoom controls and a saved position
// (chapter index + scroll offset).
export async function mount(container, { book, savePosition }) {
  const response = await fetch(`/api/books/${book.id}/epub`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'EPUB non leggibile');
  const chapters = data.chapters || [];
  if (!chapters.length) throw new Error('Nessun capitolo leggibile in questo EPUB');

  const position = book.position || {};
  let chapterIndex = Math.min(Math.max(Number(position.chapter) || 0, 0), chapters.length - 1);
  let pendingScroll = Number(position.scroll) || 0;
  let fontSize = Number(localStorage.getItem('biblio.epubFontSize')) || 19;
  let zoom = 1;
  let saveTimer = null;
  let destroyed = false;

  container.innerHTML = `
    <div class="reader">
      <div class="reader-bar">
        <a class="btn" href="#/book/${book.id}" style="border:0;background:transparent;color:#ddd">← Scheda</a>
        <span class="title">${escapeHtml(book.title || 'EPUB')}</span>
        <span class="spacer"></span>
        <button type="button" data-act="prev-ch" title="Capitolo precedente">◀</button>
        <select class="chapter-select" aria-label="Capitolo">
          ${chapters.map((c) => `<option value="${c.index}">${escapeHtml(c.title || `Capitolo ${c.index + 1}`)}</option>`).join('')}
        </select>
        <button type="button" data-act="next-ch" title="Capitolo successivo">▶</button>
        <button type="button" data-act="font-minus" title="Testo più piccolo">A−</button>
        <button type="button" data-act="font-plus" title="Testo più grande">A+</button>
        <button type="button" data-act="zoom-out" title="Riduci">−</button>
        <span class="zoom-label">100%</span>
        <button type="button" data-act="zoom-in" title="Ingrandisci">+</button>
      </div>
      <div class="epub-frame-wrap">
        <iframe class="epub-frame" title="Contenuto del libro" sandbox="allow-same-origin"></iframe>
      </div>
    </div>`;

  const bar = container.querySelector('.reader-bar');
  const selectEl = container.querySelector('.chapter-select');
  const zoomLabel = container.querySelector('.zoom-label');
  const iframe = container.querySelector('.epub-frame');
  selectEl.value = String(chapterIndex);

  function frameDocument() {
    try {
      return iframe.contentDocument;
    } catch {
      return null;
    }
  }

  function applyTypography() {
    const doc = frameDocument();
    if (!doc || !doc.documentElement) return;
    doc.documentElement.style.setProperty('--biblio-font-size', `${fontSize}px`);
    iframe.style.zoom = String(zoom);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function currentScroll() {
    try {
      return Math.round(iframe.contentWindow.scrollY || 0);
    } catch {
      return 0;
    }
  }

  function scrollFraction() {
    try {
      const win = iframe.contentWindow;
      const doc = frameDocument();
      const total = (doc.documentElement.scrollHeight || 0) - win.innerHeight;
      return total > 0 ? Math.min(Math.max(win.scrollY / total, 0), 1) : 0;
    } catch {
      return 0;
    }
  }

  function saveNow() {
    const progress = Math.min(Math.max((chapterIndex + scrollFraction()) / chapters.length, 0), 1);
    savePosition(
      { chapter: chapterIndex, scroll: currentScroll(), chapterTitle: chapters[chapterIndex]?.title || null },
      progress,
    );
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  function attachFrameHandlers() {
    const doc = frameDocument();
    if (!doc) return;
    applyTypography();
    try {
      iframe.contentWindow.addEventListener('scroll', scheduleSave, { passive: true });
    } catch { /* ignore */ }
    // Links inside the book would leave the sandboxed chapter; keep the reader in control.
    doc.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) return; // in-page anchor: let it scroll
      event.preventDefault();
      if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
    });
    if (pendingScroll > 0) {
      try {
        iframe.contentWindow.scrollTo(0, pendingScroll);
      } catch { /* ignore */ }
      pendingScroll = 0;
    }
  }

  function loadChapter(index, { scroll = 0 } = {}) {
    chapterIndex = Math.min(Math.max(index, 0), chapters.length - 1);
    selectEl.value = String(chapterIndex);
    pendingScroll = scroll;
    iframe.src = `/api/books/${book.id}/epub/chapter/${chapterIndex}`;
  }

  iframe.addEventListener('load', () => {
    // Let images/fonts settle before restoring the offset.
    setTimeout(() => {
      if (!destroyed) attachFrameHandlers();
    }, 60);
  });

  bar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.act;
    if (!action) return;
    if (action === 'prev-ch') loadChapter(chapterIndex - 1);
    if (action === 'next-ch') loadChapter(chapterIndex + 1);
    if (action === 'font-plus' || action === 'font-minus') {
      fontSize = Math.min(Math.max(fontSize + (action === 'font-plus' ? 1 : -1), 12), 32);
      localStorage.setItem('biblio.epubFontSize', String(fontSize));
      applyTypography();
    }
    if (action === 'zoom-in' || action === 'zoom-out') {
      zoom = Math.min(Math.max(zoom + (action === 'zoom-in' ? 0.1 : -0.1), 0.6), 2.4);
      applyTypography();
    }
  });

  selectEl.addEventListener('change', () => loadChapter(Number(selectEl.value) || 0));

  const onKey = (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') loadChapter(chapterIndex + 1);
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') loadChapter(chapterIndex - 1);
  };
  window.addEventListener('keydown', onKey);
  const onUnload = () => saveNow();
  window.addEventListener('beforeunload', onUnload);

  loadChapter(chapterIndex, { scroll: pendingScroll });

  return () => {
    destroyed = true;
    clearTimeout(saveTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    saveNow();
  };
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
