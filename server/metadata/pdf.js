// PDF metadata extraction and first-page rendering, using pdf.js in Node.
// pdf.js expects a handful of DOM globals; @napi-rs/canvas provides them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STANDARD_FONTS = path.join(ROOT, 'public', 'vendor', 'pdfjs', 'standard_fonts') + path.sep;

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Extract a 4-digit year from PDF dates (D:YYYYMMDDHHmmSS...) or free text. */
export function yearFromDate(value) {
  if (!value) return null;
  const m = String(value).match(/(1[5-9]\d{2}|20\d{2}|21\d{2})/);
  return m ? m[1] : null;
}

async function openDocument(filePath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const options = {
    data,
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  };
  if (fs.existsSync(STANDARD_FONTS)) options.standardFontDataUrl = STANDARD_FONTS;
  return pdfjs.getDocument(options).promise;
}

export async function readPdfMetadata(filePath) {
  const doc = await openDocument(filePath);
  try {
    let info = {};
    let xmp = null;
    try {
      const meta = await doc.getMetadata();
      info = meta.info || {};
      xmp = meta.metadata || null;
    } catch {
      info = {};
    }
    const xmpGet = (key) => {
      try {
        return xmp && typeof xmp.get === 'function' ? clean(xmp.get(key)) : null;
      } catch {
        return null;
      }
    };
    const metadata = {
      title: clean(info.Title) || xmpGet('dc:title') || null,
      author: clean(info.Author) || xmpGet('dc:creator') || null,
      year: yearFromDate(info.CreationDate) || yearFromDate(xmpGet('xmp:createdate')) || yearFromDate(xmpGet('dc:date')),
      language: xmpGet('dc:language'),
      description: clean(info.Subject) || xmpGet('dc:description') || null,
      publisher: xmpGet('dc:publisher') || null,
    };
    return { metadata, pageCount: doc.numPages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/**
 * Render one page to a JPEG buffer.
 * @returns {Promise<Buffer>} jpeg bytes
 */
export async function renderPdfPage(filePath, pageNumber = 1, targetWidth = 600) {
  const doc = await openDocument(filePath);
  try {
    const page = await doc.getPage(Math.min(Math.max(pageNumber, 1), doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(Math.max(targetWidth / base.width, 0.4), 3);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;
    page.cleanup();
    return await canvas.encode('jpeg', 82);
  } finally {
    await doc.destroy().catch(() => {});
  }
}
