// Biblioteca — Express server: library API, covers, readers and static frontend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { openDatabase, getMeta } from './db.js';
import { ScanManager } from './scanner.js';
import { placeholderSvg } from './covers.js';
import { getEpubChapters, getEpubChapter, getEpubAsset } from './metadata/epub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(ROOT);
const db = openDatabase(config.dbPath);
fs.mkdirSync(config.coversDir, { recursive: true });

const scanner = new ScanManager({ db, config });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ---------- helpers ----------

function serializeBook(row, positionRow) {
  if (!row) return null;
  let position = null;
  if (positionRow) {
    try {
      position = JSON.parse(positionRow.position);
    } catch {
      position = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    format: row.format,
    language: row.language,
    description: row.description,
    publisher: row.publisher,
    pageCount: row.page_count,
    coverUrl: `/api/books/${row.id}/cover?v=${row.updated_at || row.id}`,
    missing: !!row.missing,
    scanError: row.scan_error,
    relPath: row.rel_path,
    libraryRoot: row.library_root,
    size: row.size,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    edited: {
      title: !!row.edited_title,
      author: !!row.edited_author,
      year: !!row.edited_year,
      description: !!row.edited_description,
    },
    position,
    progress: positionRow && positionRow.progress !== null ? positionRow.progress : null,
  };
}

function getBookRow(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(Number(id));
}

function getPositionRow(id) {
  return db.prepare('SELECT * FROM reading_positions WHERE book_id = ?').get(Number(id));
}

function safeJoinInside(baseDir, relative) {
  const resolved = path.resolve(baseDir, relative);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------- API ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: config.version, books: db.prepare('SELECT COUNT(*) AS n FROM books WHERE missing = 0').get().n });
});

app.get('/api/config', (req, res) => {
  let lastScan = null;
  try {
    lastScan = JSON.parse(getMeta(db, 'last_scan') || 'null');
  } catch {
    lastScan = null;
  }
  res.json({
    version: config.version,
    libraryPaths: config.libraryPaths,
    libraryPathsSource: config.configSource,
    dataDir: config.dataDir,
    lastScan,
    scan: scanner.status(),
  });
});

app.get('/api/books', (req, res) => {
  const q = String(req.query.q || '').trim();
  const format = String(req.query.format || '').trim().toLowerCase();
  const author = String(req.query.author || '').trim();
  const sort = String(req.query.sort || 'title');
  const includeMissing = req.query.includeMissing === '1' || req.query.includeMissing === 'true';

  const where = [];
  const params = {};
  if (!includeMissing) where.push('b.missing = 0');
  if (q) {
    where.push("(LOWER(b.title) LIKE @q ESCAPE '\\' OR LOWER(IFNULL(b.author, '')) LIKE @q ESCAPE '\\')");
    params.q = `%${likeEscape(q.toLowerCase())}%`;
  }
  if (format === 'epub' || format === 'pdf') {
    where.push('b.format = @format');
    params.format = format;
  }
  if (author) {
    where.push('b.author = @author');
    params.author = author;
  }

  const orderBy = {
    title: "LOWER(IFNULL(b.title, '')) ASC",
    author: "LOWER(IFNULL(b.author, 'zzz')) ASC, LOWER(IFNULL(b.title, '')) ASC",
    recent: 'b.updated_at DESC',
    added: 'b.added_at DESC',
  }[sort] || "LOWER(IFNULL(b.title, '')) ASC";

  const sql = `SELECT b.*, p.position AS position_json, p.progress AS position_progress
    FROM books b LEFT JOIN reading_positions p ON p.book_id = b.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}`;
  const rows = db.prepare(sql).all(params);
  const books = rows.map((row) =>
    serializeBook(row, row.position_json ? { position: row.position_json, progress: row.position_progress } : null),
  );
  res.json({ count: books.length, books });
});

app.get('/api/facets', (req, res) => {
  const authors = db
    .prepare(`SELECT author, COUNT(*) AS count FROM books WHERE missing = 0 AND author IS NOT NULL AND author <> ''
      GROUP BY author ORDER BY LOWER(author) ASC`)
    .all();
  const formats = db
    .prepare('SELECT format, COUNT(*) AS count FROM books WHERE missing = 0 GROUP BY format')
    .all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM books WHERE missing = 0').get().n;
  res.json({ authors, formats, total });
});

app.get('/api/continue', (req, res) => {
  const rows = db
    .prepare(`SELECT b.*, p.position AS position_json, p.progress AS position_progress, p.updated_at AS position_updated
      FROM reading_positions p JOIN books b ON b.id = p.book_id
      WHERE b.missing = 0 ORDER BY p.updated_at DESC LIMIT 8`)
    .all();
  res.json({
    books: rows.map((row) => ({
      ...serializeBook(row, { position: row.position_json, progress: row.position_progress }),
      lastReadAt: row.position_updated,
    })),
  });
});

app.get('/api/books/:id', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });
  const book = serializeBook(row, getPositionRow(row.id));
  if (book.format === 'epub' && !row.missing) {
    try {
      book.chapterCount = getEpubChapters(row.path).length;
    } catch (err) {
      book.epubError = err.message;
    }
  }
  res.json(book);
});

const EDITABLE = { title: 'edited_title', author: 'edited_author', year: 'edited_year', description: 'edited_description' };

