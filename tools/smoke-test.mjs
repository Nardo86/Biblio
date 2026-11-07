// Smoke test for the parsing layer: metadata, chapters and cover rendering.
// Usage: node tools/smoke-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEpubMetadata, getEpubChapters, getEpubChapter, getEpubAsset, firstChapterText } from '../server/metadata/epub.js';
import { readPdfMetadata, renderPdfPage } from '../server/metadata/pdf.js';
import { renderTextCover, normalizeImage } from '../server/covers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'sample-library');

const files = fs.readdirSync(LIB).filter((f) => /\.(epub|pdf)$/i.test(f)).sort();
let failures = 0;

for (const name of files) {
  const full = path.join(LIB, name);
  try {
    if (name.toLowerCase().endsWith('.epub')) {
      const { metadata, coverData } = readEpubMetadata(full);
      const chapters = getEpubChapters(full);
      const chapter = getEpubChapter(full, 1);
      const first = firstChapterText(full);
      console.log(`EPUB ${name}`);
      console.log(`  title=${metadata.title} author=${metadata.author} year=${metadata.year} lang=${metadata.language}`);
      console.log(`  chapters=${chapters.length} coverBytes=${coverData ? coverData.length : 0} firstText=${first.text.length}`);
      if (coverData) {
        const jpeg = await normalizeImage(coverData);
        console.log(`  normalized cover jpeg bytes=${jpeg.length}`);
      } else {
        const jpeg = await renderTextCover({ title: metadata.title, author: metadata.author, text: first.text });
        console.log(`  generated text cover bytes=${jpeg.length}`);
      }
      console.log(`  chapter1 html=${chapter.html.length} baseDir=${chapter.baseDir}`);
      if (name.includes('sentiero')) {
        const asset = getEpubAsset(full, 'OEBPS/images/illustration.png');
        console.log(`  asset illustration=${asset ? asset.contentType + ' ' + asset.data.length : 'MISSING'}`);
        if (!asset) failures += 1;
      }
    } else {
      const { metadata, pageCount } = await readPdfMetadata(full);
      const jpeg = await renderPdfPage(full, 1, 600);
      console.log(`PDF ${name}`);
      console.log(`  title=${metadata.title} author=${metadata.author} year=${metadata.year} pages=${pageCount}`);
      console.log(`  rendered page1 jpeg bytes=${jpeg.length}`);
      fs.writeFileSync(`/tmp/cover-${name.replace(/\W+/g, '_')}.jpg`, jpeg);
    }
  } catch (err) {
    failures += 1;
    console.error(`FAILED ${name}: ${err.stack}`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
