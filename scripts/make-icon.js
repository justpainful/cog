// Draw simplified marks for the small icon sizes.
//
//   node scripts/make-icon.js <out-dir>
//
// The full knot is a good logo and a bad 16-pixel icon: six line crossings over
// sixteen pixels means each stroke is about 1.5px and the gaps between them are
// under a pixel, so they merge into a smudge. An ICO can carry different
// artwork per size, which is how this is normally solved — a bold mark small, a
// detailed one large.
//
// Everything is drawn as a signed distance field and supersampled, so the edges
// are clean without any image library.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './ico-to-png.js';

const SS = 8; // supersampling factor per axis

const PINK = [0xff, 0x5c, 0x9e];
const PINK_LIGHT = [0xff, 0x9a, 0xc6];
const INK = [0x1e, 0x1f, 0x22];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Distance from a point to a polyline, used to stroke a curve. */
function distanceToPath(px, py, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(px - cx, py - cy));
  }
  return best;
}

/** Lemniscate of Bernoulli — one crossing, which is the point. */
function infinityPath(cx, cy, scale, steps = 400) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const d = 1 + Math.sin(t) ** 2;
    points.push([cx + (scale * Math.cos(t)) / d, cy + (scale * Math.sin(t) * Math.cos(t)) / d]);
  }
  return points;
}

/** A single ring, for the simplest mark of all. */
function ringPath(cx, cy, radius, steps = 200) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    points.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
  }
  return points;
}

const roundedRect = (x, y, w, h, r) => (px, py) => {
  const dx = Math.max(x - px, 0, px - (x + w));
  const dy = Math.max(y - py, 0, py - (y + h));
  return Math.hypot(Math.max(dx - 0, 0), Math.max(dy - 0, 0)) - 0 + insetCorner(px, py, x, y, w, h, r);
};

function insetCorner(px, py, x, y, w, h, r) {
  // Distance to a rounded rectangle, computed as the distance to the inset
  // rectangle minus the corner radius.
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return Math.hypot(px - cx, py - cy) - r;
}

/**
 * Render one variant at a size.
 * @param spec.tile   draw a filled rounded square behind the mark
 * @param spec.mark   'infinity' | 'ring' | 'double'
 */
function render(size, spec) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = size * SS;

  // Stroke width as a fraction of the icon, floored so it never drops below
  // roughly two device pixels — under that a stroke greys out instead of reading.
  const strokeFraction = spec.stroke ?? 0.16;
  const halfStroke = Math.max((size * strokeFraction) / 2, 1.1) * SS;

  const cx = S / 2;
  const cy = S / 2;
  const margin = spec.tile ? 0.22 : 0.1;
  const scale = (S / 2) * (1 - margin * 2) * (spec.mark === 'ring' ? 1 : 1.35);

  const paths = [];
  if (spec.mark === 'infinity') paths.push(infinityPath(cx, cy, scale));
  else if (spec.mark === 'ring') paths.push(ringPath(cx, cy, scale * 0.8));
  else if (spec.mark === 'double') {
    paths.push(infinityPath(cx, cy, scale));
    paths.push(ringPath(cx, cy, scale * 0.52));
  }

  const tileHit = spec.tile
    ? (px, py) => insetCorner(px, py, S * 0.04, S * 0.04, S * 0.92, S * 0.92, S * 0.22) <= 0
    : null;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          let colour = null;
          let alpha = 0;

          const onTile = tileHit ? tileHit(px, py) : false;
          if (onTile) {
            const t = py / S;
            colour = spec.invert ? mix(PINK_LIGHT, PINK, t) : INK;
            alpha = 1;
          }

          let best = Infinity;
          for (const path of paths) best = Math.min(best, distanceToPath(px, py, path));
          if (best <= halfStroke && spec.invert) {
            // Knocked out of the tile, so the mark is the gap rather than ink.
            colour = INK;
            alpha = onTile ? 1 : 0;
          } else if (best <= halfStroke) {
            // Vertical gradient, so the mark has some life at large sizes and
            // still reads as one solid shape when it is tiny.
            const t = py / S;
            colour = mix(PINK_LIGHT, PINK, t);
            alpha = 1;
          }

          if (alpha > 0) {
            rSum += colour[0];
            gSum += colour[1];
            bSum += colour[2];
            aSum += 1;
          }
        }
      }

      const total = SS * SS;
      const i = (y * size + x) * 4;
      if (aSum === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(rSum / aSum);
        rgba[i + 1] = Math.round(gSum / aSum);
        rgba[i + 2] = Math.round(bSum / aSum);
        rgba[i + 3] = Math.round((aSum / total) * 255);
      }
    }
  }

  return encodePng(size, size, rgba);
}

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const VARIANTS = [
  { id: 'a-infinity', mark: 'infinity', tile: false, stroke: 0.17 },
  { id: 'b-infinity-tile', mark: 'infinity', tile: true, stroke: 0.15 },
  { id: 'c-ring', mark: 'ring', tile: false, stroke: 0.22 },
  { id: 'd-double-tile', mark: 'double', tile: true, stroke: 0.11 },
  { id: 'e-knockout', mark: 'infinity', tile: true, invert: true, stroke: 0.15 },
  { id: 'f-knockout-bold', mark: 'infinity', tile: true, invert: true, stroke: 0.2 },
];

for (const variant of VARIANTS) {
  for (const size of [16, 32, 48, 128]) {
    const png = render(size, variant);
    writeFileSync(join(outDir, `${variant.id}-${size}.png`), png);
  }
  console.log(`${variant.id.padEnd(18)} 16 32 48 128`);
}

console.log(`\nwrote ${VARIANTS.length * 4} files to ${outDir}`);