app.patch('/api/books/:id', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });

  const sets = [];
  const params = { id: row.id, now: Date.now() };
  for (const [field, flagColumn] of Object.entries(EDITABLE)) {
    if (!(field in req.body)) continue;
    const raw = req.body[field];
    const value = raw === null || raw === '' ? null : String(raw).trim() || null;
    sets.push(`${field} = @${field}, ${flagColumn} = 1`);
    params[field] = value;
  }
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  db.prepare(`UPDATE books SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  res.json(serializeBook(getBookRow(row.id), getPositionRow(row.id)));
});

app.get('/api/books/:id/cover', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).send('Not found');
  if (row.cover_file) {
    const filePath = safeJoinInside(config.coversDir, row.cover_file);
    if (filePath && fs.existsSync(filePath)) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(filePath);
    }
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('image/svg+xml').send(placeholderSvg({ title: row.title, author: row.author }));
});

app.get('/api/books/:id/file', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });
  if (!fs.existsSync(row.path)) return res.status(410).json({ error: 'File non più disponibile' });
  res.set('Content-Type', row.format === 'pdf' ? 'application/pdf' : 'application/epub+zip');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(row.path))}"`);
  res.sendFile(row.path, { acceptRanges: true });
});

app.get('/api/books/:id/epub', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });
  if (row.format !== 'epub') return res.status(400).json({ error: 'Non è un EPUB' });
  try {
    const chapters = getEpubChapters(row.path);
    res.json({
      chapters: chapters.map((c) => ({ index: c.index, title: c.title })),
      position: getPositionRow(row.id),
    });
  } catch (err) {
    res.status(500).json({ error: `Impossibile leggere l'EPUB: ${err.message}` });
  }
});

const READER_STYLE = `
  html { background: #ffffff; }
  body { box-sizing: border-box; margin: 0 auto; padding: 28px 30px 64px; max-width: 780px;
    font-family: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
    font-size: var(--biblio-font-size, 19px) !important; line-height: 1.65 !important;
    color: #1c1c1e !important; background: #ffffff !important; }
  img, svg, video, table { max-width: 100% !important; height: auto !important; }
  a { color: #7a4a1d; }
`;

function wrapChapterHtml(html, baseHref) {
  const baseTag = `<base href="${baseHref}">`;
  const styleTag = `<style id="biblio-reader-style">${READER_STYLE}</style>`;
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    let out = `${html.slice(0, insertAt)}${baseTag}<meta charset="utf-8">${html.slice(insertAt)}`;
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${styleTag}</head>`);
    else out = `${styleTag}${out}`;
    return out;
  }
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html.replace(/<[?]?xml[^>]*>/i, '');
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${styleTag}</head><body>${body}</body></html>`;
}

app.get('/api/books/:id/epub/chapter/:index', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).send('Not found');
  if (row.format !== 'epub') return res.status(400).send('Not an EPUB');
  try {
    const index = Number(req.params.index) || 0;
    const data = getEpubChapter(row.path, index);
    const baseHref = `/api/books/${row.id}/epub/res/${data.baseDir ? `${data.baseDir}/` : ''}`;
    const html = wrapChapterHtml(data.html, baseHref);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'",
    );
    res.set('X-Biblio-Chapter', String(data.chapter.index));
    res.set('X-Biblio-Count', String(data.count));
    res.send(html);
  } catch (err) {
    res.status(500).type('text/plain').send(`Impossibile aprire il capitolo: ${err.message}`);
  }
});

app.get('/api/books/:id/epub/res/*', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).send('Not found');
  if (row.format !== 'epub') return res.status(400).send('Not an EPUB');
  const assetPath = req.params[0] || '';
  if (!assetPath || assetPath.includes('..')) return res.status(400).send('Bad asset path');
  try {
    const asset = getEpubAsset(row.path, assetPath);
    if (!asset) return res.status(404).send('Asset not found');
    res.set('Content-Type', asset.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(asset.data);
  } catch (err) {
    res.status(500).send(`Errore asset: ${err.message}`);
  }
});

app.get('/api/books/:id/position', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });
  const positionRow = getPositionRow(row.id);
  res.json(positionRow ? { ...positionRow, position: JSON.parse(positionRow.position) } : { position: null });
});

app.put('/api/books/:id/position', (req, res) => {
  const row = getBookRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Libro non trovato' });
  const position = req.body && req.body.position;
  if (!position || typeof position !== 'object') return res.status(400).json({ error: 'Posizione non valida' });
  let progress = req.body.progress;
  progress = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : null;
  db.prepare(`INSERT INTO reading_positions (book_id, position, progress, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET position = excluded.position, progress = excluded.progress, updated_at = excluded.updated_at`)
    .run(row.id, JSON.stringify(position), progress, Date.now());
  res.json({ ok: true });
});

app.post('/api/scan', (req, res) => {
  if (scanner.status().running) return res.json({ started: false, status: scanner.status() });
  scanner.run({ trigger: 'manual' }).catch((err) => console.error('[scan] unexpected:', err));
  res.json({ started: true, status: scanner.status() });
});

app.get('/api/scan/status', (req, res) => {
  res.json(scanner.status());
});

// ---------- static frontend ----------

app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'public', 'vendor', 'pdfjs'), { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: '5m' }));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[http] unhandled:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Errore interno' });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[biblioteca] listening on http://${config.host}:${config.port}`);
  console.log(`[biblioteca] library paths: ${config.libraryPaths.join(', ')} (${config.configSource})`);
  console.log(`[biblioteca] data dir: ${config.dataDir}`);
  if (config.rescanOnStart) {
    scanner.run({ trigger: 'startup' }).catch((err) => console.error('[scan] startup scan failed:', err));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[biblioteca] ${signal} received, shutting down`);
    server.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
