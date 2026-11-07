// EPUB parsing: OPF metadata, cover detection, spine/TOC and per-chapter HTML.
// No external XML library: EPUB metadata files are small and predictable, so a
// few targeted regexes keep the dependency list short.
import AdmZip from 'adm-zip';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', egrave: 'e', eacute: 'e',
  agrave: 'a', ograve: 'o', ugrave: 'u', igrave: 'i', ccedil: 'c', deg: 'deg',
};

export function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(num) && num > 0 && num < 0x110000) {
        try { return String.fromCodePoint(num); } catch { return match; }
      }
      return match;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripTags(input) {
  return decodeEntities(String(input).replace(/<[^>]*>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').trim();
}

function cleanText(input) {
  if (!input) return null;
  const text = stripTags(input).replace(/\s+/g, ' ').trim();
  return text || null;
}

function firstTagText(xml, localName) {
  if (!xml) return null;
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'i');
  const match = xml.match(re);
  return match ? cleanText(match[1]) : null;
}

function firstTagTextRaw(xml, localName) {
  if (!xml) return null;
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1] : null;
}

export function parseAttributes(raw) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw || ''))) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

export function normalizeZipPath(baseDir, href) {
  const clean = decodeURIComponent(String(href || '').split('#')[0].split('?')[0]);
  const joined = baseDir ? `${baseDir}/${clean}` : clean;
  const parts = joined.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function dirname(zipPath) {
  const idx = zipPath.lastIndexOf('/');
  return idx === -1 ? '' : zipPath.slice(0, idx);
}

export function parseOpf(opfXml) {
  const manifest = new Map();
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let m;
  while ((m = itemRe.exec(opfXml))) {
    const attrs = parseAttributes(m[1]);
    if (attrs.id && attrs.href) {
      manifest.set(attrs.id, {
        id: attrs.id,
        href: attrs.href,
        mediaType: attrs['media-type'] || '',
        properties: attrs.properties || '',
      });
    }
  }

  const spine = [];
  const spineRe = /<itemref\b([^>]*?)\/?>/gi;
  while ((m = spineRe.exec(opfXml))) {
    const attrs = parseAttributes(m[1]);
    if (attrs.idref) spine.push(attrs.idref);
  }

  const metadata = {
    title: firstTagText(opfXml, 'title'),
    author: firstTagText(opfXml, 'creator'),
    year: null,
    language: firstTagText(opfXml, 'language'),
    description: null,
    publisher: firstTagText(opfXml, 'publisher'),
    subject: firstTagText(opfXml, 'subject'),
  };

  const date = firstTagText(opfXml, 'date');
  if (date) {
    const year = date.match(/(\d{4})/);
    metadata.year = year ? year[1] : date.slice(0, 32);
  }

  const descriptionRaw = firstTagTextRaw(opfXml, 'description');
  if (descriptionRaw) {
    const text = decodeEntities(
      descriptionRaw
        .replace(/<\/(p|div|br)\s*>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim();
    metadata.description = text || null;
  }

  // Cover: EPUB2 <meta name="cover" content="id"> or EPUB3 properties="cover-image".
  let coverHref = null;
  const metaCover = opfXml.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i);
  if (metaCover) {
    const attrs = parseAttributes(metaCover[0]);
    const item = manifest.get(attrs.content);
    if (item && item.mediaType.startsWith('image/')) coverHref = item.href;
  }
  if (!coverHref) {
    for (const item of manifest.values()) {
      if (/cover-image/i.test(item.properties) && item.mediaType.startsWith('image/')) {
        coverHref = item.href;
        break;
      }
    }
  }
  if (!coverHref) {
    for (const item of manifest.values()) {
      if (item.mediaType.startsWith('image/') && /cover/i.test(item.href)) {
        coverHref = item.href;
        break;
      }
    }
  }

  return { metadata, manifest, spine, coverHref };
}

export function openEpub(filePath) {
  const zip = new AdmZip(filePath);
  const containerEntry = zip.getEntry('META-INF/container.xml');
  let opfPath = null;
  if (containerEntry) {
    const container = containerEntry.getData().toString('utf8');
    const m = container.match(/<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i);
    if (m) opfPath = decodeURIComponent(m[1]);
  }
  if (!opfPath) {
    const candidate = zip.getEntries().find((e) => /\.opf$/i.test(e.entryName) && !e.isDirectory);
    if (candidate) opfPath = candidate.entryName;
  }
  if (!opfPath) throw new Error('EPUB has no OPF package document');

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found in archive: ${opfPath}`);
  const opfXml = opfEntry.getData().toString('utf8');
  const parsed = parseOpf(opfXml);
  return { zip, opfPath, opfDir: dirname(opfPath), opfXml, ...parsed };
}

/** Metadata + cover bytes for the scanner. Never throws for a bad cover. */
export function readEpubMetadata(filePath) {
  const epub = openEpub(filePath);
  const { metadata } = epub;
  let coverData = null;
  let coverHref = null;
  if (epub.coverHref) {
    const entryPath = normalizeZipPath(epub.opfDir, epub.coverHref);
    const entry = epub.zip.getEntry(entryPath);
    if (entry) {
      coverData = entry.getData();
      coverHref = entryPath;
    }
  }
  return { metadata, coverData, coverHref };
}

function buildTocTitles(epub) {
  const titles = new Map();
  const ncxItem = [...epub.manifest.values()].find((i) => /dtbncx/i.test(i.mediaType));
  if (ncxItem) {
    const entry = epub.zip.getEntry(normalizeZipPath(epub.opfDir, ncxItem.href));
    if (entry) {
      const ncx = entry.getData().toString('utf8');
      const re = /<text[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(ncx))) {
        const label = cleanText(m[1]);
        const href = normalizeZipPath(dirname(normalizeZipPath(epub.opfDir, ncxItem.href)), m[2]);
        if (label && href && !titles.has(href)) titles.set(href, label);
      }
    }
  }
  if (!titles.size) {
    const navItem = [...epub.manifest.values()].find((i) => /\bnav\b/.test(i.properties));
    if (navItem) {
      const navPath = normalizeZipPath(epub.opfDir, navItem.href);
      const entry = epub.zip.getEntry(navPath);
      if (entry) {
        const nav = entry.getData().toString('utf8');
        const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(nav))) {
          const label = cleanText(m[2]);
          const href = normalizeZipPath(dirname(navPath), m[1]);
          if (label && href && !titles.has(href)) titles.set(href, label);
        }
      }
    }
  }
  return titles;
}

/** Ordered list of readable documents in the EPUB spine. */
export function getEpubChapters(filePath) {
  const epub = openEpub(filePath);
  const titles = buildTocTitles(epub);
  const chapters = [];
  for (const idref of epub.spine) {
    const item = epub.manifest.get(idref);
    if (!item) continue;
    if (!/html/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    const zipPath = normalizeZipPath(epub.opfDir, item.href);
    const entry = epub.zip.getEntry(zipPath);
    if (!entry) continue;
    const fallback = path.basename(zipPath).replace(/\.x?html?$/i, '').replace(/[_-]+/g, ' ');
    let title = titles.get(zipPath);
    if (!title) {
      // No TOC entry: use the first heading inside the document.
      try {
        const doc = entry.getData().toString('utf8');
        const heading = doc.match(/<h[1-2]\b[^>]*>([\s\S]{1,200}?)<\/h[1-2]>/i) || doc.match(/<title\b[^>]*>([\s\S]{1,200}?)<\/title>/i);
        if (heading) title = cleanText(heading[1]);
      } catch { /* keep fallback */ }
    }
    chapters.push({
      index: chapters.length,
      id: item.id,
      zipPath,
      href: item.href,
      title: title || fallback || `Sezione ${chapters.length + 1}`,
    });
  }
  if (!chapters.length) throw new Error('EPUB has no readable spine documents');
  return chapters;
}

/** Raw HTML of one chapter plus the base path its relative links resolve against. */
export function getEpubChapter(filePath, index) {
  const chapters = getEpubChapters(filePath);
  const chapter = chapters[Math.min(Math.max(index, 0), chapters.length - 1)];
  const epub = openEpub(filePath);
  const entry = epub.zip.getEntry(chapter.zipPath);
  if (!entry) throw new Error(`EPUB chapter missing in archive: ${chapter.zipPath}`);
  return {
    chapter,
    count: chapters.length,
    html: entry.getData().toString('utf8'),
    baseDir: dirname(chapter.zipPath),
  };
}

export function getEpubAsset(filePath, assetPath) {
  const epub = openEpub(filePath);
  const clean = normalizeZipPath('', assetPath);
  const entry = epub.zip.getEntry(clean) || epub.zip.getEntry(decodeURIComponent(clean));
  if (!entry || entry.isDirectory) return null;
  const ext = path.extname(clean).toLowerCase();
  return { data: entry.getData(), contentType: CONTENT_TYPES[ext] || 'application/octet-stream' };
}

/** Plain text of the first readable document, used for the generated cover. */
export function firstChapterText(filePath, maxChars = 900) {
  const chapters = getEpubChapters(filePath);
  const epub = openEpub(filePath);
  for (const chapter of chapters.slice(0, 3)) {
    const entry = epub.zip.getEntry(chapter.zipPath);
    if (!entry) continue;
    let html = entry.getData().toString('utf8');
    html = html
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    const text = decodeEntities(
      (body ? body[1] : html)
        .replace(/<\/(p|div|h1|h2|h3|li|br)\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (text.length > 40) return { text: text.slice(0, maxChars), title: chapter.title };
  }
  return { text: '', title: chapters[0]?.title || '' };
}

export { CONTENT_TYPES };
