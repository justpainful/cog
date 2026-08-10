// Pull PNGs out of a Windows ICO, using Node built-ins only.
//
//   node scripts/ico-to-png.js <file.ico> <out-dir> [size ...]
//
// Needed because the editor extension wants a PNG and the source of truth for
// the logo is an ICO. Most ICO entries are BITMAPINFOHEADER bitmaps — 32bpp
// BGRA, bottom-up, no compression — so getting a PNG out means reordering the
// channels, flipping the rows, adding a filter byte per scanline, and building
// the container by hand. Entries that are already PNG are copied straight out.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(CRC(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // A filter byte precedes every scanline; 0 means "no filter".
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function readIco(path) {
  const buf = readFileSync(path);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0, o = 6; i < count; i++, o += 16) {
    entries.push({
      width: buf[o] || 256,
      height: buf[o + 1] || 256,
      bpp: buf.readUInt16LE(o + 6),
      size: buf.readUInt32LE(o + 8),
      offset: buf.readUInt32LE(o + 12),
    });
  }
  return { buf, entries };
}

export function extract(buf, entry) {
  const data = buf.subarray(entry.offset, entry.offset + entry.size);
  if (data[0] === 0x89 && data[1] === 0x50) return data; // already a PNG

  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  // A BMP inside an ICO stores the image and its AND mask, so the recorded
  // height is twice the real one.
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bpp = data.readUInt16LE(14);
  if (bpp !== 32) throw new Error(`only 32bpp entries are supported, this one is ${bpp}bpp`);

  const pixels = data.subarray(headerSize);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    // Bitmap rows run bottom-up.
    const from = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const s = from + x * 4;
      const d = (y * width + x) * 4;
      rgba[d] = pixels[s + 2]; // B -> R
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s]; // R -> B
      rgba[d + 3] = pixels[s + 3];
    }
  }
  return encodePng(width, height, rgba);
}

const [, , icoPath, outDir, ...wanted] = process.argv;

// pathToFileURL, because a bare file:// comparison does not survive a Windows
// drive letter and the whole script silently does nothing.
if (icoPath && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { buf, entries } = readIco(icoPath);
  mkdirSync(outDir ?? '.', { recursive: true });
  const sizes = wanted.length ? wanted.map(Number) : entries.map((e) => e.width);

  const seen = new Set();
  for (const entry of entries) {
    if (!sizes.includes(entry.width) || seen.has(entry.width)) continue;
    seen.add(entry.width);
    const png = extract(buf, entry);
    const out = join(outDir ?? '.', `cog-${entry.width}.png`);
    writeFileSync(out, png);
    console.log(`${out}  ${entry.width}x${entry.height}  ${(png.length / 1024).toFixed(1)}KB`);
  }
}
