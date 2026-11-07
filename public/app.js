// Biblioteca frontend: hash-routed vanilla JS app (library, detail, reader).
const state = {
  layout: localStorage.getItem('biblio.layout') || 'grid',
  q: '',
  format: '',
  author: '',
  sort: 'title',
  facets: null,
  scanPoll: null,
  readerCleanup: null,
};

const viewEl = document.getElementById('view');
const searchEl = document.getElementById('search');
const formatEl = document.getElementById('filter-format');
const authorEl = document.getElementById('filter-author');
const sortEl = document.getElementById('sort');
const rescanEl = document.getElementById('rescan');
const toolbarEl = document.getElementById('library-toolbar');

const scanStatusEl = document.createElement('span');
scanStatusEl.className = 'scan-status';
scanStatusEl.id = 'scan-status';
toolbarEl.appendChild(scanStatusEl);

// ---------- helpers ----------

const esc = (value) =>
  String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* keep default */ }
    throw new Error(message);
  }
  return res.json();
}

let toastTimer = null;
function toast(message, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

function bookSubtitle(book) {
  const parts = [];
  if (book.author) parts.push(book.author);
  if (book.year) parts.push(book.year);
  return parts.join(' · ');
}

function readingLabel(book) {
  const pos = book.position;
  if (!pos) return null;
  if (book.format === 'pdf' && pos.page) return `pagina ${pos.page}${book.pageCount ? ` di ${book.pageCount}` : ''}`;
  if (book.format === 'epub' && typeof pos.chapter === 'number') return `capitolo ${pos.chapter + 1}`;
  return null;
}

// ---------- routing ----------

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const match = hash.match(/^\/(book|read)\/(\d+)/);
  if (match) return { name: match[1], id: Number(match[2]) };
  return { name: 'library' };
}

