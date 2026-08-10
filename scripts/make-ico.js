// Assemble a multi-resolution ICO from PNGs, one drawing per size.
//
//   node scripts/make-ico.js <out.ico> <16.png> <32.png> ...
//
// The point of the format is that each size may hold different artwork, and
// Windows picks by size. A detailed mark belongs at 128 and 256; a bold
// simplified one belongs at 16 and 32, where the detail would merge into a
// smudge. Scaling one drawing to every size wastes that.
//
// PNG entries are used throughout. Windows has read them inside ICO files since
// Vista, and the alternative is carrying a bitmap encoder for no benefit.

import { readFileSync, writeFileSync } from 'node:fs';

function pngSize(buf) {
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function buildIco(pngs) {
  const images = pngs.map((buf) => ({ buf, ...pngSize(buf) }));
  images.sort((a, b) => a.width - b.width);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;

  images.forEach((image, i) => {
    const o = i * 16;
    // 256 is stored as 0, which is the format's way of fitting it in a byte.
    directory[o] = image.width >= 256 ? 0 : image.width;
    directory[o + 1] = image.height >= 256 ? 0 : image.height;
    directory[o + 2] = 0; // palette size
    directory[o + 3] = 0; // reserved
    directory.writeUInt16LE(1, o + 4); // colour planes
    directory.writeUInt16LE(32, o + 6); // bits per pixel
    directory.writeUInt32LE(image.buf.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += image.buf.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.buf)]);
}

const [, , out, ...sources] = process.argv;
if (out && sources.length) {
  const ico = buildIco(sources.map((p) => readFileSync(p)));
  writeFileSync(out, ico);
  const sizes = sources.map((p) => pngSize(readFileSync(p)).width).sort((a, b) => a - b);
  console.log(`${out}  ${sizes.join(', ')}  ${(ico.length / 1024).toFixed(1)}KB`);
}
