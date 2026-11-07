// Cover generation: normalise the EPUB cover image, render the first PDF page,
// draw a text card for EPUBs without a cover, and build deterministic SVG
// placeholders. Everything is produced locally, no external image service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export const COVER_WIDTH = 480;
export const COVER_HEIGHT = 720;

export function coverKeyFor(filePath) {
  return crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 16);
}

export function hashString(value) {
  let hash = 0;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function initialsFor(title, author) {
  const words = String(title || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const authorWords = String(author || '').split(/\s+/).filter(Boolean);
  return authorWords.length ? authorWords[0].slice(0, 2).toUpperCase() : '?';
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Scale/crop an arbitrary image buffer into a portrait JPEG. */
export async function normalizeImage(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  const scale = Math.min(COVER_WIDTH / image.width, COVER_HEIGHT / image.height);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  ctx.drawImage(image, Math.round((COVER_WIDTH - w) / 2), Math.round((COVER_HEIGHT - h) / 2), w, h);
  return canvas.encode('jpeg', 85);
}

/**
 * Draw a readable "first page" card from plain text: used when an EPUB has no
 * cover image and we cannot render a browser page server-side.
 */
export async function renderTextCover({ title, author, text, label }) {
  const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT);
  const ctx = canvas.getContext('2d');
  const hue = hashString(title || author || 'libro') % 360;

  ctx.fillStyle = `hsl(${hue}, 24%, 94%)`;
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  ctx.fillStyle = `hsl(${hue}, 38%, 32%)`;
  ctx.fillRect(0, 0, COVER_WIDTH, 10);

  ctx.fillStyle = '#1d1d1f';
  ctx.font = 'bold 30px sans-serif';
  const titleLines = wrapText(ctx, title || 'Senza titolo', COVER_WIDTH - 80).slice(0, 3);
  let y = 90;
  for (const line of titleLines) {
    ctx.fillText(line, 40, y);
    y += 38;
  }

  ctx.fillStyle = '#55555c';
  ctx.font = '18px sans-serif';
  if (author) {
    ctx.fillText(wrapText(ctx, author, COVER_WIDTH - 80)[0] || '', 40, y + 10);
    y += 40;
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath();
  ctx.moveTo(40, y + 20);
  ctx.lineTo(COVER_WIDTH - 40, y + 20);
  ctx.stroke();
  y += 60;

  ctx.fillStyle = '#2c2c31';
  ctx.font = '17px serif';
  const body = wrapText(ctx, (text || '').slice(0, 1200), COVER_WIDTH - 80);
  const maxLines = Math.floor((COVER_HEIGHT - y - 60) / 25);
  for (const line of body.slice(0, Math.max(maxLines, 0))) {
    ctx.fillText(line, 40, y);
    y += 25;
  }

  ctx.fillStyle = '#8a8a92';
  ctx.font = '13px sans-serif';
  ctx.fillText(label || 'Anteprima', 40, COVER_HEIGHT - 28);
  return canvas.encode('jpeg', 82);
}

/** Deterministic coloured card, served as SVG for books with no derivable cover. */
export function placeholderSvg({ title, author }) {
  const hue = hashString(title || author || 'libro') % 360;
  const initials = initialsFor(title, author);
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortTitle = (title || 'Senza titolo').slice(0, 42);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 720" width="480" height="720" role="img" aria-label="${esc(title || 'Senza titolo')}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 42%, 42%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 28) % 360}, 38%, 26%)"/>
    </linearGradient>
  </defs>
  <rect width="480" height="720" fill="url(#g)"/>
  <rect x="26" y="26" width="428" height="668" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="2"/>
  <text x="240" y="372" text-anchor="middle" font-family="Georgia, serif" font-size="132" fill="rgba(255,255,255,0.92)">${esc(initials)}</text>
  <text x="240" y="470" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="rgba(255,255,255,0.85)">${esc(shortTitle)}</text>
</svg>`;
}

export function writeCoverFile(coversDir, key, buffer) {
  fs.mkdirSync(coversDir, { recursive: true });
  const name = `${key}.jpg`;
  fs.writeFileSync(`${coversDir}/${name}`, buffer);
  return name;
}