async function route() {
  if (state.readerCleanup) {
    try { state.readerCleanup(); } catch { /* ignore */ }
    state.readerCleanup = null;
  }
  document.body.classList.remove('reading');
  const current = parseRoute();
  try {
    if (current.name === 'book') await renderDetail(current.id);
    else if (current.name === 'read') await renderReader(current.id);
    else await renderLibrary();
  } catch (err) {
    viewEl.innerHTML = `<div class="empty"><h3>Errore</h3><p>${esc(err.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', route);

// ---------- library ----------

function updateFacetSelects() {
  const facets = state.facets || { authors: [], formats: [] };
  const counts = new Map(facets.formats.map((f) => [f.format, f.count]));
  formatEl.options[0].textContent = `Tutti i formati (${facets.total || 0})`;
  formatEl.options[1].textContent = `EPUB${counts.has('epub') ? ` (${counts.get('epub')})` : ''}`;
  formatEl.options[2].textContent = `PDF${counts.has('pdf') ? ` (${counts.get('pdf')})` : ''}`;

  const previous = state.author;
  authorEl.innerHTML = '<option value="">Tutti gli autori</option>' +
    facets.authors.map((a) => `<option value="${esc(a.author)}">${esc(a.author)} (${a.count})</option>`).join('');
  authorEl.value = previous;
  if (authorEl.value !== previous) { state.author = ''; authorEl.value = ''; }
  formatEl.value = state.format;
  sortEl.value = state.sort;
}

function bookCard(book) {
  const subtitle = bookSubtitle(book);
  return `<a class="card" href="#/book/${book.id}">
    <div class="cover-wrap">
      <img src="${book.coverUrl}" alt="Copertina di ${esc(book.title)}" loading="lazy">
      <span class="badge">${esc(book.format)}</span>
    </div>
    <div class="title">${esc(book.title || 'Senza titolo')}</div>
    ${subtitle ? `<div class="author">${esc(subtitle)}</div>` : ''}
    ${book.missing ? '<div class="missing">File non trovato su disco</div>' : ''}
  </a>`;
}

function bookRow(book) {
  return `<a class="row" href="#/book/${book.id}">
    <img src="${book.coverUrl}" alt="" loading="lazy">
    <div class="t">${esc(book.title || 'Senza titolo')}${book.missing ? ' <span class="missing">(mancante)</span>' : ''}</div>
    <div class="a">${esc(book.author || '—')}</div>
    <div class="y">${esc(book.year || '')}</div>
    <div class="f">${esc(book.format)}</div>
  </a>`;
}

async function renderLibrary() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.format) params.set('format', state.format);
  if (state.author) params.set('author', state.author);
  params.set('sort', state.sort);

  const [list, facets, cont] = await Promise.all([
    api(`/api/books?${params.toString()}`),
    api('/api/facets'),
    api('/api/continue'),
  ]);
  state.facets = facets;
  updateFacetSelects();

  const continueHtml = cont.books.length
    ? `<section class="continue-strip">
        <div class="section-title"><h2>Continua a leggere</h2><span class="meta">${cont.books.length} in corso</span></div>
        <div class="continue-list">
          ${cont.books.map((b) => {
            const label = readingLabel(b) || 'in lettura';
            const percent = b.progress ? ` · ${Math.round(b.progress * 100)}%` : '';
            return `<a class="continue-card" href="#/read/${b.id}">
              <img src="${b.coverUrl}" alt="">
              <div><div class="t">${esc(b.title)}</div><div class="p">${esc(label + percent)}</div></div>
            </a>`;
          }).join('')}
        </div>
      </section>`
    : '';

  const count = list.count;
  const filterSummary = [
    state.q ? `ricerca “${esc(state.q)}”` : null,
    state.format ? `formato ${state.format.toUpperCase()}` : null,
    state.author ? `autore ${esc(state.author)}` : null,
  ].filter(Boolean).join(' · ');

  const booksHtml = count
    ? state.layout === 'grid'
      ? `<div class="grid">${list.books.map(bookCard).join('')}</div>`
      : `<div class="list">${list.books.map(bookRow).join('')}</div>`
    : `<div class="empty">
        <h3>Nessun libro trovato</h3>
        <p>${filterSummary ? `Nessun risultato per ${filterSummary}.` : 'La libreria è vuota.'}</p>
        <p>Controlla la variabile <code>LIBRARY_PATHS</code> e premi <strong>Scansiona</strong>.</p>
      </div>`;

  viewEl.innerHTML = `${continueHtml}
    <div class="section-title">
      <h2>Libreria</h2>
      <span class="meta">${count} ${count === 1 ? 'opera' : 'opere'}${filterSummary ? ` · ${filterSummary}` : ''}</span>
    </div>
    ${booksHtml}`;
}

// ---------- detail ----------

async function renderDetail(id) {
  const book = await api(`/api/books/${id}`);
  const positionLabel = readingLabel(book);
  const readHref = `#/read/${book.id}`;

  viewEl.innerHTML = `
    <div class="section-title"><a class="btn" href="#/">← Libreria</a></div>
    <div class="detail">
      <div class="cover-col">
        <img class="cover" src="${book.coverUrl}" alt="Copertina di ${esc(book.title)}">
      </div>
      <div>
        <h1>${esc(book.title || 'Senza titolo')}</h1>
        <div class="byline">${esc(bookSubtitle(book) || 'Autore sconosciuto')}</div>
        <div class="actions">
          <a class="btn primary" href="${readHref}">${positionLabel ? `Continua (${esc(positionLabel)})` : 'Leggi'}</a>
          <a class="btn" href="/api/books/${book.id}/file" target="_blank" rel="noopener">Apri file originale</a>
        </div>
        ${book.missing ? '<p class="missing">Il file non è più presente nella cartella della libreria.</p>' : ''}
        ${book.scanError ? `<p class="missing">Errore di lettura metadati: ${esc(book.scanError)}</p>` : ''}
        <dl>
          <dt>Formato</dt><dd>${esc(book.format.toUpperCase())}</dd>
          <dt>Anno</dt><dd>${esc(book.year || '—')}</dd>
          <dt>Lingua</dt><dd>${esc(book.language || '—')}</dd>
          <dt>Editore</dt><dd>${esc(book.publisher || '—')}</dd>
          <dt>Pagine</dt><dd>${book.pageCount ? esc(book.pageCount) : '—'}</dd>
          <dt>Percorso</dt><dd>${esc(book.relPath || '')}</dd>
          <dt>Dimensione</dt><dd>${formatBytes(book.size)}</dd>
          <dt>Aggiunto</dt><dd>${formatDate(book.addedAt)}</dd>
          <dt>Copertina</dt><dd>${book.coverUrl.includes('?') ? (book.coverFile || 'generata') : '—'}</dd>
        </dl>
        ${book.description ? `<div class="desc-title">Descrizione</div><div class="description">${esc(book.description)}</div>` : '<p class="meta">Nessuna descrizione disponibile.</p>'}

        <div class="editor">
          <h3>Modifica i dati ${book.edited.title || book.edited.author || book.edited.year || book.edited.description ? '<span class="edited-flag">modificato a mano</span>' : ''}</h3>
          <form id="edit-form">
            <div class="fields">
              <label>Titolo ${book.edited.title ? '<span class="edited-flag">manuale</span>' : ''}
                <input name="title" value="${esc(book.title || '')}"></label>
              <label>Autore ${book.edited.author ? '<span class="edited-flag">manuale</span>' : ''}
                <input name="author" value="${esc(book.author || '')}"></label>
              <label>Anno ${book.edited.year ? '<span class="edited-flag">manuale</span>' : ''}
                <input name="year" value="${esc(book.year || '')}"></label>
              <label class="wide">Descrizione ${book.edited.description ? '<span class="edited-flag">manuale</span>' : ''}
                <textarea name="description">${esc(book.description || '')}</textarea></label>
            </div>
            <div class="row-actions">
              <button class="btn primary" type="submit">Salva</button>
              <button class="btn" type="button" id="reset-fields">Ripristina valori</button>
            </div>
            <p class="hint">I campi modificati a mano non vengono sovrascritti dalle scansioni successive.</p>
          </form>
        </div>
      </div>
    </div>`;

  document.getElementById('reset-fields').addEventListener('click', () => renderDetail(id));
  document.getElementById('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const payload = {};
    for (const field of ['title', 'author', 'year', 'description']) {
      payload[field] = String(form.get(field) || '');
    }
    try {
      await api(`/api/books/${id}`, { method: 'PATCH', body: payload });
      toast('Dati aggiornati');
      await renderDetail(id);
    } catch (err) {
      toast(`Errore: ${err.message}`);
    }
  });
}

