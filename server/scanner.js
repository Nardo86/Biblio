// Library scanning: walk the configured folders, extract metadata and covers,
// store the result in SQLite. Re-scans are incremental (path + mtime + size) and
// a single broken file never aborts the run.
import fs from 'node:fs';
import path from 'node:path';
import { readEpubMetadata, firstChapterText } from './metadata/epub.js';
import { readPdfMetadata, renderPdfPage } from './metadata/pdf.js';
import { coverKeyFor, normalizeImage, renderTextCover, writeCoverFile } from './covers.js';

const SUPPORTED = new Set(['.epub', '.pdf']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__MACOSX', '.Trash', '.Trashes', '@eaDir', '$RECYCLE.BIN']);

export function titleFromFilename(filePath) {
  let base = path.basename(String(filePath)).replace(/\.(epub|pdf)$/i, '');
  base = base.replace(/[_]+/g, ' ').replace(/-{1,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Senza titolo';
  const words = base.split(' ');
  const lower = new Set(['di', 'del', 'della', 'dei', 'degli', 'delle', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'e', 'a', 'da', 'in', 'con', 'su', 'per', 'the', 'of', 'and', 'a', 'an']);
  const tidy = words.map((word, index) => {
    if (/^[IVXLC]+$/.test(word) && word.length > 1) return word; // roman numerals
    if (word.length <= 2 && !/[0-9]/.test(word)) return word.toLowerCase();
    if (index > 0 && lower.has(word.toLowerCase()) && word.length <= 4) return word.toLowerCase();
    if (word === word.toUpperCase() && word.length > 1) return word.charAt(0) + word.slice(1).toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
  const joined = tidy.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function walkDirectory(root) {
  const files = [];
  const visited = new Set();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[scan] cannot read directory ${dir}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED.has(ext)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        path: full,
        format: ext === '.pdf' ? 'pdf' : 'epub',
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        root,
        relPath: path.relative(root, full),
      });
    }
  }
  return files;
}

const UPSERT_SQL = `
INSERT INTO books (
  path, rel_path, library_root, format, title, author, year, language, description,
  publisher, page_count, cover_file, cover_source, size, mtime, missing, scan_error,
  added_at, updated_at
) VALUES (
  @path, @rel_path, @library_root, @format, @title, @author, @year, @language, @description,
  @publisher, @page_count, @cover_file, @cover_source, @size, @mtime, 0, @scan_error,
  @now, @now
)
ON CONFLICT(path) DO UPDATE SET
  rel_path = excluded.rel_path,
  library_root = excluded.library_root,
  format = excluded.format,
  title = CASE WHEN books.edited_title = 1 THEN books.title ELSE excluded.title END,
  author = CASE WHEN books.edited_author = 1 THEN books.author ELSE excluded.author END,
  year = CASE WHEN books.edited_year = 1 THEN books.year ELSE excluded.year END,
  description = CASE WHEN books.edited_description = 1 THEN books.description ELSE excluded.description END,
  language = excluded.language,
  publisher = excluded.publisher,
  page_count = excluded.page_count,
  cover_file = excluded.cover_file,
  cover_source = excluded.cover_source,
  size = excluded.size,
  mtime = excluded.mtime,
  missing = 0,
  scan_error = excluded.scan_error,
  updated_at = excluded.updated_at
`;

export class ScanManager {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
    this.state = {
      running: false,
      startedAt: null,
      finishedAt: null,
      total: 0,
      processed: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      missing: 0,
      errors: 0,
      currentFile: null,
      lastError: null,
      lastResult: null,
    };
  }

  status() {
    return { ...this.state };
  }

  /** Run a full (incremental) scan. Safe to call concurrently: second call is a no-op. */
  async run({ trigger = 'manual' } = {}) {
    if (this.state.running) return { started: false, status: this.status() };
    this.state = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      total: 0,
      processed: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      missing: 0,
      errors: 0,
      currentFile: null,
      lastError: null,
      trigger,
      lastResult: this.state.lastResult,
    };

    const started = Date.now();
    try {
      const roots = this.config.libraryPaths.filter((root) => {
        try {
          return fs.statSync(root).isDirectory();
        } catch {
          console.warn(`[scan] library path missing, skipping: ${root}`);
          return false;
        }
      });

      const allFiles = [];
      for (const root of roots) {
        const files = walkDirectory(root);
        for (const file of files) allFiles.push(file);
      }
      this.state.total = allFiles.length;

      const seen = new Set();
      const findByPath = this.db.prepare('SELECT * FROM books WHERE path = ?');
      const upsert = this.db.prepare(UPSERT_SQL);

      for (const file of allFiles) {
        seen.add(file.path);
        this.state.currentFile = file.relPath;
        try {
          const existing = findByPath.get(file.path);
          const coverPresent = existing && existing.cover_file
            ? fs.existsSync(path.join(this.config.coversDir, existing.cover_file))
            : true;
          const unchanged = existing
            && !existing.missing
            && Number(existing.size) === file.size
            && Number(existing.mtime) === file.mtime
            && coverPresent
            && !existing.scan_error;
          if (unchanged) {
            this.state.skipped += 1;
            this.state.processed += 1;
            continue;
          }
          const result = await this.processFile(file, existing);
          upsert.run({
            path: file.path,
            rel_path: file.relPath,
            library_root: file.root,
            format: file.format,
            title: result.title,
            author: result.author,
            year: result.year,
            language: result.language,
            description: result.description,
            publisher: result.publisher,
            page_count: result.pageCount,
            cover_file: result.coverFile,
            cover_source: result.coverSource,
            size: file.size,
            mtime: file.mtime,
            scan_error: result.error,
            now: Date.now(),
          });
          if (existing) this.state.updated += 1;
          else this.state.added += 1;
          if (result.error) this.state.errors += 1;
        } catch (err) {
          // A single broken file must never stop the scan.
          this.state.errors += 1;
          this.state.lastError = `${file.relPath}: ${err.message}`;
          console.warn(`[scan] failed on ${file.path}: ${err.message}`);
          try {
            upsert.run({
              path: file.path,
              rel_path: file.relPath,
              library_root: file.root,
              format: file.format,
              title: titleFromFilename(file.path),
              author: null,
              year: null,
              language: null,
              description: null,
              publisher: null,
              page_count: null,
              cover_file: null,
              cover_source: null,
              size: file.size,
              mtime: file.mtime,
              scan_error: err.message.slice(0, 500),
              now: Date.now(),
            });
          } catch (inner) {
            console.warn(`[scan] cannot store ${file.path}: ${inner.message}`);
          }
        }
        this.state.processed += 1;
      }

      // Anything under a scanned root that we did not see is gone from disk.
      const rows = this.db.prepare('SELECT id, path FROM books WHERE missing = 0').all();
      const markMissing = this.db.prepare('UPDATE books SET missing = 1, updated_at = ? WHERE id = ?');
      for (const row of rows) {
        if (seen.has(row.path)) continue;
        const underRoot = roots.some((root) => row.path.startsWith(root + path.sep) || row.path === root);
        if (!underRoot) continue;
        markMissing.run(Date.now(), row.id);
        this.state.missing += 1;
      }
    } catch (err) {
      this.state.lastError = err.message;
      console.error('[scan] fatal error:', err);
    } finally {
      this.state.running = false;
      this.state.finishedAt = Date.now();
      this.state.currentFile = null;
      this.state.lastResult = {
        trigger,
        durationMs: Date.now() - started,
        total: this.state.total,
        added: this.state.added,
        updated: this.state.updated,
        skipped: this.state.skipped,
        missing: this.state.missing,
        errors: this.state.errors,
      };
      this.db
        .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('last_scan', JSON.stringify({ ...this.state.lastResult, finishedAt: this.state.finishedAt }));
    }
    return { started: true, status: this.status() };
  }

  async processFile(file, existing) {
    const meta = {
      title: null, author: null, year: null, language: null, description: null,
      publisher: null, pageCount: null, coverFile: null, coverSource: null, error: null,
    };

    let parsed = null;
    try {
      if (file.format === 'epub') parsed = this.readEpub(file.path);
      else parsed = await readPdfMetadata(file.path);
    } catch (err) {
      meta.error = err.message.slice(0, 500);
      console.warn(`[scan] metadata error on ${file.path}: ${err.message}`);
    }

    if (parsed) {
      const m = parsed.metadata || {};
      meta.title = m.title || null;
      meta.author = m.author || null;
      meta.year = m.year || null;
      meta.language = m.language || null;
      meta.description = m.description || null;
      meta.publisher = m.publisher || null;
      meta.pageCount = parsed.pageCount || null;
    }
    if (!meta.title) meta.title = titleFromFilename(file.path);

    try {
      const cover = await this.buildCover(file, parsed);
      meta.coverFile = cover.file;
      meta.coverSource = cover.source;
    } catch (err) {
      console.warn(`[scan] cover error on ${file.path}: ${err.message}`);
      meta.coverFile = null;
      meta.coverSource = null;
    }
    return meta;
  }

  readEpub(filePath) {
    const epub = readEpubMetadata(filePath);
    return { metadata: epub.metadata, coverData: epub.coverData };
  }

  async buildCover(file, parsed) {
    const key = coverKeyFor(file.path);
    if (file.format === 'epub' && parsed && parsed.coverData) {
      try {
        const jpeg = await normalizeImage(parsed.coverData);
        return { file: writeCoverFile(this.config.coversDir, key, jpeg), source: 'epub' };
      } catch (err) {
        console.warn(`[cover] cannot decode EPUB cover for ${file.path}: ${err.message}`);
      }
    }
    if (file.format === 'pdf') {
      const jpeg = await renderPdfPage(file.path, 1, 600);
      return { file: writeCoverFile(this.config.coversDir, key, jpeg), source: 'rendered' };
    }
    // EPUB without a usable cover image: draw the first content page as text.
    const title = (parsed && parsed.metadata && parsed.metadata.title) || titleFromFilename(file.path);
    const author = parsed && parsed.metadata ? parsed.metadata.author : null;
    let text = '';
    try {
      text = firstChapterText(file.path).text;
    } catch {
      text = '';
    }
    const jpeg = await renderTextCover({ title, author, text, label: 'Prima pagina' });
    return { file: writeCoverFile(this.config.coversDir, key, jpeg), source: 'rendered' };
  }
}
