// Copy the pdf.js browser build into public/vendor/pdfjs so the reader never
// depends on a CDN at runtime. Runs before `npm start` and during docker build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const TARGET = path.join(ROOT, 'public', 'vendor', 'pdfjs');

const FILES = ['build/pdf.mjs', 'build/pdf.worker.mjs'];
const DIRS = ['standard_fonts', 'cmaps'];

function copyRecursive(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyRecursive(src, dest);
    else {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

if (!fs.existsSync(SOURCE)) {
  console.warn('[vendor] pdfjs-dist is not installed; skipping vendoring');
  process.exit(0);
}

fs.mkdirSync(TARGET, { recursive: true });
let copied = 0;
for (const rel of FILES) {
  const src = path.join(SOURCE, rel);
  if (!fs.existsSync(src)) {
    console.warn(`[vendor] missing ${rel} in pdfjs-dist`);
    continue;
  }
  fs.copyFileSync(src, path.join(TARGET, path.basename(rel)));
  copied += 1;
}
for (const dir of DIRS) copied += copyRecursive(path.join(SOURCE, dir), path.join(TARGET, dir));
console.log(`[vendor] pdf.js assets ready in public/vendor/pdfjs (${copied} files)`);