// ---------- reader ----------

async function renderReader(id) {
  const book = await api(`/api/books/${id}`);
  if (book.missing) throw new Error('Il file non è più disponibile su disco.');
  document.body.classList.add('reading');
  viewEl.innerHTML = '<div class="reader-loading">Apertura del libro…</div>';

  const savePosition = async (position, progress) => {
    try {
      await api(`/api/books/${id}/position`, { method: 'PUT', body: { position, progress } });
    } catch (err) {
      console.warn('cannot save position', err);
    }
  };

  try {
    const module = await import(book.format === 'pdf' ? '/reader-pdf.js' : '/reader-epub.js');
    state.readerCleanup = await module.mount(viewEl, { book, savePosition });
  } catch (err) {
    document.body.classList.remove('reading');
    viewEl.innerHTML = `<div class="empty"><h3>Impossibile aprire il libro</h3><p>${esc(err.message)}</p>
      <p><a class="btn" href="#/book/${id}">Torna alla scheda</a></p></div>`;
  }
}

// ---------- scanning ----------

async function pollScan() {
  try {
    const status = await api('/api/scan/status');
    if (status.running) {
      rescanEl.disabled = true;
      scanStatusEl.innerHTML = `<span class="spinner"></span>Scansione ${status.processed}/${status.total}`;
      state.scanPoll = setTimeout(pollScan, 800);
      return;
    }
    rescanEl.disabled = false;
    const result = status.lastResult;
    if (result) {
      scanStatusEl.textContent = `${result.added} nuovi · ${result.updated} aggiornati · ${result.skipped} invariati${result.missing ? ` · ${result.missing} mancanti` : ''}${result.errors ? ` · ${result.errors} errori` : ''}`;
    } else {
      scanStatusEl.textContent = '';
    }
    if (parseRoute().name === 'library') await renderLibrary();
  } catch (err) {
    state.scanPoll = setTimeout(pollScan, 2000);
  }
}

async function startScan() {
  try {
    await api('/api/scan', { method: 'POST' });
    toast('Scansione avviata');
    clearTimeout(state.scanPoll);
    pollScan();
  } catch (err) {
    toast(`Errore: ${err.message}`);
  }
}

// ---------- wiring ----------

let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    if (parseRoute().name === 'library') renderLibrary();
  }, 180);
});

formatEl.addEventListener('change', () => {
  state.format = formatEl.value;
  if (parseRoute().name === 'library') renderLibrary();
});
authorEl.addEventListener('change', () => {
  state.author = authorEl.value;
  if (parseRoute().name === 'library') renderLibrary();
});
sortEl.addEventListener('change', () => {
  state.sort = sortEl.value;
  if (parseRoute().name === 'library') renderLibrary();
});
rescanEl.addEventListener('click', startScan);

for (const button of document.querySelectorAll('.view-toggle button')) {
  button.addEventListener('click', () => {
    state.layout = button.dataset.view;
    localStorage.setItem('biblio.layout', state.layout);
    for (const other of document.querySelectorAll('.view-toggle button')) {
      other.classList.toggle('active', other === button);
    }
    if (parseRoute().name === 'library') renderLibrary();
  });
}

for (const button of document.querySelectorAll('.view-toggle button')) {
  button.classList.toggle('active', button.dataset.view === state.layout);
}

// Kick off: route + initial scan status.
route();
pollScan();
