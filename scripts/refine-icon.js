// Make the existing logo legible at small sizes without redrawing it.
//
//   node scripts/refine-icon.js <source.ico> <out-dir>
//
// The knot is the logo and stays the logo. What stops it reading at 16px is not
// the shape, it is the shading: a gradient and a highlight carry information
// that survives at 256 and turns to grey mud at 16, where every pixel is doing
// several jobs at once.
//
// So the shape is kept exactly and the rendering is changed. Colour is flattened
// to one pink, the alpha is contrast stretched so edges land on whole pixels,
// and the downsample is area-averaged from the largest available source rather
// than from an already-small entry.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodePng, readIco, extract } from './ico-to-png.js';

function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = Buffer.alloc(width * height * 4);
  // Our own encoder writes filter 0 on every scanline, which is what this reads.
  for (let y = 0; y < height; y++) {
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, pixels };
}

/**
 * One flat pink instead of a gradient with a highlight.
 *
 * At 256 the shading reads as form. At 16 a pixel is already averaging several
 * strokes, and averaging a light highlight with a dark edge gives grey — the
 * mark loses its colour exactly where it needs it most.
 */
function flatten(image, colour) {
  const out = Buffer.from(image.pixels);
  for (let i = 0; i < image.width * image.height; i++) {
    if (out[i * 4 + 3] === 0) continue;
    out[i * 4] = colour[0];
    out[i * 4 + 1] = colour[1];
    out[i * 4 + 2] = colour[2];
  }
  return { ...image, pixels: out };
}

/** Area-average down to a target size, which keeps thin strokes present. */
function downsample(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const ratio = image.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(image.width, Math.ceil((x + 1) * ratio));
      const y0 = Math.floor(y * ratio);
      const y1 = Math.min(image.height, Math.ceil((y + 1) * ratio));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * image.width + sx) * 4;
          const alpha = image.pixels[s + 3] / 255;
          r += image.pixels[s] * alpha;
          g += image.pixels[s + 1] * alpha;
          b += image.pixels[s + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const i = (y * size + x) * 4;
      if (a === 0 || n === 0) continue;
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return { width: size, height: size, pixels: out };
}

/**
 * Push coverage toward on or off, and lift what is left.
 *
 * A stroke that lands across two pixels leaves both at roughly half alpha and
 * the mark greys out. Stretching around a threshold below the halfway point
 * keeps thin strokes present rather than fading them, which matters more here
 * than a clean edge.
 */
function sharpen(image, { threshold = 0.42, strength = 5 } = {}) {
  const out = Buffer.from(image.pixels);
  for (let i = 0; i < image.width * image.height; i++) {
    const a = out[i * 4 + 3] / 255;
    if (a === 0) continue;
    const pushed = Math.max(0, Math.min(1, (a - threshold) * strength + 0.5));
    out[i * 4 + 3] = Math.round(pushed * 255);
  }
  return { ...image, pixels: out };
}

const [, , source, outDir = '.'] = process.argv;
if (!source) {
  console.error('usage: node scripts/refine-icon.js <source.ico> <out-dir>');
  process.exit(2);
}

const { buf, entries } = readIco(source);
// Work from the largest entry so the downsample has the most to average.
const largest = entries.reduce((best, e) => (e.width > best.width ? e : best), entries[0]);
const master = decodePng(extract(buf, largest));

// Sampled from the middle of the artwork, so the flat colour is the logo's own.
const PINK = (() => {
  const counts = new Map();
  for (let i = 0; i < master.width * master.height; i++) {
    if (master.pixels[i * 4 + 3] < 250) continue;
    const key = `${master.pixels[i * 4] >> 3},${master.pixels[i * 4 + 1] >> 3},${master.pixels[i * 4 + 2] >> 3}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return key.split(',').map((v) => Math.min(255, (Number(v) << 3) + 4));
})();

mkdirSync(outDir, { recursive: true });
const flat = flatten(master, PINK);

console.log(`source ${largest.width}px, flat colour rgb(${PINK.join(', ')})`);

for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  // Large sizes keep the original shading; only the small ones need the help.
  const from = size <= 48 ? flat : master;
  let image = size === master.width ? from : downsample(from, size);
  if (size <= 48) image = sharpen(image, size <= 16 ? { threshold: 0.38, strength: 6 } : { threshold: 0.42, strength: 5 });

  const out = join(outDir, `cog-${size}.png`);
  writeFileSync(out, encodePng(size, size, image.pixels));

  let partial = 0;
  let opaque = 0;
  for (let i = 0; i < size * size; i++) {
    const a = image.pixels[i * 4 + 3];
    if (a === 255) opaque++;
    else if (a > 0) partial++;
  }
  console.log(`  ${String(size).padStart(3)}px  ${String(opaque).padStart(5)} solid  ${String(partial).padStart(5)} partial`);
}
